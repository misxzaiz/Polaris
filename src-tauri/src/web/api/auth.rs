use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use super::super::auth;
use super::super::error::WebError;

pub async fn handle_verify_token(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, WebError> {
    let expected = {
        let store = state.config_store.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().web.token.clone().unwrap_or_default()
    };

    let provided = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    Ok(Json(serde_json::json!({ "valid": provided == expected })))
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

/// Generate a new token and persist it. Requires current valid token.
pub async fn handle_regenerate_token(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, WebError> {
    // Validate current token first
    let expected = {
        let store = state.config_store.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().web.token.clone().unwrap_or_default()
    };
    let provided = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    if provided != expected {
        return Err(WebError::Unauthorized);
    }

    // Generate new token and persist
    let new_token = auth::generate_token();
    {
        let mut store = state.config_store.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        let mut config = store.get().clone();
        config.web.token = Some(new_token.clone());
        store.update(config)
            .map_err(|e| WebError::Internal(e.to_string()))?;
    }

    Ok(Json(serde_json::json!({ "token": new_token })))
}
