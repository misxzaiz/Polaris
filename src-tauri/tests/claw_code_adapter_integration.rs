/*! claw-code 适配层集成测试
 *
 * 验证类型转换和 API 调用的集成。
 */

use polaris_lib::ai::adapters::{
    history_entry_to_input_message, history_entries_to_input_messages,
    stream_event_to_ai_event, stream_events_to_ai_events,
    InputContentBlock, InputMessage, StreamEvent,
};
use polaris_lib::ai::traits::HistoryEntry;
use polaris_lib::models::AIEvent;
use serde_json::json;

/// 测试 HistoryEntry 转换为 InputMessage
#[test]
fn test_history_entry_conversion_integration() {
    let entry = HistoryEntry {
        role: "user".to_string(),
        content: "你好，请介绍一下自己".to_string(),
    };

    let input_msg = history_entry_to_input_message(&entry);

    // 验证转换结果
    assert_eq!(input_msg.role, "user");
    assert_eq!(input_msg.content.len(), 1);

    match &input_msg.content[0] {
        InputContentBlock::Text { text } => {
            assert_eq!(text, "你好，请介绍一下自己");
        }
        _ => panic!("Expected Text block"),
    }

    // 验证序列化格式正确
    let json_str = serde_json::to_string(&input_msg).unwrap();
    assert!(json_str.contains("\"role\":\"user\""));
    assert!(json_str.contains("\"type\":\"text\""));
}

/// 测试批量历史消息转换
#[test]
fn test_batch_history_conversion() {
    let entries = vec![
        HistoryEntry {
            role: "user".to_string(),
            content: "问题 1".to_string(),
        },
        HistoryEntry {
            role: "assistant".to_string(),
            content: "回答 1".to_string(),
        },
        HistoryEntry {
            role: "user".to_string(),
            content: "问题 2".to_string(),
        },
    ];

    let input_msgs = history_entries_to_input_messages(&entries);

    assert_eq!(input_msgs.len(), 3);
    assert_eq!(input_msgs[0].role, "user");
    assert_eq!(input_msgs[1].role, "assistant");
    assert_eq!(input_msgs[2].role, "user");
}

/// 测试流式事件转换集成
#[test]
fn test_stream_event_conversion_integration() {
    // 模拟 Anthropic 流式响应事件序列
    let events_json = vec![
        // 消息开始
        r#"{"type":"message_start","message":{"id":"msg_001","type":"message","role":"assistant","content":[],"model":"claude-3","usage":{"input_tokens":10,"output_tokens":0}}}"#,
        // 内容块开始（文本）
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        // 文本增量
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#,
        // 文本增量
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，我是"}}"#,
        // 内容块结束
        r#"{"type":"content_block_stop","index":0}"#,
        // 消息结束
        r#"{"type":"message_stop"}"#,
    ];

    let events: Vec<StreamEvent> = events_json
        .iter()
        .map(|j| serde_json::from_str(j).unwrap())
        .collect();

    let session_id = "test-session-001";
    let ai_events = stream_events_to_ai_events(&events, session_id);

    // 验证转换结果：应该有 2 个 Token 事件 + 1 个 SessionEnd 事件
    assert_eq!(ai_events.len(), 3);

    // 第一个是 Token
    match &ai_events[0] {
        AIEvent::Token(e) => {
            assert_eq!(e.session_id, session_id);
            assert_eq!(e.value, "你好");
        }
        _ => panic!("Expected Token event"),
    }

    // 第二个是 Token
    match &ai_events[1] {
        AIEvent::Token(e) => {
            assert_eq!(e.value, "，我是");
        }
        _ => panic!("Expected Token event"),
    }

    // 第三个是 SessionEnd
    match &ai_events[2] {
        AIEvent::SessionEnd(e) => {
            assert_eq!(e.session_id, session_id);
        }
        _ => panic!("Expected SessionEnd event"),
    }
}

/// 测试工具调用事件转换
#[test]
fn test_tool_call_event_conversion() {
    // 工具调用开始
    let start_json = r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_123","name":"bash","input":{"command":"ls"}}}"#;

    let event: StreamEvent = serde_json::from_str(start_json).unwrap();
    let session_id = "test-session-002";

    let ai_event = stream_event_to_ai_event(&event, session_id);
    assert!(ai_event.is_some());

    match ai_event {
        Some(AIEvent::ToolCallStart(e)) => {
            assert_eq!(e.session_id, session_id);
            assert_eq!(e.tool, "bash");
            assert_eq!(e.call_id, Some("tool_123".to_string()));
            assert_eq!(e.args.get("command"), Some(&json!("ls")));
        }
        _ => panic!("Expected ToolCallStart event"),
    }
}

/// 测试思考过程事件转换
#[test]
fn test_thinking_event_conversion() {
    let thinking_json = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我思考一下..."}}"#;

    let event: StreamEvent = serde_json::from_str(thinking_json).unwrap();
    let session_id = "test-session-003";

    let ai_event = stream_event_to_ai_event(&event, session_id);
    assert!(ai_event.is_some());

    match ai_event {
        Some(AIEvent::Thinking(e)) => {
            assert_eq!(e.session_id, session_id);
            assert_eq!(e.content, "让我思考一下...");
        }
        _ => panic!("Expected Thinking event"),
    }
}

/// 测试完整对话流程模拟
#[test]
fn test_full_conversation_flow() {
    // 1. 用户输入转换为 API 格式
    let user_entry = HistoryEntry {
        role: "user".to_string(),
        content: "写一个 Hello World 程序".to_string(),
    };

    let input_msg = history_entry_to_input_message(&user_entry);
    let request_json = serde_json::to_string(&input_msg).unwrap();

    // 验证请求格式正确
    assert!(request_json.contains("\"role\":\"user\""));

    // 2. 模拟 API 响应转换为事件
    let response_events: Vec<StreamEvent> = vec![
        serde_json::from_str(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}"#).unwrap(),
        serde_json::from_str(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，我来帮你写"}}"#).unwrap(),
        serde_json::from_str(r#"{"type":"message_stop"}"#).unwrap(),
    ];

    let session_id = "test-session-004";
    let ai_events = stream_events_to_ai_events(&response_events, session_id);

    // 验证输出事件序列正确
    assert!(ai_events.len() >= 2); // 至少有 Token 和 SessionEnd

    // 提取完整响应文本
    let full_text = ai_events
        .iter()
        .filter_map(|e| {
            match e {
                AIEvent::Token(t) => Some(t.value.clone()),
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("");

    assert_eq!(full_text, "好的，我来帮你写");
}