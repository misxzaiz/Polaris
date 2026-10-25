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
//!     → 带 hookId：`{ "hookId", "handles": [{ "capId", "pluginId" }...] }`
//!       不带：`{ "hooks": ["ai.tool.before", ...] }`（仅非空订阅的 hook）
//! - `dispatch` `{ "hookId", "data"? }`
//!     → `{ "results": [ ...各回调返回值；失败项为 { "error", "capId" } ] }`
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

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context,
};
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
    /// 必填字符串参数校验：文案带动作名与参数键（AI 可定位是哪个动作缺什么）
    fn require_str<'a>(
        args: &'a Value,
        action: &str,
        key: &str,
    ) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.hook {action} 缺少字符串参数: {key}"))
    }

    /// 未装配 HookSystem 的错误（正常启动必有装配；面向 AI 给出可执行建议而非
    /// 开发者面的"检查 state.rs 装配"）
    fn not_ready() -> String {
        "cap.hook 未装配（HookSystem 缺失），请重试；持续出现请报告".to_string()
    }
}

impl Capability for HookCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        // describe 经 standard_describe 构造（2026-10-25 审计归一）；
        // list 的两种返回形状与 dispatch 的失败项形状按 HookRegistry 实现写准
        standard_describe(
            CAP_ID,
            "钩子",
            "基础 hook 机制：宿主关键时点 → 插件订阅/注入",
            Some("自动派发点（AI 会话/工具）广播 hook:<id> 事件；dispatch 手动逐回调经总线调用"),
            serde_json::json!({
                "register": { "params": { "hookId": "string（必填）", "capId": "string（必填，回调目标 cap id）", "pluginId": "string?（订阅方插件 id，缺省 unknown）" }, "returns": "{ ok: true }（幂等：同 hookId+capId 已注册则跳过）" },
                "unregister": { "params": { "hookId": "string（必填）", "capId": "string（必填）" }, "returns": "{ removed: bool }（是否真的移除）" },
                "list": { "params": { "hookId": "string?" }, "returns": "带 hookId → { hookId, handles: [{ capId, pluginId }] }；不带 → { hooks: [hookId...] }（仅非空订阅的 hook，已排序）" },
                "dispatch": { "params": { "hookId": "string（必填）", "data": "any?（缺省 null，透传给各回调）" }, "returns": "{ results: [...] }（逐回调返回值；失败项为 { error, capId }，不中断后续回调；无回调/通道缺失时为空数组）" }
            }),
        )
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.hook 需要 action 参数（{:?}）", HOOK_ACTIONS))?;

        match action {
            "register" => {
                let hook_id = Self::require_str(&params, "register", "hookId")?;
                let cap_id = Self::require_str(&params, "register", "capId")?;
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
                let hook_id = Self::require_str(&params, "unregister", "hookId")?;
                let cap_id = Self::require_str(&params, "unregister", "capId")?;
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
                let hook_id = Self::require_str(&params, "dispatch", "hookId")?.to_string();
                let data = params.get("data").cloned().unwrap_or(Value::Null);
                let hs = get_hook_system().ok_or_else(Self::not_ready)?;
                // 手动派发：广播 + 逐回调（HookSystem::dispatch 统一封装）
                let results = hs.dispatch(&hook_id, data);
                Ok(json!({ "results": results }))
            }
            // 未知动作文案统一走 contracts::unsupported_action（列出合法动作与
            // cap.help 指路，AI 可自纠）
            other => Err(unsupported_action(CAP_ID, other, HOOK_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = HookCapability.describe();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（HOOK_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), HOOK_ACTIONS.len());
        for name in HOOK_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn missing_param_error_names_action_and_key() {
        // 错误即文档：缺参文案带动作名与参数键，AI 可定位补齐
        let params = serde_json::json!({ "action": "register", "capId": "cap.x" });
        let err = HookCapability::require_str(&params, "register", "hookId").unwrap_err();
        assert!(err.contains("register") && err.contains("hookId"), "实际: {err}");
    }
}