// Token-based authentication for Web Access Layer

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request};
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use crate::AppState;
use super::error::WebError;

/// Generate a random 32-char hex token (UUID v4, hyphens removed).
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

/// Resolve the effective token: use configured value if present, otherwise generate.
pub fn resolve_token(configured_token: Option<&str>) -> String {
    match configured_token {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => generate_token(),
    }
}

/// Extract bearer token from `Authorization: Bearer {token}` header.
pub fn extract_bearer_from_headers(headers: &axum::http::HeaderMap) -> &str {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

/// Extract token from `Authorization: Bearer {token}` header or `?token=` query param.
fn extract_token<B>(req: &Request<B>) -> Result<String, WebError> {
    let bearer = extract_bearer_from_headers(req.headers());
    if !bearer.is_empty() {
        return Ok(bearer.to_string());
    }

    // Fallback to query parameter (used by WebSocket upgrade and initial browser access)
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                return Ok(urlencoding::decode(token)
                    .map_err(|e| WebError::Internal(format!("Invalid token encoding: {}", e)))?
                    .into_owned());
            }
        }
    }

    Err(WebError::Unauthorized)
}

/// Whether authentication should be enforced for this path+method combination.
pub fn is_auth_required(path: &str, method: &Method) -> bool {
    // Static files (SPA): skip all GET that don't start with /api
    if method == Method::GET && !path.starts_with("/api") {
        return false;
    }
    // Token verification endpoint
    if path == "/api/auth/verify" {
        return false;
    }
    // Health check endpoint
    if path == "/api/health" {
        return false;
    }
    // Token exchange endpoint
    if path == "/api/auth/token" && method == Method::POST {
        return false;
    }
    // Token regeneration requires auth (not bypassed)
    true
}

/// Axum middleware: validate Bearer token on protected API routes.
///
/// Reads the expected token from `AppState.config_store → Config.web.token`.
/// The mutex lock is brief (clone a String), acceptable for LAN MVP throughput.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, WebError> {
    let path = req.uri().path();
    let method = req.method().clone();

    if !is_auth_required(path, &method) {
        return Ok(next.run(req).await);
    }

    let provided = extract_token(&req)?;

    let expected = {
        let store = state.config_store.lock()
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().web.token.clone().unwrap_or_default()
    };

    if expected.is_empty() {
        return Err(WebError::Internal("Web server token not configured".to_string()));
    }

    if provided.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() == 1 {
        Ok(next.run(req).await)
    } else {
        Err(WebError::Unauthorized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_token_is_32_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_token_is_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
    }

    #[test]
    fn resolve_token_uses_configured_value() {
        let token = resolve_token(Some("my-custom-token"));
        assert_eq!(token, "my-custom-token");
    }

    #[test]
    fn resolve_token_generates_when_none() {
        let token = resolve_token(None);
        assert_eq!(token.len(), 32);
    }

    #[test]
    fn resolve_token_generates_when_empty() {
        let token = resolve_token(Some(""));
        assert_eq!(token.len(), 32);
    }

    #[test]
    fn auth_not_required_for_static_files() {
        assert!(!is_auth_required("/index.html", &Method::GET));
        assert!(!is_auth_required("/assets/main.js", &Method::GET));
        assert!(!is_auth_required("/", &Method::GET));
    }

    #[test]
    fn auth_not_required_for_verify_endpoint() {
        assert!(!is_auth_required("/api/auth/verify", &Method::GET));
    }

    #[test]
    fn auth_not_required_for_health() {
        assert!(!is_auth_required("/api/health", &Method::GET));
    }

    #[test]
    fn auth_not_required_for_token_exchange() {
        assert!(!is_auth_required("/api/auth/token", &Method::POST));
    }

    #[test]
    fn auth_required_for_api_routes() {
        assert!(is_auth_required("/api/chat/send", &Method::POST));
        assert!(is_auth_required("/api/sessions", &Method::GET));
        assert!(is_auth_required("/api/settings", &Method::PATCH));
    }

    #[test]
    fn auth_required_for_token_get() {
        // GET /api/auth/token still requires auth (only POST is whitelisted)
        assert!(is_auth_required("/api/auth/token", &Method::GET));
    }

    #[test]
    fn extract_token_url_decodes_query_param() {
        use axum::http::Request;

        // Simulate a URL-encoded token with a + character
        let req = Request::builder()
            .uri("/api/ws?token=my%2Bcustom%3Dtoken")
            .body(())
            .unwrap();
        let token = extract_token(&req).unwrap();
        assert_eq!(token, "my+custom=token");
    }

    #[test]
    fn extract_token_hex_token_unchanged() {
        use axum::http::Request;

        let req = Request::builder()
            .uri("/api/ws?token=abc123def456")
            .body(())
            .unwrap();
        let token = extract_token(&req).unwrap();
        assert_eq!(token, "abc123def456");
    }
}
