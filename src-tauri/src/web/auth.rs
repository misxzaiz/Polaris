// Token-based authentication for Web Access Layer
// TODO: implement token generation, validation, middleware

use axum::http::Method;

/// Paths that skip authentication
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
    true
}
