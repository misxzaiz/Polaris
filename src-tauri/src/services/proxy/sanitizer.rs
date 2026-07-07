//! Anthropic request sanitizer for provider-owned content blocks.
//!
//! Some Anthropic-compatible providers only accept client-visible content blocks
//! (`text`, `image`, `thinking`, `tool_use`, `tool_result`). Claude resume
//! history can contain provider-owned blocks such as `server_tool_use` from
//! native web search. Those blocks are useful context but invalid for many
//! third-party endpoints, so the proxy turns them into compact text.

use serde_json::{json, Value};

const SUMMARY_JSON_LIMIT: usize = 2_000;

#[derive(Debug, Clone, Copy, Default)]
pub struct AnthropicProviderCapability {
    pub supports_server_tools: bool,
}

pub fn sanitize_anthropic_messages_body(
    mut body: Value,
    capability: AnthropicProviderCapability,
) -> Value {
    sanitize_system(&mut body);

    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(content) = message.get_mut("content") {
                sanitize_content_value(content, capability);
            }
        }
    }

    body
}

fn sanitize_system(body: &mut Value) {
    if let Some(system) = body.get_mut("system") {
        match system {
            Value::Array(blocks) => {
                let sanitized: Vec<Value> = blocks
                    .iter()
                    .map(|block| match block.get("type").and_then(Value::as_str) {
                        Some("text") => block.clone(),
                        _ => json!({
                            "type": "text",
                            "text": summarize_block(block),
                        }),
                    })
                    .collect();
                *blocks = sanitized;
            }
            Value::String(_) => {}
            other => {
                let summary = summarize_block(other);
                *other = json!(summary);
            }
        }
    }
}

fn sanitize_content_value(content: &mut Value, capability: AnthropicProviderCapability) {
    let Some(blocks) = content.as_array_mut() else {
        return;
    };

    let sanitized: Vec<Value> = blocks
        .iter()
        .map(|block| sanitize_block(block, capability))
        .collect();
    *blocks = sanitized;
}

fn sanitize_block(block: &Value, capability: AnthropicProviderCapability) -> Value {
    let block_type = block.get("type").and_then(Value::as_str).unwrap_or("text");
    match block_type {
        "text" | "image" | "thinking" | "tool_use" | "tool_result" => block.clone(),
        "server_tool_use" | "web_search_tool_result" if capability.supports_server_tools => {
            block.clone()
        }
        "server_tool_use" | "web_search_tool_result" => json!({
            "type": "text",
            "text": summarize_provider_owned_block(block_type, block),
        }),
        _ => {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                json!({ "type": "text", "text": text })
            } else {
                json!({
                    "type": "text",
                    "text": summarize_provider_owned_block(block_type, block),
                })
            }
        }
    }
}

fn summarize_provider_owned_block(block_type: &str, block: &Value) -> String {
    let mut lines = vec![format!(
        "[Provider-owned Anthropic content block converted to text: {block_type}]"
    )];

    for key in ["id", "tool_use_id", "name"] {
        if let Some(value) = block.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                lines.push(format!("{key}: {value}"));
            }
        }
    }

    if let Some(input) = block.get("input") {
        lines.push(format!("input: {}", compact_json(input)));
    }

    if let Some(content) = block.get("content") {
        lines.push(format!("content: {}", summarize_content(content)));
    } else {
        lines.push(format!("raw: {}", compact_json(block)));
    }

    lines.join("\n")
}

fn summarize_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                let title = item.get("title").and_then(Value::as_str);
                let url = item.get("url").and_then(Value::as_str);
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("snippet").and_then(Value::as_str));

                if title.is_some() || url.is_some() || text.is_some() {
                    let mut line = String::new();
                    if let Some(title) = title {
                        line.push_str(title);
                    }
                    if let Some(url) = url {
                        if !line.is_empty() {
                            line.push_str(" - ");
                        }
                        line.push_str(url);
                    }
                    if let Some(text) = text {
                        if !line.is_empty() {
                            line.push_str(": ");
                        }
                        line.push_str(text);
                    }
                    parts.push(line);
                } else {
                    parts.push(compact_json(item));
                }
            }
            parts.join("\n")
        }
        other => compact_json(other),
    }
}

fn summarize_block(block: &Value) -> String {
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    summarize_provider_owned_block(block_type, block)
}

fn compact_json(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    truncate_chars(&raw, SUMMARY_JSON_LIMIT)
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }

    let mut out: String = s.chars().take(max_chars).collect();
    out.push_str("...(truncated)");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_server_tool_use_to_text_when_unsupported() {
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [{
                    "type": "server_tool_use",
                    "id": "srv_1",
                    "name": "web_search",
                    "input": {"query": "Polaris browser"}
                }]
            }]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());
        let block = &sanitized["messages"][0]["content"][0];

        assert_eq!(block["type"], "text");
        let text = block["text"].as_str().unwrap();
        assert!(text.contains("server_tool_use"));
        assert!(text.contains("web_search"));
        assert!(text.contains("Polaris browser"));
    }

    #[test]
    fn converts_web_search_tool_result_to_text_when_unsupported() {
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [{
                    "type": "web_search_tool_result",
                    "tool_use_id": "srv_1",
                    "content": [{
                        "type": "web_search_result",
                        "title": "Result title",
                        "url": "https://example.com",
                        "text": "Result text"
                    }]
                }]
            }]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());
        let block = &sanitized["messages"][0]["content"][0];

        assert_eq!(block["type"], "text");
        let text = block["text"].as_str().unwrap();
        assert!(text.contains("web_search_tool_result"));
        assert!(text.contains("Result title"));
        assert!(text.contains("https://example.com"));
    }

    #[test]
    fn preserves_client_tool_blocks() {
        let body = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "browser",
                        "input": {"action": "context"}
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "ok"
                    }]
                }
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        assert_eq!(sanitized["messages"][0]["content"][0]["type"], "tool_use");
        assert_eq!(
            sanitized["messages"][1]["content"][0]["type"],
            "tool_result"
        );
    }

    #[test]
    fn preserves_server_tool_blocks_when_supported() {
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [{
                    "type": "server_tool_use",
                    "id": "srv_1",
                    "name": "web_search"
                }]
            }]
        });

        let sanitized = sanitize_anthropic_messages_body(
            body,
            AnthropicProviderCapability {
                supports_server_tools: true,
            },
        );

        assert_eq!(
            sanitized["messages"][0]["content"][0]["type"],
            "server_tool_use"
        );
    }
}
