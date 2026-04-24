pub mod api;
pub mod auth;
pub mod error;
pub mod middleware;
pub mod router;
pub mod server;

use std::collections::HashMap;
use std::sync::MutexGuard;

use serde::Deserialize;

use crate::state::{PendingPlan, PendingQuestion};
use crate::services::config_store::ConfigStore;
use crate::AppState;
use error::WebError;

/// Shared query parameter struct for paginated endpoints.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginationQuery {
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

/// Parse pagination parameters with consistent defaults and bounds.
/// Defaults: page=1, page_size=50. Bounds: page≥1, page_size clamped to [1, 200].
pub fn parse_pagination(query: &PaginationQuery) -> crate::ai::Pagination {
    crate::ai::Pagination::new(
        query.page.unwrap_or(1).max(1),
        query.page_size.unwrap_or(50).clamp(1, 200),
    )
}

/// Web-specific lock helpers — consolidate the `lock().map_err(WebError::Internal)` pattern.
impl AppState {
    pub fn lock_config(&self) -> Result<MutexGuard<'_, ConfigStore>, WebError> {
        self.config_store.lock().map_err(|e| WebError::Internal(e.to_string()))
    }

    pub fn lock_pending_questions(&self) -> Result<MutexGuard<'_, HashMap<String, PendingQuestion>>, WebError> {
        self.pending_questions.lock().map_err(|e| WebError::Internal(e.to_string()))
    }

    pub fn lock_pending_plans(&self) -> Result<MutexGuard<'_, HashMap<String, PendingPlan>>, WebError> {
        self.pending_plans.lock().map_err(|e| WebError::Internal(e.to_string()))
    }

    /// Clone the current config, returning a WebError directly.
    /// Eliminates the `.map_err(WebError::Internal)` at every call site.
    pub fn clone_config_web(&self) -> Result<crate::models::config::Config, WebError> {
        self.clone_config().map_err(WebError::Internal)
    }
}

/// Validate that a session ID is safe to use (no path traversal, no special chars).
/// Session IDs should be alphanumeric with hyphens/underscores only (UUIDs, slugs).
pub fn validate_session_id(id: &str) -> Result<(), WebError> {
    validate_entity_id(id, "sessionId")
}

/// Validate a call/plan ID (alphanumeric + hyphens/underscores, max 128 chars).
pub fn validate_entity_id(id: &str, field: &str) -> Result<(), WebError> {
    if id.is_empty() {
        return Err(WebError::BadRequest(format!("{} must not be empty", field)));
    }
    if id.len() > 128 {
        return Err(WebError::BadRequest(format!("{} too long (max 128 chars)", field)));
    }
    if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(WebError::BadRequest(format!("{} contains invalid characters", field)));
    }
    Ok(())
}

#[cfg(test)]
mod integration_tests;
