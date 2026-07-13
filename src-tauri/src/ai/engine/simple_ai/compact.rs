/*! 手动上下文压缩（Phase 1）

自动压缩已禁用。本模块提供 `compact_history()` 供手动调用（如 tauri command），
将指定区间替换为摘要 user 消息。失败时**不修改**消息历史，返回错误。

设计要点：
- `select_compact_range` 接收 `bootstrap_end` 参数，压缩区间从 bootstrap 之后开始，
  保护 system prompt / environment_context / AGENTS.md / Skill 索引不被压缩。
- `compact_history` 失败时返回 `AppError::ProcessError`，不删除任何消息。
- `fallback_drop_oldest` 已删除（Phase 0 决策：不自动删除历史）。
- `request_summary` / `extract_summary_text` 保留供手动调用复用。
*/

use serde_json::{json, Value};

use crate::ai::engine::simple_ai_protocol::{self, WireProtocol};
use crate::error::{AppError, Result};

use super::retry;

/// 压缩请求超时（秒）。摘要请求应比对话快。
const COMPACT_TIMEOUT_SECS: u64 = 60;

/// 选取待压缩区间 `[start, end)`：
/// - `start = bootstrap_end`（跳过 system / 环境上下文 / 项目指令 / Skill 索引）；
/// - `end` = 最近一条 `user` 之前，且不切断 `assistant(tool_calls) → tool` 配对
///   （若 end-1 是 tool，回退到 tool 序列前的 assistant）。
/// 返回 None 表示历史太短不宜压缩。
pub(super) fn select_compact_range(messages: &[Value], bootstrap_end: usize) -> Option<(usize, usize)> {
    let start = bootstrap_end;
    // 至少 bootstrap + 2 turn（user/assistant/user/assistant）才有压缩价值。
    if messages.len() < start.saturating_add(3) {
        return None;
    }
    // 从尾向前找最后一条 role=="user" 的消息（index >= start）。
    let last_user = messages
        .iter()
        .enumerate()
        .rev()
        .find(|(i, m)| *i >= start && m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .map(|(i, _)| i);
    let Some(last_user) = last_user else {
        return None;
    };
let mut end = last_user;
    // 回退到 tool 配对边界之前：end 之前若是 tool，说明 tool 序列开头有 assistant(tool_calls)，
    // 切断会破坏配对，故 end 回退到该 assistant 之前。
    while end > start && messages[end - 1].get("role").and_then(|r| r.as_str()) == Some("tool") {
        end -= 1;
    }
    // 同理，end-1 若是带 tool_calls 的 assistant（无后续 tool 但有 tool_calls 字段）也回退。
    if end > start {
        let prev = &messages[end - 1];
        if prev.get("role").and_then(|r| r.as_str()) == Some("assistant")
            && prev.get("tool_calls").is_some()
        {
            end -= 1;
        }
    }
    if end <= start {
        return None;
    }
    Some((start, end))
}

/// 交接摘要指令（仿 codex compact prompt 语义）。
const COMPACT_INSTRUCTION: &str = "You are compacting a conversation history. Summarize the \
following messages into a concise handoff summary: key decisions, established facts, file paths \
touched, outstanding errors, and the current task state. Reply with ONLY the summary, no preamble.";

/// 发起非流式摘要请求，返回 summary 文本。
async fn request_summary(
    profile: &crate::models::config::ModelProfile,
    history_text: &str,
) -> Result<String> {
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    let messages = vec![
        json!({ "role": "system", "content": COMPACT_INSTRUCTION }),
        json!({ "role": "user", "content": history_text }),
    ];
    let mut body = simple_ai_protocol::build_request_body(protocol, &profile.model, &messages, &[]);
    // 非流式：去掉 stream/tools 相关字段。
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), json!(false));
        obj.remove("stream_options");
        obj.remove("tools");
        obj.remove("tool_choice");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(COMPACT_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;
    let url = protocol.build_url(&profile.base_url);
    let mut req = client.post(&url).header("Content-Type", "application/json");
    for (k, v) in protocol.auth_headers(&profile.api_key) {
        req = req.header(k, v);
    }
    if let Some(headers) = &profile.custom_headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let req = req.body(body.to_string());
    // 摘要请求也走重试（2 次，基数 500ms）。
    let response = retry::send_with_retry(req, 2, 500).await?;
    let json: Value = response
        .json()
        .await
        .map_err(|e| AppError::ProcessError(format!("parse compact response: {}", e)))?;
    extract_summary_text(protocol, &json)
}

/// 从非流式响应提取 summary 文本（三协议）。
fn extract_summary_text(protocol: WireProtocol, json: &Value) -> Result<String> {
    match protocol {
        WireProtocol::OpenAIChat => {
            let text = json
                .pointer("/choices/0/message/content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(text.to_string())
        }
        WireProtocol::Anthropic => {
            // content[] 中的 text block 拼接。
            if let Some(arr) = json.get("content").and_then(|v| v.as_array()) {
                let mut s = String::new();
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            s.push_str(t);
                        }
                    }
                }
                if !s.is_empty() {
                    return Ok(s);
                }
            }
            Err(AppError::ProcessError(
                "anthropic compact response missing text content".to_string(),
            ))
        }
        WireProtocol::Responses => {
            // output[] 中找 message item 的 content[].text 拼接。
            if let Some(arr) = json.get("output").and_then(|v| v.as_array()) {
                let mut s = String::new();
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("message") {
                        if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                            for block in content {
                                if block.get("type").and_then(|t| t.as_str()) == Some("output_text")
                                    || block.get("type").and_then(|t| t.as_str()) == Some("text")
                                {
                                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                        s.push_str(t);
                                    }
                                }
                            }
                        }
                    }
                }
                if !s.is_empty() {
                    return Ok(s);
                }
            }
            Err(AppError::ProcessError(
                "responses compact response missing output text".to_string(),
            ))
        }
    }
}

/// 手动压缩历史：把 `[start, end)` 区间替换为单条 summary user 消息。
/// 失败时不修改消息历史，返回错误。
///
/// `bootstrap_end` 是系统提示词、环境上下文、项目指令、Skill 索引的结束索引，
/// 压缩区间从该索引之后开始，保护 bootstrap 内容不被压缩。
pub(super) async fn compact_history(
    messages: &mut Vec<Value>,
    bootstrap_end: usize,
    profile: &crate::models::config::ModelProfile,
) -> Result<()> {
    tracing::info!(
        "[SimpleAI] 手动压缩上下文，bootstrap_end={}, total_messages={}",
        bootstrap_end,
        messages.len()
    );

    let (start, end) = match select_compact_range(messages, bootstrap_end) {
        Some(r) => r,
        None => {
            return Err(AppError::ProcessError(
                "历史太短，无法压缩（bootstrap 之后至少需要 2 个完整回合）".to_string(),
            ));
        }
    };

    // 序列化待压缩区间为文本。
    let history_text = messages[start..end]
        .iter()
        .map(|m| {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("?");
            let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
            format!("[{}]: {}", role, content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let summary = request_summary(profile, &history_text)
        .await
        .map_err(|e| {
            tracing::error!("[SimpleAI] 摘要请求失败：{}", e);
            AppError::ProcessError(format!("上下文压缩失败：{}", e))
        })?;

    if summary.trim().is_empty() {
        return Err(AppError::ProcessError(
            "上下文压缩失败：摘要请求返回空响应".to_string(),
        ));
    }

    let compressed_count = end - start;
    messages.drain(start..end);
    messages.insert(
        start,
        json!({ "role": "user", "content": format!("[compacted summary]\n{}", summary.trim()) }),
    );
    tracing::info!(
        "[SimpleAI] 上下文已压缩：{} 条消息 → 1 条 summary",
        compressed_count
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_range_returns_none_for_short_history() {
        let msgs = vec![json!({"role":"system","content":"s"})];
        assert!(select_compact_range(&msgs, 1).is_none());
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u"}),
        ];
        assert!(select_compact_range(&msgs, 1).is_none());
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
        ];
        assert!(select_compact_range(&msgs, 1).is_none()); // 无末尾 user
    }

    #[test]
    fn select_range_returns_some_for_long_history() {
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
        ];
        let (start, end) = select_compact_range(&msgs, 1).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 3); // [1,3) = u1, a1
    }

    #[test]
    fn select_range_respects_bootstrap_end() {
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"env_context"}),
            json!({"role":"user","content":"project_instructions"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
        ];
        let (start, end) = select_compact_range(&msgs, 3).unwrap();
        assert_eq!(start, 3); // 从 bootstrap_end=3 开始，不压缩 env_context/project_instructions
        assert_eq!(end, 5); // [3,5) = u1, a1
    }

    #[test]
    fn select_range_avoids_splitting_tool_pairs() {
        // assistant(tool_calls) + tool + user → end 应回退到 assistant 之前。
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"x"}]}),
            json!({"role":"tool","content":"r"}),
            json!({"role":"user","content":"u2"}),
        ];
        let (start, end) = select_compact_range(&msgs, 1).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 2); // [1,2) = u1，不含 assistant(tool_calls)+tool
    }

    #[test]
    fn extract_summary_openai_chat() {
        let json = json!({
            "choices": [{ "message": { "content": "summary text" } }]
        });
        let s = extract_summary_text(WireProtocol::OpenAIChat, &json).unwrap();
        assert_eq!(s, "summary text");
    }

    #[test]
    fn extract_summary_anthropic_concatenates_text_blocks() {
        let json = json!({
            "content": [
                { "type": "text", "text": "part1 " },
                { "type": "text", "text": "part2" }
            ]
        });
        let s = extract_summary_text(WireProtocol::Anthropic, &json).unwrap();
        assert_eq!(s, "part1 part2");
    }

    #[test]
    fn extract_summary_responses_picks_output_text() {
        let json = json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "resp summary" }
                    ]
                }
            ]
        });
        let s = extract_summary_text(WireProtocol::Responses, &json).unwrap();
        assert_eq!(s, "resp summary");
    }
}
