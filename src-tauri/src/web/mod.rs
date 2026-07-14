pub mod api;
pub mod auth;
pub mod error;
pub mod event_broadcaster;
pub mod middleware;
pub mod router;
pub mod server;

pub use event_broadcaster::EventBroadcaster;

use std::collections::HashMap;
use std::sync::MutexGuard;

use serde::{Deserialize, Deserializer};

use crate::services::config_store::ConfigStore;
use crate::state::{PendingPlan, PendingQuestion};
use crate::AppState;
use error::WebError;

/// Deserialize an optional numeric field that may arrive as a string in query parameters.
/// Handles: `"1"` → `Some(1)`, `1` → `Some(1)`, absent → `None`, `""` → `None`.
fn deserialize_optional_usize<'de, D>(deserializer: D) -> Result<Option<usize>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .map(|v| Some(v as usize))
            .ok_or_else(|| serde::de::Error::custom("invalid number")),
        Some(serde_json::Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(serde_json::Value::String(s)) => s
            .trim()
            .parse::<usize>()
            .map(Some)
            .map_err(|_| serde::de::Error::custom(format!("invalid usize string: {s}"))),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected number or string, got {other}"
        ))),
    }
}

/// Shared query parameter struct for paginated endpoints.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginationQuery {
    #[serde(default, deserialize_with = "deserialize_optional_usize")]
    pub page: Option<usize>,
    #[serde(default, deserialize_with = "deserialize_optional_usize")]
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
        self.config_store
            .lock()
            .map_err(|e| WebError::Internal(e.to_string()))
    }

    pub fn lock_pending_questions(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<String, PendingQuestion>>, WebError> {
        self.pending_questions
            .lock()
            .map_err(|e| WebError::Internal(e.to_string()))
    }

    pub fn lock_pending_plans(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<String, PendingPlan>>, WebError> {
        self.pending_plans
            .lock()
            .map_err(|e| WebError::Internal(e.to_string()))
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
        return Err(WebError::BadRequest(format!(
            "{} too long (max 128 chars)",
            field
        )));
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(WebError::BadRequest(format!(
            "{} contains invalid characters",
            field
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json;

    #[derive(Debug, Deserialize)]
    struct TestQuery {
        #[serde(default, deserialize_with = "deserialize_optional_usize")]
        pub value: Option<usize>,
    }

    #[test]
    fn deserialize_string_number() {
        let q: TestQuery = serde_json::from_str(r#"{"value":"1"}"#).unwrap();
        assert_eq!(q.value, Some(1));
    }

    #[test]
    fn deserialize_actual_number() {
        let q: TestQuery = serde_json::from_str(r#"{"value":42}"#).unwrap();
        assert_eq!(q.value, Some(42));
    }

    #[test]
    fn deserialize_missing_field() {
        let q: TestQuery = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(q.value, None);
    }

    #[test]
    fn deserialize_null_field() {
        let q: TestQuery = serde_json::from_str(r#"{"value":null}"#).unwrap();
        assert_eq!(q.value, None);
    }

    #[test]
    fn deserialize_empty_string() {
        let q: TestQuery = serde_json::from_str(r#"{"value":""}"#).unwrap();
        assert_eq!(q.value, None);
    }

    #[test]
    fn deserialize_invalid_string() {
        let result: Result<TestQuery, _> = serde_json::from_str(r#"{"value":"abc"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn pagination_query_from_url_encoded() {
        // Simulate what serde_urlencoded produces from query string "page=1&pageSize=20"
        let json = r#"{"page":"1","pageSize":"20"}"#;
        let q: PaginationQuery = serde_json::from_str(json).unwrap();
        assert_eq!(q.page, Some(1));
        assert_eq!(q.page_size, Some(20));
    }

    #[test]
    fn pagination_query_empty() {
        let q: PaginationQuery = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(q.page, None);
        assert_eq!(q.page_size, None);
    }
}

#[cfg(test)]
mod integration_tests;
