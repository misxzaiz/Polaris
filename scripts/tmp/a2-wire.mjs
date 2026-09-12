// A2 接线：capability 路径 + RouterBus 大容量订阅 + state.rs 注册清理
import fs from 'node:fs'

let p = 'src-tauri/src/services/router/ai_chat_capability.rs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace('use crate::ai_chat_core as core;', 'use crate::services::ai_chat_core as core;')
fs.writeFileSync(p, s)

p = 'src-tauri/src/services/router/mod.rs'
s = fs.readFileSync(p, 'utf8')
const anchor = `    /// 目标是否为已注册的流式能力
    pub fn is_streaming(&self, target: &CapabilityId) -> bool {
        self.streaming_caps.read().unwrap().contains_key(target)
    }`
if (!s.includes(anchor)) throw new Error('is_streaming anchor')
s = s.replace(
  anchor,
  anchor + `

    /// 大容量订阅（桌面 chat-event 中继用：高频 token 流防丢）
    pub fn subscribe_with_capacity(
        &self,
        capacity: usize,
        filter: Filter,
    ) -> tokio::sync::mpsc::Receiver<Event> {
        self.broadcaster.subscribe_with_capacity(capacity, filter)
    }`,
)
fs.writeFileSync(p, s)

p = 'src-tauri/src/state.rs'
s = fs.readFileSync(p, 'utf8')
s = s.replace(
  `        // cap.ai.chat —— 第一个真实流式能力：引擎句柄自持，chat-event 兼容事件泵
        let _ = bus.register_streaming(Arc::new(AiChatCapability::new(engine_registry.clone())));`,
  `        // cap.ai.chat —— 第七步阶段 A2 起在 lib.rs 装配点注册（需 Arc<AppState>）`,
)
s = s.replace(
  `        use crate::services::router::{
            AiChatCapability, EventAdapter, FileAuditSink, KvCapability, PolicyPermission,
            PromptSnippetCapability, RouterBus, StreamEchoCapability, TodoCapability, audit_sink,
            prompt_snippet_capability,
        };`,
  `        use crate::services::router::{
            EventAdapter, FileAuditSink, KvCapability, PolicyPermission,
            PromptSnippetCapability, RouterBus, StreamEchoCapability, TodoCapability, audit_sink,
            prompt_snippet_capability,
        };`,
)
fs.writeFileSync(p, s)
console.log('A2 wiring done')
