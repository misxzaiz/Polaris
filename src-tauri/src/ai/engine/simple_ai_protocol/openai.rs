//! build_openai_chat_body（K-R1 拆分）

use serde_json::{json, Value};
pub fn build_openai_chat_body(
    model: &str,
    messages: &[Value],
    tools: &[Value],
    max_tokens: Option<u64>,
    effort: Option<&str>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        // 请求末包携带 usage（prompt_tokens/completion_tokens/total_tokens）。
        "stream_options": { "include_usage": true },
    });
    // 仅发 max_tokens 不发 max_completion_tokens：兼容网关（ding 实测）认前者，双发有冲突风险。
    if let Some(v) = max_tokens {
        body["max_tokens"] = json!(v);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    // effort → reasoning_effort（OpenAI Chat 协议：o1/o3/gpt-5 系推理模型）。
    if let Some(e) = effort {
        if !e.is_empty() {
            body["reasoning_effort"] = json!(e);
        }
    }
    body
}
