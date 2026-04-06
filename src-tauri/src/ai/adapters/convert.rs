/*! claw-code 类型转换适配层
 *
 * 提供 Polaris AI 模块类型与 claw-code 类型之间的双向转换。
 */

use super::claw_code_types::{
    ContentBlockDelta, InputContentBlock, InputMessage, StreamEvent, OutputContentBlock,
};
use crate::ai::traits::HistoryEntry;
use crate::models::{AIEvent, ToolCallStartEvent, ThinkingEvent};

/// 将 Polaris HistoryEntry 转换为 claw-code InputMessage
///
/// HistoryEntry 是简单文本消息，转换为 InputMessage 时使用单一 Text 内容块。
pub fn history_entry_to_input_message(entry: &HistoryEntry) -> InputMessage {
    InputMessage {
        role: entry.role.clone(),
        content: vec![InputContentBlock::Text {
            text: entry.content.clone(),
        }],
    }
}

/// 将多个 HistoryEntry 转换为 InputMessage 列表
pub fn history_entries_to_input_messages(entries: &[HistoryEntry]) -> Vec<InputMessage> {
    entries.iter().map(history_entry_to_input_message).collect()
}

/// 将 claw-code StreamEvent 转换为 Polaris AIEvent
///
/// 转换 Anthropic API 流式事件到 Polaris 统一事件格式。
/// 需要 session_id 参数用于事件路由。
///
/// # 返回值
/// - Some(AIEvent): 成功转换的事件
/// - None: 事件无需转换（如 MessageStart 不产生用户可见事件）
pub fn stream_event_to_ai_event(event: &StreamEvent, session_id: &str) -> Option<AIEvent> {
    match event {
        // 消息开始事件 - 不产生用户可见事件，仅用于内部状态
        StreamEvent::MessageStart(_) => None,

        // 消息增量事件 - 包含 stop_reason 和 usage
        // 在消息结束时可能产生 Result 事件（如果需要）
        StreamEvent::MessageDelta(_) => None,

        // 内容块开始 - 可能是工具调用开始
        StreamEvent::ContentBlockStart(e) => {
            match &e.content_block {
                OutputContentBlock::ToolUse { id, name, input } => {
                    // 工具调用开始
                    let args = input.as_object()
                        .map(|obj| obj.iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect())
                        .unwrap_or_default();
                    Some(AIEvent::ToolCallStart(
                        ToolCallStartEvent::new(session_id, name.clone(), args)
                            .with_call_id(id.clone())
                    ))
                }
                OutputContentBlock::Text { .. } => None,
                OutputContentBlock::Thinking { .. } => None,
                OutputContentBlock::RedactedThinking { .. } => None,
            }
        }

        // 内容块增量 - 文本、工具输入 JSON、思考内容
        StreamEvent::ContentBlockDelta(e) => {
            match &e.delta {
                ContentBlockDelta::TextDelta { text } => {
                    // 文本增量
                    Some(AIEvent::token(session_id, text.clone()))
                }
                ContentBlockDelta::InputJsonDelta { .. } => None,
                ContentBlockDelta::ThinkingDelta { thinking } => {
                    // 思考过程增量
                    Some(AIEvent::Thinking(ThinkingEvent::new(session_id, thinking.clone())))
                }
                ContentBlockDelta::SignatureDelta { .. } => None,
            }
        }

        // 内容块结束 - 工具调用完成时产生 ToolCallEnd
        StreamEvent::ContentBlockStop(_) => None,

        // 消息结束
        StreamEvent::MessageStop(_) => {
            // 会话/消息结束
            Some(AIEvent::session_end(session_id))
        },
    }
}

/// 将 claw-code StreamEvent 列表转换为 AIEvent 列表
pub fn stream_events_to_ai_events(events: &[StreamEvent], session_id: &str) -> Vec<AIEvent> {
    events.iter()
        .filter_map(|e| stream_event_to_ai_event(e, session_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::traits::HistoryEntry;
    use serde_json::json;

    #[test]
    fn test_history_entry_to_input_message_user() {
        let entry = HistoryEntry {
            role: "user".to_string(),
            content: "Hello".to_string(),
        };
        let msg = history_entry_to_input_message(&entry);
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            InputContentBlock::Text { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_history_entry_to_input_message_assistant() {
        let entry = HistoryEntry {
            role: "assistant".to_string(),
            content: "Hi there!".to_string(),
        };
        let msg = history_entry_to_input_message(&entry);
        assert_eq!(msg.role, "assistant");
        match &msg.content[0] {
            InputContentBlock::Text { text } => assert_eq!(text, "Hi there!"),
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_history_entries_to_input_messages() {
        let entries = vec![
            HistoryEntry {
                role: "user".to_string(),
                content: "Hello".to_string(),
            },
            HistoryEntry {
                role: "assistant".to_string(),
                content: "Hi!".to_string(),
            },
        ];
        let msgs = history_entries_to_input_messages(&entries);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn test_stream_event_text_delta() {
        let json = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        let ai_event = stream_event_to_ai_event(&event, "test-session");
        assert!(ai_event.is_some());
        match ai_event {
            Some(AIEvent::Token(e)) => {
                assert_eq!(e.session_id, "test-session");
                assert_eq!(e.value, "Hello");
            }
            _ => panic!("Expected Token event"),
        }
    }

    #[test]
    fn test_stream_event_thinking_delta() {
        let json = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I'm thinking..."}}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        let ai_event = stream_event_to_ai_event(&event, "test-session");
        assert!(ai_event.is_some());
        match ai_event {
            Some(AIEvent::Thinking(e)) => {
                assert_eq!(e.session_id, "test-session");
                assert_eq!(e.content, "I'm thinking...");
            }
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn test_stream_event_tool_use_start() {
        let json = r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_123","name":"bash","input":{"command":"ls"}}}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        let ai_event = stream_event_to_ai_event(&event, "test-session");
        assert!(ai_event.is_some());
        match ai_event {
            Some(AIEvent::ToolCallStart(e)) => {
                assert_eq!(e.session_id, "test-session");
                assert_eq!(e.tool, "bash");
                assert_eq!(e.call_id, Some("tool_123".to_string()));
                assert_eq!(e.args.get("command"), Some(&json!("ls")));
            }
            _ => panic!("Expected ToolCallStart event"),
        }
    }

    #[test]
    fn test_stream_event_message_stop() {
        let json = r#"{"type":"message_stop"}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        let ai_event = stream_event_to_ai_event(&event, "test-session");
        assert!(ai_event.is_some());
        match ai_event {
            Some(AIEvent::SessionEnd(e)) => {
                assert_eq!(e.session_id, "test-session");
            }
            _ => panic!("Expected SessionEnd event"),
        }
    }

    #[test]
    fn test_stream_events_batch() {
        let events: Vec<StreamEvent> = vec![
            serde_json::from_str(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#).unwrap(),
            serde_json::from_str(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#).unwrap(),
            serde_json::from_str(r#"{"type":"message_stop"}"#).unwrap(),
        ];
        let ai_events = stream_events_to_ai_events(&events, "test-session");
        assert_eq!(ai_events.len(), 3);
        // 第一个是 Token
        assert!(matches!(&ai_events[0], AIEvent::Token(_)));
        // 第二个是 Token
        assert!(matches!(&ai_events[1], AIEvent::Token(_)));
        // 第三个是 SessionEnd
        assert!(matches!(&ai_events[2], AIEvent::SessionEnd(_)));
    }
}