use std::sync::Arc;

use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;
use super::auth;
use super::api;

pub fn create_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

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
        .route("/sessions/{id}", delete(api::session::handle_delete_session).patch(api::session::handle_patch_session))
        // Settings
        .route("/settings", get(api::settings::handle_get_settings).patch(api::settings::handle_update_settings))
        // Auth
        .route("/auth/verify", get(api::auth::handle_verify_token))
        .route("/auth/token", post(api::auth::handle_token_exchange))
        // WebSocket
        .route("/ws", get(api::ws::ws_handler));

    Router::new()
        .nest("/api", api_routes)
        // SPA fallback: serve static files for non-/api paths
        .fallback_service(
            ServeDir::new("../dist")
                .not_found_service(ServeFile::new("../dist/index.html"))
        )
        .layer(middleware::from_fn_with_state(state.clone(), auth::auth_middleware))
        .layer(cors)
        .with_state(state)
}
