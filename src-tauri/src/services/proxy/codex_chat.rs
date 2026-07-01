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

        if choice.get("finish_reason").and_then(|v| v.as_str()) == Some("length") {
            status = "incomplete";
            incomplete_details = json!({"reason": "max_output_tokens"});
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
pub fn chat_sse_to_codex_responses_sse(body_str: &str) -> String {
    let mut response_id = String::from("resp_polaris_stream");
    let mut model = String::from("unknown");
    let mut sequence = 0_u64;
    let mut output_index_started = false;
    let mut completed = false;
    let mut usage = json!({"input_tokens": 0, "output_tokens": 0, "total_tokens": 0});
    let mut sse = String::new();
    // 累积所有 delta 文本，用于结尾的 output_item.done 事件。
    // Codex 把 output_item.done 携带的 text 作为消息最终权威值，
    // 若写空字符串会覆盖 delta 累积的内容，导致前端显示空消息。
    let mut accumulated_text = String::new();

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
        if !has_content && (has_reasoning || has_reasoning_content) {
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
        if choice.get("finish_reason").and_then(|v| v.as_str()).is_some() {
            completed = true;
        }
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
        output_index_started = true;
    }

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

    emit_response_event(
        &mut sse,
        "response.completed",
        json!({
            "type": "response.completed",
            "sequence_number": sequence,
            "response": response_shell(&response_id, &model, if completed { "completed" } else { "completed" }, usage)
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
}
