// WebServer lifecycle management
// TODO: implement start/stop, graceful shutdown, CancellationToken

use std::sync::Arc;

use crate::AppState;
use super::router::create_router;

pub struct WebServer {
    state: Arc<AppState>,
}

impl WebServer {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    pub async fn start(self, addr: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let app = create_router(self.state);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        tracing::info!("Web server listening on {}", addr);
        axum::serve(listener, app).await?;
        Ok(())
    }
}
