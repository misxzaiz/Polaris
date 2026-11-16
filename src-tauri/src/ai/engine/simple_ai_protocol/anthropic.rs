//! build_anthropic_body（K-R1 拆分）

use super::request::{thinking_budget_for_effort, DEFAULT_MAX_TOKENS, CACHE_BREAKPOINT_LIMIT};
use super::tools::tools_for_protocol;
use super::wire::WireProtocol;
use serde_json::{json, Value};
pub fn build_anthropic_body(
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
    max_tokens: Option<u64>,
    effort: Option<&str>,
) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        system_parts.push(text.to_string());
                    }
                }
            }
            "tool" => {
                let tool_use_id = msg
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                });
                // 合并到上一条 user 消息（若存在），否则新建 user turn。
                if let Some(last) = out.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            arr.push(block);
                            continue;
                        }
                    }
                }
                out.push(json!({ "role": "user", "content": [block] }));
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
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
                            "input": input,
                        }));
                    }
                }
                // Anthropic 不接受空 content，回退一个空文本 block。
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            _ => {
                // user：content 透传；但 Anthropic 要求 user/assistant 严格交替，而 SimpleAI
                // 首轮会注入 environment_context + 项目指令 + 用户消息（连续多条 user）。
                // 故合并相邻 user 消息：字符串直接拼接；若上一条 user 的 content 已是数组
                // （如 tool_result block），则把本条文本作为 text block 追加进去。
                let content = msg.get("content").cloned().unwrap_or_else(|| json!(""));
                if let Some(text) = content.as_str() {
                    if let Some(last) = out.last_mut() {
                        if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                            if let Some(last_content) = last.get_mut("content") {
                                if let Some(prev) = last_content.as_str() {
                                    *last_content = json!(format!("{}\n\n{}", prev, text));
                                    continue;
                                }
                                if let Some(arr) = last_content.as_array_mut() {
                                    arr.push(json!({ "type": "text", "text": text }));
                                    continue;
                                }
                            }
                        }
                    }
                }
                out.push(json!({ "role": "user", "content": content }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": out,
        "stream": true,
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }
    let tools = tools_for_protocol(WireProtocol::Anthropic, openai_tools);
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    // effort → thinking 块（Anthropic Messages 协议：显式开启思考并给出 token 预算）。
    if let Some(e) = effort {
        if !e.is_empty() {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": thinking_budget_for_effort(e),
            });
        }
    }
    body
}
