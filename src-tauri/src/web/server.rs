use std::sync::Arc;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::AppState;
use super::router::create_router;

const ENV_WEB_PORT: &str = "POLARIS_WEB_PORT";

/// Handle to a running web server, allowing graceful shutdown.
pub struct WebServerHandle {
    /// Token to signal graceful shutdown.
    pub shutdown: CancellationToken,
    /// Join handle for the spawned server task.
    pub task: JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>,
}

/// Web server managing the HTTP/WS lifecycle for LAN browser access.
pub struct WebServer {
    state: Arc<AppState>,
    shutdown: CancellationToken,
}

impl WebServer {
    pub fn new(state: Arc<AppState>) -> Self {
        Self {
            state,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Resolve effective port: `POLARIS_WEB_PORT` env var overrides config.
    pub fn resolve_port(config_port: u16) -> u16 {
        std::env::var(ENV_WEB_PORT)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(config_port)
    }

    /// Bind to `addr` and serve until cancelled or fatal error.
    /// Returns a `WebServerHandle` for lifecycle management (graceful shutdown).
    pub fn start(self, addr: &str) -> WebServerHandle {
        let shutdown = self.shutdown.clone();
        let state = self.state.clone();
        let addr = addr.to_string();

        let task = tokio::spawn(async move {
            let app = create_router(state);
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("[Web] Failed to bind to {}: {}", addr, e);
                    return Err(e.into());
                }
            };
            let local_addr = listener.local_addr()?;
            tracing::info!("[Web] Server listening on {}", local_addr);

            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;

            if let Err(e) = &result {
                tracing::error!("[Web] Server error: {}", e);
            } else {
                tracing::info!("[Web] Server shut down gracefully");
            }

            result.map_err(|e| e.into())
        });

        WebServerHandle {
            shutdown: self.shutdown,
            task,
        }
    }

    /// Signal the server to shut down gracefully.
    pub fn cancel(&self) {
        self.shutdown.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_port_uses_config_when_no_env() {
        // Ensure env var is not set
        std::env::remove_var(ENV_WEB_PORT);
        assert_eq!(WebServer::resolve_port(9800), 9800);
    }

    #[test]
    fn resolve_port_env_overrides_config() {
        std::env::set_var(ENV_WEB_PORT, "8080");
        assert_eq!(WebServer::resolve_port(9800), 8080);
        std::env::remove_var(ENV_WEB_PORT);
    }

    #[test]
    fn resolve_port_ignores_invalid_env() {
        std::env::set_var(ENV_WEB_PORT, "not-a-number");
        assert_eq!(WebServer::resolve_port(9800), 9800);
        std::env::remove_var(ENV_WEB_PORT);
    }
}
