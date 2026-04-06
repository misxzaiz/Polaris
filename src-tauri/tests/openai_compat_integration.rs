/*! OpenAI 兼容 API 客户端集成测试
 *
 * 测试真实 API 调用场景。
 *
 * 运行方式：
 * - 设置环境变量 POLARIS_TEST_API_KEY 和 POLARIS_TEST_API_BASE
 * - cargo test --test openai_compat_integration -- --ignored
 */

use polaris_lib::ai::adapters::{
    OpenAiCompatClient, OpenAiCompatConfig, InputMessage, MessageRequest,
    stream_event_to_ai_event,
};
use polaris_lib::models::AIEvent;

/// 获取测试 API Key
fn test_api_key() -> Option<String> {
    std::env::var("POLARIS_TEST_API_KEY").ok()
}

/// 获取测试 API Base URL
fn test_api_base() -> String {
    std::env::var("POLARIS_TEST_API_BASE")
        .unwrap_or_else(|_| "https://apis.iflow.cn/v1".to_string())
}

/// 获取测试模型名称
fn test_model() -> String {
    std::env::var("POLARIS_TEST_MODEL")
        .unwrap_or_else(|_| "qwen3-coder-plus".to_string())
}

/// 测试配置创建
#[test]
fn test_config_creation() {
    let config = OpenAiCompatConfig::custom(
        "TestProvider",
        "test-key",
        "https://api.test.com/v1",
        "test-model",
    );

    assert_eq!(config.provider_name, "TestProvider");
    assert_eq!(config.api_key, "test-key");
    assert_eq!(config.base_url, "https://api.test.com/v1");
    assert_eq!(config.model, "test-model");
}

/// 测试客户端创建
#[test]
fn test_client_creation() {
    let config = OpenAiCompatConfig::custom(
        "TestProvider",
        "test-key",
        "https://api.test.com/v1",
        "test-model",
    );

    let client = OpenAiCompatClient::new(config);
    // 客户端创建成功即可
    let _ = &client;
}

/// 测试请求构建
#[test]
fn test_request_building() {
    let request = MessageRequest {
        model: "test-model".to_string(),
        max_tokens: 100,
        messages: vec![
            InputMessage::user_text("你好"),
        ],
        system: Some("你是一个有帮助的助手".to_string()),
        tools: None,
        tool_choice: None,
        stream: false,
    };

    // 验证请求结构
    assert_eq!(request.model, "test-model");
    assert_eq!(request.max_tokens, 100);
    assert_eq!(request.messages.len(), 1);
    assert!(request.system.is_some());
}

/// 测试流事件转换集成
#[test]
fn test_stream_event_conversion_integration() {
    // 模拟一个流事件
    let json = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#;
    let event: polaris_lib::ai::adapters::StreamEvent =
        serde_json::from_str(json).expect("解析失败");

    let ai_event = stream_event_to_ai_event(&event, "test-session");

    assert!(ai_event.is_some());
    match ai_event {
        Some(AIEvent::Token(e)) => {
            assert_eq!(e.session_id, "test-session");
            assert_eq!(e.value, "你好");
        }
        _ => panic!("期望 Token 事件"),
    }
}

/// 测试真实 API 调用（需要 API Key）
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test openai_compat_integration test_real_api_call -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_real_api_call() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = OpenAiCompatConfig::custom(
        "TestProvider",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100);

    let client = OpenAiCompatClient::new(config);

    let request = MessageRequest {
        model: test_model(),
        max_tokens: 100,
        messages: vec![InputMessage::user_text("说一句话证明你是 AI")],
        system: None,
        tools: None,
        tool_choice: None,
        stream: false,
    };

    let result = client.send_message(&request).await;

    match result {
        Ok(response) => {
            println!("响应 ID: {}", response.id);
            println!("模型: {}", response.model);
            println!("内容块数量: {}", response.content.len());

            for block in &response.content {
                match block {
                    polaris_lib::ai::adapters::OutputContentBlock::Text { text } => {
                        println!("文本响应: {}", text);
                        assert!(!text.is_empty(), "响应文本不应为空");
                    }
                    _ => {}
                }
            }
        }
        Err(e) => {
            panic!("API 调用失败: {:?}", e);
        }
    }
}

/// 测试真实流式 API 调用（需要 API Key）
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test openai_compat_integration test_real_streaming_api_call -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_real_streaming_api_call() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = OpenAiCompatConfig::custom(
        "TestProvider",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100);

    let client = OpenAiCompatClient::new(config);

    let request = MessageRequest {
        model: test_model(),
        max_tokens: 100,
        messages: vec![InputMessage::user_text("数到 5")],
        system: None,
        tools: None,
        tool_choice: None,
        stream: true,
    };

    let result = client.stream_message(&request).await;

    match result {
        Ok(mut stream) => {
            println!("请求 ID: {:?}", stream.request_id());

            let mut text_parts = Vec::new();

            while let Ok(Some(event)) = stream.next_event().await {
                match &event {
                    polaris_lib::ai::adapters::StreamEvent::ContentBlockDelta(e) => {
                        if let polaris_lib::ai::adapters::ContentBlockDelta::TextDelta { text } = &e.delta {
                            text_parts.push(text.clone());
                            print!("{}", text);
                        }
                    }
                    polaris_lib::ai::adapters::StreamEvent::MessageStop(_) => {
                        println!("\n消息结束");
                        break;
                    }
                    _ => {}
                }
            }

            let full_text = text_parts.join("");
            assert!(!full_text.is_empty(), "应该收到文本内容");
            println!("完整响应: {}", full_text);
        }
        Err(e) => {
            panic!("流式 API 调用失败: {:?}", e);
        }
    }
}

/// 测试流式事件转换为 AIEvent
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_streaming_event_conversion() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = OpenAiCompatConfig::custom(
        "TestProvider",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100);

    let client = OpenAiCompatClient::new(config);

    let request = MessageRequest {
        model: test_model(),
        max_tokens: 100,
        messages: vec![InputMessage::user_text("你好")],
        system: None,
        tools: None,
        tool_choice: None,
        stream: true,
    };

    let result = client.stream_message(&request).await;

    match result {
        Ok(mut stream) => {
            let session_id = "test-session-001";
            let mut ai_events = Vec::new();

            while let Ok(Some(event)) = stream.next_event().await {
                if let Some(ai_event) = stream_event_to_ai_event(&event, session_id) {
                    ai_events.push(ai_event);
                }
            }

            // 验证至少有一个 Token 事件
            let token_count = ai_events.iter().filter(|e| matches!(e, AIEvent::Token(_))).count();
            assert!(token_count > 0, "应该有 Token 事件");

            // 验证有 SessionEnd 事件
            let has_end = ai_events.iter().any(|e| matches!(e, AIEvent::SessionEnd(_)));
            assert!(has_end, "应该有 SessionEnd 事件");

            println!("收集到 {} 个 AI 事件", ai_events.len());
        }
        Err(e) => {
            panic!("API 调用失败: {:?}", e);
        }
    }
}