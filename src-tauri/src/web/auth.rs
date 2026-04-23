// Token-based authentication for Web Access Layer

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request};
use axum::middleware::Next;
use axum::response::Response;

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

/// Extract token from `Authorization: Bearer {token}` header or `?token=` query param.
fn extract_token<B>(req: &Request<B>) -> Result<String, WebError> {
    // Authorization header takes precedence
    if let Some(auth) = req.headers().get("Authorization") {
        if let Ok(val) = auth.to_str() {
            if let Some(token) = val.strip_prefix("Bearer ") {
                return Ok(token.to_string());
            }
        }
    }

    // Fallback to query parameter (used by WebSocket upgrade and initial browser access)
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                return Ok(token.to_string());
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
        let store = state.config_store.lock().unwrap_or_else(|e| e.into_inner());
        store.get().web.token.clone().unwrap_or_default()
    };

    if provided != expected {
        return Err(WebError::Unauthorized);
    }

    Ok(next.run(req).await)
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
}
