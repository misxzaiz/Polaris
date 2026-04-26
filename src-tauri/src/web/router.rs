use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use axum::http::Method;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;
use super::auth;
use super::api;
use super::middleware::request_trace;

/// Resolve the frontend dist directory for static file serving.
///
/// Priority:
/// 1. `resource_dir/dist` — only if the directory actually exists (production bundle)
/// 2. `../dist` relative to CWD (development fallback when running from src-tauri/)
/// 3. `./dist` relative to CWD (development fallback when running from project root)
fn resolve_dist_dir(state: &AppState) -> std::path::PathBuf {
    // Try resource_dir first — check both "dist" (dev/non-MSI) and "dist-web" (MSI bundle)
    if let Some(Some(resource_dir)) = state.resource_dir.get().as_ref() {
        let dist = resource_dir.join("dist");
        if dist.is_dir() {
            return dist;
        }
        let dist_web = resource_dir.join("dist-web");
        if dist_web.is_dir() {
            return dist_web;
        }
        tracing::debug!(
            "[Web] resource_dir has neither dist/ nor dist-web/ at {:?}, trying fallbacks",
            resource_dir
        );
    }

    // Development fallbacks
    for candidate in ["../dist", "./dist"] {
        let path = std::path::PathBuf::from(candidate);
        if path.is_dir() {
            return path;
        }
    }

    // Last resort: return ../dist (will 404 but at least it's a sensible default)
    tracing::warn!("[Web] No dist directory found, SPA serving will fail");
    std::path::PathBuf::from("../dist")
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
    tracing::info!("[Web] SPA dist directory resolved to: {:?}", dist_dir);
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
        // Catch-all IPC bridge: dispatches unmatched /api/* paths to Tauri command handlers
        .fallback(api::ipc::handle_ipc_bridge);

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
