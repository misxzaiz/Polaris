use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
async fn session_create_returns_error() {
    let app = test_app();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/sessions")
        .header(AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"test"}"#))
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
    assert_eq!(res.status(), StatusCode::OK);
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
