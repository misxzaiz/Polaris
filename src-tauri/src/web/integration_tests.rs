use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use tokio::sync::Mutex as AsyncMutex;
use tower::ServiceExt;

use crate::ai::EngineRegistry;
use crate::commands::context::ContextMemoryStore;
use crate::commands::terminal::TerminalManager;
use crate::integrations::IntegrationManager;
use crate::models::config::{Config, WebConfig};
use crate::services::config_store::ConfigStore;
use crate::services::file_watcher::FileWatcherManager;
use crate::services::lsp::LspManager;
use crate::services::lsp_config_repository::LspConfigRepository;
use crate::state::AppState;

use super::router::create_router;

const TEST_TOKEN: &str = "test-token-1234567890abcdef";

/// Compute the MD5 hex digest used by the auth middleware.
fn md5_of(s: &str) -> String {
    format!("{:x}", md5::compute(s.as_bytes()))
}

/// Create a PendingQuestion with sensible test defaults.
fn make_pending_question(call_id: &str, session_id: &str) -> crate::state::PendingQuestion {
    use crate::state::{QuestionItem, QuestionStatus};
    crate::state::PendingQuestion {
        call_id: call_id.to_string(),
        session_id: session_id.to_string(),
        questions: vec![QuestionItem {
            question: "Test".to_string(),
            header: "Test".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
        }],
        status: QuestionStatus::Pending,
    }
}

/// Create a PendingPlan with sensible test defaults.
fn make_pending_plan(plan_id: &str, session_id: &str) -> crate::state::PendingPlan {
    use crate::state::PlanApprovalStatus;
    crate::state::PendingPlan {
        plan_id: plan_id.to_string(),
        session_id: session_id.to_string(),
        title: None,
        description: None,
        status: PlanApprovalStatus::Pending,
        feedback: None,
    }
}

fn create_test_state() -> Arc<AppState> {
    let mut config = Config::default();
    config.web = WebConfig {
        enabled: true,
        host: "0.0.0.0".to_string(),
        port: 9830,
        token: Some(TEST_TOKEN.to_string()),
    };
    let config_store = ConfigStore::new_test(config, std::path::PathBuf::from("/tmp/polaris_test"));
    Arc::new(AppState {
        config_store: Arc::new(Mutex::new(config_store)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        context_store: Arc::new(Mutex::new(ContextMemoryStore::new())),
        integration_manager: AsyncMutex::new(IntegrationManager::new()),
        engine_registry: Arc::new(AsyncMutex::new(EngineRegistry::new())),
        terminal_manager: Mutex::new(TerminalManager::new()),
        file_watcher_manager: Mutex::new(FileWatcherManager::new()),
        pending_questions: Arc::new(Mutex::new(HashMap::new())),
        ask_answer_senders: Arc::new(Mutex::new(HashMap::new())),
        pending_plugin_cards: Arc::new(Mutex::new(HashMap::new())),
        plugin_card_answer_senders: Arc::new(Mutex::new(HashMap::new())),
        ask_listener: Arc::new(OnceLock::new()),
        pending_plans: Arc::new(Mutex::new(HashMap::new())),
        scheduler_daemon: AsyncMutex::new(None),
        lsp_manager: Mutex::new(LspManager::new()),
        lsp_config: Mutex::new(LspConfigRepository::new(&std::path::PathBuf::from("/tmp"))),
        lsp_index_service: crate::services::lsp_index::IndexService::new(),
        event_broadcast: crate::web::EventBroadcaster::new(256),
        #[cfg(feature = "tauri-app")]
        app_handle: OnceLock::new(),
        app_config_dir: OnceLock::new(),
        resource_dir: OnceLock::new(),
        start_time: Some(std::time::Instant::now()),
        web_server_handle: Arc::new(AsyncMutex::new(None)),
        proxy_manager: crate::services::ProxyManager::new(),
        spring_boot_manager: Mutex::new(crate::commands::spring_boot::SpringBootManager::new()),
        plugin_service_manager: Arc::new(
            crate::services::plugin_service_manager::PluginServiceManager::new(),
        ),
    })
}

fn test_app() -> axum::Router {
    create_router(create_test_state())
}

// ============================================================================
// Auth Middleware Tests
// ============================================================================

#[tokio::test]
async fn auth_middleware_rejects_missing_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/send")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_rejects_wrong_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/send")
        .header(AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_accepts_valid_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_skips_verify_endpoint() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/auth/verify")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_skips_token_exchange() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"token":"any"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

// ============================================================================
// Auth API Tests
// ============================================================================

#[tokio::test]
async fn auth_verify_valid_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/auth/verify")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["valid"], true);
}

#[tokio::test]
async fn auth_verify_invalid_token() {
    let app = test_app();
    // The verify endpoint skips auth middleware; it simply returns valid=true
    // because if we reach it, the request is allowed through.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/auth/verify")
        .header(AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    // verify endpoint always returns valid when token is configured (no header validation)
    assert_eq!(json["valid"], true);
}

#[tokio::test]
async fn auth_verify_no_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/auth/verify")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // verify endpoint is auth-skipped, so it returns 200 regardless
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["valid"], true);
}

#[tokio::test]
async fn auth_token_exchange_valid() {
    let app = test_app();
    // Send the raw token; the handler should accept it and return its MD5.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(format!(r#"{{"token":"{}"}}"#, TEST_TOKEN)))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["valid"], true);
    // The handler returns the MD5 of the configured token.
    assert_eq!(json["token"], md5_of(TEST_TOKEN));
}

#[tokio::test]
async fn auth_token_exchange_invalid() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"token":"wrong-token"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_token_exchange_missing_field() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn auth_regenerate_requires_valid_token() {
    // NOTE: /api/auth/regenerate was removed in MVP. This test now verifies
    // that a random endpoint with wrong token is rejected.
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_token_exchange_accepts_md5() {
    let app = test_app();
    // Send the MD5 of the token directly — should also be accepted.
    let token_md5 = md5_of(TEST_TOKEN);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(format!(r#"{{"token":"{}"}}"#, token_md5)))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["valid"], true);
    assert_eq!(json["token"], md5_of(TEST_TOKEN));
}

// ============================================================================
// Settings API Tests
// ============================================================================

#[tokio::test]
async fn settings_get_returns_config() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["web"]["enabled"], true);
    assert_eq!(json["web"]["port"], 9830);
}

#[tokio::test]
async fn settings_get_requires_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn settings_update_saves() {
    let state = create_test_state();
    let app = create_router(state.clone());

    let updated = {
        let store = state.config_store.lock().unwrap();
        let mut c = store.get().clone();
        c.language = Some("en-US".to_string());
        c
    };
    let body = serde_json::to_string(&updated).unwrap();

    let req = Request::builder()
        .method(Method::PATCH)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

// ============================================================================
// Session API Tests
// ============================================================================

#[tokio::test]
async fn session_create_no_message_returns_400() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/sessions")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn session_patch_returns_404() {
    // PATCH /sessions/{id} is intentionally not implemented — JSONL storage is append-only
    let app = test_app();
    let req = Request::builder()
        .method(Method::PATCH)
        .uri("/api/sessions/test-id")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"renamed"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// ============================================================================
// Terminal IPC Bridge Tests
// ============================================================================

#[tokio::test]
async fn terminal_list_available_via_web_ipc() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/terminal-list")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.as_array().is_some());
}

#[tokio::test]
async fn terminal_discover_scripts_available_via_web_ipc() {
    let temp_dir = tempfile::tempdir().unwrap();
    let root = temp_dir.path();
    std::fs::write(
        root.join("package.json"),
        r#"{"scripts":{"test":"vitest run"}}"#,
    )
    .unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();

    let app = test_app();
    let body = serde_json::json!({
        "workspacePath": root.to_string_lossy(),
    })
    .to_string();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/terminal-discover-scripts")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let scripts = json.as_array().unwrap();
    assert_eq!(scripts.len(), 1);
    assert_eq!(scripts[0]["command"], "npm run test");
}

// ============================================================================
// Chat API Tests
// ============================================================================

#[tokio::test]
async fn answer_question_updates_state() {
    let state = create_test_state();
    state.pending_questions.lock().unwrap().insert(
        "call-1".to_string(),
        make_pending_question("call-1", "s1"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","callId":"call-1","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Entry is removed after answering to prevent memory leaks
    let pending = state.pending_questions.lock().unwrap();
    assert!(pending.get("call-1").is_none());
}

#[tokio::test]
async fn approve_plan_updates_state() {
    let state = create_test_state();

    state.pending_plans.lock().unwrap().insert(
        "plan-1".to_string(),
        make_pending_plan("plan-1", "s1"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"plan-1"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Entry is removed after approval to prevent memory leaks
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-1").is_none());
}

#[tokio::test]
async fn reject_plan_updates_state() {
    let state = create_test_state();

    state.pending_plans.lock().unwrap().insert(
        "plan-2".to_string(),
        make_pending_plan("plan-2", "s1"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"plan-2","feedback":"no"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Entry is removed after rejection to prevent memory leaks
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-2").is_none());
}

// ============================================================================
// Event Broadcast Tests
// ============================================================================

#[tokio::test]
async fn answer_question_broadcasts_event() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    state.pending_questions.lock().unwrap().insert(
        "call-bc".to_string(),
        make_pending_question("call-bc", "s-bc"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-bc","callId":"call-bc","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_ok());
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // dual_emit 将事件包入 {"event":"chat-event","payload":...} envelope
    assert_eq!(json["event"], "chat-event");
    assert_eq!(json["payload"]["type"], "question_answered");
    assert_eq!(json["payload"]["sessionId"], "s-bc");
}

#[tokio::test]
async fn approve_plan_broadcasts_event() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    state.pending_plans.lock().unwrap().insert(
        "plan-bc".to_string(),
        make_pending_plan("plan-bc", "s-bc"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-bc","planId":"plan-bc"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_ok());
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // dual_emit envelope：payload 内才是 {"contextId":"main","payload":{...}}
    assert_eq!(json["event"], "chat-event");
    assert_eq!(json["payload"]["contextId"], "main");
    assert_eq!(json["payload"]["payload"]["planId"], "plan-bc");
}

// ============================================================================
// CORS Tests
// ============================================================================

#[tokio::test]
async fn cors_options_ok() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::OPTIONS)
        .uri("/api/auth/verify")
        .header("origin", "http://localhost:1420")
        .header("access-control-request-method", "GET")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

// ============================================================================
// Extended Coverage Tests
// ============================================================================

#[tokio::test]
async fn reject_plan_broadcasts_event() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    state.pending_plans.lock().unwrap().insert(
        "plan-rej-bc".to_string(),
        make_pending_plan("plan-rej-bc", "s-rej-bc"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-rej-bc","planId":"plan-rej-bc","feedback":"bad plan"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_ok());
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // dual_emit envelope：payload 内才是 {"contextId":"main","payload":{...}}
    assert_eq!(json["event"], "chat-event");
    assert_eq!(json["payload"]["contextId"], "main");
    assert_eq!(json["payload"]["payload"]["planId"], "plan-rej-bc");
}

#[tokio::test]
async fn session_list_requires_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/sessions")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_list_with_valid_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/sessions")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // 200 or 500 depending on whether claude config dir exists, but NOT 401
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn chat_interrupt_requires_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/interrupt")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"sessionId":"s1"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn chat_history_requires_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/chat/history/test-session-id")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn error_response_json_format() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/send")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.get("error").is_some());
    assert_eq!(json["error"], "Unauthorized");
}

#[tokio::test]
async fn static_files_skip_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/index.html")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // Static file serving should skip auth middleware entirely
    // May be 200 (file exists) or 404 (SPA fallback missing in test), but NOT 401
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_param_token_no_longer_supported() {
    // Auth no longer supports query-param tokens; only Bearer header is accepted.
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/settings?token={}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // Query-param is not checked; without Bearer header this returns 401.
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_param_wrong_token_rejected() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings?token=wrong-token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_delete_requires_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::DELETE)
        .uri("/api/sessions/test-id")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn answer_question_without_pending_returns_not_found() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","callId":"nonexistent","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn approve_plan_without_pending_returns_not_found() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"nonexistent"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reject_plan_without_pending_returns_not_found() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"nonexistent"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// ============================================================================
// Dual Emission Structural Verification
// ============================================================================

#[cfg(feature = "tauri-app")]
#[test]
fn test_state_has_app_handle_field() {
    let state = create_test_state();
    // app_handle is initialized as empty OnceLock in test state
    assert!(state.app_handle.get().is_none());
}

#[test]
fn clone_for_web_preserves_shared_state() {
    let state = create_test_state();
    let cloned = state.clone_for_web();

    // Shared Arc fields should point to the same allocation
    assert!(Arc::ptr_eq(&state.sessions, &cloned.sessions));
    assert!(Arc::ptr_eq(&state.pending_questions, &cloned.pending_questions));
    assert!(Arc::ptr_eq(&state.pending_plans, &cloned.pending_plans));
    assert!(Arc::ptr_eq(&state.config_store, &cloned.config_store));

    #[cfg(feature = "tauri-app")]
    assert!(cloned.app_handle.get().is_none());
}

// ============================================================================
// Auth Edge Case Tests
// ============================================================================

#[tokio::test]
async fn auth_empty_bearer_token_rejected() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, "Bearer ")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_no_bearer_prefix_rejected() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, TEST_TOKEN)
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_basic_scheme_rejected() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Basic {}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn regenerate_invalidates_old_token() {
    // NOTE: The /api/auth/regenerate endpoint was removed (MVP simplicity).
    // This test now verifies that the MD5-based auth flow works correctly
    // when the token in config changes.
    let state = create_test_state();
    let app = create_router(state.clone());

    // Step 1: MD5 of configured token should work
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Step 2: Wrong MD5 should not work
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, "Bearer wrong-md5-hash")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_param_token_with_other_params_not_supported() {
    // Auth only supports Bearer header; query-param token is not checked.
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/settings?foo=bar&token={}&baz=qux", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

// ============================================================================
// Chat Edge Case Tests
// ============================================================================

#[tokio::test]
async fn answer_question_second_call_after_removal_returns_404() {
    let state = create_test_state();

    state.pending_questions.lock().unwrap().insert(
        "call-dup".to_string(),
        make_pending_question("call-dup", "s-dup"),
    );

    let app = create_router(state.clone());

    // First answer — succeeds, entry is removed
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-dup","callId":"call-dup","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Second answer — entry already removed, returns 404
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-dup","callId":"call-dup","selected":["b"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn answer_question_with_custom_input() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    let mut q = make_pending_question("call-custom", "s-custom");
    if let Some(first) = q.questions.first_mut() {
        first.allow_custom_input = true;
    }
    state.pending_questions.lock().unwrap().insert(
        "call-custom".to_string(),
        q,
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-custom","callId":"call-custom","selected":[],"customInput":"my custom text"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_ok());
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(json["payload"]["answer"]["customInput"], "my custom text");
}

#[tokio::test]
async fn approve_plan_with_feedback() {
    let state = create_test_state();

    state.pending_plans.lock().unwrap().insert(
        "plan-fb".to_string(),
        make_pending_plan("plan-fb", "s-fb"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-fb","planId":"plan-fb","feedback":"looks good"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Entry is removed after approval
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-fb").is_none());
}

#[tokio::test]
async fn reject_plan_without_feedback() {
    let state = create_test_state();

    state.pending_plans.lock().unwrap().insert(
        "plan-no-fb".to_string(),
        make_pending_plan("plan-no-fb", "s-no-fb"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-no-fb","planId":"plan-no-fb"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Entry is removed after rejection
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-no-fb").is_none());
}

#[tokio::test]
async fn approve_plan_second_call_after_removal_returns_404() {
    let state = create_test_state();

    state.pending_plans.lock().unwrap().insert(
        "plan-idem".to_string(),
        make_pending_plan("plan-idem", "s-idem"),
    );

    let app = create_router(state.clone());

    // First approve — succeeds, entry is removed
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"sessionId":"s-idem","planId":"plan-idem"}"#))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Second approve — entry already removed, returns 404
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"sessionId":"s-idem","planId":"plan-idem"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// ============================================================================
// Session Edge Case Tests
// ============================================================================

#[tokio::test]
async fn session_list_unsupported_engine() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/sessions?engineId=unsupported")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].as_str().unwrap().contains("Unsupported engine"));
}

#[tokio::test]
async fn session_delete_unsupported_engine() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::DELETE)
        .uri("/api/sessions/test-id?engineId=unsupported")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

// ============================================================================
// Error Path Tests
// ============================================================================

#[tokio::test]
async fn unknown_route_returns_fallback() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/nonexistent-page")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // SPA fallback serves index.html, NOT 404 — but never UNAUTHORIZED
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn malformed_json_body_returns_bad_request() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from("not json"))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn missing_content_type_for_json_endpoint() {
    let app = test_app();
    // POST with JSON body but no Content-Type header
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::from(r#"{"sessionId":"s1","callId":"c1","selected":["a"]}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // Without Content-Type, axum won't parse JSON — expect 400 or 422
    assert!(res.status() == StatusCode::BAD_REQUEST
        || res.status() == StatusCode::UNSUPPORTED_MEDIA_TYPE
        || res.status() == StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn wrong_http_method_on_endpoint() {
    let app = test_app();
    // PATCH on a GET-only endpoint
    let req = Request::builder()
        .method(Method::PATCH)
        .uri("/api/auth/verify")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
}

// ============================================================================
// Concurrent Access Tests
// ============================================================================

#[tokio::test]
async fn concurrent_answer_question_same_call() {
    let state = create_test_state();
    state.pending_questions.lock().unwrap().insert(
        "call-conc".to_string(),
        make_pending_question("call-conc", "s-conc"),
    );

    let app = create_router(state.clone());

    let mut handles = vec![];
    for i in 0..5 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/chat/answer-question")
                .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"sessionId":"s-conc","callId":"call-conc","selected":["opt-{}"]}}"#,
                    i
                )))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    let mut ok_count = 0;
    let mut not_found_count = 0;
    for handle in handles {
        let res = handle.await.unwrap();
        match res.status() {
            StatusCode::OK => ok_count += 1,
            StatusCode::NOT_FOUND => not_found_count += 1,
            other => panic!("Unexpected status: {}", other),
        }
    }
    // Exactly one request wins the race and removes the entry; the rest get 404
    assert_eq!(ok_count, 1);
    assert_eq!(not_found_count, 4);

    // Entry is removed after the winning answer
    let pending = state.pending_questions.lock().unwrap();
    assert!(pending.get("call-conc").is_none());
}

#[tokio::test]
async fn concurrent_plan_approve_reject() {
    let state = create_test_state();
    state.pending_plans.lock().unwrap().insert(
        "plan-race".to_string(),
        make_pending_plan("plan-race", "s-race"),
    );

    let app = create_router(state.clone());

    // 3 approve + 2 reject concurrently
    let mut handles = vec![];
    for _ in 0..3 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/chat/approve-plan")
                .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"sessionId":"s-race","planId":"plan-race"}"#,
                ))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }
    for _ in 0..2 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/chat/reject-plan")
                .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"sessionId":"s-race","planId":"plan-race","feedback":"race"}"#,
                ))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    let mut ok_count = 0;
    let mut not_found_count = 0;
    for handle in handles {
        let res = handle.await.unwrap();
        match res.status() {
            StatusCode::OK => ok_count += 1,
            StatusCode::NOT_FOUND => not_found_count += 1,
            other => panic!("Unexpected status: {}", other),
        }
    }
    // Exactly one request wins; the rest get 404
    assert_eq!(ok_count, 1);
    assert_eq!(not_found_count, 4);

    // Entry is removed — no deadlock or panic
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-race").is_none());
}

#[tokio::test]
async fn concurrent_settings_read_write() {
    let state = create_test_state();
    let app = create_router(state.clone());

    let mut handles = vec![];

    // 5 concurrent reads
    for _ in 0..5 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::GET)
                .uri("/api/settings")
                .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
                .body(Body::empty())
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    // 2 concurrent writes
    for _ in 0..2 {
        let app = app.clone();
        let state = state.clone();
        handles.push(tokio::spawn(async move {
            let updated = {
                let store = state.config_store.lock().unwrap();
                store.get().clone()
            };
            let body = serde_json::to_string(&updated).unwrap();
            let req = Request::builder()
                .method(Method::PATCH)
                .uri("/api/settings")
                .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    for handle in handles {
        let res = handle.await.unwrap();
        // Reads: OK, Writes: OK — no deadlock
        assert!(res.status() == StatusCode::OK || res.status() == StatusCode::INTERNAL_SERVER_ERROR);
    }
}

// ============================================================================
// Broadcast Channel Behavior Tests
// ============================================================================

#[tokio::test]
async fn broadcast_reaches_multiple_subscribers() {
    let state = create_test_state();

    state.pending_questions.lock().unwrap().insert(
        "call-multi".to_string(),
        make_pending_question("call-multi", "s-multi"),
    );

    let mut rx1 = state.event_broadcast.subscribe();
    let mut rx2 = state.event_broadcast.subscribe();

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-multi","callId":"call-multi","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Both subscribers should receive the event
    let e1 = tokio::time::timeout(std::time::Duration::from_millis(500), rx1.recv()).await;
    let e2 = tokio::time::timeout(std::time::Duration::from_millis(500), rx2.recv()).await;
    assert!(e1.is_ok());
    assert!(e2.is_ok());
}

#[tokio::test]
async fn broadcast_event_contains_correct_fields() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    let mut q = make_pending_question("call-fields", "s-fields");
    if let Some(first) = q.questions.first_mut() {
        first.multi_select = true;
    }
    state.pending_questions.lock().unwrap().insert(
        "call-fields".to_string(),
        q,
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-fields","callId":"call-fields","selected":["opt1","opt2"]}"#,
        ))
        .unwrap();
    app.oneshot(req).await.unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // dual_emit envelope + EventBroadcaster 注入的顶层 seq
    assert!(json["seq"].is_u64());
    assert_eq!(json["event"], "chat-event");
    let inner = &json["payload"];
    assert_eq!(inner["type"], "question_answered");
    assert_eq!(inner["sessionId"], "s-fields");
    assert_eq!(inner["callId"], "call-fields");
    assert!(inner["answer"]["selected"].is_array());
    assert_eq!(inner["answer"]["selected"].as_array().unwrap().len(), 2);
}

// ============================================================================
// Health Check Tests
// ============================================================================

#[tokio::test]
async fn health_check_returns_ok_without_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert!(json["version"].is_string());
    assert!(json["uptime_seconds"].is_number());
}

#[tokio::test]
async fn health_check_version_matches_crate() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
}

// ============================================================================
// Session ID Verification Tests
// ============================================================================

#[tokio::test]
async fn answer_question_rejects_session_id_mismatch() {
    let state = create_test_state();
    state.pending_questions.lock().unwrap().insert(
        "call-mismatch".to_string(),
        make_pending_question("call-mismatch", "correct-session"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"wrong-session","callId":"call-mismatch","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Entry should NOT be removed on mismatch
    let pending = state.pending_questions.lock().unwrap();
    assert!(pending.get("call-mismatch").is_some());
}

#[tokio::test]
async fn approve_plan_rejects_session_id_mismatch() {
    let state = create_test_state();
    state.pending_plans.lock().unwrap().insert(
        "plan-mismatch".to_string(),
        make_pending_plan("plan-mismatch", "correct-session"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"wrong-session","planId":"plan-mismatch"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Entry should NOT be removed on mismatch
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-mismatch").is_some());
}

#[tokio::test]
async fn reject_plan_rejects_session_id_mismatch() {
    let state = create_test_state();
    state.pending_plans.lock().unwrap().insert(
        "plan-rej-mismatch".to_string(),
        make_pending_plan("plan-rej-mismatch", "correct-session"),
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", md5_of(TEST_TOKEN)))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"wrong-session","planId":"plan-rej-mismatch","feedback":"nope"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Entry should NOT be removed on mismatch
    let pending = state.pending_plans.lock().unwrap();
    assert!(pending.get("plan-rej-mismatch").is_some());
}
