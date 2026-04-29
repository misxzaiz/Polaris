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

use crate::models::{
    AIEvent, ToolCallEndEvent,
};
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

        CodexEvent::ItemStarted { item } => {
            match item.item_type.as_str() {
                "command_execution" => {
                    let mut args = HashMap::new();
                    if let Some(cmd) = item.command {
                        args.insert("command".to_string(), serde_json::Value::String(cmd));
                    }
                    vec![AIEvent::tool_call_start(session_id, "shell", args)]
                }
                _ => vec![],
            }
        }

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
                        result_map.insert(
                            "output".to_string(),
                            serde_json::Value::String(out.clone()),
                        );
                    }
                    if let Some(code) = item.exit_code {
                        result_map.insert(
                            "exit_code".to_string(),
                            serde_json::Value::Number(code.into()),
                        );
                    }

                    let end_event = ToolCallEndEvent::new(session_id, "shell".to_string(), success)
                        .with_result(serde_json::Value::Object(result_map));

                    vec![AIEvent::ToolCallEnd(end_event)]
                }
                "error" => {
                    let msg = item
                        .message
                        .or(item.text)
                        .unwrap_or_else(|| "Unknown error".to_string());
                    // 过滤掉 Codex 的 deprecation 警告（非致命）
                    if msg.contains("deprecated") || msg.contains("Enable it with") {
                        vec![]
                    } else {
                        vec![AIEvent::error(session_id, msg)]
                    }
                }
                _ => vec![],
            }
        }

        CodexEvent::TurnCompleted { usage } => {
            if let Some(u) = usage {
                tracing::info!(
                    "[CodexParser] 用量: input={}, cached={}, output={}, reasoning={}",
                    u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reasoning_output_tokens
                );
            }
            vec![AIEvent::session_end(session_id)]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_thread_started() {
        let json = r#"{"type":"thread.started","thread_id":"019dda7a-5ea9-7120-859c-a0f16a24aae7"}"#;
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
    fn skip_deprecation_warning() {
        let json = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].collab` is deprecated. Use `[features].multi_agent` instead."}}"#;
        let event = parse_codex_line(json).unwrap();
        let ai_events = codex_event_to_ai_events(event, "test-session");
        assert!(ai_events.is_empty());
    }
}
