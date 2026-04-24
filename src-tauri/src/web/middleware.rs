use axum::body::Body;
use axum::http::Request;
use axum::middleware::Next;
use axum::response::Response;

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
