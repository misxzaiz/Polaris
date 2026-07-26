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

    // 修复孤儿 tool_use:claude code 在 Stop 中断时会话状态损坏(见
    // GitHub issue #8004 werdnum 评论、#7380、#10693),会发出缺 tool_result
    // 的 assistant(tool_use)。Anthropic/GLM 上游校验「每个 tool_use 必须紧跟
    // tool_result」失败返回 400。本代理在出口扫描配对,把孤儿 tool_use 降级
    // 为 text 摘要,让请求能继续——这是 claude code 自身修不干净(旧 transcript
    // / hooks / rewound timeline)时 Polaris 的网关层防线。
    repair_orphan_tool_use(&mut body);

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

/// 修复孤儿 tool_use:把缺对应 tool_result 的 tool_use block 降级为 text 摘要。
///
/// Anthropic 协议要求 assistant(tool_use) 后紧跟 user(tool_result),且每个
/// tool_use 的 id 必须有对应的 tool_use_id。claude code 中断/分叉场景会留下
/// 没配对的 tool_use,导致上游 400。本函数扫描 messages 配对关系,把孤儿
/// tool_use 转成 text(与 server_tool_use 净化思路一致),并在 assistant content
/// 因移除全部 tool_use 而变空时补一个提示性 text block(Anthropic 不接受空 content)。
///
/// 不处理反向损坏(孤儿 tool_result,见 #10693)与连续同角色消息(见 #8004 knail1
/// 评论)——前者划 P2,后者划 P1。本函数专注「assistant 有 tool_use 但后续无
/// tool_result」这一最常见根因。
fn repair_orphan_tool_use(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };

    // 第 1 遍:统计每个 tool_use id 出现次数与 tool_result 配对次数。
    // Anthropic 要求严格配对:若 assistant 有 2 个同 id 的 tool_use 但只有 1 个
    // tool_result,则第 2 个 tool_use 是孤儿。用计数保证只保留可配对的前 N 个。
    let mut tool_use_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut tool_result_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for msg in messages.iter() {
        let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
            continue;
        };
        for b in blocks {
            let btype = b.get("type").and_then(Value::as_str).unwrap_or("");
            match btype {
                "tool_use" => {
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        *tool_use_count.entry(id.to_string()).or_insert(0) += 1;
                    }
                }
                "tool_result" => {
                    if let Some(id) = b.get("tool_use_id").and_then(Value::as_str) {
                        *tool_result_count.entry(id.to_string()).or_insert(0) += 1;
                    }
                }
                _ => {}
            }
        }
    }

    // 第 2 遍:改写 assistant content。对每个 tool_use,按出现顺序判定是否配对:
    // 前 `tool_result_count[id]` 个保留,之后的降级为 text。
    let mut consumed: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for msg in messages.iter_mut() {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "assistant" {
            continue;
        }
        let Some(blocks) = msg.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };

        let mut new_blocks: Vec<Value> = Vec::with_capacity(blocks.len());
        let mut changed = false;
        for b in blocks.iter() {
            if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                let id = b.get("id").and_then(Value::as_str).unwrap_or("");
                let seen = consumed.entry(id.to_string()).or_insert(0);
                *seen += 1;
                let paired = tool_result_count.get(id).copied().unwrap_or(0);
                if *seen <= paired {
                    // 有配对,保留
                    new_blocks.push(b.clone());
                } else {
                    // 孤儿:降级为 text 摘要(与 server_tool_use 净化思路一致)
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("unknown");
                    let input_json = b
                        .get("input")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    let summary = format!(
                        "[tool_use interrupted - auto-patched by Polaris proxy]\nname: {}\nid: {}\ninput: {}",
                        name, id, truncate_chars(&input_json, 500)
                    );
                    new_blocks.push(json!({ "type": "text", "text": summary }));
                    changed = true;
                }
            } else {
                new_blocks.push(b.clone());
            }
        }

        if changed {
            // 防御性兜底:移除孤儿 tool_use 后若 content 为空(理论上不会,至少有替换
            // 出的 text),补一个提示 text(Anthropic 不接受空 content 数组)。
            if new_blocks.is_empty() {
                new_blocks.push(json!({
                    "type": "text",
                    "text": "[assistant turn had only orphan tool_use - auto-patched by Polaris proxy]"
                }));
            }
            *blocks = new_blocks;
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

    // ============================================================
    // P0:孤儿 tool_use 修复测试
    //
    // 场景:claude code Stop 中断后留下 assistant(tool_use) 但无 tool_result,
    // 上游校验失败返回 400。Polaris 在 sanitize 出口把孤儿 tool_use 降级为
    // text 摘要,让请求能继续。
    // ============================================================

    #[test]
    fn repairs_orphan_tool_use_by_converting_to_text() {
        // assistant 有 tool_use(toolu_orphan)但后续 user 无 tool_result
        let body = json!({
            "messages": [
                {"role": "user", "content": "list files"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "I'll run bash."},
                    {"type": "tool_use", "id": "toolu_orphan", "name": "bash",
                     "input": {"command": "ls"}}
                ]},
                {"role": "user", "content": "continue"}
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        let assistant_blocks = sanitized["messages"][1]["content"].as_array().unwrap();
        // 第 1 个 block 是原 text,保留
        assert_eq!(assistant_blocks[0]["type"], "text");
        assert_eq!(assistant_blocks[0]["text"].as_str().unwrap(), "I'll run bash.");
        // 第 2 个 block 由 tool_use 降级为 text,含中断提示
        assert_eq!(assistant_blocks[1]["type"], "text");
        let patched = assistant_blocks[1]["text"].as_str().unwrap();
        assert!(patched.contains("tool_use interrupted"));
        assert!(patched.contains("bash"));
        assert!(patched.contains("toolu_orphan"));
    }

    #[test]
    fn preserves_paired_tool_use_tool_result() {
        // 正常配对:tool_use + tool_result,不应被改
        let body = json!({
            "messages": [
                {"role": "user", "content": "list files"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_ok", "name": "bash",
                     "input": {"command": "ls"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_ok", "content": "file1\nfile2"}
                ]}
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        assert_eq!(sanitized["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(sanitized["messages"][1]["content"][0]["id"], "toolu_ok");
        assert_eq!(sanitized["messages"][2]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn repairs_only_orphan_when_partial_pair_exists() {
        // 同一 id 出现 2 次但只有 1 个 tool_result:第 2 个 tool_use 是孤儿
        let body = json!({
            "messages": [
                {"role": "user", "content": "run twice"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_x", "name": "bash", "input": {"command": "ls"}},
                    {"type": "tool_use", "id": "toolu_x", "name": "bash", "input": {"command": "pwd"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_x", "content": "out1"}
                ]}
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        let blocks = sanitized["messages"][1]["content"].as_array().unwrap();
        // 第 1 个 tool_use 保留(配对消费了唯一的 tool_result)
        assert_eq!(blocks[0]["type"], "tool_use");
        // 第 2 个 tool_use 降级为 text(孤儿)
        assert_eq!(blocks[1]["type"], "text");
        assert!(blocks[1]["text"].as_str().unwrap().contains("tool_use interrupted"));
    }

    #[test]
    fn repairs_assistant_with_only_orphan_tool_use() {
        // assistant content 全是 tool_use 且无 tool_result:全部降级,至少留一个 text
        let body = json!({
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_a", "name": "bash", "input": {}}
                ]},
                {"role": "user", "content": "more"}
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        let blocks = sanitized["messages"][1]["content"].as_array().unwrap();
        // 不为空,且为 text 类型
        assert!(!blocks.is_empty());
        assert_eq!(blocks[0]["type"], "text");
        assert!(blocks[0]["text"].as_str().unwrap().contains("tool_use interrupted"));
    }

    #[test]
    fn leaves_string_content_untouched() {
        // content 是字符串(旧格式)而非数组:repair 不应崩溃,直接跳过
        let body = json!({
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "I will help."}
            ]
        });

        let sanitized =
            sanitize_anthropic_messages_body(body, AnthropicProviderCapability::default());

        // content 仍是字符串,未被改
        assert_eq!(sanitized["messages"][1]["content"].as_str().unwrap(), "I will help.");
    }
}
