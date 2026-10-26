//! cap.pluginServiceManager —— 插件服务管理统一入口
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 C：管理面域上总线。
//! 抽核自旧命令层 `commands/plugin_service.rs`（业务核逐行搬移，语义不变）。
//!
//! 边界（step7 §3）：
//! - 本域只管插件服务的进程拉起/停止/重启/状态查询/自动启动
//! - plugin_state_*（前端记忆）、plugin_get/set_config（插件配置）不在此域
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `start`            `{ "action": "start", "pluginId": string, "contribution": {...},
//!                            "installPath": string, "workspacePath": string? }`
//!                            → ServiceStatus
//! - `stop`               `{ "action": "stop", "pluginId": string, "serviceId": string }`
//!                            → ServiceStatus
//! - `restart`            `{ "action": "restart", "pluginId": string, "serviceId": string }`
//!                            → ServiceStatus
//! - `list_status`        `{ "action": "list_status" }` → Vec<ServiceStatus>
//! - `stop_for_plugin`   `{ "action": "stop_for_plugin", "pluginId": string }`
//!                            → Vec<ServiceStatus>
//! - `autostart`         `{ "action": "autostart", "pluginStates": { [k]: { enabled: bool } },
//!                            "workspacePath": string? }` → Vec<ServiceStatus>
//!                            （重发现已安装插件 + 按状态决定启动）

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use crate::models::plugin::{
    DiscoveredPluginManifest, PluginServiceManifestContribution,
};
use crate::services::plugin_service::PluginService;
use crate::services::plugin_service_manager::{
    PluginServiceManager, StartContext,
};

const CAP_ID: &str = "cap.pluginServiceManager";

/// 支持的 action 协议（与前端 pluginServiceManager 对齐）
pub const PLUGIN_SERVICE_MANAGER_ACTIONS: &[&str] = &[
    "start",
    "stop",
    "restart",
    "list_status",
    "stop_for_plugin",
    "autostart",
];

/// 前端 plugin_states 快照（autostart 用）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginStateSnapshot {
    /// 是否启用整个插件
    pub enabled: bool,
}

/// cap.pluginServiceManager —— 插件服务管理能力。
///
/// 依赖注入（组装点 state.rs 提供）：
/// - `plugin_service_manager`：Arc<PluginServiceManager>（进程拉起/状态/自动重启）
/// - `app_config_dir`：插件安装基础目录（构建 StartContext）
pub struct PluginServiceManagerCapability {
    plugin_service_manager: Arc<PluginServiceManager>,
    app_config_dir: std::path::PathBuf,
}

impl PluginServiceManagerCapability {
    /// describe 文档（单测可直接校验；`describe()` 委托本函数）。
    ///
    /// 不走实例构造的原因：单测虽可用 `PluginServiceManager::new()` 构造，
    /// 但本函数不读任何实例字段，抽成关联函数让契约测试零依赖。
    ///
    /// 2026-10-25 审计 paramDrift 修正（对齐 invoke 实现）：start 补
    /// installPath+contribution 必填、stop/restart 补 pluginId+serviceId、
    /// autostart 改 pluginStates map（顶层 pluginId/enabled 被实现完全忽略）、
    /// list_status/stop_for_plugin/autostart 返回裸数组；note 的「Remote 默认
    /// deny」已过时（policy_permission.rs P1-f 已改为已鉴权 Remote 放行）。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "插件服务",
            "插件后台服务管理：启动/停止/重启/状态查询/按插件停止/按状态自启",
            Some("管理面能力：已鉴权 Remote 放行（require_auth，未鉴权 deny）；Plugin 来源的 stop_for_plugin/autostart 默认放行（2026-10-26 起审批名单停用）；start/stop/restart 拉起或终止进程，需谨慎"),
            serde_json::json!({
                "start": { "params": {
                    "pluginId": "string（必填）",
                    "installPath": "string（必填）",
                    "contribution": "object（必填，含 id/type/command；可选 argsTemplate/port/healthCheck/healthCheckTimeout/autoStart）",
                    "workspacePath": "string?"
                }, "returns": "ServiceStatus" },
                "stop": { "params": { "pluginId": "string（必填）", "serviceId": "string（必填）" }, "returns": "ServiceStatus" },
                "restart": { "params": { "pluginId": "string（必填）", "serviceId": "string（必填）" }, "returns": "ServiceStatus" },
                "list_status": { "params": {}, "returns": "ServiceStatus[]（裸数组）" },
                "stop_for_plugin": { "params": { "pluginId": "string（必填）" }, "returns": "ServiceStatus[]（裸数组）" },
                "autostart": { "params": {
                    "pluginStates": "object（必填语义）——map: pluginId → { enabled: bool }，按各插件 enabled 决定是否启动其服务；缺省/空对象时不报错但不会启停任何服务",
                    "workspacePath": "string?"
                }, "returns": "ServiceStatus[]（裸数组）" }
            }),
        )
    }

    pub fn new(
        plugin_service_manager: Arc<PluginServiceManager>,
        app_config_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            plugin_service_manager,
            app_config_dir,
        }
    }

    /// 构建 StartContext（与旧命令层 build_ctx 同源）
    fn build_ctx(&self, workspace_path: Option<String>) -> StartContext {
        StartContext {
            workspace_path,
            app_config_dir: Some(self.app_config_dir.to_string_lossy().to_string()),
        }
    }

    /// 解析 workspacePath 参数（空串/空白 → None）
    fn workspace_path(args: &Value) -> Option<String> {
        args.get("workspacePath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
    }

    fn require_string<'a>(args: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.pluginServiceManager 缺少参数: {}", key))
    }

    /// 包装：async 业务核在 tokio 运行时内驱动（history/ai_chat 同款范式）
    fn block_on_async<F>(f: F) -> std::result::Result<Value, String>
    where
        F: std::future::Future<Output = std::result::Result<Value, String>>,
    {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.pluginServiceManager 异步动作需在 tokio 运行时内调用".to_string())?;
        tokio::task::block_in_place(move || handle.block_on(f))
    }
}

impl Capability for PluginServiceManagerCapability {
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
                    "cap.pluginServiceManager 需要 action 参数（{:?}）",
                    PLUGIN_SERVICE_MANAGER_ACTIONS
                )
            })?;

        match action {
            "start" => {
                let plugin_id = Self::require_string(&params, "pluginId")?.to_string();
                let install_path = Self::require_string(&params, "installPath")?.to_string();
                let contribution: PluginServiceManifestContribution =
                    serde_json::from_value(
                        params
                            .get("contribution")
                            .cloned()
                            .unwrap_or(Value::Null),
                    )
                    .map_err(|e| {
                        // 审计错误工效：原文案只有 serde 原始错误，未说明该字段必填
                        // 及必填子字段（id/type/command 均无 #[serde(default)]），
                        // AI 无法据此自纠。附字段结构提示。
                        format!(
                            "contribution 解析失败: {e}（必填对象，含 id/type/command；可选 argsTemplate/port/healthCheck/healthCheckTimeout/autoStart）"
                        )
                    })?;
                let workspace_path = Self::workspace_path(&params);
                let psm = self.plugin_service_manager.clone();
                let ctx = self.build_ctx(workspace_path);
                Self::block_on_async(async move {
                    let status = psm
                        .start_service(&plugin_id, contribution, install_path, ctx)
                        .await
                        .map_err(|e| e.to_string())?;
                    serde_json::to_value(status).map_err(|e| e.to_string())
                })
            }
            "stop" => {
                let plugin_id = Self::require_string(&params, "pluginId")?.to_string();
                let service_id = Self::require_string(&params, "serviceId")?.to_string();
                let psm = self.plugin_service_manager.clone();
                Self::block_on_async(async move {
                    let status = psm
                        .stop_service(&plugin_id, &service_id)
                        .await
                        .map_err(|e| e.to_string())?;
                    serde_json::to_value(status).map_err(|e| e.to_string())
                })
            }
            "restart" => {
                let plugin_id = Self::require_string(&params, "pluginId")?.to_string();
                let service_id = Self::require_string(&params, "serviceId")?.to_string();
                let psm = self.plugin_service_manager.clone();
                Self::block_on_async(async move {
                    let status = psm
                        .restart_service(&plugin_id, &service_id)
                        .await
                        .map_err(|e| e.to_string())?;
                    serde_json::to_value(status).map_err(|e| e.to_string())
                })
            }
            "list_status" => {
                let psm = self.plugin_service_manager.clone();
                Self::block_on_async(async move {
                    let statuses = psm.list_status().await;
                    serde_json::to_value(statuses).map_err(|e| e.to_string())
                })
            }
            "stop_for_plugin" => {
                let plugin_id = Self::require_string(&params, "pluginId")?.to_string();
                let psm = self.plugin_service_manager.clone();
                Self::block_on_async(async move {
                    let statuses = psm
                        .stop_services_for_plugin(&plugin_id)
                        .await
                        .map_err(|e| e.to_string())?;
                    serde_json::to_value(statuses).map_err(|e| e.to_string())
                })
            }
            "autostart" => {
                let workspace_path = Self::workspace_path(&params);
                let plugin_states = params
                    .get("pluginStates")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let states_map: std::result::Result<HashMap<String, bool>, String> =
                    plugin_states
                        .into_iter()
                        .map(|(k, v)| {
                            serde_json::from_value::<PluginStateSnapshot>(v)
                                .map(|s| (k.clone(), s.enabled))
                                .map_err(|e| format!("pluginStates[{}] 解析失败: {}", k, e))
                        })
                        .collect();
                let states_map = states_map?;
                let cfg_dir = self.app_config_dir.clone();
                let psm = self.plugin_service_manager.clone();
                let ctx = self.build_ctx(workspace_path);
                Self::block_on_async(async move {
                    let ws_path: Option<&Path> =
                        ctx.workspace_path.as_deref().map(Path::new);
                    let discovery = PluginService::discover_installed_plugins(&cfg_dir, ws_path);
                    let plugins: Vec<DiscoveredPluginManifest> = discovery.plugins;
                    let statuses = psm
                        .start_services_for_plugins(&plugins, &states_map, ctx)
                        .await;
                    serde_json::to_value(statuses).map_err(|e| e.to_string())
                })
            }
            // 审计错误工效：未知动作附支持清单与协议入口（错误即文档，可自纠）
            other => Err(unsupported_action(
                CAP_ID,
                other,
                PLUGIN_SERVICE_MANAGER_ACTIONS,
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

    /// 最小测试 Context（对齐 stream_echo_capability tests 范式；本能力 invoke
    /// 只用 require_string/workspace_path，不触达 storage/权限）
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

    /// describe 契约测试：standard_describe 构造 + validate_describe 零违例 +
    /// 动作清单与实现一致 + 审计 paramDrift 修正抽查。
    /// PluginServiceManager::new() 纯内存（broadcast channel + Mutex 表），
    /// 可无副作用构造真实实例走 trait describe()。
    #[test]
    fn describe_contract() {
        let cap = PluginServiceManagerCapability::new(
            Arc::new(PluginServiceManager::new()),
            std::path::PathBuf::from("."),
        );
        let d = cap.describe();
        let id = cap.id().0;
        let problems = crate::contracts::validate_describe(&id, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        assert_eq!(d["id"], "cap.pluginServiceManager");
        assert_eq!(d["name"], "插件服务");
        for action in PLUGIN_SERVICE_MANAGER_ACTIONS {
            assert!(
                d["actions"].get(*action).is_some(),
                "describe 缺动作 {action}"
            );
        }
        // 审计 paramDrift 抽查：start 必填三件套 / stop-restart 双键 /
        // autostart 用 pluginStates map / list_status 裸数组
        assert!(d["actions"]["start"]["params"]["installPath"].is_string());
        assert!(d["actions"]["start"]["params"]["contribution"]
            .as_str()
            .unwrap()
            .contains("必填"));
        assert!(d["actions"]["stop"]["params"]["pluginId"].is_string());
        assert!(d["actions"]["stop"]["params"]["serviceId"].is_string());
        assert!(d["actions"]["restart"]["params"]["serviceId"].is_string());
        assert!(d["actions"]["autostart"]["params"]["pluginStates"]
            .as_str()
            .unwrap()
            .contains("pluginStates"));
        assert!(d["actions"]["list_status"]["returns"]
            .as_str()
            .unwrap()
            .contains("裸数组"));
        // note 已对齐 P1-f：不再写「Remote 默认 deny」
        let note = d["note"].as_str().unwrap();
        assert!(!note.contains("Remote 默认 deny"), "过时表述仍在: {note}");
    }

    /// 审计错误工效：未知动作错误应列出全部支持动作（unsupported_action 生成）
    #[test]
    fn unknown_action_lists_supported_actions() {
        let cap = PluginServiceManagerCapability::new(
            Arc::new(PluginServiceManager::new()),
            std::path::PathBuf::from("."),
        );
        let err = cap
            .invoke(serde_json::json!({"action": "explode"}), &TestCtx)
            .unwrap_err();
        for action in PLUGIN_SERVICE_MANAGER_ACTIONS {
            assert!(err.contains(action), "错误应含动作 {action}: {err}");
        }
        assert!(err.contains("cap.help"), "错误应指路协议入口: {err}");
    }
}