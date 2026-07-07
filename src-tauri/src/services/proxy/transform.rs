//! Anthropic Messages ↔ OpenAI Chat Completions 格式转换
//!
//! 参考 cc-switch 的 transform.rs 实现，提取核心转换逻辑。
//! 处理：system prompt、messages、tools、tool_choice、thinking → reasoning_effort。

use super::error::ProxyError;
use serde_json::{json, Value};

const ANTHROPIC_BILLING_HEADER_PREFIX: &str = "x-anthropic-billing-header:";

// ============================================================================
// 公共 API
// ============================================================================

/// Anthropic Messages 请求 → OpenAI Chat Completions 请求
pub fn anthropic_to_openai(body: Value) -> Result<Value, ProxyError> {
    let mut result = json!({});

    // 模型直接透传（模型映射由上层处理）
    if let Some(model) = body.get("model").and_then(|m| m.as_str()) {
        result["model"] = json!(model);
    }

    let mut messages = Vec::new();

    // --- 处理 system prompt ---
    if let Some(system) = body.get("system") {
        if let Some(text) = system.as_str() {
            let text = strip_leading_billing_header(text);
            if !text.is_empty() {
                messages.push(json!({"role": "system", "content": text}));
            }
        } else if let Some(arr) = system.as_array() {
            for msg in arr {
                if let Some(text) = msg.get("text").and_then(|t| t.as_str()) {
                    let text = strip_leading_billing_header(text);
                    if text.is_empty() {
                        continue;
                    }
                    messages.push(json!({"role": "system", "content": text}));
                }
            }
        }
    }

    // --- 转换 messages ---
    if let Some(msgs) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in msgs {
            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = msg.get("content");
            let converted = convert_message_to_openai(role, content)?;
            messages.extend(converted);
        }
    }

    // 合并多个 system message（保持在最前面）
    normalize_system_messages(&mut messages);
    result["messages"] = json!(messages);

    // --- 转换参数 ---
    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
    if let Some(v) = body.get("max_tokens") {
        if is_o_series_model(model) {
            result["max_completion_tokens"] = v.clone();
        } else {
            result["max_tokens"] = v.clone();
        }
    }
    if let Some(v) = body.get("temperature") {
        result["temperature"] = v.clone();
    }
    if let Some(v) = body.get("top_p") {
        result["top_p"] = v.clone();
    }
    if let Some(v) = body.get("stop_sequences") {
        result["stop"] = v.clone();
    }
    if let Some(v) = body.get("stream") {
        result["stream"] = v.clone();
    }

    // thinking → reasoning_effort
    if supports_reasoning_effort(model) {
        if let Some(effort) = resolve_reasoning_effort(&body) {
            result["reasoning_effort"] = json!(effort);
        }
    }

    // --- 转换 tools ---
    // 注意：过滤掉 BatchTool（Claude Code 内部工具），并移除 Anthropic 特有的 cache_control 字段
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let openai_tools: Vec<Value> = tools
            .iter()
            .filter(|t| t.get("type").and_then(|v| v.as_str()) != Some("BatchTool"))
            .map(|t| {
                let mut function = json!({
                    "name": t.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                    "parameters": clean_schema(t.get("input_schema").cloned().unwrap_or(json!({})))
                });
                // 只在 description 非空时包含（避免 null 值导致上游 400 错误）
                if let Some(desc) = t.get("description").and_then(|d| d.as_str()) {
                    if !desc.is_empty() {
                        function["description"] = json!(desc);
                    }
                }
                json!({
                    "type": "function",
                    "function": function
                })
            })
            .collect();

        if !openai_tools.is_empty() {
            result["tools"] = json!(openai_tools);
        }
    }

    // --- 转换 tool_choice ---
    if let Some(v) = body.get("tool_choice") {
        result["tool_choice"] = map_tool_choice_to_openai(v);
    }

    Ok(result)
}

/// OpenAI Chat Completions 响应 → Anthropic Messages 响应（非流式）
pub fn openai_to_anthropic(body: Value) -> Result<Value, ProxyError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("msg_proxy")
        .to_string();
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first());

    let (content_blocks, stop_reason) = if let Some(choice) = choice {
        let message = choice.get("message");
        let finish_reason = choice
            .get("finish_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("stop");

        let mut blocks = Vec::new();

        // 提取 reasoning_content / reasoning（thinking block）
        if let Some(message) = message {
            let reasoning = message
                .get("reasoning_content")
                .or_else(|| message.get("reasoning"))
                .and_then(|v| v.as_str());
            if let Some(reasoning) = reasoning {
                if !reasoning.is_empty() {
                    blocks.push(json!({
                        "type": "thinking",
                        "thinking": reasoning
                    }));
                }
            }

            // 提取文本内容
            if let Some(content) = message.get("content") {
                if let Some(text) = content.as_str() {
                    if !text.is_empty() {
                        blocks.push(json!({
                            "type": "text",
                            "text": text
                        }));
                    }
                } else if let Some(parts) = content.as_array() {
                    // 多模态内容（数组格式）
                    for part in parts {
                        if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    blocks.push(json!({
                                        "type": "text",
                                        "text": text
                                    }));
                                }
                            }
                        }
                    }
                }
            }

            // 提取 tool_calls
            if let Some(tool_calls) = message.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = tc
                        .pointer("/function/name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let args_str = tc
                        .pointer("/function/arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}");
                    let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input
                    }));
                }
            }
        }

        if blocks.is_empty() {
            blocks.push(json!({
                "type": "text",
                "text": ""
            }));
        }

        let anthropic_stop = match finish_reason {
            "stop" => "end_turn",
            "length" => "max_tokens",
            "tool_calls" => "tool_use",
            "content_filter" => "end_turn",
            _ => "end_turn",
        };

        (blocks, anthropic_stop)
    } else {
        (vec![json!({"type": "text", "text": ""})], "end_turn")
    };

    // 构建 usage
    let mut usage = json!({
        "input_tokens": 0,
        "output_tokens": 0
    });
    if let Some(openai_usage) = body.get("usage") {
        usage["input_tokens"] = openai_usage
            .get("prompt_tokens")
            .cloned()
            .unwrap_or(json!(0));
        usage["output_tokens"] = openai_usage
            .get("completion_tokens")
            .cloned()
            .unwrap_or(json!(0));
        // 缓存 token
        if let Some(cached) = openai_usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(|v| v.as_u64())
        {
            usage["cache_read_input_tokens"] = json!(cached);
        }
    }

    Ok(json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content_blocks,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": usage
    }))
}

// ============================================================================
// Responses API 转换（OpenAI /v1/responses）
// ============================================================================

/// Anthropic Messages 请求 → OpenAI Responses 请求
///
/// 与 Chat Completions 的差异：
/// - system → 顶层 `instructions`
/// - messages → `input[]`（user 用 input_text/input_image，assistant 用 output_text，
///   tool_use/tool_result 作为独立的 function_call / function_call_output item）
/// - tools 为扁平结构（`{type:"function", name, parameters}`，无嵌套 function 对象）
/// - max_tokens → max_output_tokens；thinking → reasoning.effort
pub fn anthropic_to_responses(body: Value) -> Result<Value, ProxyError> {
    let mut result = json!({});

    if let Some(model) = body.get("model").and_then(|m| m.as_str()) {
        result["model"] = json!(model);
    }

    // --- system → instructions ---
    let mut instructions = String::new();
    if let Some(system) = body.get("system") {
        if let Some(text) = system.as_str() {
            instructions = strip_leading_billing_header(text).to_string();
        } else if let Some(arr) = system.as_array() {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|m| m.get("text").and_then(|t| t.as_str()))
                .map(|t| strip_leading_billing_header(t).to_string())
                .filter(|t| !t.is_empty())
                .collect();
            instructions = parts.join("\n");
        }
    }
    if !instructions.is_empty() {
        result["instructions"] = json!(instructions);
    }

    // --- messages → input[] ---
    let mut input = Vec::new();
    if let Some(msgs) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in msgs {
            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = msg.get("content");
            convert_message_to_responses_input(role, content, &mut input);
        }
    }
    result["input"] = json!(input);

    // --- 参数 ---
    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
    if let Some(v) = body.get("max_tokens") {
        result["max_output_tokens"] = v.clone();
    }
    if let Some(v) = body.get("temperature") {
        result["temperature"] = v.clone();
    }
    if let Some(v) = body.get("top_p") {
        result["top_p"] = v.clone();
    }
    if let Some(v) = body.get("stream") {
        result["stream"] = v.clone();
    }

    // thinking → reasoning.effort
    if supports_reasoning_effort(model) {
        if let Some(effort) = resolve_reasoning_effort(&body) {
            result["reasoning"] = json!({ "effort": effort });
        }
    }

    // --- tools（扁平 function）---
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let resp_tools: Vec<Value> = tools
            .iter()
            .filter(|t| t.get("type").and_then(|v| v.as_str()) != Some("BatchTool"))
            .map(|t| {
                let mut tool = json!({
                    "type": "function",
                    "name": t.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                    "parameters": clean_schema(t.get("input_schema").cloned().unwrap_or(json!({})))
                });
                if let Some(desc) = t.get("description").and_then(|d| d.as_str()) {
                    if !desc.is_empty() {
                        tool["description"] = json!(desc);
                    }
                }
                tool
            })
            .collect();
        if !resp_tools.is_empty() {
            result["tools"] = json!(resp_tools);
        }
    }

    if let Some(v) = body.get("tool_choice") {
        result["tool_choice"] = map_tool_choice_to_responses(v);
    }

    Ok(result)
}

/// OpenAI Responses 响应 → Anthropic Messages 响应（非流式）
pub fn responses_to_anthropic(body: Value) -> Result<Value, ProxyError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("msg_proxy")
        .to_string();
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let mut blocks = Vec::new();
    let mut stop_reason = "end_turn";

    if let Some(output) = body.get("output").and_then(|o| o.as_array()) {
        for item in output {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("reasoning") => {
                    let mut texts = Vec::new();
                    if let Some(summary) = item.get("summary").and_then(|s| s.as_array()) {
                        for s in summary {
                            if let Some(t) = s.get("text").and_then(|t| t.as_str()) {
                                texts.push(t.to_string());
                            }
                        }
                    }
                    let combined = texts.join("");
                    if !combined.is_empty() {
                        blocks.push(json!({"type": "thinking", "thinking": combined}));
                    }
                }
                Some("message") => {
                    if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                        for part in content {
                            if part.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                    if !text.is_empty() {
                                        blocks.push(json!({"type": "text", "text": text}));
                                    }
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let call_id = item
                        .get("call_id")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.get("id").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let args_str = item
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}");
                    let parsed: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": parsed
                    }));
                    stop_reason = "tool_use";
                }
                _ => {}
            }
        }
    }

    // 便捷字段 output_text 兜底
    if blocks.is_empty() {
        if let Some(text) = body.get("output_text").and_then(|t| t.as_str()) {
            if !text.is_empty() {
                blocks.push(json!({"type": "text", "text": text}));
            }
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({"type": "text", "text": ""}));
    }

    // incomplete → max_tokens
    if body
        .pointer("/incomplete_details/reason")
        .and_then(|v| v.as_str())
        == Some("max_output_tokens")
    {
        stop_reason = "max_tokens";
    }

    let mut usage = json!({"input_tokens": 0, "output_tokens": 0});
    if let Some(u) = body.get("usage") {
        usage["input_tokens"] = u.get("input_tokens").cloned().unwrap_or(json!(0));
        usage["output_tokens"] = u.get("output_tokens").cloned().unwrap_or(json!(0));
        if let Some(cached) = u
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(|v| v.as_u64())
        {
            usage["cache_read_input_tokens"] = json!(cached);
        }
    }

    Ok(json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": usage
    }))
}

/// 将单条 Anthropic message 转换为 Responses input item(s)，追加到 `input`
fn convert_message_to_responses_input(role: &str, content: Option<&Value>, input: &mut Vec<Value>) {
    let text_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };

    let Some(content) = content else {
        input.push(json!({"role": role, "content": [{"type": text_type, "text": ""}]}));
        return;
    };

    // 字符串内容
    if let Some(text) = content.as_str() {
        input.push(json!({
            "role": role,
            "content": [{"type": text_type, "text": text}]
        }));
        return;
    }

    let Some(blocks) = content.as_array() else {
        return;
    };

    let mut parts: Vec<Value> = Vec::new();
    let flush = |parts: &mut Vec<Value>, input: &mut Vec<Value>| {
        if !parts.is_empty() {
            input.push(json!({"role": role, "content": parts.clone()}));
            parts.clear();
        }
    };

    for block in blocks {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("text");
        match block_type {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    parts.push(json!({"type": text_type, "text": text}));
                }
            }
            "image" => {
                if let Some(source) = block.get("source") {
                    let media_type = source
                        .get("media_type")
                        .and_then(|m| m.as_str())
                        .unwrap_or("image/png");
                    let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                    parts.push(json!({
                        "type": "input_image",
                        "image_url": format!("data:{};base64,{}", media_type, data)
                    }));
                }
            }
            "tool_use" => {
                flush(&mut parts, input);
                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = block.get("input").cloned().unwrap_or(json!({}));
                let args_str = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                input.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": args_str
                }));
            }
            "tool_result" => {
                flush(&mut parts, input);
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let output = extract_tool_result_text(block);
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": output
                }));
            }
            "thinking" => {
                // assistant thinking block 不回传上游
            }
            _ => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    parts.push(json!({"type": text_type, "text": text}));
                }
            }
        }
    }

    flush(&mut parts, input);
}

/// 映射 Anthropic tool_choice → OpenAI Responses tool_choice
/// （Responses 指定具体工具用 `{type:"function", name}`，非嵌套 function 对象）
fn map_tool_choice_to_responses(tool_choice: &Value) -> Value {
    match tool_choice {
        Value::String(s) => match s.as_str() {
            "any" => json!("required"),
            other => json!(other),
        },
        Value::Object(obj) => match obj.get("type").and_then(|t| t.as_str()) {
            Some("any") => json!("required"),
            Some("auto") => json!("auto"),
            Some("none") => json!("none"),
            Some("tool") => {
                let name = obj.get("name").and_then(|n| n.as_str()).unwrap_or("");
                json!({"type": "function", "name": name})
            }
            _ => json!("auto"),
        },
        _ => json!("auto"),
    }
}

// ============================================================================
// Message 转换
// ============================================================================

/// 将单条 Anthropic message 转换为零或多条 OpenAI messages
fn convert_message_to_openai(
    role: &str,
    content: Option<&Value>,
) -> Result<Vec<Value>, ProxyError> {
    match role {
        "user" => convert_user_message(content),
        "assistant" => convert_assistant_message(content),
        _ => Ok(vec![]),
    }
}

fn convert_user_message(content: Option<&Value>) -> Result<Vec<Value>, ProxyError> {
    let Some(content) = content else {
        return Ok(vec![json!({"role": "user", "content": ""})]);
    };

    // 字符串格式
    if let Some(text) = content.as_str() {
        return Ok(vec![json!({"role": "user", "content": text})]);
    }

    // 数组格式（content blocks）
    let Some(blocks) = content.as_array() else {
        return Ok(vec![json!({"role": "user", "content": content})]);
    };

    let mut messages = Vec::new();
    let mut text_parts = Vec::new();
    let mut image_parts = Vec::new();

    for block in blocks {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("text");
        match block_type {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
            "image" => {
                // Anthropic image block → OpenAI image_url
                if let Some(source) = block.get("source") {
                    let media_type = source
                        .get("media_type")
                        .and_then(|m| m.as_str())
                        .unwrap_or("image/png");
                    let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                    image_parts.push(json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:{};base64,{}", media_type, data)
                        }
                    }));
                }
            }
            "tool_result" => {
                // tool_result 作为单独的 tool message 处理
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let result_content = extract_tool_result_text(block);
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": result_content
                }));
            }
            _ => {
                // 其他类型尝试提取文本
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
        }
    }

    // 合并文本和图片为一条 user message
    if !text_parts.is_empty() || !image_parts.is_empty() {
        let mut parts = Vec::new();
        for img in image_parts {
            parts.push(img);
        }
        if !text_parts.is_empty() {
            parts.push(json!({"type": "text", "text": text_parts.join("\n")}));
        }
        if parts.len() == 1 && parts[0].get("type").and_then(|t| t.as_str()) == Some("text") {
            // 只有纯文本，简化格式
            messages.insert(
                0,
                json!({"role": "user", "content": parts[0].get("text").cloned().unwrap_or(json!(""))}),
            );
        } else {
            messages.insert(0, json!({"role": "user", "content": parts}));
        }
    }

    if messages.is_empty() {
        messages.push(json!({"role": "user", "content": ""}));
    }

    Ok(messages)
}

fn convert_assistant_message(content: Option<&Value>) -> Result<Vec<Value>, ProxyError> {
    let Some(content) = content else {
        return Ok(vec![json!({"role": "assistant", "content": ""})]);
    };

    // 字符串格式
    if let Some(text) = content.as_str() {
        return Ok(vec![json!({"role": "assistant", "content": text})]);
    }

    // 数组格式（content blocks）
    let Some(blocks) = content.as_array() else {
        return Ok(vec![json!({"role": "assistant", "content": content})]);
    };

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    for block in blocks {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("text");
        match block_type {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
            "thinking" => {
                // thinking blocks 在 assistant message 中跳过（不发给 OpenAI）
                // 如果需要 reasoning_content，由上层处理
            }
            "tool_use" => {
                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let input = block.get("input").cloned().unwrap_or(json!({}));
                let args_str = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args_str
                    }
                }));
            }
            _ => {}
        }
    }

    let mut msg = json!({"role": "assistant"});

    let text_content = text_parts.join("");
    if !text_content.is_empty() {
        msg["content"] = json!(text_content);
    } else if tool_calls.is_empty() {
        msg["content"] = json!("");
    }

    if !tool_calls.is_empty() {
        msg["tool_calls"] = json!(tool_calls);
    }

    Ok(vec![msg])
}

fn extract_tool_result_text(block: &Value) -> String {
    if let Some(text) = block.get("content").and_then(|c| c.as_str()) {
        return text.to_string();
    }
    if let Some(arr) = block.get("content").and_then(|c| c.as_array()) {
        let texts: Vec<&str> = arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect();
        return texts.join("\n");
    }
    String::new()
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 去掉 Claude Code 发送的 `x-anthropic-billing-header:` 前缀
/// （该元数据会破坏上游 prefix cache）
fn strip_leading_billing_header(text: &str) -> &str {
    if !text.starts_with(ANTHROPIC_BILLING_HEADER_PREFIX) {
        return text;
    }
    let Some(line_end) = text
        .as_bytes()
        .iter()
        .position(|b| *b == b'\n' || *b == b'\r')
    else {
        return "";
    };
    let bytes = text.as_bytes();
    let mut rest_start = line_end + 1;
    if bytes[line_end] == b'\r' && bytes.get(line_end + 1) == Some(&b'\n') {
        rest_start += 1;
    }
    let rest = &text[rest_start..];
    rest.strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .or_else(|| rest.strip_prefix('\r'))
        .unwrap_or(rest)
}

/// 检测 OpenAI o-series 推理模型（o1, o3, o4-mini 等）
fn is_o_series_model(model: &str) -> bool {
    model.len() > 1
        && model.starts_with('o')
        && model.as_bytes().get(1).is_some_and(|b| b.is_ascii_digit())
}

/// 检测支持 reasoning_effort 的模型
fn supports_reasoning_effort(model: &str) -> bool {
    is_o_series_model(model)
        || model
            .to_lowercase()
            .strip_prefix("gpt-")
            .and_then(|rest| rest.chars().next())
            .is_some_and(|c| c.is_ascii_digit() && c >= '5')
}

/// 从 Anthropic thinking 配置解析 OpenAI reasoning_effort
fn resolve_reasoning_effort(body: &Value) -> Option<&'static str> {
    let thinking = body.get("thinking")?;
    match thinking.get("type").and_then(|t| t.as_str()) {
        Some("adaptive") => Some("xhigh"),
        Some("enabled") => {
            let budget = thinking.get("budget_tokens").and_then(|b| b.as_u64());
            match budget {
                Some(b) if b < 4_000 => Some("low"),
                Some(b) if b < 16_000 => Some("medium"),
                Some(_) => Some("high"),
                None => Some("high"),
            }
        }
        _ => None,
    }
}

/// 合并多个 system messages 为一个，确保 system 消息在最前面
fn normalize_system_messages(messages: &mut Vec<Value>) {
    let system_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("system"))
        .map(|(i, _)| i)
        .collect();

    if system_indices.is_empty() {
        return;
    }

    if system_indices.len() == 1 {
        // 只有一个 system message，确保在最前面
        let idx = system_indices[0];
        if idx > 0 {
            let msg = messages.remove(idx);
            messages.insert(0, msg);
        }
        return;
    }

    // 多个 system message，合并为一个
    let texts: Vec<String> = system_indices
        .iter()
        .rev() // 从后往前移除避免索引偏移
        .map(|&i| {
            let msg = messages.remove(i);
            msg.get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();

    let combined = texts.into_iter().rev().collect::<Vec<_>>().join("\n\n");
    messages.insert(0, json!({"role": "system", "content": combined}));
}

/// 映射 Anthropic tool_choice → OpenAI tool_choice
fn map_tool_choice_to_openai(tool_choice: &Value) -> Value {
    match tool_choice {
        Value::String(s) => match s.as_str() {
            "any" => json!("required"),
            other => json!(other),
        },
        Value::Object(obj) => match obj.get("type").and_then(|t| t.as_str()) {
            Some("any") => json!("required"),
            Some("auto") => json!("auto"),
            Some("none") => json!("none"),
            Some("tool") => {
                let name = obj.get("name").and_then(|n| n.as_str()).unwrap_or("");
                json!({
                    "type": "function",
                    "function": { "name": name }
                })
            }
            _ => tool_choice.clone(),
        },
        _ => tool_choice.clone(),
    }
}

/// 清理 JSON Schema 中的不兼容字段
///
/// 移除 Anthropic 特有的字段（cache_control、$schema 等），
/// 避免 OpenAI 兼容 API 返回 400 错误。
fn clean_schema(mut schema: Value) -> Value {
    if let Some(obj) = schema.as_object_mut() {
        obj.remove("$schema");
        obj.remove("additionalProperties");
        obj.remove("cache_control");
        // 递归处理 properties
        if let Some(props) = obj.get_mut("properties") {
            if let Some(props_obj) = props.as_object_mut() {
                let keys: Vec<String> = props_obj.keys().cloned().collect();
                for key in keys {
                    if let Some(prop) = props_obj.get_mut(&key) {
                        let cleaned = clean_schema(prop.take());
                        *prop = cleaned;
                    }
                }
            }
        }
    }
    schema
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_billing_header() {
        let input = "x-anthropic-billing-header: cch=abc123\n\nReal system prompt";
        assert_eq!(strip_leading_billing_header(input), "Real system prompt");
    }

    #[test]
    fn test_strip_billing_header_no_header() {
        let input = "Normal system prompt";
        assert_eq!(strip_leading_billing_header(input), "Normal system prompt");
    }

    #[test]
    fn test_is_o_series() {
        assert!(is_o_series_model("o1"));
        assert!(is_o_series_model("o3-mini"));
        assert!(is_o_series_model("o4-mini"));
        assert!(!is_o_series_model("gpt-4o"));
        assert!(!is_o_series_model("claude-3-opus"));
    }

    #[test]
    fn test_supports_reasoning_effort() {
        assert!(supports_reasoning_effort("o1"));
        assert!(supports_reasoning_effort("gpt-5"));
        assert!(supports_reasoning_effort("gpt-5.4-turbo"));
        assert!(!supports_reasoning_effort("gpt-4o"));
        assert!(!supports_reasoning_effort("claude-3"));
    }

    #[test]
    fn test_map_tool_choice() {
        assert_eq!(map_tool_choice_to_openai(&json!("any")), json!("required"));
        assert_eq!(map_tool_choice_to_openai(&json!("auto")), json!("auto"));
        assert_eq!(
            map_tool_choice_to_openai(&json!({"type": "tool", "name": "read_file"})),
            json!({"type": "function", "function": {"name": "read_file"}})
        );
    }

    #[test]
    fn test_anthropic_to_openai_basic() {
        let anthropic = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 4096,
            "system": "You are helpful.",
            "messages": [
                {"role": "user", "content": "Hello"}
            ]
        });
        let result = anthropic_to_openai(anthropic).unwrap();
        assert_eq!(result["model"], "claude-sonnet-4-20250514");
        assert_eq!(result["max_tokens"], 4096);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful.");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn test_anthropic_to_openai_with_tools() {
        let anthropic = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "test"}],
            "tools": [{
                "name": "read_file",
                "description": "Read a file",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"}
                    },
                    "required": ["path"]
                }
            }],
            "tool_choice": {"type": "any"}
        });
        let result = anthropic_to_openai(anthropic).unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "read_file");
        assert_eq!(result["tool_choice"], "required");
    }

    #[test]
    fn test_openai_to_anthropic_basic() {
        let openai = json!({
            "id": "chatcmpl-test",
            "model": "deepseek-chat",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Hello there!"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15
            }
        });
        let result = openai_to_anthropic(openai).unwrap();
        assert_eq!(result["type"], "message");
        assert_eq!(result["stop_reason"], "end_turn");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "Hello there!");
        assert_eq!(result["usage"]["input_tokens"], 10);
        assert_eq!(result["usage"]["output_tokens"], 5);
    }

    #[test]
    fn test_openai_to_anthropic_with_tool_calls() {
        let openai = json!({
            "id": "chatcmpl-tc",
            "model": "deepseek-chat",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_123",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"/test.txt\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 30, "total_tokens": 50}
        });
        let result = openai_to_anthropic(openai).unwrap();
        assert_eq!(result["stop_reason"], "tool_use");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "tool_use");
        assert_eq!(content[0]["id"], "call_123");
        assert_eq!(content[0]["name"], "read_file");
        assert_eq!(content[0]["input"]["path"], "/test.txt");
    }

    #[test]
    fn test_tools_cache_control_stripped() {
        // 模拟 Claude CLI 发送的带 cache_control 的工具定义
        let anthropic = json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "test"}],
            "tools": [
                {
                    "name": "Bash",
                    "description": "Run a command",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string"}
                        },
                        "required": ["command"]
                    },
                    "cache_control": {"type": "ephemeral"}
                },
                {
                    "name": "Read",
                    "description": null,
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string"}
                        }
                    },
                    "cache_control": {"type": "ephemeral"}
                }
            ]
        });
        let result = anthropic_to_openai(anthropic).unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);

        // cache_control 不应出现在转换后的工具中
        let bash_tool = &tools[0];
        assert!(bash_tool.get("cache_control").is_none());
        assert_eq!(bash_tool["function"]["name"], "Bash");
        assert_eq!(bash_tool["function"]["description"], "Run a command");

        // null description 不应出现在转换后的工具中
        let read_tool = &tools[1];
        assert!(read_tool["function"].get("description").is_none());
        assert_eq!(read_tool["function"]["name"], "Read");
    }

    #[test]
    fn test_clean_schema_removes_anthropic_fields() {
        let schema = json!({
            "type": "object",
            "$schema": "http://json-schema.org/draft-07/schema#",
            "additionalProperties": false,
            "cache_control": {"type": "ephemeral"},
            "properties": {
                "path": {
                    "type": "string",
                    "cache_control": {"type": "ephemeral"}
                }
            },
            "required": ["path"]
        });
        let cleaned = clean_schema(schema);
        assert!(cleaned.get("$schema").is_none());
        assert!(cleaned.get("additionalProperties").is_none());
        assert!(cleaned.get("cache_control").is_none());
        assert!(cleaned["properties"]["path"].get("cache_control").is_none());
        assert_eq!(cleaned["properties"]["path"]["type"], "string");
        assert_eq!(cleaned["required"], json!(["path"]));
    }

    // ===== Responses API 转换测试 =====

    #[test]
    fn test_anthropic_to_responses_basic() {
        let anthropic = json!({
            "model": "gpt-5",
            "max_tokens": 4096,
            "system": "You are helpful.",
            "messages": [{"role": "user", "content": "Hello"}]
        });
        let result = anthropic_to_responses(anthropic).unwrap();
        assert_eq!(result["model"], "gpt-5");
        assert_eq!(result["instructions"], "You are helpful.");
        assert_eq!(result["max_output_tokens"], 4096);
        let input = result["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "Hello");
    }

    #[test]
    fn test_anthropic_to_responses_tools_and_reasoning() {
        let anthropic = json!({
            "model": "gpt-5",
            "max_tokens": 1024,
            "thinking": {"type": "enabled", "budget_tokens": 20000},
            "messages": [{"role": "user", "content": "test"}],
            "tools": [{
                "name": "read_file",
                "description": "Read a file",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}
            }],
            "tool_choice": {"type": "any"}
        });
        let result = anthropic_to_responses(anthropic).unwrap();
        assert_eq!(result["reasoning"]["effort"], "high");
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "read_file");
        assert_eq!(
            tools[0]["parameters"]["properties"]["path"]["type"],
            "string"
        );
        assert_eq!(result["tool_choice"], "required");
    }

    #[test]
    fn test_anthropic_to_responses_tool_use_and_result() {
        let anthropic = json!({
            "model": "gpt-5",
            "max_tokens": 1024,
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "/a"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "file body"}
                ]}
            ]
        });
        let result = anthropic_to_responses(anthropic).unwrap();
        let input = result["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[0]["name"], "read_file");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[1]["output"], "file body");
    }

    #[test]
    fn test_responses_to_anthropic_text_and_reasoning() {
        let resp = json!({
            "id": "resp_1",
            "model": "gpt-5",
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking..."}]},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "Hello there!"}
                ]}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });
        let result = responses_to_anthropic(resp).unwrap();
        assert_eq!(result["type"], "message");
        assert_eq!(result["stop_reason"], "end_turn");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "thinking...");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "Hello there!");
        assert_eq!(result["usage"]["input_tokens"], 10);
        assert_eq!(result["usage"]["output_tokens"], 5);
    }

    #[test]
    fn test_responses_to_anthropic_function_call() {
        let resp = json!({
            "id": "resp_2",
            "model": "gpt-5",
            "output": [
                {"type": "function_call", "call_id": "call_9", "name": "read_file",
                 "arguments": "{\"path\":\"/test.txt\"}"}
            ],
            "usage": {"input_tokens": 20, "output_tokens": 30}
        });
        let result = responses_to_anthropic(resp).unwrap();
        assert_eq!(result["stop_reason"], "tool_use");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "tool_use");
        assert_eq!(content[0]["id"], "call_9");
        assert_eq!(content[0]["name"], "read_file");
        assert_eq!(content[0]["input"]["path"], "/test.txt");
    }
}
