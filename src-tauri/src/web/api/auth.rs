use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use super::super::auth;
use super::WebError;

/// Verify if the provided Bearer token is valid.
pub async fn handle_verify_token(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, WebError> {
    let expected = auth::get_expected_token(&state)?;
    let provided = auth::extract_bearer_from_headers(&headers);
    Ok(Json(serde_json::json!({ "valid": auth::token_eq(provided, &expected) })))
}

#[derive(Debug, Deserialize)]
pub struct TokenRequest {
    pub token: Option<String>,
}

/// Exchange an existing token for confirmation (no-auth endpoint).
///
/// Special case: if the server has no token configured yet (e.g. auto-started
/// without the Tauri setup flow), this endpoint accepts the provided token as
/// the new expected token and persists it. This allows the TokenAuthPage to
/// bootstrap authentication on first access.
pub async fn handle_token_exchange(
    State(state): State<Arc<AppState>>,
    axum::Json(req): axum::Json<TokenRequest>,
) -> Result<impl IntoResponse, WebError> {
    // Use get_raw_token to check if server has a token WITHOUT triggering auto-generation.
    // This allows the bootstrap flow (first access with no token) to work correctly.
    let expected = auth::get_raw_token(&state)?;

    // Normal case: server already has a configured token — verify the provided one
    if !expected.is_empty() {
        if let Some(provided) = req.token {
            if auth::token_eq(&provided, &expected) {
                Ok(Json(serde_json::json!({ "token": expected, "valid": true })))
            } else {
                Err(WebError::Unauthorized)
            }
        } else {
            Err(WebError::BadRequest("Missing token field".to_string()))
        }
    } else {
        // Bootstrap case: no token on server — accept the provided token as the new one
        if let Some(provided) = req.token {
            if !provided.is_empty() {
                {
                    let mut store = state.lock_config()?;
                    let mut config = store.get().clone();
                    config.web.token = Some(provided.clone());
                    store.update(config)?;
                }
                tracing::info!("[Web] Bootstrapped web token from client");
                Ok(Json(serde_json::json!({ "token": provided, "valid": true })))
            } else {
                Err(WebError::BadRequest("Token must not be empty for initial setup".to_string()))
            }
        } else {
            Err(WebError::BadRequest("Missing token field".to_string()))
        }
    }
}

/// Regenerate the web access token. Requires current valid token (enforced by middleware).
pub async fn handle_regenerate_token(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let new_token = auth::generate_token();
    {
        let mut store = state.lock_config()?;
        let mut config = store.get().clone();
        config.web.token = Some(new_token.clone());
        store.update(config)?;
    }

    Ok(Json(serde_json::json!({ "token": new_token })))
}
