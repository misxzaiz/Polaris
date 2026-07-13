/*! Codex JSONL 事件解析器
 *
 * 将 `codex exec --json` 输出的 JSONL 事件转换为统一的 AIEvent。
 *
 * Codex JSONL 事件类型：
 * - `thread.started`    → { thread_id }
 * - `turn.started`      → (无额外数据)
 * - `item.started`      → { item: { id, type, command?, status } }
 * - `item.completed`    → { item: { id, type, text?, command?, aggregated_output?, exit_code?, status?, message? } }
 * - `turn.completed`    → { usage: { input_tokens, output_tokens, ... } }
 */

use crate::models::{AIEvent, ToolCallEndEvent, ToolCallStartEvent};
use std::collections::HashMap;

/// Codex JSONL 事件
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type")]
pub enum CodexEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted { thread_id: String },

    #[serde(rename = "turn.started")]
    TurnStarted,

    #[serde(rename = "item.started")]
    ItemStarted { item: CodexItem },

    #[serde(rename = "item.completed")]
    ItemCompleted { item: CodexItem },

    #[serde(rename = "turn.completed")]
    TurnCompleted { usage: Option<CodexUsage> },

    #[serde(rename = "turn.failed")]
    TurnFailed { error: Option<CodexTurnError> },

    #[serde(rename = "item.updated")]
    ItemUpdated { item: CodexItem },

    /// Top-level stream error (distinct from item.type = "error")
    #[serde(rename = "error")]
    StreamError { message: Option<String> },

    /// Unknown event type (forward compat + debug)
    #[serde(other)]
    Unknown,
}

/// Codex 项目（工具调用或消息）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CodexItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub aggregated_output: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// Codex 用量统计
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CodexUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub reasoning_output_tokens: u64,
}

/// Codex turn error (from turn.failed event)
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CodexTurnError {
    #[serde(default)]
    pub message: Option<String>,
}

/// Extract top-level "type" field value from JSON string (without full deserialization).
pub fn extract_event_type(json: &str) -> Option<&str> {
    let marker = r#""type":"#;
    let pos = json.find(marker)?;
    let rest = json[pos + marker.len()..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let value = &rest[1..];
    let end = value.find('"')?;
    Some(&value[..end])
}

/// 解析一行 Codex JSONL 输出
pub fn parse_codex_line(line: &str) -> Option<CodexEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 跳过非 JSON 行（如 stderr 错误信息、token 统计等）
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// 将 CodexEvent 转换为 Vec<AIEvent>
///
/// `session_id`: 当前会话 ID（可能是临时 ID）
pub fn codex_event_to_ai_events(event: CodexEvent, session_id: &str) -> Vec<AIEvent> {
    match event {
        CodexEvent::ThreadStarted { .. } => {
            // thread_id 的更新由 CodexEngine 在上层处理
            // 此处不生成 AIEvent，因为 session_start 由引擎层发出
            vec![]
        }

        CodexEvent::TurnStarted => {
            vec![AIEvent::progress(session_id, "处理中...")]
        }

        CodexEvent::ItemStarted { item } => match item.item_type.as_str() {
            "command_execution" => {
                let mut args = HashMap::new();
                if let Some(cmd) = item.command {
                    args.insert("command".to_string(), serde_json::Value::String(cmd));
                }
                vec![AIEvent::ToolCallStart(
                    ToolCallStartEvent::new(session_id, "shell".to_string(), args)
                        .with_call_id(item.id),
                )]
            }
            _ => vec![],
        },

        CodexEvent::ItemCompleted { item } => {
            match item.item_type.as_str() {
                "agent_message" => {
                    // AI 文本回复
                    let text = item.text.unwrap_or_default();
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![AIEvent::assistant_message(session_id, text, false)]
                    }
                }
                "command_execution" => {
                    // 工具调用完成
                    let success = item.exit_code.map(|c| c == 0).unwrap_or(true);

                    let mut result_map = serde_json::Map::new();
                    if let Some(ref out) = item.aggregated_output {
                        result_map
                            .insert("output".to_string(), serde_json::Value::String(out.clone()));
                    }
                    if let Some(code) = item.exit_code {
                        result_map.insert(
                            "exit_code".to_string(),
                            serde_json::Value::Number(code.into()),
                        );
                    }

                    let end_event = ToolCallEndEvent::new(session_id, "shell".to_string(), success)
                        .with_call_id(item.id)
                        .with_result(serde_json::Value::Object(result_map));

                    vec![AIEvent::ToolCallEnd(end_event)]
                }
                "error" => {
                    let msg = item
                        .message
                        .or(item.text)
                        .unwrap_or_else(|| "Unknown error".to_string());
                    // item.completed 级别的 error 是 Codex 的诊断消息（如模型元数据缺失、
                    // 配置项废弃告警），不是会话失败信号——真正的失败走 turn.failed / 顶层
                    // StreamError 分支。统一降级为非终止的 progress，避免误杀正常完成的会话。
                    tracing::warn!("[CodexParser] item error（非致命，降级为 progress）: {}", msg);
                    vec![AIEvent::progress(session_id, format!("Codex: {}", msg))]
                }
                _ => vec![],
            }
        }

        CodexEvent::TurnCompleted { usage } => {
            if let Some(u) = usage {
                tracing::info!(
                    "[CodexParser] 用量: input={}, cached={}, output={}, reasoning={}",
                    u.input_tokens,
                    u.cached_input_tokens,
                    u.output_tokens,
                    u.reasoning_output_tokens
                );
            }
            vec![AIEvent::session_end(session_id)]
        }

        CodexEvent::TurnFailed { error } => {
            let msg = error
                .and_then(|e| e.message)
                .unwrap_or_else(|| "Turn failed".to_string());
            tracing::warn!("[CodexParser] turn.failed: {}", msg);
            // Generate error + session_end so frontend exits streaming state
            vec![
                AIEvent::error(session_id, msg),
                AIEvent::session_end(session_id),
            ]
        }

        CodexEvent::ItemUpdated { item } => {
            // item.updated is used for todo_list, mcp_tool_call progress, etc.
            // Do not treat command_execution updates as starts: Codex can emit multiple updates
            // for one item, and start/end pairing is driven by item.started/item.completed.
            match item.item_type.as_str() {
                "command_execution" => vec![],
                _ => vec![],
            }
        }

        CodexEvent::StreamError { message } => {
            let msg = message.unwrap_or_else(|| "Stream error".to_string());
            tracing::warn!("[CodexParser] stream error: {}", msg);
            // Non-fatal reconnect notices should not generate error events
            if msg.contains("Reconnecting") {
                vec![AIEvent::progress(session_id, &msg)]
            } else {
                vec![AIEvent::error(session_id, msg)]
            }
        }

        CodexEvent::Unknown => {
            // Unknown event type — raw line logged in spawn_event_reader
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_thread_started() {
        let json =
            r#"{"type":"thread.started","thread_id":"019dda7a-5ea9-7120-859c-a0f16a24aae7"}"#;
        let event = parse_codex_line(json).unwrap();
        match event {
            CodexEvent::ThreadStarted { thread_id } => {
                assert_eq!(thread_id, "019dda7a-5ea9-7120-859c-a0f16a24aae7");
            }
            _ => panic!("Expected ThreadStarted"),
        }
    }

    #[test]
    fn parse_agent_message() {
        let json = r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello"}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert_eq!(ai_events.len(), 1);
        match &ai_events[0] {
            AIEvent::AssistantMessage(e) => assert_eq!(e.content, "Hello"),
            _ => panic!("Expected AssistantMessage"),
        }
    }

    #[test]
    fn parse_command_execution() {
        let json = r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","ag_output":"file1\nfile2","exit_code":0,"status":"completed"}}"#;
        let event = parse_codex_line(json);
        assert!(event.is_some());
    }

    #[test]
    fn command_execution_start_and_end_use_item_id_as_call_id() {
        let start_json = r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git status","status":"running"}}"#;
        let start_event = parse_codex_line(start_json).unwrap();
        let start_ai_events = codex_event_to_ai_events(start_event, "test-session");
        assert_eq!(start_ai_events.len(), 1);
        match &start_ai_events[0] {
            AIEvent::ToolCallStart(e) => {
                assert_eq!(e.tool, "shell");
                assert_eq!(e.call_id.as_deref(), Some("item_1"));
            }
            _ => panic!("Expected ToolCallStart"),
        }

        let end_json = r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git status","aggregated_output":"clean","exit_code":0,"status":"completed"}}"#;
        let end_event = parse_codex_line(end_json).unwrap();
        let end_ai_events = codex_event_to_ai_events(end_event, "test-session");
        assert_eq!(end_ai_events.len(), 1);
        match &end_ai_events[0] {
            AIEvent::ToolCallEnd(e) => {
                assert_eq!(e.tool, "shell");
                assert_eq!(e.call_id.as_deref(), Some("item_1"));
                assert!(e.success);
            }
            _ => panic!("Expected ToolCallEnd"),
        }
    }

    #[test]
    fn concurrent_command_executions_keep_distinct_call_ids() {
        let events = [
            r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git status","status":"running"}}"#,
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"git log --oneline -5","status":"running"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"git log --oneline -5","aggregated_output":"log","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git status","aggregated_output":"status","exit_code":0,"status":"completed"}}"#,
        ];

        let call_ids: Vec<(String, String)> = events
            .iter()
            .flat_map(|json| {
                let event = parse_codex_line(json).unwrap();
                codex_event_to_ai_events(event, "test-session")
            })
            .map(|event| match event {
                AIEvent::ToolCallStart(e) => ("start".to_string(), e.call_id.unwrap()),
                AIEvent::ToolCallEnd(e) => ("end".to_string(), e.call_id.unwrap()),
                _ => panic!("Expected tool call event"),
            })
            .collect();

        assert_eq!(
            call_ids,
            vec![
                ("start".to_string(), "item_1".to_string()),
                ("start".to_string(), "item_2".to_string()),
                ("end".to_string(), "item_2".to_string()),
                ("end".to_string(), "item_1".to_string()),
            ]
        );
    }

    #[test]
    fn command_execution_update_does_not_create_duplicate_start() {
        let json = r#"{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"git status","status":"running"}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert!(ai_events.is_empty());
    }

    #[test]
    fn parse_turn_completed() {
        let json = r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":10}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert_eq!(ai_events.len(), 1);
        assert!(matches!(&ai_events[0], AIEvent::SessionEnd(_)));
    }

    #[test]
    fn skip_non_json_lines() {
        assert!(parse_codex_line("").is_none());
        assert!(parse_codex_line("some error text").is_none());
        assert!(parse_codex_line("2026-04-29T18:22:32 ERROR ...").is_none());
    }

    #[test]
    fn deprecation_warning_becomes_progress() {
        let json = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].collab` is deprecated. Use `[features].multi_agent` instead."}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert_eq!(ai_events.len(), 1);
        assert!(matches!(&ai_events[0], AIEvent::Progress(_)));
    }

    #[test]
    fn metadata_warning_becomes_progress() {
        // 真实故障用例：自定义 provider + 非官方模型名时 Codex 必发的非致命警告，
        // 曾被误判为致命错误导致会话被终止、后续 agent_message 丢失
        let json = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert_eq!(ai_events.len(), 1);
        match &ai_events[0] {
            AIEvent::Progress(e) => {
                assert!(e.message.as_deref().unwrap_or("").contains("Model metadata"));
            }
            other => panic!("Expected Progress, got {:?}", other),
        }
    }

    #[test]
    fn item_error_never_produces_error_or_session_end() {
        let json = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"anything at all"}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert!(ai_events
            .iter()
            .all(|e| !matches!(e, AIEvent::Error(_) | AIEvent::SessionEnd(_))));
    }

    #[test]
    fn turn_failed_produces_error_and_session_end() {
        let json = r#"{"type":"turn.failed","error":{"message":"boom"}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert_eq!(ai_events.len(), 2);
        match &ai_events[0] {
            AIEvent::Error(e) => assert_eq!(e.error, "boom"),
            other => panic!("Expected Error, got {:?}", other),
        }
        assert!(matches!(&ai_events[1], AIEvent::SessionEnd(_)));
    }

    #[test]
    fn parse_unknown_event_type() {
        // Unknown event type should parse as Unknown, not None
        let json = r#"{"type":"some_future_event","data":"test"}"#;
        let event = parse_codex_line(json);
        assert!(event.is_some());
        assert!(matches!(event.unwrap(), CodexEvent::Unknown));
    }

    #[test]
    fn unknown_event_produces_no_ai_events() {
        let ai_events = codex_event_to_ai_events(CodexEvent::Unknown, "test-session");
        assert!(ai_events.is_empty());
    }

    #[test]
    fn extract_event_type_basic() {
        assert_eq!(
            extract_event_type(r#"{"type":"thread.started","thread_id":"abc"}"#),
            Some("thread.started")
        );
    }

    #[test]
    fn extract_event_type_unknown() {
        assert_eq!(
            extract_event_type(r#"{"type":"agent_message_delta","delta":"x"}"#),
            Some("agent_message_delta")
        );
    }

    #[test]
    fn extract_event_type_missing() {
        assert_eq!(extract_event_type(r#"{"foo":"bar"}"#), None);
    }
}
