//! 插件生命周期事件广播 + 状态变更后端统一感知（P0）
//!
//! 设计目标（plans/plugin-manage-hook-inject-v1.md §9 + 用户补充：「后端感知而不是前端」）：
//! 插件「管理」与「生效」关联的逻辑统一放在后端，前端只做展示与回填回调。
//!
//! ## 现状与缺口
//! - 安装/卸载/更新（cap.pluginDiscovery）纯文件/进程操作，返回 PluginOperationResult，
//!   但对其它模块零通知 → 前端插件列表/状态在操作后不同步。
//! - `plugin_state_*` 开关只落 state.json，无变更广播、无后端感知逻辑。
//!
//! ## 本模块职责
//! 1. `emit_plugin_lifecycle` / `broadcast_plugin_lifecycle`：统一 `plugin.lifecycle` 事件发送。
//!    事件 kind = `plugin.lifecycle`，payload：
//!    ```json
//!    { "pluginId": "...", "event": "installed|uninstalled|updated|state_changed",
//!      "installPath": "?", "detail": "?" }
//!    ```
//! 2. `handle_plugin_state_change`：状态保存（plugin_state_save 两入口共用）时
//!    **后端 diff 旧状态 → 逐插件广播 state_changed + 返回变更概览**。
//!    变更语义（单一权威，见 AGENTS.md §4.3「广播尽量携带并分类 reason」）：
//!    - `enabled` 或 `mcpEnabled` 变化 → `state_changed`，detail.changed = ["enabled"/"mcpEnabled"]
//!    - per-server `mcp_servers.{id}.enabled` 变化 → `state_changed`，detail.changed=["mcpServers.<id>"]
//!    - 新增/删除插件记录 → `installed`/`uninstalled`（不覆盖 install 能力的事件，避免重复；仅 state 记录层面）
//!
//! ## 发送通道
//! - 插件能力（cap.pluginDiscovery）内部用 `Context::emit`（已有 RealContext → EventAdapter 实现，
//!   见 `git_capability.rs` 的 `emit_*_event` 先例）——插件能力侧零依赖。
//! - 状态保存（Tauri 命令 / Web ipc）用 `EventBroadcaster`（AppState.event_broadcast）——
//!   前端 `listen('plugin.lifecycle')` 统一消费（Tauri event / WS 双通道）。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::models::plugin_state::{
    PluginMcpServerState, PluginState, PluginStateMap,
};

pub const PLUGIN_LIFECYCLE_EVENT: &str = "plugin.lifecycle";

/// 构造 `plugin.lifecycle` 事件 payload（统一形状）。
fn lifecycle_payload(plugin_id: &str, event: &str, detail: Option<Value>) -> Value {
    let mut payload = json!({
        "pluginId": plugin_id,
        "event": event,
    });
    if let Some(detail) = detail {
        payload["detail"] = detail;
    }
    payload
}

/// 通过 EventBroadcaster 广播插件生命周期事件（状态保存 / 非 cap 通道用）。
pub fn broadcast_plugin_lifecycle(
    broadcaster: &crate::web::EventBroadcaster,
    plugin_id: &str,
    event: &str,
    detail: Option<Value>,
) {
    let msg = json!({
        "event": PLUGIN_LIFECYCLE_EVENT,
        "payload": lifecycle_payload(plugin_id, event, detail),
    })
    .to_string();
    let _ = broadcaster.send(msg);
}

/// 通过 Context::emit 广播插件生命周期事件（cap.pluginDiscovery 等插件能力内用）。
pub fn emit_plugin_lifecycle(
    ctx: &dyn crate::contracts::Context,
    plugin_id: &str,
    event: &str,
    detail: Option<Value>,
) {
    // P2-d：插件生命周期变化 → cap 贡献增量同步（installed/uninstalled/updated
    // 统一出口；幂等全量重算；RouterBus 未装配时静默跳过）
    if let Some(router) = crate::services::plugin_capability_assembly::router_bus() {
        let config_dir = crate::services::data_root::data_root().config_dir();
        let discovery = crate::services::plugin_service::PluginService::discover_installed_plugins(
            &config_dir, None,
        );
        let states = crate::services::plugin_state_service::PluginStateService::new(config_dir)
            .load()
            .unwrap_or_default();
        crate::services::plugin_capability_assembly::sync_plugin_contributions(
            &router,
            &discovery.plugins,
            &states,
        );
    }
    if let Err(e) = ctx.emit(
        PLUGIN_LIFECYCLE_EVENT,
        lifecycle_payload(plugin_id, event, detail),
    ) {
        tracing::warn!("[plugin.lifecycle] 广播失败: {}", e);
    }
}

/// 插件状态变更概览（plugin_state_save 返回给前端，供友善回显）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateChangeOverview {
    /// 发生变更的插件 id
    pub changed_plugins: Vec<String>,
    /// 变更明细（pluginId -> 变更项列表）
    pub changes: BTreeMap<String, Vec<String>>,
}

/// 对比旧状态与新状态，返回逐插件变更项（同一插件多字段变化时合并）。
fn diff_plugin_states(
    old: &PluginState,
    new: &PluginState,
) -> Vec<String> {
    let mut changed = Vec::new();
    if old.enabled != new.enabled {
        changed.push("enabled".to_string());
    }
    if old.mcp_enabled != new.mcp_enabled {
        changed.push("mcpEnabled".to_string());
    }

    // per-server 开关 diff（以新旧 key 并集遍历）
    let mut server_keys: Vec<&String> = old
        .mcp_servers
        .keys()
        .chain(new.mcp_servers.keys())
        .collect();
    server_keys.sort();
    server_keys.dedup();
    for key in server_keys {
        let old_enabled = old
            .mcp_servers
            .get(key)
            .map(|s: &PluginMcpServerState| s.enabled);
        let new_enabled = new
            .mcp_servers
            .get(key)
            .map(|s: &PluginMcpServerState| s.enabled);
        if old_enabled != new_enabled {
            changed.push(format!("mcpServers.{}", key));
        }
    }

    changed
}

/// 后端统一感知：状态保存（plugin_state_save）后的 diff + 广播 + 返回概览。
///
/// `config_dir` 用于读旧状态（与保存同一路径源）；`broadcaster` 用于事件发送。
/// 返回 `PluginStateChangeOverview` 供调用方回传给前端（展示「哪些插件变了、怎么变」）。
///
/// 幂等边界：无旧状态文件（首次保存）→ 仅当新状态非空时广播一次 `state_changed`（pluginId=unknown）
/// 触发前端全量刷新；有旧状态 → 逐插件广播变更项。
pub fn handle_plugin_state_change(
    config_dir: &std::path::Path,
    new_states: &PluginStateMap,
    broadcaster: &crate::web::EventBroadcaster,
) -> PluginStateChangeOverview {
    let old_states = crate::services::plugin_state_service::PluginStateService::new(
        config_dir.to_path_buf(),
    )
    .load()
    .unwrap_or_default();

    let mut changes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut changed_plugins = Vec::new();

    if old_states.is_empty() {
        // 首次保存：无旧状态可 diff，广播一次全量刷新信号
        if !new_states.is_empty() {
            broadcast_plugin_lifecycle(
                broadcaster,
                "unknown",
                "state_changed",
                Some(json!({ "initial": true })),
            );
            changed_plugins = new_states.keys().cloned().collect();
            for plugin_id in new_states.keys() {
                changes.insert(plugin_id.clone(), vec!["*".to_string()]);
            }
        }
        return PluginStateChangeOverview {
            changed_plugins,
            changes,
        };
    }

    // 有旧状态：逐插件 diff
    let mut all_keys: Vec<&String> = old_states
        .keys()
        .chain(new_states.keys())
        .collect();
    all_keys.sort();
    all_keys.dedup();

    for plugin_id in all_keys {
        let old = old_states.get(plugin_id);
        let new = new_states.get(plugin_id);
        match (old, new) {
            (Some(_), None) => {
                // 状态记录被删除（resetPluginState）
                changed_plugins.push(plugin_id.clone());
                changes.insert(plugin_id.clone(), vec!["removed".to_string()]);
                broadcast_plugin_lifecycle(
                    broadcaster,
                    plugin_id,
                    "state_changed",
                    Some(json!({ "changed": ["removed"] })),
                );
            }
            (None, Some(_)) => {
                // 新增状态记录（首次设置某插件开关）
                changed_plugins.push(plugin_id.clone());
                changes.insert(plugin_id.clone(), vec!["*".to_string()]);
                broadcast_plugin_lifecycle(
                    broadcaster,
                    plugin_id,
                    "state_changed",
                    Some(json!({ "changed": ["*"] })),
                );
            }
            (Some(old_state), Some(new_state)) => {
                let fields = diff_plugin_states(old_state, new_state);
                if !fields.is_empty() {
                    changed_plugins.push(plugin_id.clone());
                    changes.insert(plugin_id.clone(), fields.clone());
                    broadcast_plugin_lifecycle(
                        broadcaster,
                        plugin_id,
                        "state_changed",
                        Some(json!({ "changed": fields })),
                    );
                }
            }
            (None, None) => {}
        }
    }

    PluginStateChangeOverview {
        changed_plugins,
        changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(enabled: bool, mcp_enabled: bool, mcp_servers: Vec<(&str, bool)>) -> PluginState {
        PluginState {
            enabled,
            mcp_enabled,
            ui_enabled: true,
            mcp_servers: mcp_servers
                .into_iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        PluginMcpServerState { enabled: v },
                    )
                })
                .collect(),
            mcp_tool_gates: Default::default(),
        }
    }

    #[test]
    fn diff_plugin_states_detects_switch_changes() {
        let old = state(true, true, vec![]);
        let new = state(false, true, vec![]);
        let fields = diff_plugin_states(&old, &new);
        assert!(fields.contains(&"enabled".to_string()));
        assert!(!fields.contains(&"mcpEnabled".to_string()));
    }

    #[test]
    fn diff_plugin_states_detects_server_changes() {
        let old = state(true, true, vec![("s1", true)]);
        let new = state(true, true, vec![("s1", false)]);
        let fields = diff_plugin_states(&old, &new);
        assert!(fields.contains(&"mcpServers.s1".to_string()));
    }

    #[test]
    fn diff_plugin_states_ignores_unchanged() {
        let old = state(true, true, vec![("s1", true)]);
        let new = state(true, true, vec![("s1", true)]);
        assert!(diff_plugin_states(&old, &new).is_empty());
    }

    #[test]
    fn handle_plugin_state_change_initial_save_broadcasts_once() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_dir = temp_dir.path();
        let broadcaster = crate::web::EventBroadcaster::new(8);
        let mut sub = broadcaster.subscribe();

        let mut states = PluginStateMap::new();
        states.insert(
            "polaris.todo".to_string(),
            state(true, true, vec![]),
        );

        let overview =
            handle_plugin_state_change(config_dir, &states, &broadcaster);
        assert!(overview.changed_plugins.contains(&"polaris.todo".to_string()));

        // 应广播一条 state_changed（initial）
        let mut got = 0;
        while let Ok(ev) = sub.try_recv() {
            if ev.contains("plugin.lifecycle") {
                got += 1;
            }
        }
        assert_eq!(got, 1);
    }

    #[test]
    fn handle_plugin_state_change_diffs_and_broadcasts_per_plugin() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_dir = temp_dir.path();
        let service =
            crate::services::plugin_state_service::PluginStateService::new(config_dir.to_path_buf());

        // 先落一个旧状态
        let mut old = PluginStateMap::new();
        old.insert(
            "polaris.ask".to_string(),
            state(true, true, vec![]),
        );
        service.save(&old).unwrap();

        let broadcaster = crate::web::EventBroadcaster::new(8);
        let mut sub = broadcaster.subscribe();

        // 新状态：ask 关掉 enabled
        let mut new = PluginStateMap::new();
        new.insert(
            "polaris.ask".to_string(),
            state(false, true, vec![]),
        );

        let overview = handle_plugin_state_change(config_dir, &new, &broadcaster);
        assert_eq!(overview.changed_plugins, vec!["polaris.ask".to_string()]);
        assert_eq!(
            overview.changes.get("polaris.ask").unwrap(),
            &vec!["enabled".to_string()]
        );

        // 广播一条 state_changed
        let mut got = 0;
        while let Ok(ev) = sub.try_recv() {
            if ev.contains("plugin.lifecycle") {
                got += 1;
            }
        }
        assert_eq!(got, 1);
    }

    #[test]
    fn handle_plugin_state_change_unchanged_broadcasts_nothing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_dir = temp_dir.path();
        let service =
            crate::services::plugin_state_service::PluginStateService::new(config_dir.to_path_buf());

        let mut states = PluginStateMap::new();
        states.insert("polaris.ask".to_string(), state(true, true, vec![]));
        service.save(&states).unwrap();

        let broadcaster = crate::web::EventBroadcaster::new(8);
        let mut sub = broadcaster.subscribe();

        let overview = handle_plugin_state_change(config_dir, &states, &broadcaster);
        assert!(overview.changed_plugins.is_empty());

        let mut got = 0;
        while let Ok(ev) = sub.try_recv() {
            if ev.contains("plugin.lifecycle") {
                got += 1;
            }
        }
        assert_eq!(got, 0);
    }
}