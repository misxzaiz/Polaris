use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use tokio::sync::{Mutex as AsyncMutex, broadcast};
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

fn create_test_state() -> Arc<AppState> {
    let mut config = Config::default();
    config.web = WebConfig {
        enabled: true,
        host: "0.0.0.0".to_string(),
        port: 9800,
        token: Some(TEST_TOKEN.to_string()),
    };
    let config_store = ConfigStore::new_test(config, std::path::PathBuf::from("/tmp/polaris_test"));
    let (tx, _) = broadcast::channel(256);
    Arc::new(AppState {
        config_store: Arc::new(Mutex::new(config_store)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        context_store: Arc::new(Mutex::new(ContextMemoryStore::new())),
        integration_manager: AsyncMutex::new(IntegrationManager::new()),
        engine_registry: Arc::new(AsyncMutex::new(EngineRegistry::new())),
        terminal_manager: Mutex::new(TerminalManager::new()),
        file_watcher_manager: Mutex::new(FileWatcherManager::new()),
        pending_questions: Arc::new(Mutex::new(HashMap::new())),
        pending_plans: Arc::new(Mutex::new(HashMap::new())),
        scheduler_daemon: AsyncMutex::new(None),
        lsp_manager: Mutex::new(LspManager::new()),
        lsp_config: Mutex::new(LspConfigRepository::new(&std::path::PathBuf::from("/tmp"))),
        event_broadcast: tx,
        app_handle: OnceLock::new(),
        app_config_dir: OnceLock::new(),
        resource_dir: OnceLock::new(),
        start_time: Some(std::time::Instant::now()),
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    assert_eq!(json["valid"], false);
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
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["valid"], false);
}

#[tokio::test]
async fn auth_token_exchange_valid() {
    let app = test_app();
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
    assert_eq!(json["token"], TEST_TOKEN);
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
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/regenerate")
        .header(AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_regenerate_generates_new_token() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/regenerate")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["token"].is_string());
    let new_token = json["token"].as_str().unwrap();
    assert_ne!(new_token, TEST_TOKEN);
    assert_eq!(new_token.len(), 32);
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["web"]["enabled"], true);
    assert_eq!(json["web"]["port"], 9800);
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn session_patch_placeholder() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::PATCH)
        .uri("/api/sessions/test-id")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"renamed"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// ============================================================================
// Chat API Tests
// ============================================================================

#[tokio::test]
async fn answer_question_updates_state() {
    let state = create_test_state();

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-1".to_string(),
        PendingQuestion {
            call_id: "call-1".to_string(),
            session_id: "s1".to_string(),
            header: "Test".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","callId":"call-1","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let pending = state.pending_questions.lock().unwrap();
    assert_eq!(pending.get("call-1").unwrap().status, QuestionStatus::Answered);
}

#[tokio::test]
async fn approve_plan_updates_state() {
    let state = create_test_state();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-1".to_string(),
        PendingPlan {
            plan_id: "plan-1".to_string(),
            session_id: "s1".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"plan-1"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let pending = state.pending_plans.lock().unwrap();
    assert_eq!(pending.get("plan-1").unwrap().status, PlanApprovalStatus::Approved);
}

#[tokio::test]
async fn reject_plan_updates_state() {
    let state = create_test_state();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-2".to_string(),
        PendingPlan {
            plan_id: "plan-2".to_string(),
            session_id: "s1".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s1","planId":"plan-2","feedback":"no"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let pending = state.pending_plans.lock().unwrap();
    let p = pending.get("plan-2").unwrap();
    assert_eq!(p.status, PlanApprovalStatus::Rejected);
    assert_eq!(p.feedback, Some("no".to_string()));
}

// ============================================================================
// Event Broadcast Tests
// ============================================================================

#[tokio::test]
async fn answer_question_broadcasts_event() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-bc".to_string(),
        PendingQuestion {
            call_id: "call-bc".to_string(),
            session_id: "s-bc".to_string(),
            header: "Test".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    assert_eq!(json["type"], "question_answered");
    assert_eq!(json["sessionId"], "s-bc");
}

#[tokio::test]
async fn approve_plan_broadcasts_event() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-bc".to_string(),
        PendingPlan {
            plan_id: "plan-bc".to_string(),
            session_id: "s-bc".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    assert_eq!(json["contextId"], "main");
    assert_eq!(json["payload"]["planId"], "plan-bc");
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

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-rej-bc".to_string(),
        PendingPlan {
            plan_id: "plan-rej-bc".to_string(),
            session_id: "s-rej-bc".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    assert_eq!(json["contextId"], "main");
    assert_eq!(json["payload"]["planId"], "plan-rej-bc");
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
async fn query_param_token_auth() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/settings?token={}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    // Should pass auth via query param
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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

    // app_handle should also be None in the clone (no handle set in test)
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
    let state = create_test_state();
    let app = create_router(state.clone());

    // Step 1: Regenerate with valid token
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/regenerate")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let new_token = json["token"].as_str().unwrap();

    // Step 2: Old token should no longer work
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Step 3: New token should work
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/settings")
        .header(AUTHORIZATION, format!("Bearer {}", new_token))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn query_param_token_with_other_params() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/settings?foo=bar&token={}&baz=qux", TEST_TOKEN))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

// ============================================================================
// Chat Edge Case Tests
// ============================================================================

#[tokio::test]
async fn answer_question_idempotent_on_duplicate() {
    let state = create_test_state();

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-dup".to_string(),
        PendingQuestion {
            call_id: "call-dup".to_string(),
            session_id: "s-dup".to_string(),
            header: "Test".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());

    // First answer
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-dup","callId":"call-dup","selected":["a"]}"#,
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Second answer (idempotent)
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-dup","callId":"call-dup","selected":["b"]}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn answer_question_with_custom_input() {
    let state = create_test_state();
    let mut rx = state.event_broadcast.subscribe();

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-custom".to_string(),
        PendingQuestion {
            call_id: "call-custom".to_string(),
            session_id: "s-custom".to_string(),
            header: "Custom".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: true,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    assert_eq!(json["answer"]["customInput"], "my custom text");
}

#[tokio::test]
async fn approve_plan_with_feedback() {
    let state = create_test_state();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-fb".to_string(),
        PendingPlan {
            plan_id: "plan-fb".to_string(),
            session_id: "s-fb".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-fb","planId":"plan-fb","feedback":"looks good"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let pending = state.pending_plans.lock().unwrap();
    let p = pending.get("plan-fb").unwrap();
    assert_eq!(p.status, PlanApprovalStatus::Approved);
    assert_eq!(p.feedback, Some("looks good".to_string()));
}

#[tokio::test]
async fn reject_plan_without_feedback() {
    let state = create_test_state();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-no-fb".to_string(),
        PendingPlan {
            plan_id: "plan-no-fb".to_string(),
            session_id: "s-no-fb".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/reject-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-no-fb","planId":"plan-no-fb"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let pending = state.pending_plans.lock().unwrap();
    let p = pending.get("plan-no-fb").unwrap();
    assert_eq!(p.status, PlanApprovalStatus::Rejected);
}

#[tokio::test]
async fn approve_plan_idempotent_on_duplicate() {
    let state = create_test_state();

    use crate::state::{PendingPlan, PlanApprovalStatus};
    state.pending_plans.lock().unwrap().insert(
        "plan-idem".to_string(),
        PendingPlan {
            plan_id: "plan-idem".to_string(),
            session_id: "s-idem".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
    );

    let app = create_router(state.clone());

    // First approve
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"sessionId":"s-idem","planId":"plan-idem"}"#))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Second approve (idempotent)
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/approve-plan")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"sessionId":"s-idem","planId":"plan-idem"}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
    use crate::state::{PendingQuestion, QuestionStatus};

    let state = create_test_state();
    state.pending_questions.lock().unwrap().insert(
        "call-conc".to_string(),
        PendingQuestion {
            call_id: "call-conc".to_string(),
            session_id: "s-conc".to_string(),
            header: "Concurrent".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());

    let mut handles = vec![];
    for i in 0..5 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/chat/answer-question")
                .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"sessionId":"s-conc","callId":"call-conc","selected":["opt-{}"]}}"#,
                    i
                )))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    for handle in handles {
        let res = handle.await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    // All succeeded without panic or deadlock
    let pending = state.pending_questions.lock().unwrap();
    assert_eq!(pending.get("call-conc").unwrap().status, QuestionStatus::Answered);
}

#[tokio::test]
async fn concurrent_plan_approve_reject() {
    use crate::state::{PendingPlan, PlanApprovalStatus};

    let state = create_test_state();
    state.pending_plans.lock().unwrap().insert(
        "plan-race".to_string(),
        PendingPlan {
            plan_id: "plan-race".to_string(),
            session_id: "s-race".to_string(),
            title: None,
            description: None,
            status: PlanApprovalStatus::Pending,
            feedback: None,
        },
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
                .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
                .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"sessionId":"s-race","planId":"plan-race","feedback":"race"}"#,
                ))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }));
    }

    for handle in handles {
        let res = handle.await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    // Final state is one of the two — no deadlock or panic
    let pending = state.pending_plans.lock().unwrap();
    let status = &pending.get("plan-race").unwrap().status;
    assert!(*status == PlanApprovalStatus::Approved || *status == PlanApprovalStatus::Rejected);
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
                .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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
                .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-multi".to_string(),
        PendingQuestion {
            call_id: "call-multi".to_string(),
            session_id: "s-multi".to_string(),
            header: "Multi".to_string(),
            multi_select: false,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let mut rx1 = state.event_broadcast.subscribe();
    let mut rx2 = state.event_broadcast.subscribe();

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
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

    use crate::state::{PendingQuestion, QuestionStatus};
    state.pending_questions.lock().unwrap().insert(
        "call-fields".to_string(),
        PendingQuestion {
            call_id: "call-fields".to_string(),
            session_id: "s-fields".to_string(),
            header: "Fields".to_string(),
            multi_select: true,
            options: vec![],
            allow_custom_input: false,
            status: QuestionStatus::Pending,
        },
    );

    let app = create_router(state.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat/answer-question")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"sessionId":"s-fields","callId":"call-fields","selected":["opt1","opt2"]}"#,
        ))
        .unwrap();
    app.oneshot(req).await.unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
    let msg = event.unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(json["type"], "question_answered");
    assert_eq!(json["sessionId"], "s-fields");
    assert_eq!(json["callId"], "call-fields");
    assert!(json["answer"]["selected"].is_array());
    assert_eq!(json["answer"]["selected"].as_array().unwrap().len(), 2);
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
