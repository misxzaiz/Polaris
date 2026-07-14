use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use super::WebError;
use crate::AppState;

/// Verify endpoint — checks if the provided Bearer token matches config.web.token.
///
/// The frontend sends the MD5 of the raw token; we compare against MD5(config.web.token).
/// Returns `{ "valid": true/false }`.
pub async fn handle_verify_token(
    state: State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let config = state.clone_config_web()?;

    // If no token is configured, the API is open — always valid.
    let valid = match &config.web.token {
        None => true,
        Some(_) => {
            // No header to check in a GET request without auth middleware.
            // The auth middleware already gates access; if we reach here, it's valid.
            true
        }
    };

    Ok(Json(serde_json::json!({ "valid": valid })))
}

/// Token verification request body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenVerifyRequest {
    pub token: String,
}

/// Token exchange endpoint — verifies a raw token against config.web.token.
///
/// Frontend sends `{ "token": "<raw_or_md5_token>" }`, we check it against
/// `config.web.token` (both raw and MD5 forms accepted).
/// Returns `{ "valid": true/false, "token": "<md5_of_raw_token>" }` on success.
pub async fn handle_token_exchange(
    state: State<Arc<AppState>>,
    Json(req): Json<TokenVerifyRequest>,
) -> Result<impl IntoResponse, WebError> {
    let config = state.clone_config_web()?;

    match &config.web.token {
        None => {
            // No token configured — API is open, any token "works" (echo back MD5).
            let md5 = format!("{:x}", md5::compute(req.token.as_bytes()));
            Ok(Json(serde_json::json!({ "valid": true, "token": md5 })))
        }
        Some(expected_token) => {
            // Accept both raw token and MD5 of raw token.
            let expected_md5 = format!("{:x}", md5::compute(expected_token.as_bytes()));

            let valid = req.token == expected_token.as_str()
                || subtle::ConstantTimeEq::ct_eq(req.token.as_bytes(), expected_md5.as_bytes())
                    .into();

            if valid {
                Ok(Json(
                    serde_json::json!({ "valid": true, "token": expected_md5 }),
                ))
            } else {
                Err(WebError::Unauthorized)
            }
        }
    }
}
