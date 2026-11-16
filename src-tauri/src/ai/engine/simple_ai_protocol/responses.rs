//! build_responses_body（K-R1 拆分）

use super::request::DEFAULT_MAX_TOKENS;
use super::tools::tools_for_protocol;
use super::wire::WireProtocol;
use serde_json::{json, Value};
pub fn build_responses_body(
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
    max_tokens: Option<u64>,
    effort: Option<&str>,
) -> Value {
    let mut instructions_parts: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        instructions_parts.push(text.to_string());
                    }
                }
            }
            "tool" => {
                let call_id = msg
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let output = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }));
            }
            "assistant" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        input.push(json!({ "role": "assistant", "content": text }));
                    }
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = tc
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let args = tc
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": args,
                        }));
                    }
                }
            }
            _ => {
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                input.push(json!({ "role": "user", "content": content }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "input": input,
        "max_output_tokens": max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
    });
    if !instructions_parts.is_empty() {
        body["instructions"] = json!(instructions_parts.join("\n\n"));
    }
    let tools = tools_for_protocol(WireProtocol::Responses, openai_tools);
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    // effort → reasoning 块（OpenAI Responses 协议：reasoning.effort）。
    if let Some(e) = effort {
        if !e.is_empty() {
            body["reasoning"] = json!({ "effort": e });
        }
    }
    body
}