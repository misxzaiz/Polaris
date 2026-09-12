// 一次性脚手架：在系统临时目录搭独立验证 crate（绕开 Tauri DLL 0xc0000139 限制），
// 复制主 crate 的 contracts/models/services/storage/router/web 文件原样编译运行单测。
// ai 模块用最小 shim（真实 registry/traits 依赖树太深）——shim 只保留 cap.ai.chat
// 依赖的 API 形状，使未知引擎报错路径可在 verify crate 实测。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = 'src-tauri/src'
const DST = path.join(os.tmpdir(), 'sky-verify')
fs.rmSync(DST, { recursive: true, force: true })

function write(rel, content) {
  const d = path.join(DST, rel)
  fs.mkdirSync(path.dirname(d), { recursive: true })
  fs.writeFileSync(d, content)
}
function cp(rel) {
  write(path.join('src', rel), fs.readFileSync(path.join(SRC, rel), 'utf8'))
}

for (const rel of [
  'contracts/mod.rs',
  'models/todo.rs',
  'models/prompt_snippet.rs',
  'models/ai_event.rs',
  'services/storage/sqlite.rs',
  'services/storage/mod.rs',
  'services/router/mod.rs',
  'services/router/audit_sink.rs',
  'services/router/demo_capability.rs',
  'services/router/event_adapter.rs',
  'services/router/kv_capability.rs',
  'services/router/policy_permission.rs',
  'services/router/prompt_snippet_capability.rs',
  'services/router/stream_echo_capability.rs',
  'services/router/context_capability.rs',
  'services/context_core.rs',
  'services/router/todo_capability.rs',
  'web/event_broadcaster.rs',
]) cp(rel)

write('Cargo.toml', `[package]
name = "sky-verify"
version = "0.1.0"
edition = "2021"

[lib]
name = "sky_verify"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
tokio = { version = "1", features = ["sync", "rt-multi-thread", "macros", "time"] }
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
sha2 = "0.10"
tracing = "0.1"

[workspace]
`)

write('src/lib.rs', `//! 独立验证 crate：绕开 Tauri DLL 环境限制（0xc0000139），实际运行
//! contracts + storage + router 全部单测（第五步 audit/policy、cap.prompt_snippet、
//! 第六步流式骨架 + cap.stream.echo + cap.ai.chat）。ai 模块为最小 shim。
pub mod ai;
pub mod contracts;
pub mod error;
pub mod models;
pub mod services;
pub mod web;
`)

write('src/models/mod.rs', 'pub mod ai_event;\npub mod config;\npub mod prompt_snippet;\npub mod todo;\n')

write('src/models/config.rs', `//! 最小 shim：仅保留 PolicyPermission 依赖的权限策略配置类型
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRuleConfig {
    pub capability: String,
    pub source: String,
    pub verdict: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicyConfig {
    #[serde(default)]
    pub rules: Vec<PermissionRuleConfig>,
}
`)

write('src/services/mod.rs', 'pub mod context_core;\npub mod data_root;\npub mod router;\npub mod storage;\n')

// router/mod.rs 剥离 ai_chat_capability / history_capability（依赖 AppState，verify crate 不复制）
{
  const rp = path.join(DST, 'src', 'services', 'router', 'mod.rs')
  let rs = fs.readFileSync(rp, 'utf8')
  rs = rs
    .replace('mod ai_chat_capability;\n', '')
    .replace('pub use ai_chat_capability::AiChatCapability;\n', '')
    .replace('mod history_capability;\n', '')
    .replace('pub use history_capability::HistoryCapability;\n', '')
  fs.writeFileSync(rp, rs)
}

write('src/services/data_root.rs', `//! 最小 shim：验证 crate 的数据根（进程内唯一临时目录）
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct DataRoot { root: PathBuf }

pub fn data_root() -> DataRoot {
    let dir = std::env::temp_dir().join(format!(
        "sky-verify-root-{}",
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::create_dir_all(&dir);
    DataRoot { root: dir }
}

impl DataRoot {
    pub fn root(&self) -> PathBuf { self.root.clone() }
}
`)

write('src/web/mod.rs', 'pub mod event_broadcaster;\npub use event_broadcaster::EventBroadcaster;\n')

write('src/ai/mod.rs', 'pub mod registry;\npub mod traits;\n')

write('src/ai/traits.rs', `//! 最小 shim：仅保留 cap.ai.chat 依赖的 EngineId / SessionOptions 形状
use crate::models::ai_event::AIEvent;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum EngineId {
    #[default]
    ClaudeCode,
    Codex,
    SimpleAI,
    Pi,
    Custom(String),
}

impl EngineId {
    pub fn as_str(&self) -> String {
        match self {
            Self::ClaudeCode => "claude-code".into(),
            Self::Codex => "codex".into(),
            Self::SimpleAI => "simple-ai".into(),
            Self::Pi => "pi".into(),
            Self::Custom(id) => id.clone(),
        }
    }

    pub fn parse_any(s: &str) -> Self {
        match s {
            "claude" | "claude-code" => Self::ClaudeCode,
            "codex" | "openai-codex" => Self::Codex,
            "simple-ai" => Self::SimpleAI,
            "pi" => Self::Pi,
            other => Self::Custom(other.to_string()),
        }
    }
}

pub struct SessionOptions {
    pub work_dir: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_tools: Vec<String>,
    pub client_message_id: Option<String>,
    pub event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    pub on_complete: Option<Arc<dyn Fn(i32) + Send + Sync>>,
    pub on_error: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

impl SessionOptions {
    pub fn new<F>(event_callback: F) -> Self
    where
        F: Fn(AIEvent) + Send + Sync + 'static,
    {
        Self {
            work_dir: None,
            system_prompt: None,
            allowed_tools: Vec::new(),
            client_message_id: None,
            event_callback: Arc::new(event_callback),
            on_complete: None,
            on_error: None,
        }
    }
}
`)

write('src/ai/registry.rs', `//! 最小 shim：无引擎的空 registry（未知引擎报错路径可测）
use crate::ai::traits::{EngineId, SessionOptions};
use crate::error::AppError;

pub struct EngineRegistry {
    engines: std::collections::HashMap<String, ()>,
}

impl EngineRegistry {
    pub fn new() -> Self {
        Self { engines: std::collections::HashMap::new() }
    }

    pub fn start_session(
        &mut self,
        engine_id: Option<EngineId>,
        _message: &str,
        _options: SessionOptions,
    ) -> Result<String, AppError> {
        let key = engine_id.unwrap_or_default().as_str();
        if !self.engines.contains_key(&key) {
            return Err(AppError::ValidationError(format!("引擎 {} 未注册", key)));
        }
        Ok(uuid::Uuid::new_v4().to_string())
    }

    pub fn continue_session(
        &mut self,
        engine_id: EngineId,
        _session_id: &str,
        _message: &str,
        _options: SessionOptions,
    ) -> Result<(), AppError> {
        let key = engine_id.as_str();
        if !self.engines.contains_key(&key) {
            return Err(AppError::ValidationError(format!("引擎 {} 未注册", key)));
        }
        Ok(())
    }

    pub fn try_interrupt_all(&mut self, _session_id: &str) -> bool {
        false
    }
}
`)

write('src/error.rs', `//! 最小 shim：AppError 形状（ai_chat 只用 to_message）
#[derive(Debug, Clone)]
pub enum AppError {
    ValidationError(String),
    Unknown(String),
}

impl AppError {
    pub fn to_message(&self) -> String {
        match self {
            Self::ValidationError(m) => m.clone(),
            Self::Unknown(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_message())
    }
}
`)

console.log('scaffolded at', DST)
