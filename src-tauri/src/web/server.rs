use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::AppState;
use super::router::create_router;

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

    pub fn cancel(&self) {
        self.shutdown.cancel();
    }
}
