/*! Simple AI 历史裁剪
 *
 * 借鉴 codex `tools/src/response_history.rs` 的「assistant 输出 token 预算截断」思路，
 * 在每轮请求前对历史中超长的 assistant 文本输出做逐条截断，零额外 API 调用，
 * 缓解长会话撑爆上下文窗口。
 *
 * 与 codex 的关键差异（务必保持）：codex 的 `retain_tail_from_last_n_user_messages`
 * 会**删消息**；SimpleAI **不采用** —— 历史含 `assistant.tool_calls` 与 `role:"tool"`
 * 的配对消息，且默认走 Anthropic 协议要求 user/assistant 严格交替，删消息会破坏
 * 配对/交替导致 API 报错。故本模块只**逐条截断 assistant 文本**：不增删消息、不改顺序、
 * 不触碰 tool_calls 字段、不动 user/tool/system，结构零风险。
 */

use serde_json::Value;

/// 粗略 token 估算：约 4 字符/token（与 codex `approx_token_count` 同量级）。
/// 中文等多字节字符按字符数计，实际 token 通常更多，作为保守截断阈值足够。
pub(super) fn approx_token_count(text: &str) -> usize {
    // 手写向上取整除法（不用 usize::div_ceil 以兼容较旧的 Rust 工具链）。
    (text.chars().count() + 3) / 4
}

/// 将历史中超过 `per_msg_token_cap` 的 assistant 文本输出逐条截断，保留头部并加标注。
///
/// 仅处理 `role == "assistant"` 且 `content` 为字符串者；不增删消息、不改顺序、
/// 不触碰 `tool_calls` 字段，也不动 user / tool / system 消息。
pub(super) fn truncate_history_assistant_outputs(messages: &mut [Value], per_msg_token_cap: usize) {
    if per_msg_token_cap == 0 {
        return;
    }
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        // content 为 null（仅 tool_calls）或非字符串：跳过，避免破坏结构。
        let Some(text) = msg.get("content").and_then(Value::as_str) else {
            continue;
        };
        if approx_token_count(text) <= per_msg_token_cap {
            continue;
        }
        let truncated = truncate_to_token_cap(text, per_msg_token_cap);
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("content".to_string(), Value::String(truncated));
        }
    }
}

/// 按 token 上限截断文本，保留头部并追加标注（标注风格对齐 `tools::truncate_chars`）。
fn truncate_to_token_cap(text: &str, token_cap: usize) -> String {
    let char_cap = token_cap.saturating_mul(4);
    let head: String = text.chars().take(char_cap).collect();
    format!(
        "{head}\n... (truncated history output, total {} bytes)",
        text.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approx_token_count_is_chars_over_four_rounded_up() {
        assert_eq!(approx_token_count(""), 0);
        assert_eq!(approx_token_count("abcd"), 1);
        assert_eq!(approx_token_count("abcde"), 2);
    }

    #[test]
    fn short_assistant_output_is_kept() {
        let mut msgs = vec![json!({ "role": "assistant", "content": "short reply" })];
        truncate_history_assistant_outputs(&mut msgs, 100);
        assert_eq!(msgs[0]["content"], json!("short reply"));
    }

    #[test]
    fn long_assistant_output_is_truncated_with_head_and_marker() {
        let long = "x".repeat(1000);
        let mut msgs = vec![json!({ "role": "assistant", "content": long.clone() })];
        // cap 10 token => 40 字符头部。
        truncate_history_assistant_outputs(&mut msgs, 10);
        let out = msgs[0]["content"].as_str().unwrap();
        assert!(out.starts_with(&"x".repeat(40)));
        assert!(out.contains("truncated"));
        assert!(out.len() < long.len());
    }

    #[test]
    fn non_assistant_messages_are_untouched() {
        let long = "y".repeat(1000);
        let mut msgs = vec![
            json!({ "role": "system", "content": long.clone() }),
            json!({ "role": "user", "content": long.clone() }),
            json!({ "role": "tool", "tool_call_id": "1", "content": long.clone() }),
        ];
        truncate_history_assistant_outputs(&mut msgs, 1);
        assert_eq!(msgs[0]["content"], json!(long));
        assert_eq!(msgs[1]["content"], json!(long));
        assert_eq!(msgs[2]["content"], json!(long));
    }

    #[test]
    fn assistant_tool_calls_field_is_preserved() {
        let long = "z".repeat(1000);
        let mut msgs = vec![json!({
            "role": "assistant",
            "content": long,
            "tool_calls": [{ "id": "a", "function": { "name": "bash", "arguments": "{}" } }]
        })];
        truncate_history_assistant_outputs(&mut msgs, 1);
        assert!(msgs[0]["content"].as_str().unwrap().contains("truncated"));
        assert_eq!(msgs[0]["tool_calls"][0]["id"], json!("a"));
        assert_eq!(msgs[0]["tool_calls"][0]["function"]["name"], json!("bash"));
    }

    #[test]
    fn assistant_with_null_content_is_skipped() {
        let mut msgs = vec![json!({
            "role": "assistant",
            "content": Value::Null,
            "tool_calls": [{ "id": "a" }]
        })];
        truncate_history_assistant_outputs(&mut msgs, 1);
        assert_eq!(msgs[0]["content"], Value::Null);
    }
}
