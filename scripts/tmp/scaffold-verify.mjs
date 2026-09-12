// 一次性脚手架：在系统临时目录搭独立验证 crate（绕开 Tauri DLL 0xc0000139 限制），
// 复制主 crate 的 contracts/models/services/storage/router/web 文件原样编译运行单测。
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
  'services/storage/sqlite.rs',
  'services/storage/mod.rs',
  'services/router/mod.rs',
  'services/router/audit_sink.rs',
  'services/router/demo_capability.rs',
  'services/router/event_adapter.rs',
  'services/router/kv_capability.rs',
  'services/router/policy_permission.rs',
  'services/router/prompt_snippet_capability.rs',
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
//! contracts + storage + router 全部单测（含第五步 audit/policy、cap.prompt_snippet）。
//! 模块路径与主 crate 对齐，文件原样复制。
pub mod contracts;
pub mod models;
pub mod services;
pub mod web;
`)

write('src/models/mod.rs', 'pub mod config;\npub mod prompt_snippet;\npub mod todo;\n')

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

write('src/services/mod.rs', 'pub mod data_root;\npub mod router;\npub mod storage;\n')

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

console.log('scaffolded at', DST)
