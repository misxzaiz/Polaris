//! cap.terminal —— 终端 PTY 能力（`commands/terminal.rs` TerminalManager 的总线入口）
//!
//! 定位（plans/terminal-plugin-spec.md §四）：PTY 核心是宿主能力（同 cap.bash 定位），
//! 插件终端面板（terminal-desk）经本能力驱动 PTY；过渡期旧 `terminal_*` 命令并行
//! （双轨零回归），拆除阶段砍命令层后本能力是唯一入口。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `create`   `{ "name"?, "cwd"?, "cols"?, "rows"?, "initialCommand"?, "env"?, "purpose"?, "scriptId"? }`
//!              → `{ "session": TerminalSession }`
//! - `write`    `{ "sessionId", "data"(base64) }` → `{}`
//! - `resize`   `{ "sessionId", "cols", "rows" }` → `{}`
//! - `close`    `{ "sessionId" }` → `{}`
//! - `list`     `{}` → `{ "sessions": TerminalSession[] }`（已退出的会话被过滤）
//! - `get`      `{ "sessionId" }` → `{ "session": TerminalSession | null }`
//! - `discover_scripts` `{ "workspacePath" }` → `{ "scripts": DiscoveredTerminalScript[] }`
//! - `open_in_external` `{ "command", "cwd"?, "env"? }` → `{}`（仅桌面构建；web-only 返回错误）
//!
//! # 事件流（复用既有事件名，负载与旧命令层一致）
//!
//! - `terminal:output` `{ sessionId, data(base64) }`
//! - `terminal:exit`   `{ sessionId, exitCode }`
//!
//! 会话事件出口取 [`crate::commands::terminal::global_terminal_sink`]（桌面=Dual
//! 双通道 Tauri emit + WS 广播，web-only=WS 广播；由 lib.rs / run_web_server
//! 启动时注入）。旧命令层的 per-session sink 语义不变。
//!
//! # 权限
//!
//! 不设内置 Remote deny（policy_permission.rs 默认放行）：与既有 legacy 终端
//! 命令对鉴权 Remote 的暴露面完全一致（`/api/terminal-create` 等本就允许已鉴权
//! 远程创建 PTY），收紧只会造成「插件终端面板在 web 独立构建不可用」的功能回归
//! 而非安全增益。鉴权依赖传输层 token（同 cap.config 的远程读写先例）。

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

use crate::commands::terminal::{global_terminal_sink, TerminalSession};
use crate::AppState;

const CAP_ID: &str = "cap.terminal";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const TERMINAL_CAP_ACTIONS: &[&str] = &[
    "create",
    "write",
    "resize",
    "close",
    "list",
    "get",
    "discover_scripts",
    "open_in_external",
];

/// cols/rows 保守上限（协议无运行时 schema 校验的已知缺口下，入参在能力内自检）
const MAX_PTY_DIM: u16 = 500;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// cap.terminal —— 终端 PTY 能力
pub struct TerminalCapability {
    state: Arc<AppState>,
}

impl TerminalCapability {
    pub fn with_state(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn lock_manager(&self) -> Result<std::sync::MutexGuard<'_, crate::commands::terminal::TerminalManager>, String> {
        self.state
            .terminal_manager
            .lock()
            .map_err(|e| format!("cap.terminal 锁获取失败: {}", e))
    }

    fn do_create(&self, params: &Value) -> Result<Value, String> {
        let sink = global_terminal_sink()
            .ok_or_else(|| "cap.terminal 事件出口未注入（启动装配缺失）".to_string())?;
        let cols = params
            .get("cols")
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(2, MAX_PTY_DIM as u64) as u16)
            .unwrap_or(DEFAULT_COLS);
        let rows = params
            .get("rows")
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(2, MAX_PTY_DIM as u64) as u16)
            .unwrap_or(DEFAULT_ROWS);
        let env: Option<HashMap<String, String>> = params
            .get("env")
            .and_then(|v| v.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            });
        let session = self
            .lock_manager()?
            .create_session(
                sink,
                opt_string(params, "name"),
                opt_string(params, "cwd"),
                cols,
                rows,
                opt_string(params, "initialCommand"),
                env,
                opt_string(params, "purpose"),
                opt_string(params, "scriptId"),
            )
            .map_err(|e| e.to_string())?;
        let session = serde_json::to_value(session)
            .map_err(|e| format!("cap.terminal 会话序列化失败: {}", e))?;
        Ok(json!({ "session": session }))
    }

    fn do_write(&self, params: &Value) -> Result<Value, String> {
        let session_id = require_session_id(params)?;
        let data = params
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "缺少参数: data (base64 字符串)".to_string())?;
        self.lock_manager()?
            .write(&session_id, data)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    }

    fn do_resize(&self, params: &Value) -> Result<Value, String> {
        let session_id = require_session_id(params)?;
        let cols = params
            .get("cols")
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(2, MAX_PTY_DIM as u64) as u16)
            .ok_or_else(|| "缺少参数: cols".to_string())?;
        let rows = params
            .get("rows")
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(2, MAX_PTY_DIM as u64) as u16)
            .ok_or_else(|| "缺少参数: rows".to_string())?;
        self.lock_manager()?
            .resize(&session_id, cols, rows)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    }

    fn do_close(&self, params: &Value) -> Result<Value, String> {
        let session_id = require_session_id(params)?;
        self.lock_manager()?
            .close_session(&session_id)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    }

    fn do_list(&self) -> Result<Value, String> {
        let sessions: Vec<TerminalSession> = self
            .lock_manager()?
            .list_sessions()
            .map_err(|e| e.to_string())?;
        let sessions = serde_json::to_value(sessions)
            .map_err(|e| format!("cap.terminal 会话序列化失败: {}", e))?;
        Ok(json!({ "sessions": sessions }))
    }

    fn do_get(&self, params: &Value) -> Result<Value, String> {
        let session_id = require_session_id(params)?;
        // 会话不存在/已退出未关闭：返回 null（与旧 terminal_get 的 NotFound 语义
        // 区分——查询语义下 null 比 4xx 更利于调用方幂等轮询）
        let found = self
            .lock_manager()?
            .get_session(&session_id)
            .ok()
            .and_then(|s| serde_json::to_value(s).ok());
        Ok(json!({ "session": found }))
    }

    fn do_discover_scripts(&self, params: &Value) -> Result<Value, String> {
        let workspace_path = opt_string(params, "workspacePath")
            .ok_or_else(|| "缺少参数: workspacePath（经 __POLARIS_WORKSPACE_API__ 获取当前工作区路径）".to_string())?;
        let scripts = crate::commands::terminal_script::discover_scripts_in_workspace(std::path::Path::new(
            &workspace_path,
        ))
        .map_err(|e| e.to_string())?;
        let scripts =
            serde_json::to_value(scripts).map_err(|e| format!("脚本序列化失败: {}", e))?;
        Ok(json!({ "scripts": scripts }))
    }

    /// describe 文档体（状态无关；独立成关联函数便于 describe_contract 测试
    /// 直接调用，无需构造 AppState——同 history_capability 先例）。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "终端",
            "终端 PTY 会话管理：创建交互式 shell 会话、写入输入、调整尺寸、关闭；事件 terminal:output/terminal:exit 推送输出",
            Some("高危面：等同本机 shell 交互。open_in_external 仅桌面构建可用"),
            json!({
                "create": {
                    "params": {
                        "name": "string 可选，会话名（缺省自动编号）",
                        "cwd": "string 可选，工作目录",
                        "cols": "u16 可选，默认 80",
                        "rows": "u16 可选，默认 24",
                        "initialCommand": "string 可选，启动后先执行的命令",
                        "env": "object 可选，环境变量 {k:v}",
                        "purpose": "string 可选，用途标记（脚本运行归因）",
                        "scriptId": "string 可选，关联脚本 ID"
                    },
                    "returns": "{ session: TerminalSession }，事件输出经 terminal:output"
                },
                "write": {
                    "params": { "sessionId": "string", "data": "base64 编码的输入字节" },
                    "returns": "{}"
                },
                "resize": {
                    "params": { "sessionId": "string", "cols": "u16", "rows": "u16" },
                    "returns": "{}"
                },
                "close": {
                    "params": { "sessionId": "string" },
                    "returns": "{}"
                },
                "list": { "params": {}, "returns": "{ sessions: TerminalSession[] }" },
                "get": { "params": { "sessionId": "string" }, "returns": "{ session: TerminalSession | null }" },
                "discover_scripts": {
                    "params": { "workspacePath": "string，工作区根目录" },
                    "returns": "{ scripts: [{ id, name, command, cwd, source, sourcePath, enabled, tags }] }"
                },
                "open_in_external": {
                    "params": { "command": "string", "cwd": "string 可选", "env": "object 可选" },
                    "returns": "{}（仅桌面构建）"
                }
            }),
        )
    }

    #[cfg(all(feature = "tauri-app", not(target_os = "android")))]
    fn do_open_in_external(&self, params: &Value) -> Result<Value, String> {
        let command = opt_string(params, "command")
            .ok_or_else(|| "缺少参数: command".to_string())?;
        let env: Option<HashMap<String, String>> = params
            .get("env")
            .and_then(|v| v.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            });
        crate::commands::terminal::open_in_external_impl(command, opt_string(params, "cwd"), env)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    }
}

impl Capability for TerminalCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params.get("action").and_then(|a| a.as_str()).unwrap_or("").to_string();
        match action.as_str() {
            "create" => self.do_create(&params),
            "write" => self.do_write(&params),
            "resize" => self.do_resize(&params),
            "close" => self.do_close(&params),
            "list" => self.do_list(),
            "get" => self.do_get(&params),
            "discover_scripts" => self.do_discover_scripts(&params),
            #[cfg(all(feature = "tauri-app", not(target_os = "android")))]
            "open_in_external" => self.do_open_in_external(&params),
            // web-only 构建 / android：外部终端是桌面概念，与旧命令层门控对齐
            #[cfg(any(not(feature = "tauri-app"), target_os = "android"))]
            "open_in_external" => Err("外部终端仅在桌面端可用".to_string()),
            other => Err(unsupported_action(CAP_ID, other, TERMINAL_CAP_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }
}

fn opt_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn require_session_id(params: &Value) -> Result<String, String> {
    params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "缺少参数: sessionId".to_string())
}

// ============================================================================
// 契约测试：describe 形状巡逻（不构造 AppState——单测无法完整装配，
// 触达 state 的路径由插件面板真机冒烟覆盖，见 plans/terminal-plugin-spec.md §九）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = TerminalCapability::describe_doc();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（TERMINAL_CAP_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), TERMINAL_CAP_ACTIONS.len());
        for name in TERMINAL_CAP_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn unsupported_action_message_lists_supported() {
        let err = unsupported_action(CAP_ID, "bogus", TERMINAL_CAP_ACTIONS);
        assert!(err.contains("create") && err.contains("cap.terminal"));
    }
}
