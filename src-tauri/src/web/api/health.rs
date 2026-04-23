use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;

use crate::AppState;

/// `GET /api/health` — lightweight liveness probe (no auth required).
pub async fn handle_health(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let uptime = state.start_time
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);

    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime,
    }))
}
