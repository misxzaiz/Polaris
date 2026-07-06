use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use axum::http::Method;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;
use super::api;
use super::middleware::{api_auth, request_trace};

/// Resolve the frontend dist directory for static file serving.
///
/// Priority (first match wins):
/// 1. `resource_dir/dist/` — Tauri bundles directory resources as subdirectories
/// 2. `resource_dir/` — Tauri may copy dist *contents* flat into resource_dir
/// 3. Exe-relative paths — production fallback when CWD ≠ install dir
///    a. `<exe_dir>/dist/`
///    b. `<exe_dir>/resources/dist/`
///    c. `<exe_dir>/../dist/`
/// 4. CWD-relative paths — development fallback
///    a. `../dist` (running from src-tauri/)
///    b. `./dist` (running from project root)
fn resolve_dist_dir(state: &AppState) -> std::path::PathBuf {
    // Layer 1: resource_dir (production bundle via Tauri path resolver)
    if let Some(Some(resource_dir)) = state.resource_dir.get().as_ref() {
        // Tauri bundles directory resources as subdirectories: resources/dist/
        let dist = resource_dir.join("dist");
        if dist.is_dir() {
            tracing::info!("[Web] SPA dist resolved via resource_dir/dist: {:?}", dist);
            return dist;
        }
        // Tauri may copy dist *contents* flat into resource_dir (version-dependent behavior)
        let index_html = resource_dir.join("index.html");
        if index_html.exists() {
            tracing::info!("[Web] SPA dist resolved via resource_dir (flat): {:?}", resource_dir);
            return resource_dir.clone();
        }
        tracing::debug!(
            "[Web] resource_dir exists but no dist found. resource_dir={:?}, checked={:?} and {:?}",
            resource_dir, dist, index_html
        );
    } else {
        tracing::debug!("[Web] resource_dir not available (None or unset), trying exe-relative paths");
    }

    // Layer 2: Exe-relative paths (production fallback — CWD may not be install dir)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Check standard locations first
            for candidate in &["dist", "resources/dist"] {
                let path = exe_dir.join(candidate);
                if path.is_dir() {
                    tracing::info!("[Web] SPA dist resolved via exe-relative: {:?}", path);
                    return path;
                }
            }
            
            // CRITICAL: Check Tauri's _up_ directory (MSI bundle format for ../dist)
            // In MSI installations, Tauri bundles "../dist" as "_up_/dist"
            // Example: D:\app\polaris\_up_\dist
            let up_dist = exe_dir.join("_up_/dist");
            if up_dist.is_dir() {
                tracing::info!("[Web] SPA dist resolved via Tauri _up_ path: {:?}", up_dist);
                return up_dist;
            }
            
            // Also try one level up (for Cargo-style layouts)
            if let Some(parent) = exe_dir.parent() {
                let candidate = parent.join("dist");
                if candidate.is_dir() {
                    tracing::info!("[Web] SPA dist resolved via exe-parent-relative: {:?}", candidate);
                    return candidate;
                }
            }
        }
    }

    // Layer 3: CWD-relative paths (development fallback)
    for candidate in ["../dist", "./dist"] {
        let path = std::path::PathBuf::from(candidate);
        if path.is_dir() {
            tracing::info!("[Web] SPA dist resolved via CWD-relative: {:?}", path);
            return path;
        }
    }

    // Last resort: log a detailed error and return a path that will cause ServeDir to 404.
    // This path is intentionally non-existent so the SPA fallback (ServeFile) also 404s,
    // making the failure immediately visible.
    tracing::error!(
        "[Web] CRITICAL: No SPA dist directory found. Web UI will return 404 for all requests. \
         Check that the application is properly installed and the dist/ directory exists. \
         CWD={:?}, exe={:?}",
        std::env::current_dir().ok(),
        std::env::current_exe().ok()
    );
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
        .route("/chat/respond-plugin-card", post(api::chat::handle_respond_plugin_card))
        .route("/chat/approve-plan", post(api::chat::handle_approve_plan))
        .route("/chat/reject-plan", post(api::chat::handle_reject_plan))
        // Artifacts
        .route("/artifacts/codex-images/{thread_id}/{file_name}", get(api::artifacts::handle_codex_image_artifact))
        // Sessions
        .route("/sessions", get(api::session::handle_list_sessions).post(api::session::handle_create_session))
        .route("/sessions/{id}", delete(api::session::handle_delete_session))
        // Legacy Claude Code session endpoints (return flat arrays, not PagedResult)
        .route("/claude-sessions", get(api::session::handle_list_claude_sessions))
        .route("/claude-sessions/{session_id}/history", get(api::session::handle_get_claude_session_history))
        // Settings
        .route("/settings", get(api::settings::handle_get_settings).patch(api::settings::handle_update_settings))
        // Auth
        .route("/auth/verify", get(api::auth::handle_verify_token))
        .route("/auth/token", post(api::auth::handle_token_exchange))
        // Health
        .route("/health", get(api::health::handle_health))
        // WebSocket
        .route("/ws", get(api::ws::ws_handler))
        // Catch-all IPC bridge: dispatches unmatched /api/* paths to Tauri command handlers
        .fallback(api::ipc::handle_ipc_bridge);

    let index_html = dist_dir.join("index.html");

    Router::new()
        // Auth middleware only applies to /api/* routes (SPA static files are public)
        .nest("/api", api_routes.layer(axum::middleware::from_fn_with_state(state.clone(), api_auth)))
        // SPA fallback: serve static files for non-/api paths — no auth needed
        .fallback_service(
            ServeDir::new(&dist_dir)
                .not_found_service(ServeFile::new(&index_html))
        )
        .layer(axum::middleware::from_fn(request_trace))
        .layer(cors)
        .with_state(state)
}
