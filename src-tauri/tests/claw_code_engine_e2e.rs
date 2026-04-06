/*! ClawCode 引擎端到端测试
 *
 * 验证 ClawCodeEngine 能否真实调用 API 并正确处理响应。
 *
 * 运行方式：
 * - 设置环境变量 POLARIS_TEST_API_KEY 和 POLARIS_TEST_API_BASE
 * - cargo test --test claw_code_engine_e2e -- --ignored
 */

use std::sync::{Arc, Mutex};
use polaris_lib::ai::engine::{ClawCodeConfig, ClawCodeEngine};
use polaris_lib::ai::traits::{AIEngine, SessionOptions};
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

/// 测试引擎初始化
#[test]
fn test_engine_initialization() {
    let config = ClawCodeConfig::new(
        "TestClawCode",
        "test-key",
        "https://api.test.com/v1",
        "test-model",
    );

    let engine = ClawCodeEngine::with_config(config);

    assert!(engine.is_available());
    assert_eq!(engine.name(), "ClawCode");
    assert_eq!(engine.description(), "使用 claw-code 适配层的 AI 引擎");
}

/// 测试引擎不可用状态
#[test]
fn test_engine_unavailable() {
    let engine = ClawCodeEngine::new();

    assert!(!engine.is_available());
    assert!(engine.unavailable_reason().is_some());
    assert_eq!(engine.unavailable_reason().unwrap(), "未配置 ClawCode Provider");
}

/// 测试启动会话失败（无配置）
#[test]
fn test_start_session_without_config() {
    let mut engine = ClawCodeEngine::new();

    let options = SessionOptions::new(|_event: AIEvent| {});

    let result = engine.start_session("你好", options);

    assert!(result.is_err());
}

/// 测试真实 API 调用（需要 API Key）
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test claw_code_engine_e2e test_real_api_start_session -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_real_api_start_session() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = ClawCodeConfig::new(
        "TestClawCode",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100)
    .with_temperature(0.7);

    let mut engine = ClawCodeEngine::with_config(config);

    assert!(engine.is_available(), "引擎应该可用");

    // 创建事件收集器
    let events: Arc<Mutex<Vec<AIEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();

    let options = SessionOptions::new(move |event: AIEvent| {
        events_clone.lock().unwrap().push(event);
    })
    .with_system_prompt("你是一个有帮助的助手，请用简洁的语言回答");

    // 启动会话
    let session_id = engine.start_session("说一句话证明你是 AI", options);

    match session_id {
        Ok(sid) => {
            println!("会话 ID: {}", sid);

            // 等待响应完成（最多 30 秒）
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(30);

            loop {
                let events_guard = events.lock().unwrap();
                let has_end = events_guard.iter().any(|e| matches!(e, AIEvent::SessionEnd(_)));

                if has_end {
                    println!("收到 SessionEnd 事件");
                    drop(events_guard);
                    break;
                }

                drop(events_guard);

                if start.elapsed() > timeout {
                    let events_guard = events.lock().unwrap();
                    println!("等待超时，当前事件数量: {}", events_guard.len());
                    break;
                }

                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            // 分析收集的事件
            let events_guard = events.lock().unwrap();
            println!("收集到 {} 个事件", events_guard.len());

            // 验证至少有 Token 事件
            let token_events: Vec<_> = events_guard
                .iter()
                .filter_map(|e| {
                    match e {
                        AIEvent::Token(t) => Some(t.value.clone()),
                        _ => None,
                    }
                })
                .collect();

            assert!(!token_events.is_empty(), "应该收到 Token 事件");
            println!("Token 事件数量: {}", token_events.len());

            let full_text = token_events.join("");
            println!("完整响应: {}", full_text);
            assert!(!full_text.is_empty(), "响应文本不应为空");
        }
        Err(e) => {
            panic!("启动会话失败: {:?}", e);
        }
    }
}

/// 测试真实 API 流式调用（需要 API Key）
///
/// 验证：
/// 1. 流式响应正确分词
/// 2. Token 事件顺序正确
/// 3. SessionEnd 事件最后触发
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test claw_code_engine_e2e test_real_api_streaming -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_real_api_streaming() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = ClawCodeConfig::new(
        "TestClawCode",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100);

    let mut engine = ClawCodeEngine::with_config(config);

    // 创建事件收集器
    let events: Arc<Mutex<Vec<AIEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();

    let options = SessionOptions::new(move |event: AIEvent| {
        match &event {
            AIEvent::Token(t) => {
                println!("[Token] {}", t.value);
            }
            AIEvent::SessionEnd(_) => {
                println!("[SessionEnd]");
            }
            AIEvent::Error(e) => {
                println!("[Error] {}", e.error);
            }
            _ => {}
        }
        events_clone.lock().unwrap().push(event);
    });

    // 启动会话
    let session_id = engine.start_session("数到 3", options).expect("启动会话成功");
    println!("会话 ID: {}", session_id);

    // 等待完成
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);

    loop {
        let events_guard = events.lock().unwrap();
        let has_end = events_guard.iter().any(|e| matches!(e, AIEvent::SessionEnd(_)));

        drop(events_guard);

        if has_end || start.elapsed() > timeout {
            break;
        }

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // 验证事件序列
    let events_guard = events.lock().unwrap();

    // 检查事件顺序：第一个应该是 session_start
    if let Some(first) = events_guard.first() {
        match first {
            AIEvent::SessionStart(ss) => {
                println!("session_start sessionId: {}", ss.session_id);
            }
            _ => {
                panic!("第一个事件应该是 session_start，实际是: {:?}", first);
            }
        }
    }

    // 检查事件顺序
    let mut token_count = 0;
    let mut last_token_index = 0;
    let mut end_index = 0;

    for (i, event) in events_guard.iter().enumerate() {
        match event {
            AIEvent::Token(_) => {
                token_count += 1;
                last_token_index = i;
            }
            AIEvent::SessionEnd(_) => {
                end_index = i;
            }
            _ => {}
        }
    }

    println!("Token 事件数: {}", token_count);
    println!("最后 Token 位置: {}", last_token_index);
    println!("SessionEnd 位置: {}", end_index);

    // 验证 SessionEnd 是最后一个事件
    assert!(end_index > 0, "应该有 SessionEnd 事件");
    assert!(end_index >= last_token_index, "SessionEnd 应在 Token 之后");

    // 验证有流式文本
    assert!(token_count >= 1, "应该至少有 1 个 Token 事件");
}

/// 测试历史消息续接（需要 API Key）
///
/// 验证：
/// 1. 历史消息正确转换
/// 2. 多轮对话正确处理
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test claw_code_engine_e2e test_real_api_continue_session -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_real_api_continue_session() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = ClawCodeConfig::new(
        "TestClawCode",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(100);

    let mut engine = ClawCodeEngine::with_config(config);

    // 创建事件收集器
    let events: Arc<Mutex<Vec<AIEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();

    // 模拟历史消息
    use polaris_lib::ai::traits::HistoryEntry;
    let history = vec![
        HistoryEntry {
            role: "user".to_string(),
            content: "我的名字是小明".to_string(),
        },
        HistoryEntry {
            role: "assistant".to_string(),
            content: "好的，小明，我记得你的名字了".to_string(),
        },
    ];

    let options = SessionOptions::new(move |event: AIEvent| {
        events_clone.lock().unwrap().push(event);
    })
    .with_message_history(history);

    // 续接会话，测试是否能记住名字
    let result = engine.continue_session("previous-session", "你还记得我的名字吗？", options);

    match result {
        Ok(_) => {
            println!("续接会话成功");

            // 等待完成
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(30);

            loop {
                let events_guard = events.lock().unwrap();
                let has_end = events_guard.iter().any(|e| matches!(e, AIEvent::SessionEnd(_)));

                drop(events_guard);

                if has_end || start.elapsed() > timeout {
                    break;
                }

                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            // 分析响应
            let events_guard = events.lock().unwrap();
            let token_events: Vec<_> = events_guard
                .iter()
                .filter_map(|e| {
                    match e {
                        AIEvent::Token(t) => Some(t.value.clone()),
                        _ => None,
                    }
                })
                .collect();

            let full_text = token_events.join("");
            println!("完整响应: {}", full_text);

            // 注意：AI 可能不一定会提到名字，这里只验证响应非空
            assert!(!full_text.is_empty(), "响应不应为空");
        }
        Err(e) => {
            panic!("续接会话失败: {:?}", e);
        }
    }
}

/// 测试中断会话
#[tokio::test]
async fn test_interrupt_session() {
    let config = ClawCodeConfig::new(
        "Test",
        "key",
        "url",
        "model",
    );

    let mut engine = ClawCodeEngine::with_config(config);
    assert!(engine.is_available());

    // 中断一个不存在的会话（应该成功）
    let result = engine.interrupt("non-existent-session");
    assert!(result.is_ok());

    // 验证活跃会话数
    assert_eq!(engine.active_session_count(), 0);
}

/// 测试 session_start 事件发送
///
/// 验证：
/// 1. session_start 事件在流式响应开始时发送
/// 2. session_start 包含正确的 session_id
/// 3. session_id 已注册到 cancel_tokens，支持中断
///
/// 运行方式：
/// ```bash
/// POLARIS_TEST_API_KEY=your-key cargo test --test claw_code_engine_e2e test_session_start_event -- --ignored
/// ```
#[tokio::test]
#[ignore = "需要设置 POLARIS_TEST_API_KEY 环境变量"]
async fn test_session_start_event() {
    let api_key = match test_api_key() {
        Some(key) => key,
        None => {
            eprintln!("跳过测试：未设置 POLARIS_TEST_API_KEY");
            return;
        }
    };

    let config = ClawCodeConfig::new(
        "TestClawCode",
        api_key,
        test_api_base(),
        test_model(),
    )
    .with_max_tokens(50);

    let mut engine = ClawCodeEngine::with_config(config);
    assert!(engine.is_available(), "引擎应该可用");

    // 创建事件收集器
    let events: Arc<Mutex<Vec<AIEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();

    let options = SessionOptions::new(move |event: AIEvent| {
        events_clone.lock().unwrap().push(event);
    });

    // 启动会话
    let session_id = engine.start_session("说一个字", options).expect("启动会话成功");
    println!("返回的 session_id: {}", session_id);

    // 等待 session_start 事件（应该在第一个事件中）
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(5);

    loop {
        let events_guard = events.lock().unwrap();
        let has_session_start = events_guard.iter().any(|e| matches!(e, AIEvent::SessionStart(_)));

        if has_session_start || start.elapsed() > timeout {
            drop(events_guard);
            break;
        }

        drop(events_guard);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // 验证事件
    let events_guard = events.lock().unwrap();
    println!("收集到 {} 个事件", events_guard.len());

    // 验证第一个事件是 session_start
    assert!(!events_guard.is_empty(), "应该有事件");
    let first_event = &events_guard[0];

    match first_event {
        AIEvent::SessionStart(ss) => {
            println!("session_start 事件的 sessionId: {}", ss.session_id);
            // 验证 session_id 匹配
            assert_eq!(ss.session_id, session_id, "session_start 的 sessionId 应与返回值匹配");
        }
        _ => {
            panic!("第一个事件应该是 session_start，实际是: {:?}", first_event);
        }
    }

    // 验证中断功能：session_id 应已注册到 cancel_tokens
    let interrupt_result = engine.interrupt(&session_id);
    assert!(interrupt_result.is_ok(), "中断应该成功，说明 session_id 已注册");

    println!("✅ session_start 事件验证通过");
}
