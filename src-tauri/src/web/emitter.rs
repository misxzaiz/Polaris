// EventEmitter trait — abstraction for shared business logic
// TODO: implement TauriEmitter, WsEmitter, CompositeEmitter

use async_trait::async_trait;

#[async_trait]
pub trait EventEmitter: Send + Sync {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String>;
}
