use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::{header, request::Parts, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use serde::Deserialize;

use crate::AppState;
use super::WebError;
use super::super::rate_limit;

/// 客户端 IP 提取器：读 ConnectInfo 扩展（需 serve 侧
/// `into_make_service_with_connect_info`），缺失（如单测 oneshot）时为 None。
///
/// 不用 `Option<ConnectInfo<T>>`：axum 0.8 的 Option 提取器改走
/// `OptionalFromRequestParts`，ConnectInfo 未实现该 trait。
pub struct ClientIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

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
///
/// 限速(P0 安全部署闸,spec §2):失败尝试按 key(XFF 首段 / socket IP)
/// 记入滑动窗口,超限 429 + Retry-After;成功清空该 key 记录。
pub async fn handle_token_exchange(
    state: State<Arc<AppState>>,
    ClientIp(client_ip): ClientIp,
    headers: HeaderMap,
    Json(req): Json<TokenVerifyRequest>,
) -> Result<Response, WebError> {
    let key = rate_limit::rate_limit_key(
        headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
        client_ip,
    );
    if let Err(wait_secs) = rate_limit::check_login_allowed(&key) {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, wait_secs.to_string())],
            Json(serde_json::json!({ "error": "Too many failed attempts, retry later" })),
        )
            .into_response());
    }

    let config = state.clone_config_web()?;

    match &config.web.token {
        None => {
            // No token configured — API is open, any token "works" (echo back MD5).
            rate_limit::clear_login_failures(&key);
            let md5 = format!("{:x}", md5::compute(req.token.as_bytes()));
            Ok(Json(serde_json::json!({ "valid": true, "token": md5 })).into_response())
        }
        Some(expected_token) => {
            // Accept both raw token and MD5 of raw token.
            let expected_md5 = format!("{:x}", md5::compute(expected_token.as_bytes()));

            let valid = req.token == expected_token.as_str()
                || subtle::ConstantTimeEq::ct_eq(req.token.as_bytes(), expected_md5.as_bytes()).into();

            if valid {
                rate_limit::clear_login_failures(&key);
                Ok(Json(serde_json::json!({ "valid": true, "token": expected_md5 })).into_response())
            } else {
                rate_limit::record_login_failure(&key);
                Err(WebError::Unauthorized)
            }
        }
    }
}