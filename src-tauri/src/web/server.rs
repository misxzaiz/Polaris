use std::sync::Arc;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::AppState;
use super::router::create_router;

const ENV_WEB_PORT: &str = "POLARIS_WEB_PORT";

/// Maximum number of ports to try when the configured port is occupied.
const MAX_PORT_ATTEMPTS: u16 = 10;

/// Handle to a running web server, allowing graceful shutdown.
pub struct WebServerHandle {
    /// Token to signal graceful shutdown.
    pub shutdown: CancellationToken,
    /// Join handle for the spawned server task.
    pub task: JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>,
    /// The actual port the server bound to.
    /// May differ from the configured port if automatic fallback occurred.
    pub actual_port: u16,
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
    ///
    /// Uses two-phase binding: bind the listener first, then spawn the server task,
    /// so the actual port is known immediately.
    pub async fn start(self, addr: &str) -> Result<WebServerHandle, Box<dyn std::error::Error + Send + Sync>> {
        let shutdown = self.shutdown.clone();
        let state = self.state.clone();

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("[Web] Failed to bind to {}: {}", addr, e);
                return Err(e.into());
            }
        };
        let local_addr = listener.local_addr()?;
        let actual_port = local_addr.port();
        tracing::info!("[Web] Server listening on {}", local_addr);

        let task = tokio::spawn(async move {
            let app = create_router(state);
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

        Ok(WebServerHandle {
            shutdown: self.shutdown,
            task,
            actual_port,
        })
    }

    /// Bind with automatic port fallback.
    ///
    /// If `start_port` is occupied, tries `start_port + 1`, `start_port + 2`, etc.
    /// up to `MAX_PORT_ATTEMPTS` ports. Returns both the server handle and the
    /// actual port that was successfully bound.
    ///
    /// The router is created inside the spawned task to keep the same pattern
    /// as `start()`, avoiding type inference issues with axum middleware layers.
    pub async fn start_with_fallback(
        self,
        host: &str,
        start_port: u16,
    ) -> Result<(WebServerHandle, u16), Box<dyn std::error::Error + Send + Sync>> {
        let shutdown = self.shutdown.clone();
        let state = self.state.clone();
        let host_owned = host.to_string();

        // Phase 1: find an available port
        let mut bound_listener = None;
        let mut actual_port: u16 = 0;

        for offset in 0..MAX_PORT_ATTEMPTS {
            let port = match start_port.checked_add(offset) {
                Some(p) => p,
                None => break,
            };
            let addr = format!("{}:{}", host, port);

            match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => {
                    bound_listener = Some(l);
                    actual_port = port;
                    break;
                }
                Err(e) => {
                    if offset == 0 {
                        tracing::warn!(
                            "[Web] Port {} occupied, trying fallback ports...",
                            start_port
                        );
                    }
                    if offset == MAX_PORT_ATTEMPTS - 1 {
                        tracing::error!(
                            "[Web] Failed to bind {} after {} attempts (ports {}-{}): {}",
                            host,
                            MAX_PORT_ATTEMPTS,
                            start_port,
                            port,
                            e
                        );
                        return Err(e.into());
                    }
                }
            }
        }

        let listener = bound_listener.ok_or_else(|| {
            let msg = format!(
                "[Web] No available port found in range {}-{}",
                start_port,
                start_port.saturating_add(MAX_PORT_ATTEMPTS - 1)
            );
            tracing::error!("{}", msg);
            Box::new(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                msg,
            )) as Box<dyn std::error::Error + Send + Sync>
        })?;

        tracing::info!("[Web] Server listening on {}:{}", host_owned, actual_port);

        // Phase 2: spawn the server task — router created inside spawn
        let task = tokio::spawn(async move {
            let app = create_router(state);
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

        Ok((
            WebServerHandle {
                shutdown: self.shutdown,
                task,
                actual_port,
            },
            actual_port,
        ))
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

    #[test]
    fn max_port_attempts_is_reasonable() {
        assert!(MAX_PORT_ATTEMPTS >= 3 && MAX_PORT_ATTEMPTS <= 100);
    }
}
