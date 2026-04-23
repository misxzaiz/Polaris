use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use subtle::ConstantTimeEq;

use crate::AppState;
use super::super::auth;
use super::super::error::WebError;

fn token_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).unwrap_u8() == 1
}

/// Verify if the provided Bearer token is valid.
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

    Ok(Json(serde_json::json!({ "valid": token_eq(provided, &expected) })))
}

#[derive(Debug, Deserialize)]
pub struct TokenRequest {
    pub token: Option<String>,
}

/// Exchange an existing token for confirmation (no-auth endpoint).
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
        if token_eq(&provided, &expected) {
            Ok(Json(serde_json::json!({ "token": expected, "valid": true })))
        } else {
            Err(WebError::Unauthorized)
        }
    } else {
        Err(WebError::BadRequest("缺少 token 字段".to_string()))
    }
}

/// Regenerate the web access token. Requires current valid token.
pub async fn handle_regenerate_token(
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

    if !token_eq(provided, &expected) {
        return Err(WebError::Unauthorized);
    }

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
