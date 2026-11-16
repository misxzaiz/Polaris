//! 传输无关回调类型（K-R6 自 ai_chat_core.rs 迁入）

use std::path::PathBuf;
use std::sync::Arc;

// ============================================================================
// Transport-agnostic callback types (shared by Tauri commands & HTTP handlers)
// ============================================================================

/// Application paths needed for MCP config resolution, decoupled from Window.
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
}

/// Callbacks for chat event emission, abstracting over transport (Tauri Window vs HTTP/WS).
pub struct ChatCallbacks {
    /// Emit a chat-event JSON payload to all connected clients.
    pub emit_event: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
    /// Show a desktop notification when AI reply completes (no-op for web-only clients).
    pub notify_complete: Arc<dyn Fn() + Send + Sync>,
}
