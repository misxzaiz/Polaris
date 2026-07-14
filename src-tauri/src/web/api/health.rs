use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;

use crate::AppState;

/// `GET /api/health` — returns full `HealthStatus` including Claude CLI availability.
/// No auth required — this is a liveness + readiness probe.
pub async fn handle_health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let health = {
        let store = state.config_store.lock().unwrap_or_else(|e| e.into_inner());
        store.health_status()
    };

    Json(health)
}
