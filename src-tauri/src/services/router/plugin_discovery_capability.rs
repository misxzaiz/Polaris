//! cap.pluginDiscovery —— 插件发现/安装/卸载/市场统一入口
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 C：管理面域上总线。
//! 抽核自旧命令层 `commands/plugin.rs` + `web/api/ipc.rs` 的 plugin dispatcher
//! （业务核 + 类型逐行搬移，语义不变）。
//!
//! 边界（step7 §3）：
//! - `plugin_state_*`（前端记忆）不在此域，留在命令层/ipc
//! - `plugin_get_config` / `plugin_set_config`（插件配置）不在此域
//! - `register_plugin_engine` / `unregister_plugin_engine`（引擎注册表）不在此域
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `list`                 `{ "action": "list", "available": bool }`
//!                            → PluginListResult（已安装/可选插件列表）
//! - `discover`             `{ "action": "discover", "workspacePath": string? }`
//!                            → PluginDiscoveryResult（发现已安装插件）
//! - `install_locations`    `{ "action": "install_locations", "workspacePath": string? }`
//!                            → PluginInstallLocations
//! - `validate_manifest`    `{ "action": "validate_manifest", "sourcePath": string }`
//!                            → PluginManifestValidationResult
//! - `install_local`        `{ "action": "install_local", "sourcePath": string,
//!                            "scope": "user"|"project", "workspacePath": string? }`
//!                            → PluginOperationResult
//! - `install_package`      `{ "action": "install_package", "packagePath": string, ... }`
//!                            → PluginOperationResult
//! - `install_remote`       `{ "action": "install_remote", "sourceUrl": string, ... }`  (async)
//!                            → PluginOperationResult
//! - `uninstall_local`      `{ "action": "uninstall_local", "installPath": string, ... }`
//!                            → PluginOperationResult
//! - `uninstall_with_cleanup` `{ "action": "uninstall_with_cleanup", "installPath": string,
//!                            "pluginId": string, ... }`  (async)
//!                            → PluginOperationResult（先停 PluginServiceManager 服务再杀进程删目录）
//! - `force_uninstall`      `{ "action": "force_uninstall", "installPath": string, ... }`
//!                            → PluginOperationResult
//! - `check_update`         `{ "action": "check_update", "installPath": string }`  (async)
//!                            → PluginUpdateCheckResult
//! - `apply_update`         `{ "action": "apply_update", "installPath": string, ... }`  (async)
//!                            → PluginOperationResult
//! 其余 plugin.rs 命令（install/enable/disable/update/uninstall + marketplace_*）
//! 无前端消费方，保留在命令层（step7 抽核只搬有消费方的 11 个）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::contracts::{Capability, CapabilityId, Context, Value};
use crate::models::plugin::PluginManifestSourceKind;
use crate::services::config_store::ConfigStore;
use crate::services::plugin_service::PluginService;
use crate::services::plugin_service_manager::PluginServiceManager;

const CAP_ID: &str = "cap.pluginDiscovery";

/// 支持的 action 协议（与前端 pluginDiscoveryService 对齐）
pub const PLUGIN_DISCOVERY_ACTIONS: &[&str] = &[
    "list",
    "discover",
    "install_locations",
    "validate_manifest",
    "install_local",
    "install_package",
    "install_remote",
    "uninstall_local",
    "uninstall_with_cleanup",
    "force_uninstall",
    "check_update",
    "apply_update",
];

/// cap.pluginDiscovery —— 插件发现能力。
///
/// 依赖注入（组装点 state.rs 提供，capability 内部不碰 AppState）：
/// - `config_store`：取 claude CLI 路径（PluginService::new 需要）
/// - `app_config_dir`：插件安装基础目录
/// - `plugin_service_manager`：`uninstall_with_cleanup` 先停服务再删目录
pub struct PluginDiscoveryCapability {
    config_store: Arc<Mutex<ConfigStore>>,
    app_config_dir: PathBuf,
    plugin_service_manager: Arc<PluginServiceManager>,
}

impl PluginDiscoveryCapability {
    pub fn new(
        config_store: Arc<Mutex<ConfigStore>>,
        app_config_dir: PathBuf,
        plugin_service_manager: Arc<PluginServiceManager>,
    ) -> Self {
        Self {
            config_store,
            app_config_dir,
            plugin_service_manager,
        }
    }

    /// claude_code.cli_path（自动解析，未手动指定时走 PATH/常见位置检测）
    fn claude_path(&self) -> crate::error::Result<String> {
        let store = self
            .config_store
            .lock()
            .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
        Ok(store.get().resolve_claude_cmd())
    }

    /// 插件安装基础目录（与旧命令层 get_plugin_config_dir 同源）
    fn plugin_config_dir(&self) -> crate::error::Result<PathBuf> {
        // app_config_dir 在组装点已 resolved；兜底 DataRoot
        if self.app_config_dir.as_os_str().is_empty() {
            Ok(crate::services::data_root::data_root().config_dir())
        } else {
            Ok(self.app_config_dir.clone())
        }
    }

    /// 解析 workspacePath 参数（空串/空白 → None）
    fn workspace_path(args: &Value) -> Option<PathBuf> {
        args.get("workspacePath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
    }

    /// scope 字符串 → PluginManifestSourceKind
    fn parse_scope(args: &Value) -> PluginManifestSourceKind {
        match args.get("scope").and_then(|v| v.as_str()) {
            Some("project") => PluginManifestSourceKind::Project,
            _ => PluginManifestSourceKind::User,
        }
    }

    fn require_string<'a>(args: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.pluginDiscovery 缺少参数: {}", key))
    }

    /// 包装：async 业务核在 tokio 运行时内驱动（history/ai_chat 同款范式）
    fn block_on_async<F>(f: F) -> std::result::Result<Value, String>
    where
        F: std::future::Future<Output = std::result::Result<Value, String>>,
    {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.pluginDiscovery 异步动作需在 tokio 运行时内调用".to_string())?;
        tokio::task::block_in_place(move || handle.block_on(f))
    }
}

impl Capability for PluginDiscoveryCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.pluginDiscovery 需要 action 参数（{:?}）", PLUGIN_DISCOVERY_ACTIONS))?;

        let map_err = |e: crate::error::AppError| e.to_string();

        match action {
            "list" => {
                let available = params.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
                let claude_path = self.claude_path().map_err(map_err)?;
                if claude_path.is_empty() {
                    return Ok(serde_json::json!({ "installed": [], "available": [] }));
                }
                let service = PluginService::new(claude_path);
                let result = service.list_plugins(available).map_err(map_err)?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "discover" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                Ok(serde_json::to_value(
                    PluginService::discover_installed_plugins(&config_dir, workspace_path.as_deref()),
                )
                .map_err(|e| e.to_string())?)
            }
            "install_locations" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                Ok(serde_json::to_value(
                    PluginService::install_locations(&config_dir, workspace_path.as_deref()),
                )
                .map_err(|e| e.to_string())?)
            }
            "validate_manifest" => {
                let source_path = Self::require_string(&params, "sourcePath")?;
                Ok(serde_json::to_value(
                    PluginService::validate_plugin_manifest(Path::new(source_path)),
                )
                .map_err(|e| e.to_string())?)
            }
            "install_local" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                let source_path = Self::require_string(&params, "sourcePath")?;
                let scope = Self::parse_scope(&params);
                let result = PluginService::install_local_plugin(
                    &config_dir,
                    workspace_path.as_deref(),
                    Path::new(source_path),
                    scope,
                )
                .map_err(map_err)?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "install_package" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                let package_path = Self::require_string(&params, "packagePath")?;
                let scope = Self::parse_scope(&params);
                let result = PluginService::install_plugin_package(
                    &config_dir,
                    workspace_path.as_deref(),
                    Path::new(package_path),
                    scope,
                )
                .map_err(map_err)?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "install_remote" => {
                let config_dir = self.plugin_config_dir();
                let workspace_path = Self::workspace_path(&params);
                let source_url = Self::require_string(&params, "sourceUrl")?.to_string();
                let scope = Self::parse_scope(&params);
                let config_dir = config_dir.map_err(map_err)?;
                Self::block_on_async(async move {
                    let result = PluginService::install_remote_plugin(
                        &config_dir,
                        workspace_path.as_deref(),
                        &source_url,
                        scope,
                    )
                    .await
                    .map_err(map_err)?;
                    serde_json::to_value(result).map_err(|e| e.to_string())
                })
            }
            "uninstall_local" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                let install_path = Self::require_string(&params, "installPath")?;
                let result = PluginService::uninstall_local_plugin(
                    &config_dir,
                    workspace_path.as_deref(),
                    Path::new(install_path),
                )
                .map_err(map_err)?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "uninstall_with_cleanup" => {
                let config_dir = self.plugin_config_dir();
                let workspace_path = Self::workspace_path(&params);
                let install_path = Self::require_string(&params, "installPath")?.to_string();
                let plugin_id = Self::require_string(&params, "pluginId")?.to_string();
                let config_dir = config_dir.map_err(map_err)?;
                let psm = self.plugin_service_manager.clone();
                Self::block_on_async(async move {
                    // 1. 停止 PluginServiceManager 管理的服务
                    let _ = psm.stop_services_for_plugin(&plugin_id).await;
                    // 2. 终止进程 + 删除目录（带重试）
                    let result = PluginService::uninstall_plugin_with_cleanup(
                        &config_dir,
                        workspace_path.as_deref(),
                        Path::new(&install_path),
                    )
                    .map_err(map_err)?;
                    serde_json::to_value(result).map_err(|e| e.to_string())
                })
            }
            "force_uninstall" => {
                let config_dir = self.plugin_config_dir().map_err(map_err)?;
                let workspace_path = Self::workspace_path(&params);
                let install_path = Self::require_string(&params, "installPath")?;
                // 注：force_uninstall_plugin 直接返回 PluginOperationResult（内含 success/error），
                // 无 crate Result 外壳，不 map_err
                let result = PluginService::force_uninstall_plugin(
                    &config_dir,
                    workspace_path.as_deref(),
                    Path::new(install_path),
                );
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "check_update" => {
                let install_path = Self::require_string(&params, "installPath")?.to_string();
                Self::block_on_async(async move {
                    serde_json::to_value(
                        PluginService::check_local_plugin_update(Path::new(&install_path)).await,
                    )
                    .map_err(|e| e.to_string())
                })
            }
            "apply_update" => {
                let config_dir = self.plugin_config_dir();
                let workspace_path = Self::workspace_path(&params);
                let install_path = Self::require_string(&params, "installPath")?.to_string();
                let config_dir = config_dir.map_err(map_err)?;
                Self::block_on_async(async move {
                    let result = PluginService::apply_local_plugin_update(
                        &config_dir,
                        workspace_path.as_deref(),
                        Path::new(&install_path),
                    )
                    .await
                    .map_err(map_err)?;
                    serde_json::to_value(result).map_err(|e| e.to_string())
                })
            }
            other => Err(format!("cap.pluginDiscovery 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}