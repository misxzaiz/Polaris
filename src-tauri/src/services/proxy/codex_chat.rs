//! Codex Responses ↔ OpenAI Chat Completions 转换
//!
//! Codex CLI 新版本偏向使用 OpenAI Responses API。部分第三方供应商只提供
//! OpenAI Chat Completions 端点。本模块用于本地代理接收 Codex `/v1/responses`
//! 请求后，转换并转发到上游 `/v1/chat/completions`，再把响应转换回 Codex
//! 可消费的 Responses 形态。

use serde_json::{json, Value};

use super::error::ProxyError;

/// Codex Responses 请求 → OpenAI Chat Completions 请求。
pub fn codex_responses_to_chat(body: Value) -> Result<Value, ProxyError> {
    let mut result = json!({});

    if let Some(model) = body.get("model").and_then(|v| v.as_str()) {
        result["model"] = json!(model);
    }

    let mut messages = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(|v| v.as_str()) {
        if !instructions.is_empty() {
            messages.push(json!({"role": "system", "content": instructions}));
        }
    }

    convert_responses_input_to_chat_messages(body.get("input"), &mut messages);
    if messages.is_empty() {
        messages.push(json!({"role": "user", "content": ""}));
    }
    result["messages"] = json!(messages);

    if let Some(v) = body.get("max_output_tokens") {
        result["max_tokens"] = v.clone();
    }
    copy_if_present(&body, &mut result, "temperature");
    copy_if_present(&body, &mut result, "top_p");
    copy_if_present(&body, &mut result, "frequency_penalty");
    copy_if_present(&body, &mut result, "presence_penalty");
    copy_if_present(&body, &mut result, "metadata");
    copy_if_present(&body, &mut result, "parallel_tool_calls");
    copy_if_present(&body, &mut result, "response_format");
    copy_if_present(&body, &mut result, "service_tier");
    copy_if_present(&body, &mut result, "stream_options");

    if let Some(stream) = body.get("stream") {
        result["stream"] = stream.clone();
    }

    if let Some(reasoning) = body.get("reasoning") {
        if let Some(effort) = reasoning.get("effort").and_then(|v| v.as_str()) {
            result["reasoning_effort"] = json!(effort);
        }
    }

    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let chat_tools: Vec<Value> = tools
            .iter()
            .filter_map(responses_tool_to_chat_tool)
            .collect();
        if !chat_tools.is_empty() {
            result["tools"] = json!(chat_tools);
        }
    }

    if let Some(tool_choice) = body.get("tool_choice") {
        result["tool_choice"] = responses_tool_choice_to_chat(tool_choice);
    } else if result.get("tools").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
        // 当 Codex 发送了 tools 但没有指定 tool_choice 时，
        // 默认设为 "auto"，让模型自主决定是否调用工具。
        // 某些上游 API 需要显式设置 tool_choice 才会触发工具调用。
        result["tool_choice"] = json!("auto");
    }

    Ok(result)
}

/// OpenAI Chat Completions 非流式响应 → OpenAI Responses 响应。
pub fn chat_to_codex_response(body: Value) -> Result<Value, ProxyError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("resp_polaris")
        .to_string();
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let mut output = Vec::new();
    let mut status = "completed";
    let mut incomplete_details = Value::Null;

    if let Some(choice) = body.get("choices").and_then(|v| v.as_array()).and_then(|v| v.first()) {
        if let Some(message) = choice.get("message") {
            if let Some(content) = message.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    output.push(json!({
                        "type": "message",
                        "id": format!("msg_{}", safe_suffix(&id)),
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": content}]
                    }));
                }
            } else if let Some(reasoning) = message.get("reasoning").and_then(|v| v.as_str()) {
                if !reasoning.is_empty() {
                    output.push(json!({
                        "type": "message",
                        "id": format!("msg_{}", safe_suffix(&id)),
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": reasoning}]
                    }));
                }
            } else if let Some(reasoning_content) = message.get("reasoning_content").and_then(|v| v.as_str()) {
                // DeepSeek 系列模型将回复内容放在 reasoning_content 而非 content
                if !reasoning_content.is_empty() {
                    output.push(json!({
                        "type": "message",
                        "id": format!("msg_{}", safe_suffix(&id)),
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": reasoning_content}]
                    }));
                }
            }

            if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
                for call in tool_calls {
                    if let Some(item) = chat_tool_call_to_response_item(call) {
                        output.push(item);
                    }
                }
            }
        }

        match choice.get("finish_reason").and_then(|v| v.as_str()) {
            Some("length") => {
                status = "incomplete";
                incomplete_details = json!({"reason": "max_output_tokens"});
            }
            Some("tool_calls") => {
                // 当模型返回 tool_calls 时，将 response 状态设为 "in_progress"
                // 让 Codex 知道需要先执行工具，后续还有工具结果需要处理。
                status = "in_progress";
            }
            _ => {}
        }
    }

    if output.is_empty() {
        output.push(json!({
            "type": "message",
            "id": format!("msg_{}", safe_suffix(&id)),
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": ""}]
        }));
    }

    let usage = chat_usage_to_responses_usage(body.get("usage"));
    let mut response = json!({
        "id": id,
        "object": "response",
        "created_at": current_unix_timestamp(),
        "status": status,
        "model": model,
        "output": output,
        "usage": usage
    });

    if !incomplete_details.is_null() {
        response["incomplete_details"] = incomplete_details;
    }

    Ok(response)
}

/// OpenAI Chat Completions SSE → OpenAI Responses SSE。
///
/// 将上游 Chat Completions 流式 SSE 转换为 Responses API 格式，
/// 支持 text delta、reasoning delta 和 tool_calls delta 的完整转换。
/// 工具调用会作为独立的 function_call output item 发出。
pub fn chat_sse_to_codex_responses_sse(body_str: &str) -> String {
    let mut response_id = String::from("resp_polaris_stream");
    let mut model = String::from("unknown");
    let mut sequence = 0_u64;
    let mut output_index_started = false;
    let mut completed = false;
    let mut usage = json!({"input_tokens": 0, "output_tokens": 0, "total_tokens": 0});
    let mut sse = String::new();
    // 累积所有 delta 文本，用于结尾的 output_item.done 事件。
    let mut accumulated_text = String::new();

    // 工具调用累积器：tool_call_delta_index → {id, name, arguments}
    // 使用 Response API 的 output_index 体系，每个 function_call 是一个独立 output item。
    let mut tool_call_accumulators: std::collections::HashMap<u32, ToolCallAccum> =
        std::collections::HashMap::new();
    // 已发出 output_item.added 事件的 function_call output_index
    let mut tool_call_started: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // 下一个可用的 output_index（0 留给 message，工具调用从 1 开始）
    let mut next_tool_output_index: u32 = 1;
    // 工具调用内部的 delta index → output_index 映射
    let mut tool_index_to_output: std::collections::HashMap<u32, u32> =
        std::collections::HashMap::new();

    for line in body_str.lines() {
        let Some(data) = line.strip_prefix("data: ").map(str::trim) else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }

        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            continue;
        };

        if let Some(id) = chunk.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                response_id = id.to_string();
            }
        }
        if let Some(m) = chunk.get("model").and_then(|v| v.as_str()) {
            if !m.is_empty() {
                model = m.to_string();
            }
        }
        if let Some(u) = chunk.get("usage") {
            usage = chat_usage_to_responses_usage(Some(u));
        }

        if !output_index_started {
            emit_response_event(
                &mut sse,
                "response.created",
                json!({
                    "type": "response.created",
                    "sequence_number": sequence,
                    "response": response_shell(&response_id, &model, "in_progress", usage.clone())
                }),
            );
            sequence += 1;
            emit_response_event(
                &mut sse,
                "response.in_progress",
                json!({
                    "type": "response.in_progress",
                    "sequence_number": sequence,
                    "response": response_shell(&response_id, &model, "in_progress", usage.clone())
                }),
            );
            sequence += 1;
            emit_response_event(
                &mut sse,
                "response.output_item.added",
                json!({
                    "type": "response.output_item.added",
                    "sequence_number": sequence,
                    "output_index": 0,
                    "item": {
                        "id": format!("msg_{}", safe_suffix(&response_id)),
                        "type": "message",
                        "status": "in_progress",
                        "role": "assistant",
                        "content": []
                    }
                }),
            );
            sequence += 1;
            emit_response_event(
                &mut sse,
                "response.content_part.added",
                json!({
                    "type": "response.content_part.added",
                    "sequence_number": sequence,
                    "item_id": format!("msg_{}", safe_suffix(&response_id)),
                    "output_index": 0,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": ""}
                }),
            );
            sequence += 1;
            output_index_started = true;
        }

        let Some(choice) = chunk.get("choices").and_then(|v| v.as_array()).and_then(|v| v.first()) else {
            continue;
        };

        // 记录上游 chunk 原始内容供调试
        let has_content = choice.pointer("/delta/content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_some();
        let has_reasoning = choice.pointer("/delta/reasoning").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_some();
        let has_reasoning_content = choice.pointer("/delta/reasoning_content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_some();
        let has_tool_calls = choice.pointer("/delta/tool_calls").and_then(|v| v.as_array()).filter(|a| !a.is_empty()).is_some();

        if !has_content && (has_reasoning || has_reasoning_content) && !has_tool_calls {
            let text = choice.pointer("/delta/reasoning").and_then(|v| v.as_str())
                .or_else(|| choice.pointer("/delta/reasoning_content").and_then(|v| v.as_str()))
                .unwrap_or("");
            tracing::info!("[CodexSSE] 上游无 delta.content，降级提取 reasoning/reasoning_content: {:?}", text);
        }

        // 提取输出文本：优先 content，降级 reasoning（sensenova-6.7），再降级 reasoning_content（deepseek-v4）
        let output_text = choice.pointer("/delta/content")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| choice.pointer("/delta/reasoning").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
            .or_else(|| choice.pointer("/delta/reasoning_content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()));

        if let Some(text) = output_text {
            if !text.is_empty() {
                accumulated_text.push_str(text);
                emit_response_event(
                    &mut sse,
                    "response.output_text.delta",
                    json!({
                        "type": "response.output_text.delta",
                        "sequence_number": sequence,
                        "item_id": format!("msg_{}", safe_suffix(&response_id)),
                        "output_index": 0,
                        "content_index": 0,
                        "delta": text
                    }),
                );
                sequence += 1;
            }
        }

        // === 处理工具调用 delta（tool_calls）===
        // 上游 Chat Completions 流式返回的 tool_calls delta 需要转换为
        // Responses API 的 function_call 事件序列：
        //   output_item.added (type: function_call) → function_call_arguments.delta → output_item.done
        if let Some(tool_calls) = choice.pointer("/delta/tool_calls").and_then(|v| v.as_array()) {
            for tc_delta in tool_calls {
                let tc_index = tc_delta.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let output_index = *tool_index_to_output.entry(tc_index).or_insert_with(|| {
                    let idx = next_tool_output_index;
                    next_tool_output_index += 1;
                    idx
                });

                let entry = tool_call_accumulators.entry(output_index).or_insert_with(|| ToolCallAccum {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });

                if let Some(id) = tc_delta.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        entry.id = id.to_string();
                    }
                }
                if let Some(name) = tc_delta.pointer("/function/name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        entry.name = name.to_string();
                    }
                }
                if let Some(args) = tc_delta.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    if !args.is_empty() {
                        entry.arguments.push_str(args);
                    }
                }

                // 发出 output_item.added 事件（仅首次）
                if !tool_call_started.contains(&output_index) {
                    let call_id = tc_delta.get("id").and_then(|v| v.as_str()).unwrap_or("call_polaris");
                    let name = tc_delta.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("unknown");
                    emit_response_event(
                        &mut sse,
                        "response.output_item.added",
                        json!({
                            "type": "response.output_item.added",
                            "sequence_number": sequence,
                            "output_index": output_index,
                            "item": {
                                "id": format!("fc_{}", safe_suffix(&response_id)),
                                "type": "function_call",
                                "status": "in_progress",
                                "call_id": call_id,
                                "name": name,
                                "arguments": ""
                            }
                        }),
                    );
                    sequence += 1;
                    tool_call_started.insert(output_index);
                }

                // 发出 arguments delta
                if let Some(args) = tc_delta.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    if !args.is_empty() {
                        emit_response_event(
                            &mut sse,
                            "response.function_call_arguments.delta",
                            json!({
                                "type": "response.function_call_arguments.delta",
                                "sequence_number": sequence,
                                "item_id": format!("fc_{}", safe_suffix(&response_id)),
                                "output_index": output_index,
                                "delta": args
                            }),
                        );
                        sequence += 1;
                    }
                }
            }
        }

        // 处理 finish_reason
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            if !fr.is_empty() {
                if fr == "tool_calls" {
                    // tool_calls finish_reason 表示模型决定调用工具，但 turn 尚未完成
                    // Codex 需要先执行工具再继续
                    completed = false;
                } else {
                    completed = true;
                }
            }
        }
    }

    // --- 结束事件 ---
    if !output_index_started {
        emit_response_event(
            &mut sse,
            "response.created",
            json!({
                "type": "response.created",
                "sequence_number": sequence,
                "response": response_shell(&response_id, &model, "in_progress", usage.clone())
            }),
        );
        sequence += 1;
        output_index_started = true;
    }

    // 关闭消息 output_item
    if output_index_started {
        emit_response_event(
            &mut sse,
            "response.content_part.done",
            json!({
                "type": "response.content_part.done",
                "sequence_number": sequence,
                "item_id": format!("msg_{}", safe_suffix(&response_id)),
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": accumulated_text}
            }),
        );
        sequence += 1;
        emit_response_event(
            &mut sse,
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "sequence_number": sequence,
                "output_index": 0,
                "item": {
                    "id": format!("msg_{}", safe_suffix(&response_id)),
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": accumulated_text}]
                }
            }),
        );
        sequence += 1;
    }

    // 关闭所有工具调用 output_item
    let mut sorted_output_indices: Vec<u32> = tool_call_accumulators.keys().copied().collect();
    sorted_output_indices.sort();
    for output_index in &sorted_output_indices {
        if let Some(tc) = tool_call_accumulators.get(output_index) {
            let call_id = if tc.id.is_empty() { "call_polaris" } else { &tc.id };
            let name = if tc.name.is_empty() { "unknown" } else { &tc.name };
            let arguments = if tc.arguments.is_empty() { "{}" } else { &tc.arguments };
            emit_response_event(
                &mut sse,
                "response.output_item.done",
                json!({
                    "type": "response.output_item.done",
                    "sequence_number": sequence,
                    "output_index": output_index,
                    "item": {
                        "id": format!("fc_{}", safe_suffix(&response_id)),
                        "type": "function_call",
                        "status": "completed",
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments
                    }
                }),
            );
            sequence += 1;
        }
    }

    // 如果模型调用了工具，response 状态用 "in_progress" 而非 "completed"
    // 因为 Codex 需要先执行工具再完成 turn
    let has_tool_calls = !tool_call_accumulators.is_empty();
    let response_status = if completed && !has_tool_calls { "completed" } else if has_tool_calls { "in_progress" } else { "completed" };

    emit_response_event(
        &mut sse,
        "response.completed",
        json!({
            "type": "response.completed",
            "sequence_number": sequence,
            "response": response_shell(&response_id, &model, response_status, usage)
        }),
    );
    sse.push_str("data: [DONE]\n\n");
    sse
}

fn convert_responses_input_to_chat_messages(input: Option<&Value>, messages: &mut Vec<Value>) {
    match input {
        Some(Value::String(text)) => {
            messages.push(json!({"role": "user", "content": text}));
        }
        Some(Value::Array(items)) => {
            for item in items {
                convert_responses_input_item(item, messages);
            }
        }
        Some(Value::Object(_)) => convert_responses_input_item(input.unwrap(), messages),
        _ => {}
    }
}

fn convert_responses_input_item(item: &Value, messages: &mut Vec<Value>) {
    let item_type = item.get("type").and_then(|v| v.as_str());
    match item_type {
        Some("message") | None => {
            let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
            // Codex Responses API 使用 "developer" 角色，但 Chat Completions API
            // 仅支持 "system" / "user" / "assistant" / "tool"。映射 developer → system。
            let chat_role = match role {
                "developer" => "system",
                other => other,
            };
            let content = item.get("content");
            messages.push(json!({
                "role": chat_role,
                "content": responses_content_to_chat_content(content)
            }));
        }
        Some("function_call") => {
            let call_id = item
                .get("call_id")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("id").and_then(|v| v.as_str()))
                .unwrap_or("call_polaris");
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = item
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            messages.push(json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments}
                }]
            }));
        }
        Some("function_call_output") => {
            let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            let output = item.get("output").and_then(|v| v.as_str()).unwrap_or("");
            messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
        }
        _ => {}
    }
}

fn responses_content_to_chat_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => json!(text),
        Some(Value::Array(parts)) => {
            let mut chat_parts = Vec::new();
            for part in parts {
                match part.get("type").and_then(|v| v.as_str()) {
                    Some("input_text") | Some("output_text") => {
                        chat_parts.push(json!({
                            "type": "text",
                            "text": part.get("text").and_then(|v| v.as_str()).unwrap_or("")
                        }));
                    }
                    Some("input_image") => {
                        if let Some(url) = part
                            .get("image_url")
                            .and_then(|v| v.as_str())
                            .or_else(|| part.pointer("/image_url/url").and_then(|v| v.as_str()))
                        {
                            chat_parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
                        }
                    }
                    _ => {}
                }
            }
            if chat_parts.len() == 1 && chat_parts[0].get("type").and_then(|v| v.as_str()) == Some("text") {
                chat_parts[0].get("text").cloned().unwrap_or(json!(""))
            } else {
                json!(chat_parts)
            }
        }
        _ => json!(""),
    }
}

fn responses_tool_to_chat_tool(tool: &Value) -> Option<Value> {
    match tool.get("type").and_then(|v| v.as_str()) {
        Some("function") => Some(json!({
            "type": "function",
            "function": {
                "name": tool.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "description": tool.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}}))
            }
        })),
        Some("custom") => Some(json!({
            "type": "function",
            "function": {
                "name": tool.get("name").and_then(|v| v.as_str()).unwrap_or("custom_tool"),
                "description": tool.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "parameters": tool.get("input_schema").or_else(|| tool.get("parameters")).cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}}))
            }
        })),
        _ => None,
    }
}

fn responses_tool_choice_to_chat(tool_choice: &Value) -> Value {
    match tool_choice {
        Value::String(s) => match s.as_str() {
            "required" => json!("required"),
            "none" => json!("none"),
            _ => json!("auto"),
        },
        Value::Object(obj) => {
            if obj.get("type").and_then(|v| v.as_str()) == Some("function") {
                json!({"type": "function", "function": {"name": obj.get("name").and_then(|v| v.as_str()).unwrap_or("")}})
            } else {
                json!("auto")
            }
        }
        _ => json!("auto"),
    }
}

fn chat_tool_call_to_response_item(call: &Value) -> Option<Value> {
    let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("call_polaris");
    let function = call.get("function")?;
    Some(json!({
        "type": "function_call",
        "id": id,
        "call_id": id,
        "name": function.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "arguments": function.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}"),
        "status": "completed"
    }))
}

fn chat_usage_to_responses_usage(usage: Option<&Value>) -> Value {
    let input = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    json!({"input_tokens": input, "output_tokens": output, "total_tokens": input + output})
}

fn copy_if_present(from: &Value, to: &mut Value, key: &str) {
    if let Some(v) = from.get(key) {
        to[key] = v.clone();
    }
}

fn response_shell(id: &str, model: &str, status: &str, usage: Value) -> Value {
    json!({
        "id": id,
        "object": "response",
        "created_at": current_unix_timestamp(),
        "status": status,
        "model": model,
        "output": [],
        "usage": usage
    })
}

fn emit_response_event(sse: &mut String, event: &str, data: Value) {
    sse.push_str("event: ");
    sse.push_str(event);
    sse.push_str("\n");
    sse.push_str("data: ");
    sse.push_str(&serde_json::to_string(&data).unwrap_or_default());
    sse.push_str("\n\n");
}

fn safe_suffix(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>()
}

fn current_unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 工具调用累积器（用于 SSE 流式转换中的 tool_calls delta 累积）
#[derive(Debug, Default, Clone)]
struct ToolCallAccum {
    id: String,
    name: String,
    arguments: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_basic_responses_request_to_chat() {
        let result = codex_responses_to_chat(json!({
            "model": "gpt-5.5",
            "instructions": "Be concise.",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
            "max_output_tokens": 16,
            "stream": true
        }))
        .unwrap();

        assert_eq!(result["model"], "gpt-5.5");
        assert_eq!(result["max_tokens"], 16);
        assert_eq!(result["stream"], true);
        let messages = result["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hi");
    }

    #[test]
    fn converts_chat_response_to_responses() {
        let result = chat_to_codex_response(json!({
            "id": "chatcmpl_1",
            "model": "gpt-5.5",
            "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}
        }))
        .unwrap();

        assert_eq!(result["id"], "chatcmpl_1");
        assert_eq!(result["model"], "gpt-5.5");
        assert_eq!(result["status"], "completed");
        assert_eq!(result["output"][0]["content"][0]["text"], "OK");
        assert_eq!(result["usage"]["input_tokens"], 2);
        assert_eq!(result["usage"]["output_tokens"], 1);
    }

    #[test]
    fn converts_chat_sse_to_responses_sse() {
        let input = concat!(
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"content\":\"O\"}}]}\n",
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"content\":\"K\"},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n"
        );
        let output = chat_sse_to_codex_responses_sse(input);
        assert!(output.contains("response.created"));
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("\"delta\":\"O\""));
        assert!(output.contains("\"delta\":\"K\""));
        assert!(output.contains("response.completed"));
        // output_item.done 必须携带累积文本，否则 Codex 显示空消息
        assert!(output.contains("\"text\":\"OK\""));
    }

    #[test]
    fn sse_accumulates_reasoning_when_no_content() {
        // Sensenova / DeepSeek 把回复放在 delta.reasoning / delta.reasoning_content
        let input = concat!(
            "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"reasoning\":\"hel\"}}]}\n",
            "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"reasoning_content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n"
        );
        let output = chat_sse_to_codex_responses_sse(input);
        assert!(output.contains("\"delta\":\"hel\""));
        assert!(output.contains("\"delta\":\"lo\""));
        // 累积文本应出现在结尾事件中
        assert!(output.contains("\"text\":\"hello\""));
    }

    #[test]
    fn sse_converts_tool_call_delta_to_function_call_events() {
        // 模拟上游 Chat Completions 流式返回 tool_calls
        let input = concat!(
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"content\":\"I'll check\"}}]}\n",
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"content\":\" the files.\\n\\n\"}}]}\n",
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"com\"}}]}}]}\n",
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"mand\\\":\\\"ls\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: [DONE]\n"
        );
        let output = chat_sse_to_codex_responses_sse(input);

        // 文本 delta 应正常传递
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("\"delta\":\"I'll check\""));
        assert!(output.contains("the files."));

        // 应该有 function_call output_item.added 事件
        assert!(output.contains("function_call_added") || output.contains("\"type\":\"function_call\""),
            "输出应包含 function_call 类型的 output_item: {}", output);

        // 应该有 function_call_arguments.delta 事件
        assert!(output.contains("function_call_arguments.delta"),
            "输出应包含 function_call_arguments.delta 事件: {:?}", &output[..output.len().min(200)]);

        // 应该有 function_call 的 output_item.done 事件
        assert!(output.contains("\"arguments\":\"{\\\"com\\\""),
            "arguments delta 应包含累积的参数: {:?}", &output[..output.len().min(200)]);

        // tool_calls 的 finish_reason 应让 response 状态为 in_progress
        assert!(output.contains("response.completed"));
    }

    #[test]
    fn non_streaming_handles_tool_calls_response() {
        let result = chat_to_codex_response(json!({
            "id": "chatcmpl_tc1",
            "model": "gpt-5.5",
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "bash", "arguments": "{\"command\":\"ls\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        })).unwrap();

        // 状态应为 in_progress（工具调用需要执行）
        assert_eq!(result["status"], "in_progress",
            "工具调用响应状态应为 in_progress，实际: {}", result["status"]);

        // 输出列表应包含 function_call 项
        let output = result["output"].as_array().unwrap();
        let has_function_call = output.iter().any(|item|
            item.get("type").and_then(|v| v.as_str()) == Some("function_call")
        );
        assert!(has_function_call, "输出应包含 function_call: {:?}", output);

        // 函数调用应有正确的名称和参数
        let fc = output.iter().find(|item|
            item.get("type").and_then(|v| v.as_str()) == Some("function_call")
        ).unwrap();
        assert_eq!(fc["name"], "bash");
        assert!(fc["arguments"].as_str().unwrap_or("").contains("ls"));
    }

    #[test]
    fn codex_responses_request_adds_tool_choice_auto_when_omitted() {
        let result = codex_responses_to_chat(json!({
            "model": "test-model",
            "input": [{"role": "user", "content": "hi"}],
            "tools": [{"type": "function", "name": "bash", "description": "run cmd", "parameters": {"type": "object"}}]
        })).unwrap();

        assert!(result.get("tools").is_some(), "tools 应被传递");
        assert_eq!(result["tool_choice"], "auto",
            "未指定 tool_choice 时有 tools 应默认 auto, 实际: {:?}", result["tool_choice"]);
    }
}
