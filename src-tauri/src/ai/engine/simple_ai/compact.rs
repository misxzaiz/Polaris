/*! 上下文压缩（Phase 3.3）

累计每轮 `usage.input_tokens`，超过窗口阈值（默认 75%）时把 `system` 之后、
最近一条 `user` 之前的历史连同交接摘要指令发一次**非流式**请求，得 summary
替换被压缩区间。兜底：压缩失败或区间太短 → 移除最早一个完整 turn（user +
assistant + tool*），保留 `system` 与最近上下文。

设计要点：
- 纯逻辑（`should_compact` / `select_compact_range` / `fallback_drop_oldest`）单测覆盖。
- `compact_history` 是 async 胶水：序列化区间 → 请求 summary → 替换 / 兜底。
- 摘要请求复用 `build_request_body` 构造后改 `stream:false`，经 `retry::send_with_retry` 发送。
- 三协议非流式响应解析在 `extract_summary_text`。
 */

use std::sync::Arc;

use serde_json::{json, Value};

use crate::ai::engine::simple_ai_protocol::{self, WireProtocol};
use crate::error::{AppError, Result};
use crate::models::ai_event::ProgressEvent;
use crate::models::AIEvent;

use super::retry;

/// 默认上下文窗口（token）。`SIMPLE_AI_CONTEXT_WINDOW` 可覆盖（决策 §12-5）。
pub(super) const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
/// 触发压缩的阈值比例（累计 input / window）。
const COMPACT_THRESHOLD: f64 = 0.75;
/// 压缩请求超时（秒）。摘要请求应比对话快。
const COMPACT_TIMEOUT_SECS: u64 = 60;

/// 累计每轮 input_tokens。
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct UsageAccumulator {
    pub total_input: u64,
}

impl UsageAccumulator {
    pub fn add(&mut self, input_tokens: u64) {
        self.total_input = self.total_input.saturating_add(input_tokens);
    }
    /// 累计 input 达窗口的 `COMPACT_THRESHOLD` 时触发。
    pub fn should_compact(&self, window: u64) -> bool {
        let threshold = ((window as f64) * COMPACT_THRESHOLD) as u64;
        self.total_input >= threshold
    }
}

/// 选取待压缩区间 `[start, end)`：
/// - `start = 1`（跳过 system）；
/// - `end` = 最近一条 `user` 之前，且不切断 `assistant(tool_calls) → tool` 配对
///   （若 end-1 是 tool，回退到 tool 序列前的 assistant）。
/// 返回 None 表示历史太短不宜压缩。
pub(super) fn select_compact_range(messages: &[Value]) -> Option<(usize, usize)> {
    // 至少 system + 2 turn（user/assistant/user/assistant）才有压缩价值。
    if messages.len() < 4 {
        return None;
    }
    let last_user = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))?;
    if last_user <= 1 {
        return None;
    }
    let mut end = last_user;
    // 回退到 tool 配对边界之前：end 之前若是 tool，说明 tool 序列开头有 assistant(tool_calls)，
    // 切断会破坏配对，故 end 回退到该 assistant 之前。
    while end > 1 && messages[end - 1].get("role").and_then(|r| r.as_str()) == Some("tool") {
        end -= 1;
    }
    // 同理，end-1 若是带 tool_calls 的 assistant（无后续 tool 但有 tool_calls 字段）也回退。
    if end > 1 {
        let prev = &messages[end - 1];
        if prev.get("role").and_then(|r| r.as_str()) == Some("assistant")
            && prev.get("tool_calls").is_some()
        {
            end -= 1;
        }
    }
    if end <= 1 {
        return None;
    }
    Some((1, end))
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

/// 压缩历史：把 `[start, end)` 区间替换为单条 summary user 消息；失败则兜底移除最早 turn。
pub(super) async fn compact_history(
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    session_id: &str,
) -> Result<()> {
    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
        session_id,
        "正在压缩上下文…".to_string(),
    )));

    let (start, end) = match select_compact_range(messages) {
        Some(r) => r,
        None => {
            tracing::warn!("[SimpleAI] 历史太短无法压缩，回退到移除最早 turn");
            fallback_drop_oldest(messages);
            return Ok(());
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

    match request_summary(profile, &history_text).await {
        Ok(summary) if !summary.trim().is_empty() => {
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
        }
        _ => {
            tracing::warn!("[SimpleAI] 上下文压缩失败，回退到移除最早 turn");
            fallback_drop_oldest(messages);
        }
    }
    Ok(())
}

/// 兜底：移除最早一个完整 turn（user + assistant + tool*），保留 system 与后续 turns。
/// 若仅有一个 user turn（移除会丢最近上下文）则不动。
fn fallback_drop_oldest(messages: &mut Vec<Value>) {
    if messages.len() < 3 {
        return;
    }
    // 第一个 user（index >= 1）。
    let first_user = match messages
        .iter()
        .skip(1)
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
    {
        Some(p) => p + 1,
        None => return,
    };
    // 下一个 user（turn 边界）。
    let next_user = messages
        .iter()
        .skip(first_user + 1)
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
    let end = match next_user {
        Some(p) => first_user + 1 + p,
        None => return, // 只有一个 turn，不移除。
    };
    messages.drain(first_user..end);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulator_should_compact_at_threshold() {
        let mut acc = UsageAccumulator::default();
        acc.add(50_000);
        assert!(!acc.should_compact(128_000)); // 50k < 96k
        acc.add(50_000);
        assert!(acc.should_compact(128_000)); // 100k > 96k
    }

    #[test]
    fn accumulator_saturates() {
        let mut acc = UsageAccumulator::default();
        acc.add(u64::MAX);
        acc.add(10);
        assert_eq!(acc.total_input, u64::MAX);
    }

    #[test]
    fn select_range_returns_none_for_short_history() {
        let msgs = vec![json!({"role":"system","content":"s"})];
        assert!(select_compact_range(&msgs).is_none());
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u"}),
        ];
        assert!(select_compact_range(&msgs).is_none());
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
        ];
        assert!(select_compact_range(&msgs).is_none()); // 无末尾 user
    }

    #[test]
    fn select_range_returns_some_for_long_history() {
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
        ];
        let (start, end) = select_compact_range(&msgs).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 3); // [1,3) = u1, a1
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
        let (start, end) = select_compact_range(&msgs).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 2); // [1,2) = u1，不含 assistant(tool_calls)+tool
    }

    #[test]
    fn fallback_drops_oldest_complete_turn() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
            json!({"role":"assistant","content":"a2"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "u2");
    }

    #[test]
    fn fallback_drops_assistant_with_tool_results() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"x"}]}),
            json!({"role":"tool","content":"r"}),
            json!({"role":"user","content":"u2"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "u2");
    }

    #[test]
    fn fallback_preserves_single_turn() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 3); // 不动
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
