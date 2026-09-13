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

use crate::contracts::{Capability, CapabilityId, Context, Value};
use crate::models::plugin::{
    DiscoveredPluginManifest, PluginServiceManifestContribution,
};
use crate::services::plugin_service::PluginService;
use crate::services::plugin_service_manager::{
    PluginServiceManager, ServiceStatus, StartContext,
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
                let contribution: PluginServiceManifestContribution = serde_json::from_value(
                    params
                        .get("contribution")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|e| format!("contribution 解析失败: {}", e))?;
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
            other => Err(format!("cap.pluginServiceManager 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}