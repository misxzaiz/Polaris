use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use axum::http::Method;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;
use super::auth;
use super::api;
use super::error::WebError;
use super::middleware::request_trace;

/// Resolve the frontend dist directory for static file serving.
///
/// Priority:
/// 1. `resource_dir` set by Tauri during setup (production: points to bundled assets)
/// 2. `../dist` relative to CWD (development: works when run from project root)
fn resolve_dist_dir(state: &AppState) -> std::path::PathBuf {
    state.resource_dir.get()
        .and_then(|opt| opt.as_ref())
        .map(|p| p.join("dist"))
        .unwrap_or_else(|| std::path::PathBuf::from("../dist"))
}

/// Build CORS layer: permissive in dev (Vite dev server on different port),
/// restrictive in production (SPA served from same origin, no CORS needed).
fn build_cors_layer() -> CorsLayer {
    if cfg!(debug_assertions) {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::OPTIONS])
            .allow_headers(tower_http::cors::Any)
    } else {
        // Production: empty CORS — same-origin requests pass, cross-origin blocked
        CorsLayer::new()
    }
}

/// Build the complete axum Router with API routes, auth middleware, CORS, and SPA fallback.
pub fn create_router(state: Arc<AppState>) -> Router {
    let dist_dir = resolve_dist_dir(&state);
    let cors = build_cors_layer();

    let api_routes = Router::new()
        // Chat
        .route("/chat/send", post(api::chat::handle_send_message))
        .route("/chat/interrupt", post(api::chat::handle_interrupt))
        .route("/chat/history/{session_id}", get(api::chat::handle_get_history))
        .route("/chat/answer-question", post(api::chat::handle_answer_question))
        .route("/chat/approve-plan", post(api::chat::handle_approve_plan))
        .route("/chat/reject-plan", post(api::chat::handle_reject_plan))
        // Sessions
        .route("/sessions", get(api::session::handle_list_sessions).post(api::session::handle_create_session))
        .route("/sessions/{id}", delete(api::session::handle_delete_session))
        // Settings
        .route("/settings", get(api::settings::handle_get_settings).patch(api::settings::handle_update_settings))
        // Auth
        .route("/auth/verify", get(api::auth::handle_verify_token))
        .route("/auth/token", post(api::auth::handle_token_exchange))
        .route("/auth/regenerate", post(api::auth::handle_regenerate_token))
        // Health
        .route("/health", get(api::health::handle_health))
        // WebSocket
        .route("/ws", get(api::ws::ws_handler))
        // Catch-all: return JSON 404 for unmatched /api/* routes
        .fallback(|| async { Err::<(), WebError>(WebError::NotFound("API route not found".into())) });

    let index_html = dist_dir.join("index.html");

    Router::new()
        .nest("/api", api_routes)
        // SPA fallback: serve static files for non-/api paths
        .fallback_service(
            ServeDir::new(&dist_dir)
                .not_found_service(ServeFile::new(&index_html))
        )
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth::auth_middleware))
        .layer(axum::middleware::from_fn(request_trace))
        .layer(cors)
        .with_state(state)
}
