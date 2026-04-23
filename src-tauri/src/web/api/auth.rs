use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

pub async fn handle_verify_token() -> Result<impl IntoResponse, WebError> {
    // If auth middleware passed, token is valid
    Ok(Json(serde_json::json!({ "valid": true })))
}

#[derive(Debug, Deserialize)]
pub struct TokenRequest {
    pub token: Option<String>,
}

pub async fn handle_token_exchange(
    State(state): State<Arc<AppState>>,
    axum::Json(req): axum::Json<TokenRequest>,
) -> Result<impl IntoResponse, WebError> {
    let expected = {
        let store = state.config_store.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().web.token.clone().unwrap_or_default()
    };

    if let Some(provided) = req.token {
        let valid = provided == expected;
        if valid {
            Ok(Json(serde_json::json!({ "token": expected, "valid": true })))
        } else {
            Err(WebError::Unauthorized)
        }
    } else {
        Err(WebError::BadRequest("缺少 token 字段".to_string()))
    }
}
