use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::extract::State;
use std::sync::Arc;

use crate::AppState;

/// Lightweight request tracing: logs method, path, status code, and duration.
pub async fn request_trace(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let start = std::time::Instant::now();

    let response = next.run(req).await;

    let elapsed = start.elapsed();
    let status = response.status().as_u16();

    if path.starts_with("/api/") {
        if status >= 500 {
            tracing::error!(
                method = %method,
                path = %path,
                status = status,
                elapsed_ms = elapsed.as_millis() as u64,
                "HTTP request"
            );
        } else if status >= 400 {
            tracing::warn!(
                method = %method,
                path = %path,
                status = status,
                elapsed_ms = elapsed.as_millis() as u64,
                "HTTP request"
            );
        } else {
            tracing::debug!(
                method = %method,
                path = %path,
                status = status,
                elapsed_ms = elapsed.as_millis() as u64,
                "HTTP request"
            );
        }
    }

    response
}

/// Paths that skip auth validation (health, auth endpoints).
/// WebSocket auth is handled separately via query parameter in ws_handler.
///
/// Note: In Axum nested routers (.nest("/api", ...)), the prefix is stripped before
/// the inner router processes the request. So /api/ws becomes /ws inside the
/// nested handler. We must match BOTH forms to cover all cases.
fn is_auth_skipped_path(path: &str) -> bool {
    matches!(
        path,
        "/api/health"
            | "/health"
            | "/api/ws"
            | "/ws"
            | "/api/auth/verify"
            | "/auth/verify"
            | "/api/auth/token"
            | "/auth/token"
    ) || path.starts_with("/api/artifacts/codex-images/")
        || path.starts_with("/artifacts/codex-images/")
}

/// Extract the token value from an `Authorization: Bearer <value>` header.
fn parse_bearer_token(header: &str) -> Option<&str> {
    let header = header.trim();
    header.strip_prefix("Bearer ")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

/// Compute the lowercase hex MD5 of a string.
fn md5_hex(input: &str) -> String {
    format!("{:x}", md5::compute(input.as_bytes()))
}

/// API auth middleware — validates `Authorization: Bearer <md5_of_token>` against config.web.token.
///
/// Flow:
/// 1. If `config.web.token` is None → API is open (no auth required).
/// 2. If token is set, compute `md5(config.web.token)` and compare against
///    the Bearer value using constant-time comparison.
/// 3. Skip auth for `/api/health`, `/api/ws`, `/api/auth/verify`, `/api/auth/token`.
pub async fn api_auth(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();
    if is_auth_skipped_path(path) {
        return next.run(req).await;
    }

    let required = match state.clone_config_web().map(|c| c.web.token) {
        Ok(token_opt) => token_opt,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "{\"error\":\"Internal error\"}").into_response(),
    };

    // Token 为 None 或空字符串均视为未设置 → API 开放（无鉴权）。
    // Serde 反序列化时 `"token": ""` 会产生 `Some("")`，需归一化。
    let Some(raw_token) = required.filter(|t| !t.is_empty()) else {
        return next.run(req).await;
    };

    // Frontend sends MD5 of the raw token; compute the expected MD5 server-side.
    let expected_md5 = md5_hex(&raw_token);

    let header = req.headers().get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_bearer_token);

    let ok = header.is_some_and(|t| {
        subtle::ConstantTimeEq::ct_eq(t.as_bytes(), expected_md5.as_bytes()).into()
    });

    if !ok {
        return (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({"error": "Unauthorized"}))).into_response();
    }

    next.run(req).await
}
