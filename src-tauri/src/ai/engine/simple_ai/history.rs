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

/// 清洗历史末尾不完整的工具调用轮次（孤儿 `assistant.tool_calls` / 无配对结果的 tool）。
///
/// 中断可能发生在工具执行循环的任意检查点（见 chat_loop.rs 的 abort 提前退出），
/// 此时历史末尾可能残留两类不完整状态，若原样随历史重发会被 API 拒绝：
/// - `assistant(tool_calls)` 消息而无对应 `role:"tool"` 结果：
///   OpenAI Chat / Responses 报 400；Anthropic 的 `tool_use` block 也要求配对 `tool_result`；
/// - 同批次多个 tool_call 只执行了一部分：末尾出现 `[assistant(tool_calls a,b), tool(a)]`，
///   缺失 b 的结果，同样违反配对约束。
///
/// 规则（仅操作尾部，中间已配对消息一律不动）：
/// 1. 若末尾是 `role:"tool"`，连同其前的 `assistant(tool_calls)` 一并回退删除（该批未执行完）；
/// 2. 若末尾是孤立 `assistant(tool_calls)`，有文本 content 则降级为纯文本消息，
///    否则整条删除；
/// 3. 重复以上两步直至尾部不再是「孤立的 tool / tool_calls」。
/// 该清洗保证中断后可继续对话（continue_session 复用历史时不会触发协议 400）。
pub(super) fn sanitize_tool_pairs(messages: &mut Vec<Value>) {
    loop {
        let len = messages.len();
        if len == 0 {
            return;
        }
        let last = &messages[len - 1];
        let last_role = last.get("role").and_then(Value::as_str).unwrap_or("");

        if last_role == "tool" {
            // 末尾 tool 无配对（或配对批次未执行完）：连同其前最近的 assistant(tool_calls) 一起删。
            messages.pop();
            if let Some(prev) = messages.last() {
                if prev.get("role").and_then(Value::as_str) == Some("assistant")
                    && prev.get("tool_calls").is_some()
                {
                    messages.pop();
                }
            }
            continue;
        }

        if last_role == "assistant" && last.get("tool_calls").is_some() {
            // 孤立 assistant(tool_calls)：保留文本内容（若有），移除 tool_calls 降级为纯文本。
            if last.get("content").and_then(Value::as_str).map_or(false, |t| !t.is_empty()) {
                if let Some(obj) = messages[len - 1].as_object_mut() {
                    obj.remove("tool_calls");
                }
            } else {
                messages.pop();
            }
            continue;
        }

        // 尾部已是正常消息（user / 纯文本 assistant / 其他），清洗完成。
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn orphan_tool_calls_assistant(id: &str) -> Value {
        json!({
            "role": "assistant",
            "content": Value::Null,
            "tool_calls": [{ "id": id, "function": { "name": "bash", "arguments": "{}" } }]
        })
    }

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

    #[test]
    fn sanitize_removes_orphan_tool_calls_assistant_at_end() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            orphan_tool_calls_assistant("a"),
        ];
        sanitize_tool_pairs(&mut msgs);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], json!("user"));
    }

    #[test]
    fn sanitize_downgrades_orphan_assistant_with_text_to_plain_text() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({
                "role": "assistant",
                "content": "I will check",
                "tool_calls": [{ "id": "a", "function": { "name": "bash", "arguments": "{}" } }]
            }),
        ];
        sanitize_tool_pairs(&mut msgs);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["role"], json!("assistant"));
        assert!(msgs[1].get("tool_calls").is_none());
        assert_eq!(msgs[1]["content"], json!("I will check"));
    }

    #[test]
    fn sanitize_keeps_paired_tool_messages() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            orphan_tool_calls_assistant("a"),
            json!({ "role": "tool", "tool_call_id": "a", "content": "ok" }),
            json!({ "role": "assistant", "content": "done" }),
        ];
        sanitize_tool_pairs(&mut msgs);
        assert_eq!(msgs.len(), 4);
    }

    #[test]
    fn sanitize_only_affects_tail_not_middle() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            orphan_tool_calls_assistant("a"),
            json!({ "role": "tool", "tool_call_id": "a", "content": "ok" }),
            orphan_tool_calls_assistant("b"),
        ];
        sanitize_tool_pairs(&mut msgs);
        // 末尾孤儿 b 被移除，a 的配对保持完整
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], json!("tool"));
        assert_eq!(msgs[2]["tool_call_id"], json!("a"));
    }

    #[test]
    fn sanitize_multiple_orphans_at_tail() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            orphan_tool_calls_assistant("a"),
            json!({ "role": "tool", "tool_call_id": "a", "content": "ok" }),
            orphan_tool_calls_assistant("b"),
            orphan_tool_calls_assistant("c"),
        ];
        sanitize_tool_pairs(&mut msgs);
        // b、c 均为末尾孤儿，全部移除；a 的配对完整保留
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], json!("tool"));
        assert_eq!(msgs[2]["tool_call_id"], json!("a"));
    }

    #[test]
    fn sanitize_removes_partially_executed_batch() {
        // 同批次两个 tool_call，仅 a 执行完（有 tool 结果），b 的结果缺失。
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [
                    { "id": "a", "function": { "name": "bash", "arguments": "{}" } },
                    { "id": "b", "function": { "name": "bash", "arguments": "{}" } }
                ]
            }),
            json!({ "role": "tool", "tool_call_id": "a", "content": "ok" }),
        ];
        sanitize_tool_pairs(&mut msgs);
        // 不完整的批次整体移除，避免缺失 b 结果的 400
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], json!("user"));
    }

    #[test]
    fn sanitize_is_idempotent_on_clean_history() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            orphan_tool_calls_assistant("a"),
            json!({ "role": "tool", "tool_call_id": "a", "content": "ok" }),
            json!({ "role": "assistant", "content": "done" }),
        ];
        let snapshot = msgs.clone();
        sanitize_tool_pairs(&mut msgs);
        sanitize_tool_pairs(&mut msgs);
        sanitize_tool_pairs(&mut msgs);
        assert_eq!(msgs, snapshot);
    }
}