//! cap.hook —— 基础 hook 机制（P1）
//!
//! 对应 `plans/plugin-manage-hook-inject-v1.md` §2.2 / §3 / §5 P1：
//! 宿主在关键时点派发 hook，插件声明订阅并执行，可注入数据返回宿主。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `register` `{ "hookId", "capId", "pluginId"? }`
//!     → `{ "ok": true }`（幂等：同 hook+capId 已注册跳过）
//! - `unregister` `{ "hookId", "capId" }` → `{ "removed": bool }`
//! - `list` `{ "hookId"? }`
//!     → `{ "hooks": ["ai.tool.before", ...] }` 或 `{ "handles": [HookHandle...] }`
//! - `dispatch` `{ "hookId", "data"? }`
//!     → `{ "results": [ ...各回调返回值 ] }`
//!
//! # 派发通道
//!
//! - **自动派发**：AI 会话/工具循环插桩点广播 `hook:<id>` 事件
//!   （`dispatch_hooks`，见 hook_registry.rs）。插件/前端订阅事件流联动。
//! - **手动派发**：`cap.hook.dispatch` 逐个调注册的回调 cap（经 RouterBus dispatch，
//!   复用权限 gate + 审计），返回各回调结果。
//!
//! # 实现
//!
//! 状态源全局单例 `HookSystem`（`hook_registry.rs` 装配时注入），本能力只做
//! 动作协议转发 —— 无独立状态，装配/插桩点共享同一实例。

use serde_json::{json, Value};

use crate::contracts::{Capability, CapabilityId, Context};
use crate::services::hook_registry::{get_hook_system, HookHandle};

const CAP_ID: &str = "cap.hook";

/// 支持的动作协议
pub const HOOK_ACTIONS: &[&str] = &["register", "unregister", "list", "dispatch"];

/// cap.hook —— hook 注册/卸载/列出/手动派发。
///
/// 无独立状态：经全局 `HookSystem`（state.rs 装配注入）操作，与插桩点共享
/// 同一注册表与 RouterBus。
pub struct HookCapability;

impl HookCapability {
    fn require_str<'a>(args: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.hook 缺少参数: {}", key))
    }

    /// 未装配 HookSystem 的错误（正常启动必有，容错一条日志而非崩溃）
    fn not_ready() -> String {
        "cap.hook 未装配（HookSystem 缺失），检查 state.rs 装配".to_string()
    }
}

impl Capability for HookCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "基础 hook 机制：宿主关键时点 → 插件订阅/注入",
            "note": "自动派发点（AI 会话/工具）广播 hook:<id> 事件；dispatch 手动逐回调经总线调用",
            "actions": {
                "register": { "params": { "hookId": "string（必填）", "capId": "string（必填）", "pluginId": "string?" }, "returns": "{ ok }" },
                "unregister": { "params": { "hookId": "string（必填）", "capId": "string（必填）" }, "returns": "{ removed }" },
                "list": { "params": { "hookId": "string?" }, "returns": "hook id 列表或某 hook 的回调列表" },
                "dispatch": { "params": { "hookId": "string（必填）", "data": "any?" }, "returns": "{ results }" }
            }
        })
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.hook 需要 action 参数（{:?}）", HOOK_ACTIONS))?;

        match action {
            "register" => {
                let hook_id = Self::require_str(&params, "hookId")?;
                let cap_id = Self::require_str(&params, "capId")?;
                let plugin_id = params
                    .get("pluginId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let hs = get_hook_system().ok_or_else(Self::not_ready)?;
                hs.registry.register(
                    hook_id,
                    HookHandle {
                        cap_id: cap_id.to_string(),
                        plugin_id,
                    },
                );
                Ok(json!({ "ok": true }))
            }
            "unregister" => {
                let hook_id = Self::require_str(&params, "hookId")?;
                let cap_id = Self::require_str(&params, "capId")?;
                let hs = get_hook_system().ok_or_else(Self::not_ready)?;
                let removed = hs.registry.unregister(hook_id, cap_id);
                Ok(json!({ "removed": removed }))
            }
            "list" => {
                let hs = get_hook_system().ok_or_else(Self::not_ready)?;
                match params.get("hookId").and_then(|v| v.as_str()) {
                    Some(hook_id) => {
                        let handles = hs.registry.list(hook_id);
                        Ok(json!({ "hookId": hook_id, "handles": handles }))
                    }
                    None => {
                        let hooks = hs.registry.all_hook_ids();
                        Ok(json!({ "hooks": hooks }))
                    }
                }
            }
            "dispatch" => {
                let hook_id = Self::require_str(&params, "hookId")?.to_string();
                let data = params.get("data").cloned().unwrap_or(Value::Null);
                let hs = get_hook_system().ok_or_else(Self::not_ready)?;
                // 手动派发：广播 + 逐回调（HookSystem::dispatch 统一封装）
                let results = hs.dispatch(&hook_id, data);
                Ok(json!({ "results": results }))
            }
            other => Err(format!("cap.hook 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}