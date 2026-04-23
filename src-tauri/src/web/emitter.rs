use async_trait::async_trait;
use serde_json::json;
use tauri::Emitter;
use tokio::sync::broadcast;

/// Event emission abstraction — decouples business logic from transport.
///
/// All `*_inner()` functions accept `&dyn EventEmitter` so the same logic
/// can emit to Tauri webview, WebSocket clients, or both simultaneously.
#[async_trait]
pub trait EventEmitter: Send + Sync {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String>;
}

/// Emits events to the Tauri webview via `AppHandle::emit()`.
pub struct TauriEmitter {
    app: tauri::AppHandle,
}

impl TauriEmitter {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl EventEmitter for TauriEmitter {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String> {
        let event_name = format!("{}:{}", event_type, context_id);
        self.app
            .emit(&event_name, payload)
            .map_err(|e| format!("Tauri emit error: {}", e))
    }
}

/// Emits events to all connected WebSocket clients via broadcast channel.
pub struct WsEmitter {
    tx: broadcast::Sender<String>,
}

impl WsEmitter {
    pub fn new(tx: broadcast::Sender<String>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl EventEmitter for WsEmitter {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String> {
        let msg = json!({
            "event": event_type,
            "contextId": context_id,
            "payload": payload,
        });
        // broadcast::send ignores receiver-lag errors (no active receivers is OK)
        let _ = self.tx.send(msg.to_string());
        Ok(())
    }
}

/// Fires both Tauri and WebSocket channels simultaneously.
///
/// Ensures desktop-initiated chats reach WS clients and
/// web-initiated chats reach the webview.
pub struct CompositeEmitter<'a> {
    tauri: &'a TauriEmitter,
    ws: &'a WsEmitter,
}

impl<'a> CompositeEmitter<'a> {
    pub fn new(tauri: &'a TauriEmitter, ws: &'a WsEmitter) -> Self {
        Self { tauri, ws }
    }
}

#[async_trait]
impl<'a> EventEmitter for CompositeEmitter<'a> {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String> {
        let (r1, r2) = tokio::join!(
            self.tauri.emit(context_id, event_type, payload),
            self.ws.emit(context_id, event_type, payload),
        );
        r1.or(r2)
    }
}
