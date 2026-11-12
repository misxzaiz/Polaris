//! cap.pluginState —— 插件状态（state.json）读写统一入口
//!
//! 商城面板「插件管理中心」改造（plans/plugin-management-center-analysis.md §4.3，
//! 决策 2026-11-13：不设白名单，状态口走 cap 整域放行，权限对齐 cap.pluginServiceManager）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get_states`  `{ "action": "get_states" }` → PluginStateMap（全量状态）
//! - `set_states`  `{ "action": "set_states", "states": { [pluginId]: { enabled, uiEnabled?,
//!                   mcpEnabled?, mcpServers?, mcpToolGates? } } }`
//!   → `{ "ok": true, "changed": [...], "changes": {...} }`（复用 plugin_state_save
//!   的后端语义：写 state.json + diff 广播 plugin.lifecycle + cap 贡献同步）
//!
//! # 设计约束
//!
//! - **写路径唯一权威**：`set_states` 与旧命令 `plugin_state_save`（commands/plugin_state.rs）
//!   共享同一保存核 [`save_states_with_events`]——state.json 写入、diff 广播
//!   `plugin.lifecycle(state_changed)`、cap 贡献增量同步三者不可拆分，拆开会造成
//!   多端状态漂移（AGENTS.md §4.3）。
//! - 事件广播依赖 EventBroadcaster（与 Tauri/Web ipc 同源通道），由组装点注入；
//!   面板经 router_dispatch 调用，无需改动前端 HOST_INVOKE_ALLOWLIST。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use crate::models::plugin_state::PluginStateMap;
use crate::services::plugin_state_service::PluginStateService;
use crate::web::EventBroadcaster;

const CAP_ID: &str = "cap.pluginState";

/// 支持的 action 协议（与前端 pluginStateService 对齐）
pub const PLUGIN_STATE_ACTIONS: &[&str] = &["get_states", "set_states"];

/// set_states 返回载荷（changed/changes 来自 diff 概览，camelCase 对齐前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateSaveResult {
    pub ok: bool,
    /// 发生变更的插件 id（空数组 = 无变化，幂等）
    pub changed: Vec<String>,
    /// 变更明细（pluginId → 变更项列表）
    pub changes: std::collections::BTreeMap<String, Vec<String>>,
}

/// 保存插件状态 + diff 广播 + cap 贡献同步（plugin_state_save 与 cap.pluginState
/// set_states 的共享保存核）。
///
/// 语义与 commands/plugin_state.rs::plugin_state_save 完全一致：
/// 1. `PluginStateService::save` 原子写 state.json
/// 2. `handle_plugin_state_change` diff 旧状态 → 广播 `plugin.lifecycle(state_changed)`
/// 3. RouterBus 已装配时按新状态全量重算插件 cap 贡献（幂等）
///
/// 拆出公共函数的原因：两条入口（旧 Tauri 命令 / 新 cap）若各自实现，
/// 广播与贡献同步极易随单边演进漂移（AGENTS.md「唯一权威，禁止多写路径」）。
pub fn save_states_with_events(
    config_dir: &std::path::Path,
    states: &PluginStateMap,
    broadcaster: &EventBroadcaster,
) -> crate::services::plugin_events::PluginStateChangeOverview {
    // 1. 原子写 state.json（tmp + rename）
    let service = PluginStateService::new(config_dir.to_path_buf());
    if let Err(e) = service.save(states) {
        tracing::error!("[cap.pluginState] state.json 写入失败: {}", e);
    }

    // 2. 后端统一感知：diff 旧状态 → 广播 plugin.lifecycle(state_changed)
    let overview = crate::services::plugin_events::handle_plugin_state_change(
        config_dir,
        states,
        broadcaster,
    );

    // 3. P2-d：启停切换 → 插件 cap 贡献增量同步（幂等全量重算）
    if let Some(router) = crate::services::plugin_capability_assembly::router_bus() {
        let discovery = crate::services::plugin_service::PluginService::discover_installed_plugins(
            config_dir, None,
        );
        crate::services::plugin_capability_assembly::sync_plugin_contributions(
            &router,
            &discovery.plugins,
            states,
        );
    }

    overview
}

/// cap.pluginState —— 插件状态读写能力。
///
/// 依赖注入（组装点 state.rs 提供）：
/// - `config_dir`：数据根 config 目录（state.json 所在）
/// - `broadcaster`：事件广播器（与 AppState.event_broadcast 同源）
pub struct PluginStateCapability {
    config_dir: PathBuf,
    broadcaster: Arc<EventBroadcaster>,
}

impl PluginStateCapability {
    pub fn new(config_dir: PathBuf, broadcaster: Arc<EventBroadcaster>) -> Self {
        Self {
            config_dir,
            broadcaster,
        }
    }

    /// describe 文档（单测可直接校验；`describe()` 委托本函数）。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "插件状态",
            "插件状态（state.json）读写：读全量状态 / 批量写状态（保存+广播+cap 贡献同步）",
            Some("管理面能力：已鉴权 Remote 放行（require_auth，未鉴权 deny）；对齐 cap.pluginServiceManager 整域放行，不做逐动作白名单（决策 2026-11-13，plans/plugin-management-center-analysis.md §4.3）"),
            serde_json::json!({
                "get_states": {
                    "params": {},
                    "returns": "PluginStateMap（pluginId → { enabled, uiEnabled, mcpEnabled, mcpServers?, mcpToolGates?, devLink? }）"
                },
                "set_states": {
                    "params": {
                        "states": "object（必填）——map: pluginId → { enabled: bool, uiEnabled?: bool, mcpEnabled?: bool }；整表覆盖语义，未列出的插件状态记录会被删除"
                    },
                    "returns": "{ ok: true, changed: string[], changes: { [pluginId]: string[] } }——changed/changes 为 diff 概览，空数组 = 无变化"
                }
            }),
        )
    }
}

impl Capability for PluginStateCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| {
                format!(
                    "cap.pluginState 需要 action 参数（{:?}）",
                    PLUGIN_STATE_ACTIONS
                )
            })?;

        match action {
            "get_states" => {
                let states = PluginStateService::new(self.config_dir.clone())
                    .load()
                    .map_err(|e| format!("cap.pluginState 读取状态失败: {}", e))?;
                serde_json::to_value(states).map_err(|e| e.to_string())
            }
            "set_states" => {
                let states: PluginStateMap = serde_json::from_value(
                    params.get("states").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| {
                    format!(
                        "cap.pluginState set_states: states 解析失败: {e}（必填对象，pluginId → {{ enabled, uiEnabled?, mcpEnabled? }}）"
                    )
                })?;
                let overview = save_states_with_events(
                    &self.config_dir,
                    &states,
                    &self.broadcaster,
                );
                serde_json::to_value(PluginStateSaveResult {
                    ok: true,
                    changed: overview.changed_plugins,
                    changes: overview.changes,
                })
                .map_err(|e| e.to_string())
            }
            // 审计错误工效：未知动作附支持清单与协议入口（错误即文档，可自纠）
            other => Err(unsupported_action(
                CAP_ID,
                other,
                PLUGIN_STATE_ACTIONS,
            )),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小测试 Context（对齐 plugin_service_manager_capability tests 范式）
    struct TestCtx;
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &crate::contracts::Source {
            static S: crate::contracts::Source = crate::contracts::Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            static C: crate::contracts::PluginId = crate::contracts::PluginId(String::new());
            &C
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_cap(dir: &std::path::Path) -> PluginStateCapability {
        PluginStateCapability::new(
            dir.to_path_buf(),
            Arc::new(EventBroadcaster::new(8)),
        )
    }

    /// describe 契约测试：standard_describe 构造 + validate_describe 零违例 +
    /// 动作清单与实现一致。
    #[test]
    fn describe_contract() {
        let d = PluginStateCapability::describe_doc();
        let problems = crate::contracts::validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        assert_eq!(d["id"], "cap.pluginState");
        assert_eq!(d["name"], "插件状态");
        for action in PLUGIN_STATE_ACTIONS {
            assert!(
                d["actions"].get(*action).is_some(),
                "describe 缺动作 {action}"
            );
        }
        assert!(d["actions"]["set_states"]["params"]["states"]
            .as_str()
            .unwrap()
            .contains("必填"));
    }

    /// 审计错误工效：未知动作错误应列出全部支持动作（unsupported_action 生成）
    #[test]
    fn unknown_action_lists_supported_actions() {
        let temp = tempfile::tempdir().unwrap();
        let cap = make_cap(temp.path());
        let err = cap
            .invoke(serde_json::json!({"action": "explode"}), &TestCtx)
            .unwrap_err();
        for action in PLUGIN_STATE_ACTIONS {
            assert!(err.contains(action), "错误应含动作 {action}: {err}");
        }
        assert!(err.contains("cap.help"), "错误应指路协议入口: {err}");
    }

    /// get_states：空数据根返回空 map（不报错）
    #[test]
    fn get_states_empty_returns_empty_map() {
        let temp = tempfile::tempdir().unwrap();
        let cap = make_cap(temp.path());
        let out = cap
            .invoke(serde_json::json!({"action": "get_states"}), &TestCtx)
            .unwrap();
        assert!(out.as_object().unwrap().is_empty());
    }

    /// set_states → get_states 往返：写入的布尔位可读回（camelCase 键）
    #[test]
    fn set_then_get_roundtrips_state() {
        let temp = tempfile::tempdir().unwrap();
        let cap = make_cap(temp.path());
        let out = cap
            .invoke(
                serde_json::json!({
                    "action": "set_states",
                    "states": {
                        "polaris.marketplace": { "enabled": false, "uiEnabled": true, "mcpEnabled": true }
                    }
                }),
                &TestCtx,
            )
            .unwrap();
        assert_eq!(out["ok"], true);
        assert!(out["changed"].as_array().unwrap().iter().any(|v| v == "polaris.marketplace"));

        let got = cap
            .invoke(serde_json::json!({"action": "get_states"}), &TestCtx)
            .unwrap();
        assert_eq!(got["polaris.marketplace"]["enabled"], false);
        assert_eq!(got["polaris.marketplace"]["uiEnabled"], true);
        assert_eq!(got["polaris.marketplace"]["mcpEnabled"], true);
    }

    /// set_states 幂等：同值重写 changed 为空（diff 广播不重复发）
    #[test]
    fn set_states_idempotent_no_diff() {
        let temp = tempfile::tempdir().unwrap();
        let cap = make_cap(temp.path());
        let payload = serde_json::json!({
            "action": "set_states",
            "states": { "polaris.marketplace": { "enabled": true } }
        });
        let first = cap.invoke(payload.clone(), &TestCtx).unwrap();
        assert!(!first["changed"].as_array().unwrap().is_empty());
        let second = cap.invoke(payload, &TestCtx).unwrap();
        assert!(
            second["changed"].as_array().unwrap().is_empty(),
            "同值重写不应产生 diff: {second}"
        );
    }

    /// set_states 缺 states 参数 → 结构化错误（错误即文档）
    #[test]
    fn set_states_missing_states_errors() {
        let temp = tempfile::tempdir().unwrap();
        let cap = make_cap(temp.path());
        let err = cap
            .invoke(serde_json::json!({"action": "set_states"}), &TestCtx)
            .unwrap_err();
        assert!(err.contains("states"), "错误应点名缺参: {err}");
    }

    /// 保存核广播：diff 产生的 state_changed 事件进入 EventBroadcaster
    #[test]
    fn save_states_with_events_broadcasts_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let broadcaster = Arc::new(EventBroadcaster::new(8));
        let mut sub = broadcaster.subscribe();

        let mut states = PluginStateMap::new();
        states.insert(
            "polaris.marketplace".to_string(),
            crate::models::plugin_state::PluginState {
                enabled: false,
                ui_enabled: true,
                mcp_enabled: true,
                mcp_servers: Default::default(),
                mcp_tool_gates: Default::default(),
                dev_link: None,
            },
        );
        let overview =
            save_states_with_events(temp.path(), &states, &broadcaster);
        assert!(overview.changed_plugins.contains(&"polaris.marketplace".to_string()));

        // EventAdapter 订阅侧应收到 plugin.lifecycle（broadcast_plugin_lifecycle 落 EventBroadcaster）
        let mut got = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while !got && std::time::Instant::now() < deadline {
            match sub.try_recv() {
                Ok(ev) => {
                    if ev.kind == "plugin.lifecycle" {
                        got = true;
                    }
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
        assert!(got, "state 保存应广播 plugin.lifecycle 事件");
    }
}
