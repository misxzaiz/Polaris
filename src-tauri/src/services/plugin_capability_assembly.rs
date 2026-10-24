//! 插件 cap 贡献装配（P2-d，2026-10-24 审计：插件提供 cap 的运行时装配面）
//!
//! 职责：把启用插件 `contributes.capabilities` 声明装配进 RouterBus——
//! - 非 replaces：注册全新动态能力（DynamicCapability，X12 查重防重复）；
//! - replaces：走覆盖链（分级授权 L0/L2/L4 仍生效，复用 registry 的判定）。
//!
//! 同步时机：应用启动（state.rs）、插件启停切换（plugin_state_save）、
//! 安装/更新/卸载（cap.pluginDiscovery 写动作）。每次全量重算（幂等：
//! 已注册的注册失败被 X12 查重拒绝并跳过 warn；禁用插件的贡献被撤销）。
//!
//! RouterBus 经进程级 OnceLock 共享（模式同 hook_registry / mcp_tool_gates）：
//! PluginDiscoveryCapability / plugin_state command 无 AppState.router 直达通道。

use std::sync::{Arc, OnceLock};

use crate::contracts::{CapabilityId, ReplaceMode};
use crate::models::plugin::DiscoveredPluginManifest;
use crate::models::plugin_state::PluginStateMap;
use crate::services::router::check_override_permission;
use crate::services::router::{
    DynamicCapability, DynamicCapabilityConfig, DynamicHandler, RouterBus,
};

static ROUTER_BUS: OnceLock<Arc<RouterBus>> = OnceLock::new();

/// 装配期注入（state.rs，RouterBus 构建后调用一次）
pub fn put_router_bus(router: Arc<RouterBus>) {
    let _ = ROUTER_BUS.set(router);
}

/// 进程级 RouterBus（装配点调用；未装配返回 None——测试/极早调用）
pub fn router_bus() -> Option<Arc<RouterBus>> {
    ROUTER_BUS.get().cloned()
}

/// 插件贡献统一同步入口（P2-d capabilities + P4 skills）。
/// 全部生命周期挂点（启动 / plugin_state_save / emit_plugin_lifecycle）统一调用。
pub fn sync_plugin_contributions(
    router: &Arc<RouterBus>,
    plugins: &[DiscoveredPluginManifest],
    plugin_states: &PluginStateMap,
) -> Vec<String> {
    let mut synced = sync_plugin_capabilities(router, plugins, plugin_states);
    synced.extend(crate::services::plugin_skills::sync_plugin_skills(
        plugins,
        plugin_states,
    ));
    synced
}

/// 全量同步插件 cap 贡献（幂等，可重复调用）。
/// 返回本次生效注册的 cap id 列表（诊断用）。
pub fn sync_plugin_capabilities(
    router: &Arc<RouterBus>,
    plugins: &[DiscoveredPluginManifest],
    plugin_states: &PluginStateMap,
) -> Vec<String> {
    let mut effective = Vec::new();
    for plugin in plugins {
        let enabled = plugin_states
            .get(&plugin.id)
            .map(|st| st.enabled)
            .unwrap_or(plugin.enabled_by_default);
        if !enabled {
            // 禁用插件：撤销其贡献（覆盖层弹出 + 动态注册卸载，均幂等）
            for contrib in &plugin.contributes.capabilities {
                let id = CapabilityId(contrib.id.clone());
                if router.unregister_override(&id) {
                    tracing::info!(plugin = %plugin.id, cap = %contrib.id, "插件禁用：覆盖层已弹出");
                } else if router.unregister(&id) {
                    tracing::info!(plugin = %plugin.id, cap = %contrib.id, "插件禁用：动态 cap 已卸载");
                }
            }
            continue;
        }
        for contrib in &plugin.contributes.capabilities {
            let outcome = register_one(router, plugin.id.as_str(), contrib);
            match outcome {
                Ok(()) => {
                    tracing::info!(
                        plugin = %plugin.id,
                        cap = %contrib.id,
                        replaced = contrib.replaces,
                        "插件 cap 贡献已注册"
                    );
                    effective.push(contrib.id.clone());
                }
                Err(e) => tracing::warn!(
                    plugin = %plugin.id,
                    cap = %contrib.id,
                    error = %e,
                    "插件 cap 贡献注册失败（跳过，不影响其余贡献）"
                ),
            }
        }
    }
    effective
}

fn register_one(
    router: &Arc<RouterBus>,
    _plugin_id: &str,
    contrib: &crate::models::plugin::PluginCapabilityManifestContribution,
) -> Result<(), String> {
    if !contrib.id.starts_with("cap.") {
        return Err(format!("cap id 必须以 cap. 开头: {}", contrib.id));
    }
    let handler: DynamicHandler = serde_json::from_value(contrib.handler.clone())
        .map_err(|e| format!("handler 反序列化失败: {}（形态见 cap.registry register）", e))?;
    let config = DynamicCapabilityConfig {
        id: contrib.id.clone(),
        summary: contrib.summary.clone(),
        description: contrib.description.clone(),
        handler,
        persist: false,
    };
    let cap: Arc<DynamicCapability> =
        Arc::new(DynamicCapability::new(config, router.clone()));
    if contrib.replaces {
        check_override_permission(router, &contrib.id)?;
        let mode = ReplaceMode::parse(contrib.replace_mode.as_deref().unwrap_or("override"))?;
        router.register_override(CapabilityId(contrib.id.clone()), cap, mode)
    } else {
        // X12：同 id 已注册（重复同步/与内置撞名）→ Err，按 warn 跳过
        router.register_handle_arc(cap).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugin::PluginCapabilityManifestContribution;
    use crate::services::router::event_adapter::EventAdapter;
    use crate::services::router::KvCapability;
    use crate::contracts::{Permission, PermissionRequest, PermissionVerdict};

    struct AllowAll;
    impl Permission for AllowAll {
        fn check(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            Ok(PermissionVerdict::Allow)
        }
    }

    fn make_router() -> Arc<RouterBus> {
        let adapter = Arc::new(EventAdapter::new(16));
        let bus = Arc::new(RouterBus::new(
            adapter,
            Arc::new(AllowAll),
            None,
            None,
        ));
        use crate::contracts::Router as _;
        let _ = bus.register_handle(Box::new(KvCapability));
        bus
    }

    fn contrib(id: &str, replaces: bool, handler: serde_json::Value) -> PluginCapabilityManifestContribution {
        PluginCapabilityManifestContribution {
            id: id.into(),
            summary: "test".into(),
            description: None,
            handler,
            replaces,
            replace_mode: None,
        }
    }

    #[test]
    fn sync_registers_and_revokes() {
        let router = make_router();
        let c = contrib(
            "cap.pluginx.test",
            false,
            serde_json::json!({"type": "forward", "target": "cap.kv"}),
        );
        let out = sync_plugin_capabilities(&router, &[], &HashMap::new());
        assert!(out.is_empty(), "无插件时无注册");

        // 直接以单插件调用（构造 DiscoveredPluginManifest 较重，走 register_one 语义）
        assert!(register_one(&router, "pluginx", &c).is_ok());
        assert!(register_one(&router, "pluginx", &c).is_err(), "X12 查重：重复注册被拒");

        // 禁用撤销
        assert!(router.unregister(&CapabilityId("cap.pluginx.test".into())));
    }

    #[test]
    fn replace_requires_levels() {
        let router = make_router();
        // L4 拒绝
        let c = contrib(
            "cap.registry",
            true,
            serde_json::json!({"type": "forward", "target": "cap.kv"}),
        );
        assert!(register_one(&router, "p", &c).is_err());
        // L2 未授权拒绝
        let c2 = contrib(
            "cap.bash",
            true,
            serde_json::json!({"type": "forward", "target": "cap.kv"}),
        );
        assert!(register_one(&router, "p", &c2).is_err());
        // L0 放行（cap.kv 已注册为 base，覆盖合法）
        let c3 = contrib(
            "cap.kv",
            true,
            serde_json::json!({"type": "forward", "target": "cap.kv"}),
        );
        assert!(register_one(&router, "p", &c3).is_ok());
        assert!(router.is_overridden(&CapabilityId("cap.kv".into())));
        // 弹出恢复
        assert!(router.unregister_override(&CapabilityId("cap.kv".into())));
        assert!(!router.is_overridden(&CapabilityId("cap.kv".into())));
    }
}
