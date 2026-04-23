use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::AppState;
use super::router::create_router;

const ENV_WEB_PORT: &str = "POLARIS_WEB_PORT";

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
    pub async fn start(self, addr: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let shutdown = self.shutdown.clone();
        let app = create_router(self.state);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;
        tracing::info!("Web server listening on {}", local_addr);

        axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await?;

        tracing::info!("Web server shut down gracefully");
        Ok(())
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
