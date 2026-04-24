pub mod api;
pub mod auth;
pub mod error;
pub mod middleware;
pub mod router;
pub mod server;

use std::collections::HashMap;
use std::sync::MutexGuard;

use crate::state::{PendingPlan, PendingQuestion};
use crate::services::config_store::ConfigStore;
use crate::AppState;
use error::WebError;

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
}

#[cfg(test)]
mod integration_tests;
