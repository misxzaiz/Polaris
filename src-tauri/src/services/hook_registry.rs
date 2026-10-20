//! Hook 注册表 + 派发器（P1：基础 hook 机制）
//!
//! 对应 `plans/plugin-manage-hook-inject-v1.md` §2.2 / §3 / §5 P1：
//! 「宿主在关键时点派发 hook 事件，插件声明订阅并执行，可注入数据返回宿主」。
//!
//! ## 设计（对齐 spec 与既有基建）
//!
//! - **hook 点**（v1）：`plugin.lifecycle`（复用 P0，见 plugin_events.rs）、
//!   `ai.session.start/end`、`ai.tool.before/after`。
//! - **派发通道**：
//!   - **广播**：所有派发先经 EventAdapter 广播 `hook:<id>` 事件（事件总线，插件/
//!     前端订阅联动，不阻塞调用方）；
//!   - **回调**：registered 的插件回调 cap 逐个经 RouterBus dispatch（复用权限
//!     gate + 审计），返回改写数据给宿主（`ai.tool.before` 可改 args 等）。
//! - **回调载体**：插件声明 `contributes.hooks: [{id}]` 后，经 `cap.hook.register`
//!   绑定「回调 cap id」——派发时经总线调该 cap（复用权限 gate + 审计）。
//! - **全局触达**（为何用 OnceLock）：自动派发点分布在深层链路（`chat_loop.rs`
//!   工具循环、`ai_chat_core.rs` 会话生命周期），逐层传参侵入面过大；用
//!   `HOOK_SYSTEM` 全局单例（装配时 `put_hook_system` 注入 registry + router +
//!   broadcaster），插桩点统一调 `dispatch_hooks(hook_id, data)` 便捷函数。
//!   生命周期同进程（desktop / polaris-web / MCP server 各自装配一次）。
//! - **安全边界**（spec §7）：
//!   - 回调失败不回传给调用方（不阻塞宿主主流程），逐项收集 `{capId, error}`；
//!   - 派发深度限制：回调经 RouterBus dispatch 天然单轮回调（cap 内再调
//!     `cap.hook.dispatch` 时 HookRegistry 内部无状态重入防护成本高，靠使用
//!     方不用同一 hook 回调里再调同 hook 派发规避，spec 列 v2）；
//!   - 幂等：同一 hook 多次注册同一 cap 去重；
//!   - `plugin.lifecycle` 仅广播不递归触发（已在 plugin_events.rs）。

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::contracts::{Envelope, Event, TraceId};
use crate::contracts::Router as _; // dispatch 是 Router trait 方法（非固有方法）

/// 单条 hook 订阅（回调目标 = 已注册的 cap id）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHandle {
    /// 回调目标 cap id（dispatch 时经 RouterBus 调它）
    pub cap_id: String,
    /// 订阅方插件 id（归属记录 / 审计 / 冲突排查）
    pub plugin_id: String,
}

/// Hook 注册表：hook_id → 订阅列表（cap 回调）
pub struct HookRegistry {
    hooks: Mutex<HashMap<String, Vec<HookHandle>>>,
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HookRegistry {
    pub fn new() -> Self {
        Self {
            hooks: Mutex::new(HashMap::new()),
        }
    }

    /// 注册 hook 订阅（cap 回调）。幂等：同 hook + 同 cap_id 已注册则跳过。
    pub fn register(&self, hook_id: &str, handle: HookHandle) {
        let mut hooks = self.hooks.lock().unwrap();
        let entries = hooks.entry(hook_id.to_string()).or_default();
        if !entries.iter().any(|h| h.cap_id == handle.cap_id) {
            entries.push(handle);
        }
    }

    /// 卸载 hook 订阅。返回是否真的移除。
    pub fn unregister(&self, hook_id: &str, cap_id: &str) -> bool {
        let mut hooks = self.hooks.lock().unwrap();
        if let Some(entries) = hooks.get_mut(hook_id) {
            let before = entries.len();
            entries.retain(|h| h.cap_id != cap_id);
            return entries.len() != before;
        }
        false
    }

    /// 列出某 hook 的订阅列表（cap_id / plugin_id）。
    pub fn list(&self, hook_id: &str) -> Vec<HookHandle> {
        self.hooks
            .lock()
            .unwrap()
            .get(hook_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 列出所有已注册的 hook id（供 cap.hook.list 聚合）。
    pub fn all_hook_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .hooks
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, _)| k.clone())
            .collect();
        ids.sort();
        ids
    }
}

/// Hook 系统全局句柄（装配时注入，插桩点经
/// [`get_hook_system`] / [`dispatch_hooks`] 触达）。
///
/// # 生命周期
/// 进程级 `OnceLock`，`create_app_state` 装配时 `put_hook_system` 注入一次；
/// 三端（desktop tauri / polaris-web / MCP server）各自装配，进程内单例。
/// 多次`put`幂等（后写不覆盖，避免竞态双写）。
///
/// # 并行安全
/// - `registry`: Mutex 内部锁，`dispatch` 前 clone handles（调用中不持锁）；
///   RouterBus 回调本身是 reentrant 的（dispatch 释放读锁后 invoke），
///   所以 handle 列表在派发期间可能变更——用「派发开始时的快照」即可，
///   旧句柄多跑一次或丢掉新注册都不会破坏正确性。
pub struct HookSystem {
    /// 注册表
    pub registry: HookRegistry,
    /// RouterBus（回调 dispatch 通道；提供回调 cap 时必填）
    pub router: Option<std::sync::Arc<crate::services::router::RouterBus>>,
    /// EventAdapter（`hook:<id>` 事件广播通道；提供前端/插件订阅时必填）
    pub broadcaster: Option<std::sync::Arc<crate::services::router::EventAdapter>>,
}

impl HookSystem {
    pub fn new(
        router: Option<std::sync::Arc<crate::services::router::RouterBus>>,
        broadcaster: Option<std::sync::Arc<crate::services::router::EventAdapter>>,
    ) -> Self {
        Self {
            registry: HookRegistry::new(),
            router,
            broadcaster,
        }
    }

    /// 派发一次 hook：先广播 `hook:<id>` 事件，再逐个调注册的回调 cap。
    ///
    /// - **广播**（可选通道）：`broadcaster` 非 None 时广播事件，payload
    ///   `{ hookId, data }`——插件/前端经事件总线订阅联动，不阻塞。
    /// - **回调**（可选通道）：`router` 非 None 时逐个调注册的 cap 回调，
    ///   返回各回调结果。回调失败逐项收集（不中断后续回调）。
    ///
    /// 返回各回调结果（无回调 / 通道缺失时为空）。
    pub fn dispatch(&self, hook_id: &str, data: Value) -> Vec<Value> {
        // 1. 广播事件（channel A：事件总线，非阻塞）
        if let Some(bc) = &self.broadcaster {
            bc.broadcast(Event {
                seq: 0,
                kind: format!("hook:{}", hook_id),
                payload: json!({ "hookId": hook_id, "data": data }),
                trace: TraceId(format!("trace-hook-{}", hook_id)),
            });
        }

        // 2. 回调（channel B：逐 cap dispatch，返回改写数据）
        let Some(router) = &self.router else {
            return Vec::new();
        };
        let handles = self.registry.list(hook_id);
        let mut results = Vec::with_capacity(handles.len());
        for handle in &handles {
            let envelope = Envelope {
                id: crate::contracts::MsgId(format!("hook-{}-{}", hook_id, handle.cap_id)),
                source: crate::contracts::Source::Bootstrap, // Core 内部派发（无 token，自动过 gate）
                target: crate::contracts::CapabilityId(handle.cap_id.clone()),
                payload: json!({
                    "action": "invoke",
                    "hook": hook_id,
                    "data": data,
                }),
                trace: TraceId(format!("trace-hook-{}", hook_id)),
            };
            match router.dispatch(envelope) {
                Ok(reply) => match reply.result {
                    Ok(v) => results.push(v),
                    Err(e) => {
                        tracing::warn!(
                            "[HookRegistry] hook={} 回调 cap={} 执行失败: {}",
                            hook_id,
                            handle.cap_id,
                            e
                        );
                        results.push(json!({ "error": e, "capId": handle.cap_id }));
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        "[HookRegistry] hook={} 回调 cap={} 路由失败: {}",
                        hook_id,
                        handle.cap_id,
                        e
                    );
                    results.push(json!({ "error": e, "capId": handle.cap_id }));
                }
            }
        }
        results
    }
}

/// 全局 HookSystem（进程级单例）。
static HOOK_SYSTEM: std::sync::OnceLock<HookSystem> = std::sync::OnceLock::new();

/// 装配时注入全局 HookSystem（desktop/web/MCP 三端各自装配一次）。
/// 幂等：已装配过则忽略（后写不覆盖，避免多入口竞态双写）。
pub fn put_hook_system(hook_system: HookSystem) {
    let _ = HOOK_SYSTEM.set(hook_system);
}

/// 取全局 HookSystem（未装配返回 None，插桩点静默 no-op）。
pub fn get_hook_system() -> Option<&'static HookSystem> {
    HOOK_SYSTEM.get()
}

/// 便捷派发：未装配时静默 no-op（插桩点零负担）。
///
/// 广播 hook 事件 + 逐个调注册回调，返回各回调结果（无回调时为空）。
pub fn dispatch_hooks(hook_id: &str, data: Value) -> Vec<Value> {
    match get_hook_system() {
        Some(hs) => hs.dispatch(hook_id, data),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_list_unregister_roundtrip() {
        let registry = HookRegistry::new();
        assert!(registry.all_hook_ids().is_empty());

        registry.register("ai.tool.before", HookHandle { cap_id: "cap.hookHandler.a".into(), plugin_id: "plug.a".into() });
        registry.register("ai.tool.before", HookHandle { cap_id: "cap.hookHandler.b".into(), plugin_id: "plug.b".into() });
        registry.register("ai.tool.before", HookHandle { cap_id: "cap.hookHandler.a".into(), plugin_id: "plug.a".into() }); // 幂等去重

        let list = registry.list("ai.tool.before");
        assert_eq!(list.len(), 2);
        assert_eq!(registry.all_hook_ids(), vec!["ai.tool.before"]);

        assert!(registry.unregister("ai.tool.before", "cap.hookHandler.a"));
        assert!(!registry.unregister("ai.tool.before", "cap.hookHandler.a")); // 第二次无操作
        assert_eq!(registry.list("ai.tool.before").len(), 1);
    }

    #[test]
    fn dispatch_without_router_channel_returns_empty() {
        // 无 RouterBus 通道（早期装配 / 纯广播模式）→ 回调不执行，返回空不崩溃
        let system = HookSystem::new(None, None);
        system.registry.register("ai.tool.before", HookHandle { cap_id: "cap.a".into(), plugin_id: "plug.a".into() });
        let results = system.dispatch("ai.tool.before", json!({ "tool": "read" }));
        assert!(results.is_empty());
    }

    #[test]
    fn dispatch_unknown_hook_is_empty() {
        let system = HookSystem::new(None, None);
        assert!(system.dispatch("ghost.hook", json!({})).is_empty());
    }

    #[test]
    fn constructor_defaults_ok() {
        let system = HookSystem::new(None, None);
        assert!(system.registry.all_hook_ids().is_empty());
        assert!(system.router.is_none());
        assert!(system.broadcaster.is_none());
    }
}