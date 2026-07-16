use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::models::plugin::DiscoveredPluginManifest;
use crate::models::plugin_state::{PluginState, PluginStateMap};
use crate::services::plugin_service::PluginService;
use crate::services::plugin_state_service::PluginStateService;

const MCP_CONFIG_RELATIVE_PATH: &str = ".polaris/claude/mcp.json";
const TODO_MCP_SERVER_NAME: &str = "polaris-todo";
const TODO_MCP_BIN_NAME: &str = "polaris-todo-mcp";
const REQUIREMENTS_MCP_SERVER_NAME: &str = "polaris-requirements";
const REQUIREMENTS_MCP_BIN_NAME: &str = "polaris-requirements-mcp";
const SCHEDULER_MCP_SERVER_NAME: &str = "polaris-scheduler";
const SCHEDULER_MCP_BIN_NAME: &str = "polaris-scheduler-mcp";
const PRD_PREVIEW_MCP_SERVER_NAME: &str = "polaris-prd-preview";
const PRD_PREVIEW_MCP_BIN_NAME: &str = "polaris-prd-preview-mcp";
const COMPUTER_MCP_SERVER_NAME: &str = "polaris-computer";
const COMPUTER_MCP_BIN_NAME: &str = "polaris-computer-mcp";
const ASK_MCP_SERVER_NAME: &str = "polaris-ask";
const ASK_MCP_BIN_NAME: &str = "polaris-ask-mcp";
const DISPATCH_MCP_SERVER_NAME: &str = "polaris-dispatch";
const DISPATCH_MCP_BIN_NAME: &str = "polaris-dispatch-mcp";
const BROWSER_MCP_SERVER_NAME: &str = "polaris-browser";
const BROWSER_MCP_BIN_NAME: &str = "polaris-browser-mcp";
const AGNES_MCP_SERVER_NAME: &str = "polaris-agnes";
const AGNES_MCP_BIN_NAME: &str = "polaris-agnes-mcp";
const TODO_PLUGIN_ID: &str = "polaris.todo";
const REQUIREMENTS_PLUGIN_ID: &str = "polaris.requirements";
const SCHEDULER_PLUGIN_ID: &str = "polaris.scheduler";
const PRD_PREVIEW_PLUGIN_ID: &str = "polaris.prd-preview";
const COMPUTER_PLUGIN_ID: &str = "polaris.computer";
const ASK_PLUGIN_ID: &str = "polaris.ask";
const DISPATCH_PLUGIN_ID: &str = "polaris.dispatch";
const BROWSER_PLUGIN_ID: &str = "polaris.browser";
const AGNES_PLUGIN_ID: &str = "polaris.agnes";

/// Platform-aware executable suffix: ".exe" on Windows, "" on Linux/macOS.
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

/// Build a platform-correct relative path for an MCP binary.
fn mcp_exe_path(prefix: &str) -> String {
    format!("{}{}", prefix, EXE_SUFFIX)
}

#[cfg(test)]
fn todo_bundle_path() -> String {
    mcp_exe_path("bin/polaris-todo-mcp")
}
#[cfg(test)]
fn todo_fallback_path() -> String {
    mcp_exe_path("polaris-todo-mcp")
}
#[cfg(test)]
fn todo_dev_path() -> String {
    mcp_exe_path("src-tauri/target/debug/polaris-todo-mcp")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerTransport {
    Stdio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerArgsMode {
    ConfigDirAndWorkspace,
    WorkspaceOnly,
    /// `--polaris-port <PORT> --polaris-token <TOKEN>` for the ask MCP companion.
    AskListener,
}

#[derive(Debug, Clone)]
pub struct PluginMcpServerContribution {
    pub plugin_id: Option<String>,
    pub server_name: String,
    pub transport: McpServerTransport,
    pub bin_name: String,
    pub bundled_path_prefix: String,
    pub fallback_path_prefix: String,
    pub dev_path_prefix: String,
    pub env_var_name: String,
    pub args_mode: McpServerArgsMode,
    required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinPluginMcpManifest {
    pub plugin_id: &'static str,
    pub mcp_server_names: &'static [&'static str],
}

impl PluginMcpServerContribution {
    pub fn builtin(
        server_name: impl Into<String>,
        bin_name: impl Into<String>,
        bundled_path_prefix: impl Into<String>,
        fallback_path_prefix: impl Into<String>,
        dev_path_prefix: impl Into<String>,
        env_var_name: impl Into<String>,
        args_mode: McpServerArgsMode,
        required: bool,
    ) -> Self {
        Self {
            plugin_id: None,
            server_name: server_name.into(),
            transport: McpServerTransport::Stdio,
            bin_name: bin_name.into(),
            bundled_path_prefix: bundled_path_prefix.into(),
            fallback_path_prefix: fallback_path_prefix.into(),
            dev_path_prefix: dev_path_prefix.into(),
            env_var_name: env_var_name.into(),
            args_mode,
            required,
        }
    }

    pub fn required(&self) -> bool {
        self.required
    }
}

#[derive(Debug, Clone, Default)]
pub struct McpServerContributionRegistry {
    contributions: Vec<PluginMcpServerContribution>,
}

impl McpServerContributionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, contribution: PluginMcpServerContribution) {
        self.contributions.push(contribution);
    }

    pub fn register_plugin_server(
        &mut self,
        plugin_id: impl Into<String>,
        mut contribution: PluginMcpServerContribution,
    ) {
        contribution.plugin_id = Some(plugin_id.into());
        self.register(contribution);
    }

    fn contributions(&self) -> &[PluginMcpServerContribution] {
        &self.contributions
    }

    pub fn has_plugin_server(&self, plugin_id: &str, server_name: &str) -> bool {
        self.contributions.iter().any(|contribution| {
            contribution.plugin_id.as_deref() == Some(plugin_id)
                && contribution.server_name == server_name
        })
    }
}

pub fn builtin_plugin_mcp_manifests() -> &'static [BuiltinPluginMcpManifest] {
    &[
        BuiltinPluginMcpManifest {
            plugin_id: TODO_PLUGIN_ID,
            mcp_server_names: &[TODO_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: REQUIREMENTS_PLUGIN_ID,
            mcp_server_names: &[REQUIREMENTS_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: SCHEDULER_PLUGIN_ID,
            mcp_server_names: &[SCHEDULER_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: PRD_PREVIEW_PLUGIN_ID,
            mcp_server_names: &[PRD_PREVIEW_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: COMPUTER_PLUGIN_ID,
            mcp_server_names: &[COMPUTER_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: ASK_PLUGIN_ID,
            mcp_server_names: &[ASK_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: DISPATCH_PLUGIN_ID,
            mcp_server_names: &[DISPATCH_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: BROWSER_PLUGIN_ID,
            mcp_server_names: &[BROWSER_MCP_SERVER_NAME],
        },
        BuiltinPluginMcpManifest {
            plugin_id: AGNES_PLUGIN_ID,
            mcp_server_names: &[AGNES_MCP_SERVER_NAME],
        },
    ]
}

fn builtin_mcp_contribution_registry() -> McpServerContributionRegistry {
    let mut registry = McpServerContributionRegistry::new();
    registry.register_plugin_server(
        TODO_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            TODO_MCP_SERVER_NAME,
            TODO_MCP_BIN_NAME,
            "bin/polaris-todo-mcp",
            "polaris-todo-mcp",
            "src-tauri/target/debug/polaris-todo-mcp",
            "POLARIS_TODO_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry.register_plugin_server(
        REQUIREMENTS_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            REQUIREMENTS_MCP_SERVER_NAME,
            REQUIREMENTS_MCP_BIN_NAME,
            "bin/polaris-requirements-mcp",
            "polaris-requirements-mcp",
            "src-tauri/target/debug/polaris-requirements-mcp",
            "POLARIS_REQUIREMENTS_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry.register_plugin_server(
        SCHEDULER_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            SCHEDULER_MCP_SERVER_NAME,
            SCHEDULER_MCP_BIN_NAME,
            "bin/polaris-scheduler-mcp",
            "polaris-scheduler-mcp",
            "src-tauri/target/debug/polaris-scheduler-mcp",
            "POLARIS_SCHEDULER_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry.register_plugin_server(
        COMPUTER_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            COMPUTER_MCP_SERVER_NAME,
            COMPUTER_MCP_BIN_NAME,
            "bin/polaris-computer-mcp",
            "polaris-computer-mcp",
            "src-tauri/target/debug/polaris-computer-mcp",
            "POLARIS_COMPUTER_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry.register_plugin_server(
        PRD_PREVIEW_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            PRD_PREVIEW_MCP_SERVER_NAME,
            PRD_PREVIEW_MCP_BIN_NAME,
            "bin/polaris-prd-preview-mcp",
            "polaris-prd-preview-mcp",
            "src-tauri/target/debug/polaris-prd-preview-mcp",
            "POLARIS_PRD_PREVIEW_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry.register_plugin_server(
        ASK_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            ASK_MCP_SERVER_NAME,
            ASK_MCP_BIN_NAME,
            "bin/polaris-ask-mcp",
            "polaris-ask-mcp",
            "src-tauri/target/debug/polaris-ask-mcp",
            "POLARIS_ASK_MCP_PATH",
            McpServerArgsMode::AskListener,
            false,
        ),
    );
    registry.register_plugin_server(
        DISPATCH_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            DISPATCH_MCP_SERVER_NAME,
            DISPATCH_MCP_BIN_NAME,
            "bin/polaris-dispatch-mcp",
            "polaris-dispatch-mcp",
            "src-tauri/target/debug/polaris-dispatch-mcp",
            "POLARIS_DISPATCH_MCP_PATH",
            McpServerArgsMode::AskListener,
            false,
        ),
    );
    registry.register_plugin_server(
        BROWSER_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            BROWSER_MCP_SERVER_NAME,
            BROWSER_MCP_BIN_NAME,
            "bin/polaris-browser-mcp",
            "polaris-browser-mcp",
            "src-tauri/target/debug/polaris-browser-mcp",
            "POLARIS_BROWSER_MCP_PATH",
            McpServerArgsMode::AskListener,
            false,
        ),
    );
    registry.register_plugin_server(
        AGNES_PLUGIN_ID,
        PluginMcpServerContribution::builtin(
            AGNES_MCP_SERVER_NAME,
            AGNES_MCP_BIN_NAME,
            "bin/polaris-agnes-mcp",
            "polaris-agnes-mcp",
            "src-tauri/target/debug/polaris-agnes-mcp",
            "POLARIS_AGNES_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ),
    );
    registry
}

#[derive(Debug, Clone, serde::Serialize)]
struct ClaudeMcpServerConfig {
    command: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMcpConfig {
    mcp_servers: BTreeMap<String, ClaudeMcpServerConfig>,
}

#[derive(Debug, Clone)]
struct ResolvedMcpBinary {
    server_name: String,
    executable_path: PathBuf,
    args_mode: McpServerArgsMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedExternalMcpServer {
    pub plugin_id: String,
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
}

pub struct WorkspaceMcpConfigService {
    binaries: Vec<ResolvedMcpBinary>,
    external_servers: Vec<ResolvedExternalMcpServer>,
    config_dir: PathBuf,
    ask_listener: Option<crate::services::ask_listener::AskListenerHandle>,
    ask_route_session_id: Option<String>,
}

impl WorkspaceMcpConfigService {
    pub fn new(
        config_dir: PathBuf,
        todo_executable_path: PathBuf,
        requirements_executable_path: Option<PathBuf>,
        scheduler_executable_path: Option<PathBuf>,
    ) -> Self {
        let mut binaries = vec![ResolvedMcpBinary {
            server_name: TODO_MCP_SERVER_NAME.to_string(),
            executable_path: todo_executable_path,
            args_mode: McpServerArgsMode::ConfigDirAndWorkspace,
        }];

        if let Some(path) = requirements_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: REQUIREMENTS_MCP_SERVER_NAME.to_string(),
                executable_path: path,
                args_mode: McpServerArgsMode::ConfigDirAndWorkspace,
            });
        }

        if let Some(path) = scheduler_executable_path {
            binaries.push(ResolvedMcpBinary {
                server_name: SCHEDULER_MCP_SERVER_NAME.to_string(),
                executable_path: path,
                args_mode: McpServerArgsMode::ConfigDirAndWorkspace,
            });
        }

        Self {
            binaries,
            external_servers: Vec::new(),
            config_dir,
            ask_listener: None,
            ask_route_session_id: None,
        }
    }

    pub fn executable_path(&self) -> &Path {
        &self.binaries[0].executable_path
    }

    pub fn from_app_paths(
        config_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        app_root: PathBuf,
    ) -> Result<Self> {
        Self::from_contribution_registry_app_paths(
            config_dir,
            resource_dir,
            app_root,
            builtin_mcp_contribution_registry(),
        )
    }

    pub fn from_contribution_registry_app_paths(
        config_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        app_root: PathBuf,
        registry: McpServerContributionRegistry,
    ) -> Result<Self> {
        let mut binaries = Vec::new();

        for contribution in registry.contributions() {
            match resolve_mcp_contribution_binary(
                contribution,
                resource_dir.clone(),
                app_root.clone(),
            ) {
                Ok(binary) => binaries.push(binary),
                Err(error) if contribution.required() => return Err(error),
                Err(error) => {
                    tracing::warn!(
                        "[MCP] 跳过可选 MCP server {}: {}",
                        contribution.bin_name,
                        error.to_message()
                    );
                }
            }
        }

        Ok(Self {
            binaries,
            external_servers: Vec::new(),
            config_dir,
            ask_listener: None,
            ask_route_session_id: None,
        })
    }

    pub fn with_external_servers(
        mut self,
        external_servers: Vec<ResolvedExternalMcpServer>,
    ) -> Self {
        self.external_servers = external_servers;
        self
    }

    /// Inject the ask-listener handle so the `polaris-ask` binary gets
    /// `--polaris-port` / `--polaris-token` args. Without this, the
    /// `AskListener` server is silently skipped.
    pub fn with_ask_listener(
        mut self,
        handle: Option<crate::services::ask_listener::AskListenerHandle>,
    ) -> Self {
        self.ask_listener = handle;
        self
    }

    /// Attach the frontend route session id to the ask companion. This keeps
    /// question events in the same panel as the originating tool call even
    /// before the backend CLI session id is known.
    pub fn with_ask_route_session_id(mut self, session_id: Option<String>) -> Self {
        self.ask_route_session_id = session_id.filter(|id| !id.trim().is_empty());
        self
    }

    pub fn prepare_workspace_config(&self, workspace_path: &str) -> Result<PathBuf> {
        self.prepare_workspace_config_with_disabled(workspace_path, &[])
    }

    pub fn prepare_workspace_config_with_disabled(
        &self,
        workspace_path: &str,
        disabled_server_names: &[String],
    ) -> Result<PathBuf> {
        let normalized_workspace = workspace_path.trim();
        if normalized_workspace.is_empty() {
            return Err(AppError::ValidationError(
                "workspace_path 不能为空".to_string(),
            ));
        }

        let workspace_dir = PathBuf::from(normalized_workspace);
        let config_path = workspace_dir.join(Path::new(MCP_CONFIG_RELATIVE_PATH));

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::ProcessError(format!("创建 MCP 配置目录失败: {}", e)))?;
        }

        let mut servers = BTreeMap::new();
        for binary in &self.binaries {
            if is_server_disabled(disabled_server_names, &binary.server_name) {
                tracing::info!("[MCP] 跳过已禁用 MCP server: {}", binary.server_name);
                continue;
            }

            if !binary.executable_path.exists() {
                tracing::warn!(
                    "[MCP] 跳过 MCP server {}，可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                );
                continue;
            }

            // AskListener mode needs a live listener handle — skip if missing.
            if matches!(binary.args_mode, McpServerArgsMode::AskListener)
                && self.ask_listener.is_none()
            {
                tracing::info!(
                    "[MCP] 跳过 {}：ask_listener 未就绪",
                    binary.server_name
                );
                continue;
            }

            let args = build_mcp_server_args(
                binary.args_mode,
                &self.config_dir,
                normalized_workspace,
                self.ask_listener.as_ref(),
                self.ask_route_session_id.as_deref(),
            );

            servers.insert(
                binary.server_name.to_string(),
                ClaudeMcpServerConfig {
                    command: strip_unc_prefix(&binary.executable_path.to_string_lossy()),
                    args,
                },
            );
        }

        for server in &self.external_servers {
            if is_server_disabled(disabled_server_names, &server.server_name) {
                tracing::info!(
                    "[MCP] 跳过已禁用外部插件 MCP server: {}",
                    server.server_name
                );
                continue;
            }

            if servers.contains_key(&server.server_name) {
                tracing::warn!(
                    "[MCP] 跳过外部插件 MCP server {}，名称与已有 server 冲突",
                    server.server_name
                );
                continue;
            }

            servers.insert(
                server.server_name.clone(),
                ClaudeMcpServerConfig {
                    command: strip_unc_prefix(&server.command),
                    args: server
                        .args
                        .iter()
                        .map(|arg| strip_unc_prefix(arg))
                        .collect(),
                },
            );
        }

        let config = ClaudeMcpConfig {
            mcp_servers: servers,
        };

        write_json_atomically(&config_path, &config)?;
        Ok(config_path)
    }

    pub fn prepare_workspace_codex_config_args(&self, workspace_path: &str) -> Result<Vec<String>> {
        self.prepare_workspace_codex_config_args_with_disabled(workspace_path, &[])
    }

    pub fn prepare_workspace_codex_config_args_with_disabled(
        &self,
        workspace_path: &str,
        disabled_server_names: &[String],
    ) -> Result<Vec<String>> {
        let normalized_workspace = workspace_path.trim();
        if normalized_workspace.is_empty() {
            return Err(AppError::ValidationError(
                "workspace_path 不能为空".to_string(),
            ));
        }

        let mut args = Vec::new();
        let mut registered_names = BTreeSet::new();
        for binary in &self.binaries {
            if is_server_disabled(disabled_server_names, &binary.server_name) {
                tracing::info!("[MCP] 跳过已禁用 Codex MCP server: {}", binary.server_name);
                continue;
            }

            if !binary.executable_path.exists() {
                tracing::warn!(
                    "[MCP] 跳过 Codex MCP server {}，可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                );
                continue;
            }

            if matches!(binary.args_mode, McpServerArgsMode::AskListener)
                && self.ask_listener.is_none()
            {
                tracing::info!(
                    "[MCP] 跳过 Codex {}：ask_listener 未就绪",
                    binary.server_name
                );
                continue;
            }

            let server_args = build_mcp_server_args(
                binary.args_mode,
                &self.config_dir,
                normalized_workspace,
                self.ask_listener.as_ref(),
                self.ask_route_session_id.as_deref(),
            );

            registered_names.insert(binary.server_name.clone());
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.command={}",
                binary.server_name,
                toml_string(&strip_unc_prefix(&binary.executable_path.to_string_lossy()))?
            ));
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.args={}",
                binary.server_name,
                toml_string_array(&server_args)?
            ));
        }

        for server in &self.external_servers {
            if is_server_disabled(disabled_server_names, &server.server_name) {
                tracing::info!(
                    "[MCP] 跳过已禁用 Codex 外部插件 MCP server: {}",
                    server.server_name
                );
                continue;
            }

            if registered_names.contains(&server.server_name) {
                tracing::warn!(
                    "[MCP] 跳过 Codex 外部插件 MCP server {}，名称与已有 server 冲突",
                    server.server_name
                );
                continue;
            }

            registered_names.insert(server.server_name.clone());
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.command={}",
                server.server_name,
                toml_string(&strip_unc_prefix(&server.command))?
            ));
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{}.args={}",
                server.server_name,
                toml_string_array(
                    &server
                        .args
                        .iter()
                        .map(|arg| strip_unc_prefix(arg))
                        .collect::<Vec<_>>()
                )?
            ));
        }

        Ok(args)
    }

    /// 返回 SimpleAI 直接消费的 MCP server 列表（**内置 + 外部插件**合并，已过滤 disabled）。
    ///
    /// 与 `prepare_workspace_config`（写 .mcp.json 给 Claude CLI）对齐：内置 MCP 走 binary
    /// 解析 + `build_mcp_server_args`，外部插件走 `external_servers`。同名校验：内置优先
    /// （与 `external_plugin_mcp_server_does_not_override_builtin_server` 测试语义一致）。
    ///
    /// 内置 MCP 的 `plugin_id` 设为 `"polaris.builtin"`，SimpleAI 分支据此跳过 `aiToolAccess`
    /// 门控（内置默认信任）；外部插件由 SimpleAI 分支另行检查 `aiToolAccess`。
    pub fn resolved_simple_ai_servers(
        &self,
        workspace_path: &str,
        disabled_server_names: &[String],
    ) -> Vec<ResolvedExternalMcpServer> {
        let mut servers: Vec<ResolvedExternalMcpServer> = Vec::new();

        // 内置 MCP（todo/requirements/scheduler/prd-preview/computer/ask）
        for binary in &self.binaries {
            if is_server_disabled(disabled_server_names, &binary.server_name) {
                tracing::info!("[MCP] SimpleAI 跳过已禁用内置 MCP: {}", binary.server_name);
                continue;
            }
            if !binary.executable_path.exists() {
                tracing::warn!(
                    "[MCP] SimpleAI 跳过内置 MCP {}，可执行文件不存在: {}",
                    binary.server_name,
                    binary.executable_path.display()
                );
                continue;
            }
            // ask MCP 需 listener handle
            if matches!(binary.args_mode, McpServerArgsMode::AskListener)
                && self.ask_listener.is_none()
            {
                tracing::info!("[MCP] SimpleAI 跳过 {}：ask_listener 未就绪", binary.server_name);
                continue;
            }
            let args = build_mcp_server_args(
                binary.args_mode,
                &self.config_dir,
                workspace_path,
                self.ask_listener.as_ref(),
                self.ask_route_session_id.as_deref(),
            );
            servers.push(ResolvedExternalMcpServer {
                plugin_id: "polaris.builtin".to_string(),
                server_name: binary.server_name.clone(),
                command: strip_unc_prefix(&binary.executable_path.to_string_lossy()),
                args,
            });
        }

        // 外部插件 MCP（与内置同名时跳过，内置优先）
        for server in &self.external_servers {
            if is_server_disabled(disabled_server_names, &server.server_name) {
                tracing::info!(
                    "[MCP] SimpleAI 跳过已禁用外部插件 MCP: {}",
                    server.server_name
                );
                continue;
            }
            if servers.iter().any(|s| s.server_name == server.server_name) {
                tracing::warn!(
                    "[MCP] SimpleAI 跳过外部插件 MCP {}，与内置同名",
                    server.server_name
                );
                continue;
            }
            servers.push(server.clone());
        }

        servers
    }
}

pub fn resolve_external_plugin_mcp_servers(
    config_dir: &Path,
    workspace_path: &Path,
    plugins: &[DiscoveredPluginManifest],
    plugin_states: &PluginStateMap,
    ask_listener: Option<&crate::services::ask_listener::AskListenerHandle>,
    ask_route_session_id: Option<&str>,
) -> Vec<ResolvedExternalMcpServer> {
    let workspace = workspace_path.to_string_lossy().to_string();
    let app_config_dir = config_dir.to_string_lossy().to_string();
    let mut resolved = Vec::new();

    for plugin in plugins {
        let plugin_state = plugin_states.get(&plugin.id);
        if !is_plugin_mcp_enabled(plugin, plugin_state) {
            continue;
        }

        let plugin_dir = plugin.install_path.trim();
        if plugin_dir.is_empty() {
            tracing::warn!("[MCP] 跳过插件 {}，缺少 installPath", plugin.id);
            continue;
        }

        for server in &plugin.contributes.mcp_servers {
            if !is_plugin_mcp_server_enabled(server.id.as_str(), plugin_state) {
                tracing::info!(
                    "[MCP] 跳过已禁用插件 MCP server {}:{}",
                    plugin.id,
                    server.id
                );
                continue;
            }

            if server.transport != "stdio" {
                tracing::warn!(
                    "[MCP] 跳过插件 {} 的 MCP server {}，当前仅支持 stdio transport",
                    plugin.id,
                    server.id
                );
                continue;
            }

            if server.id.trim().is_empty() || server.command.trim().is_empty() {
                tracing::warn!("[MCP] 跳过插件 {} 的无效 MCP server 声明", plugin.id);
                continue;
            }
            if external_server_requires_listener(server) && ask_listener.is_none() {
                tracing::info!(
                    "[MCP] 跳过插件 {} 的 MCP server {}：ask_listener 未就绪",
                    plugin.id,
                    server.id
                );
                continue;
            }

            let command = expand_external_mcp_template(
                &server.command,
                plugin_dir,
                &workspace,
                &app_config_dir,
                ask_listener,
                ask_route_session_id,
            );
            let args = server
                .args_template
                .iter()
                .map(|arg| {
                    expand_external_mcp_template(
                        arg,
                        plugin_dir,
                        &workspace,
                        &app_config_dir,
                        ask_listener,
                        ask_route_session_id,
                    )
                })
                .collect();

            resolved.push(ResolvedExternalMcpServer {
                plugin_id: plugin.id.clone(),
                server_name: server.id.clone(),
                command,
                args,
            });
        }
    }

    resolved
}

fn external_server_requires_listener(
    server: &crate::models::plugin::PluginMcpServerManifestContribution,
) -> bool {
    server.command.contains("{{polarisPort}}")
        || server.command.contains("{{polarisToken}}")
        || server
            .args_template
            .iter()
            .any(|arg| arg.contains("{{polarisPort}}") || arg.contains("{{polarisToken}}"))
}

fn is_plugin_mcp_enabled(plugin: &DiscoveredPluginManifest, state: Option<&PluginState>) -> bool {
    match state {
        Some(state) => state.enabled && state.mcp_enabled,
        None => plugin.enabled_by_default,
    }
}

fn is_builtin_plugin_mcp_enabled(state: Option<&PluginState>) -> bool {
    match state {
        Some(state) => state.enabled && state.mcp_enabled,
        None => true,
    }
}

fn is_plugin_mcp_server_enabled(server_name: &str, state: Option<&PluginState>) -> bool {
    match state.and_then(|state| state.mcp_servers.get(server_name)) {
        Some(server_state) => server_state.enabled,
        None => true,
    }
}

pub fn disabled_builtin_mcp_server_names(plugin_states: &PluginStateMap) -> Vec<String> {
    let registry = builtin_mcp_contribution_registry();
    registry
        .contributions()
        .iter()
        .filter_map(|contribution| {
            let plugin_id = contribution.plugin_id.as_deref()?;
            let state = plugin_states.get(plugin_id);
            let enabled = is_builtin_plugin_mcp_enabled(state)
                && is_plugin_mcp_server_enabled(&contribution.server_name, state);

            (!enabled).then(|| contribution.server_name.clone())
        })
        .collect()
}

pub fn load_plugin_mcp_runtime_state(
    config_dir: &Path,
    workspace_path: &Path,
) -> (PluginStateMap, Vec<DiscoveredPluginManifest>) {
    let plugin_discovery =
        PluginService::discover_installed_plugins(config_dir, Some(workspace_path));
    for error in &plugin_discovery.errors {
        tracing::warn!("[MCP] 插件发现诊断 {}: {}", error.path, error.error);
    }

    let plugin_states = match PluginStateService::new(config_dir.to_path_buf()).load() {
        Ok(states) => states,
        Err(error) => {
            tracing::warn!("[MCP] 加载插件状态失败，按默认状态处理: {}", error);
            Default::default()
        }
    };

    (plugin_states, plugin_discovery.plugins)
}

pub fn resolve_workspace_mcp_runtime_service(
    config_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
    workspace_path: &Path,
    ask_listener: Option<crate::services::ask_listener::AskListenerHandle>,
    ask_route_session_id: Option<String>,
) -> Result<(WorkspaceMcpConfigService, Vec<String>)> {
    let service =
        WorkspaceMcpConfigService::from_app_paths(config_dir.clone(), resource_dir, app_root)?;
    let (plugin_states, plugins) = load_plugin_mcp_runtime_state(&config_dir, workspace_path);
    let disabled_builtin_servers = disabled_builtin_mcp_server_names(&plugin_states);
    let external_servers = resolve_external_plugin_mcp_servers(
        &config_dir,
        workspace_path,
        &plugins,
        &plugin_states,
        ask_listener.as_ref(),
        ask_route_session_id.as_deref(),
    );

    Ok((
        service
            .with_external_servers(external_servers)
            .with_ask_listener(ask_listener)
            .with_ask_route_session_id(ask_route_session_id),
        disabled_builtin_servers,
    ))
}

fn expand_external_mcp_template(
    value: &str,
    plugin_dir: &str,
    workspace_path: &str,
    app_config_dir: &str,
    ask_listener: Option<&crate::services::ask_listener::AskListenerHandle>,
    ask_route_session_id: Option<&str>,
) -> String {
    let port = ask_listener
        .map(|handle| handle.port.to_string())
        .unwrap_or_default();
    let token = ask_listener
        .map(|handle| handle.token.clone())
        .unwrap_or_default();
    let session_id = ask_route_session_id.unwrap_or_default();
    value
        .replace("{{pluginDir}}", plugin_dir)
        .replace("{{workspacePath}}", workspace_path)
        .replace("{{appConfigDir}}", app_config_dir)
        .replace("{{polarisPort}}", &port)
        .replace("{{polarisToken}}", &token)
        .replace("{{sessionId}}", session_id)
}

fn is_server_disabled(disabled_server_names: &[String], server_name: &str) -> bool {
    disabled_server_names.iter().any(|name| name == server_name)
}

fn build_mcp_server_args(
    args_mode: McpServerArgsMode,
    config_dir: &Path,
    workspace_path: &str,
    ask_listener: Option<&crate::services::ask_listener::AskListenerHandle>,
    ask_route_session_id: Option<&str>,
) -> Vec<String> {
    match args_mode {
        McpServerArgsMode::ConfigDirAndWorkspace => vec![
            strip_unc_prefix(&config_dir.to_string_lossy()),
            workspace_path.to_string(),
        ],
        McpServerArgsMode::WorkspaceOnly => vec![workspace_path.to_string()],
        McpServerArgsMode::AskListener => {
            // Caller is expected to skip when no handle is present; defensive
            // fallback yields empty args (the companion will then exit with
            // a clear "缺少 --polaris-port" error).
            match ask_listener {
                Some(handle) => {
                    let mut args = vec![
                        "--polaris-port".to_string(),
                        handle.port.to_string(),
                        "--polaris-token".to_string(),
                        handle.token.clone(),
                    ];
                    if let Some(session_id) = ask_route_session_id {
                        if !session_id.trim().is_empty() {
                            args.push("--polaris-session".to_string());
                            args.push(session_id.to_string());
                        }
                    }
                    args
                }
                None => Vec::new(),
            }
        }
    }
}

/// Strip the Windows UNC extended-length path prefix (`\\?\`) from a path string.
///
/// On Windows, `std::fs::canonicalize()` and some Tauri path APIs return paths
/// with the `\\?\` prefix. While valid for Win32 APIs, this prefix can cause
/// issues with Node.js `child_process.spawn()` and some CLI tools. For paths
/// under MAX_PATH (260 chars), the prefix is unnecessary.
fn strip_unc_prefix(s: &str) -> String {
    if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s.to_string()
    }
}

fn resolve_mcp_contribution_binary(
    contribution: &PluginMcpServerContribution,
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
) -> Result<ResolvedMcpBinary> {
    let executable_path = resolve_mcp_executable_path(
        resource_dir,
        app_root,
        &contribution.bin_name,
        &mcp_exe_path(&contribution.bundled_path_prefix),
        &mcp_exe_path(&contribution.fallback_path_prefix),
        &mcp_exe_path(&contribution.dev_path_prefix),
        &contribution.env_var_name,
    )?;

    Ok(ResolvedMcpBinary {
        server_name: contribution.server_name.clone(),
        executable_path,
        args_mode: contribution.args_mode,
    })
}

#[allow(dead_code)]
fn resolve_optional_mcp_executable_path(
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
    bin_name: &str,
    bundled_relative_path: &str,
    bundled_fallback_relative_path: &str,
    dev_relative_path: &str,
    env_var_name: &str,
) -> Option<PathBuf> {
    match resolve_mcp_executable_path(
        resource_dir,
        app_root,
        bin_name,
        bundled_relative_path,
        bundled_fallback_relative_path,
        dev_relative_path,
        env_var_name,
    ) {
        Ok(path) => Some(path),
        Err(error) => {
            tracing::warn!(
                "[MCP] 跳过可选 MCP server {}: {}",
                bin_name,
                error.to_message()
            );
            None
        }
    }
}

fn resolve_mcp_executable_path(
    resource_dir: Option<PathBuf>,
    app_root: PathBuf,
    bin_name: &str,
    bundled_relative_path: &str,
    bundled_fallback_relative_path: &str,
    dev_relative_path: &str,
    env_var_name: &str,
) -> Result<PathBuf> {
    if let Some(ref resource_dir) = resource_dir {
        let bundled_candidates = [
            resource_dir.join(Path::new(bundled_relative_path)),
            resource_dir.join(Path::new(bundled_fallback_relative_path)),
        ];

        for bundled_path in bundled_candidates {
            if bundled_path.exists() {
                return Ok(bundled_path);
            }
        }

        tracing::warn!(
            "[MCP] 未在资源目录找到 {} 可执行文件，已检查: '{}' 和 '{}'，回退到开发目录",
            bin_name,
            resource_dir
                .join(Path::new(bundled_relative_path))
                .display(),
            resource_dir
                .join(Path::new(bundled_fallback_relative_path))
                .display()
        );
    }

    if let Ok(path) = std::env::var(env_var_name) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let override_path = PathBuf::from(trimmed);
            if override_path.exists() {
                return Ok(override_path);
            }

            tracing::warn!(
                "[MCP] {} 指向的文件不存在，继续回退: {}",
                env_var_name,
                override_path.display()
            );
        }
    }

    let dev_path = app_root.join(Path::new(dev_relative_path));
    if dev_path.exists() {
        return Ok(dev_path);
    }

    // Fallback: also check release directory (debug path may not exist if only release was built)
    let release_relative_path = dev_relative_path.replace("/debug/", "/release/");
    let release_path = app_root.join(Path::new(&release_relative_path));
    if release_path.exists() {
        tracing::info!(
            "[MCP] {} 在 debug 目录未找到，使用 release 目录: {}",
            bin_name,
            release_path.display()
        );
        return Ok(release_path);
    }

    Err(AppError::ProcessError(format!(
        "无法定位 {}。已检查资源路径 '{}'、'{}' 与开发路径 '{}'、'{}'",
        bin_name,
        resource_dir
            .as_ref()
            .map(|dir| dir
                .join(Path::new(bundled_relative_path))
                .display()
                .to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        resource_dir
            .as_ref()
            .map(|dir| dir
                .join(Path::new(bundled_fallback_relative_path))
                .display()
                .to_string())
            .unwrap_or_else(|| "<无资源目录>".to_string()),
        dev_path.display(),
        release_path.display()
    )))
}

fn write_json_atomically<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value)?;
    std::fs::write(&temp_path, format!("{}\n", content))?;
    std::fs::rename(&temp_path, path)?;
    Ok(())
}

fn toml_string(value: &str) -> Result<String> {
    Ok(toml_string_literal(value))
}

fn toml_string_array(values: &[String]) -> Result<String> {
    Ok(format!(
        "[{}]",
        values
            .iter()
            .map(|value| toml_string_literal(value))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn toml_string_literal(value: &str) -> String {
    if !value.contains('\'') && !value.contains('\n') && !value.contains('\r') {
        return format!("'{}'", value);
    }

    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugin::{
        DiscoveredPluginManifest, PluginManifestContributes, PluginManifestPermissions,
        PluginManifestSource, PluginManifestSourceKind, PluginMcpServerManifestContribution,
        PluginOriginMetadata,
    };
    use crate::models::plugin_state::{PluginMcpServerState, PluginState};

    fn external_plugin_manifest(plugin_dir: &Path, server_name: &str) -> DiscoveredPluginManifest {
        DiscoveredPluginManifest {
            id: "example.demo-mcp".to_string(),
            name: "Demo MCP Plugin".to_string(),
            version: "0.1.0".to_string(),
            description: None,
            builtin: false,
            enabled_by_default: true,
            contributes: PluginManifestContributes {
                views: Vec::new(),
                panel: None,
                mcp_servers: vec![PluginMcpServerManifestContribution {
                    id: server_name.to_string(),
                    transport: "stdio".to_string(),
                    command: "node".to_string(),
                    args_template: vec![
                        "{{pluginDir}}/mcp/demo-mcp-server.js".to_string(),
                        "{{workspacePath}}".to_string(),
                        "{{appConfigDir}}".to_string(),
                    ],
                }],
                services: Vec::new(),
            },
            permissions: PluginManifestPermissions::default(),
            origin: PluginOriginMetadata::default(),
            source: PluginManifestSource {
                kind: PluginManifestSourceKind::User,
                workspace_path: None,
            },
            install_path: plugin_dir.to_string_lossy().to_string(),
        }
    }

    /// Helper to create a platform-correct fixture file path.
    fn fixture_exe(base: &str) -> String {
        format!("{}{}", base, EXE_SUFFIX)
    }

    #[test]
    fn prefers_bundled_resource_path_when_present() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(resource_dir.join("bin")).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();
        std::fs::write(
            resource_dir.join(fixture_exe("bin/polaris-todo-mcp")),
            "bundled bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("bin/polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prefers_root_level_bundled_path_when_present() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();
        std::fs::write(
            resource_dir.join(fixture_exe("polaris-todo-mcp")),
            "bundled root bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir.clone()),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(path, resource_dir.join(fixture_exe("polaris-todo-mcp")));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn falls_back_to_dev_path_when_resource_missing() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        std::fs::create_dir_all(app_root.join("src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp")),
            "dev bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(
            path,
            app_root.join(fixture_exe("src-tauri/target/debug/polaris-todo-mcp"))
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn falls_back_to_release_path_when_debug_missing() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let resource_dir = temp_root.join("resources");

        // Only create release binary, no debug binary
        std::fs::create_dir_all(app_root.join("src-tauri/target/release")).unwrap();
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(
            app_root.join(fixture_exe("src-tauri/target/release/polaris-todo-mcp")),
            "release bin",
        )
        .unwrap();

        let path = resolve_mcp_executable_path(
            Some(resource_dir),
            app_root.clone(),
            TODO_MCP_BIN_NAME,
            &todo_bundle_path(),
            &todo_fallback_path(),
            &todo_dev_path(),
            "POLARIS_TODO_MCP_PATH",
        )
        .unwrap();
        assert_eq!(
            path,
            app_root.join(fixture_exe("src-tauri/target/release/polaris-todo-mcp"))
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn registry_required_server_missing_returns_error() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let app_root = temp_root.join("app-root");
        let config_dir = temp_root.join("config");
        let mut registry = McpServerContributionRegistry::new();
        registry.register(PluginMcpServerContribution::builtin(
            "polaris-required-test",
            "polaris-required-test-mcp",
            "bin/polaris-required-test-mcp",
            "polaris-required-test-mcp",
            "missing/polaris-required-test-mcp",
            "POLARIS_REQUIRED_TEST_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            true,
        ));

        let result = WorkspaceMcpConfigService::from_contribution_registry_app_paths(
            config_dir, None, app_root, registry,
        );

        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn registry_optional_server_missing_is_skipped() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-optional");
        let app_root = temp_root.join("app-root");
        let config_dir = temp_root.join("config");
        let mut registry = McpServerContributionRegistry::new();
        registry.register(PluginMcpServerContribution::builtin(
            "polaris-optional-test",
            "polaris-optional-test-mcp",
            "bin/polaris-optional-test-mcp",
            "polaris-optional-test-mcp",
            "missing/polaris-optional-test-mcp",
            "POLARIS_OPTIONAL_TEST_MCP_PATH",
            McpServerArgsMode::ConfigDirAndWorkspace,
            false,
        ));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();

        let service = WorkspaceMcpConfigService::from_contribution_registry_app_paths(
            config_dir, None, app_root, registry,
        )
        .unwrap();
        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert_eq!(json["mcpServers"].as_object().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn registry_workspace_only_args_mode_uses_workspace_path_only() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-args");
        let app_root = temp_root.join("app-root");
        let config_dir = temp_root.join("config");
        let plugin_executable_path = app_root.join(fixture_exe("plugins/sample/plugin-mcp"));
        let mut registry = McpServerContributionRegistry::new();
        registry.register_plugin_server(
            "polaris.sample",
            PluginMcpServerContribution::builtin(
                "polaris-sample",
                "polaris-sample-mcp",
                "bin/polaris-sample-mcp",
                "polaris-sample-mcp",
                "plugins/sample/plugin-mcp",
                "POLARIS_SAMPLE_MCP_PATH",
                McpServerArgsMode::WorkspaceOnly,
                true,
            ),
        );

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(plugin_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&plugin_executable_path, "sample bin").unwrap();

        let service = WorkspaceMcpConfigService::from_contribution_registry_app_paths(
            config_dir, None, app_root, registry,
        )
        .unwrap();
        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        let sample_server = &json["mcpServers"]["polaris-sample"];

        assert_eq!(
            sample_server["args"].as_array().unwrap(),
            &[serde_json::Value::String(
                workspace.to_string_lossy().to_string()
            )]
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn builtin_plugin_mcp_manifest_matches_registry() {
        let registry = builtin_mcp_contribution_registry();

        for manifest in builtin_plugin_mcp_manifests() {
            for server_name in manifest.mcp_server_names {
                assert!(
                    registry.has_plugin_server(manifest.plugin_id, server_name),
                    "plugin {} must register MCP server {}",
                    manifest.plugin_id,
                    server_name
                );
            }
        }
    }

    #[test]
    fn disabled_builtin_mcp_server_names_honors_plugin_state() {
        let mut states = PluginStateMap::new();
        states.insert(
            SCHEDULER_PLUGIN_ID.to_string(),
            PluginState {
                enabled: true,
                ui_enabled: true,
                mcp_enabled: false,
                mcp_servers: Default::default(),
            },
        );

        let disabled = disabled_builtin_mcp_server_names(&states);

        assert_eq!(disabled, vec![SCHEDULER_MCP_SERVER_NAME.to_string()]);
    }

    #[test]
    fn disabled_builtin_mcp_server_names_honors_server_state() {
        let mut states = PluginStateMap::new();
        states.insert(
            REQUIREMENTS_PLUGIN_ID.to_string(),
            PluginState {
                enabled: true,
                ui_enabled: true,
                mcp_enabled: true,
                mcp_servers: BTreeMap::from([(
                    REQUIREMENTS_MCP_SERVER_NAME.to_string(),
                    PluginMcpServerState { enabled: false },
                )]),
            },
        );

        let disabled = disabled_builtin_mcp_server_names(&states);

        assert_eq!(disabled, vec![REQUIREMENTS_MCP_SERVER_NAME.to_string()]);
    }

    #[test]
    fn resolves_external_plugin_mcp_server_templates() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let config_dir = temp_root.join("config");
        let workspace = temp_root.join("workspace-external");
        let plugin_dir = config_dir.join("plugins").join("example.demo-mcp");
        let plugin = external_plugin_manifest(&plugin_dir, "example-demo-mcp");
        let mut states = PluginStateMap::new();
        states.insert(
            plugin.id.clone(),
            PluginState {
                enabled: true,
                ui_enabled: true,
                mcp_enabled: true,
                mcp_servers: Default::default(),
            },
        );

        let servers =
            resolve_external_plugin_mcp_servers(
                &config_dir,
                &workspace,
                &[plugin],
                &states,
                None,
                None,
            );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].plugin_id, "example.demo-mcp");
        assert_eq!(servers[0].server_name, "example-demo-mcp");
        assert_eq!(servers[0].command, "node");
        assert_eq!(
            servers[0].args[0],
            format!("{}/mcp/demo-mcp-server.js", plugin_dir.to_string_lossy())
        );
        assert_eq!(servers[0].args[1], workspace.to_string_lossy().to_string());
        assert_eq!(servers[0].args[2], config_dir.to_string_lossy().to_string());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn external_plugin_mcp_server_is_written_to_claude_config() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-external-config");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let plugin_script = config_dir
            .join("plugins")
            .join("example.demo-mcp")
            .join("mcp")
            .join("demo-mcp-server.js");

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(plugin_script.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&plugin_script, "demo server").unwrap();

        let service = WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None)
            .with_external_servers(vec![ResolvedExternalMcpServer {
                plugin_id: "example.demo-mcp".to_string(),
                server_name: "example-demo-mcp".to_string(),
                command: "node".to_string(),
                args: vec![
                    plugin_script.to_string_lossy().to_string(),
                    workspace.to_string_lossy().to_string(),
                ],
            }]);

        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        let external_server = &json["mcpServers"]["example-demo-mcp"];

        assert_eq!(
            external_server["command"],
            serde_json::Value::String("node".to_string())
        );
        assert_eq!(
            external_server["args"][0],
            serde_json::Value::String(plugin_script.to_string_lossy().to_string())
        );
        assert!(json["mcpServers"][TODO_MCP_SERVER_NAME].is_object());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn external_plugin_mcp_server_is_written_to_codex_args() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-external-codex");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let plugin_script = config_dir
            .join("plugins")
            .join("example.demo-mcp")
            .join("mcp")
            .join("demo-mcp-server.js");

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(plugin_script.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&plugin_script, "demo server").unwrap();

        let service = WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None)
            .with_external_servers(vec![ResolvedExternalMcpServer {
                plugin_id: "example.demo-mcp".to_string(),
                server_name: "example-demo-mcp".to_string(),
                command: "node".to_string(),
                args: vec![
                    plugin_script.to_string_lossy().to_string(),
                    workspace.to_string_lossy().to_string(),
                ],
            }]);

        let args = service
            .prepare_workspace_codex_config_args(workspace.to_string_lossy().as_ref())
            .unwrap();
        let joined = args.join("\n");

        assert!(joined.contains("mcp_servers.example-demo-mcp.command='node'"));
        assert!(joined.contains("mcp_servers.example-demo-mcp.args="));
        assert!(joined.contains(plugin_script.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn external_plugin_mcp_server_does_not_override_builtin_server() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-external-conflict");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();

        let service =
            WorkspaceMcpConfigService::new(config_dir, todo_executable_path.clone(), None, None)
                .with_external_servers(vec![ResolvedExternalMcpServer {
                    plugin_id: "example.conflict".to_string(),
                    server_name: TODO_MCP_SERVER_NAME.to_string(),
                    command: "node".to_string(),
                    args: vec!["conflict.js".to_string()],
                }]);

        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert_eq!(
            json["mcpServers"][TODO_MCP_SERVER_NAME]["command"],
            serde_json::Value::String(todo_executable_path.to_string_lossy().to_string())
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepares_workspace_scoped_mcp_config() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-a");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let requirements_executable_path =
            temp_root.join(fixture_exe("bin/polaris-requirements-mcp"));
        let scheduler_executable_path = temp_root.join(fixture_exe("bin/polaris-scheduler-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&requirements_executable_path, "requirements bin").unwrap();
        std::fs::write(&scheduler_executable_path, "scheduler bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            todo_executable_path.clone(),
            Some(requirements_executable_path.clone()),
            Some(scheduler_executable_path.clone()),
        );
        let config_path = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();

        assert_eq!(config_path, workspace.join(".polaris/claude/mcp.json"));

        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        // Todo MCP should have two args: config_dir and workspace_path
        let todo_server = &json["mcpServers"][TODO_MCP_SERVER_NAME];
        assert_eq!(
            todo_server["command"],
            serde_json::Value::String(todo_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            todo_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            todo_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        // Requirements MCP should have two args: config_dir and workspace_path
        let requirements_server = &json["mcpServers"][REQUIREMENTS_MCP_SERVER_NAME];
        assert_eq!(
            requirements_server["command"],
            serde_json::Value::String(requirements_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            requirements_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            requirements_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        // Scheduler MCP should have two args: config_dir and workspace_path
        let scheduler_server = &json["mcpServers"][SCHEDULER_MCP_SERVER_NAME];
        assert_eq!(
            scheduler_server["command"],
            serde_json::Value::String(scheduler_executable_path.to_string_lossy().to_string())
        );
        assert_eq!(
            scheduler_server["args"][0],
            serde_json::Value::String(config_dir.to_string_lossy().to_string())
        );
        assert_eq!(
            scheduler_server["args"][1],
            serde_json::Value::String(workspace.to_string_lossy().to_string())
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepares_workspace_codex_config_args() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-c");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));
        let requirements_executable_path =
            temp_root.join(fixture_exe("bin/polaris-requirements-mcp"));
        let scheduler_executable_path = temp_root.join(fixture_exe("bin/polaris-scheduler-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();
        std::fs::write(&requirements_executable_path, "requirements bin").unwrap();
        std::fs::write(&scheduler_executable_path, "scheduler bin").unwrap();

        let service = WorkspaceMcpConfigService::new(
            config_dir.clone(),
            todo_executable_path.clone(),
            Some(requirements_executable_path.clone()),
            Some(scheduler_executable_path.clone()),
        );

        let args = service
            .prepare_workspace_codex_config_args(workspace.to_string_lossy().as_ref())
            .unwrap();

        assert_eq!(args.len(), 12);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-c").count(), 6);

        let joined = args.join("\n");
        assert!(joined.contains("mcp_servers.polaris-todo.command="));
        assert!(joined.contains("mcp_servers.polaris-requirements.command="));
        assert!(joined.contains("mcp_servers.polaris-scheduler.command="));
        assert!(joined.contains("mcp_servers.polaris-todo.args=["));

        let expected_config_dir = toml_string_literal(config_dir.to_string_lossy().as_ref());
        let expected_workspace = toml_string_literal(workspace.to_string_lossy().as_ref());
        let expected_todo_command =
            toml_string_literal(todo_executable_path.to_string_lossy().as_ref());
        let expected_args = format!("[{},{}]", expected_config_dir, expected_workspace);

        assert!(joined.contains(&format!(
            "mcp_servers.polaris-todo.command={}",
            expected_todo_command
        )));
        assert!(joined.contains(&format!("mcp_servers.polaris-todo.args={}", expected_args)));
        assert!(
            !joined.contains("\\\""),
            "Codex -c values must be TOML, not JSON-escaped strings"
        );

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn codex_toml_literals_handle_windows_paths_and_quotes() {
        assert_eq!(
            toml_string_literal(r"D:\app\polaris\polaris-todo-mcp.exe"),
            r"'D:\app\polaris\polaris-todo-mcp.exe'"
        );
        assert_eq!(
            toml_string_array(&[
                r"C:\Users\28409\AppData\Roaming\com.polaris.app".to_string(),
                r"D:\space\base\Polaris".to_string(),
            ])
            .unwrap(),
            r"['C:\Users\28409\AppData\Roaming\com.polaris.app','D:\space\base\Polaris']"
        );
        assert_eq!(
            toml_string_literal(r"D:\space\team's project"),
            r#""D:\\space\\team's project""#
        );
    }

    #[test]
    fn rewrites_existing_config_idempotently() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-b");
        let config_dir = temp_root.join("config");
        let executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(executable_path.parent().unwrap()).unwrap();
        std::fs::write(&executable_path, "bin").unwrap();

        let service =
            WorkspaceMcpConfigService::new(config_dir.clone(), executable_path.clone(), None, None);
        let first = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let first_content = std::fs::read_to_string(&first).unwrap();
        let second = service
            .prepare_workspace_config(workspace.to_string_lossy().as_ref())
            .unwrap();
        let second_content = std::fs::read_to_string(&second).unwrap();

        assert_eq!(first, second);
        assert_eq!(first_content, second_content);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepare_workspace_config_skips_disabled_servers() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-disabled");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();

        let service = WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None);

        let config_path = service
            .prepare_workspace_config_with_disabled(
                workspace.to_string_lossy().as_ref(),
                &[TODO_MCP_SERVER_NAME.to_string()],
            )
            .unwrap();

        let content = std::fs::read_to_string(&config_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["mcpServers"].as_object().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn prepare_workspace_codex_config_args_skips_disabled_servers() {
        let temp_root =
            std::env::temp_dir().join(format!("polaris-mcp-test-{}", uuid::Uuid::new_v4()));
        let workspace = temp_root.join("workspace-disabled-codex");
        let config_dir = temp_root.join("config");
        let todo_executable_path = temp_root.join(fixture_exe("bin/polaris-todo-mcp"));

        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(todo_executable_path.parent().unwrap()).unwrap();
        std::fs::write(&todo_executable_path, "todo bin").unwrap();

        let service = WorkspaceMcpConfigService::new(config_dir, todo_executable_path, None, None);

        let args = service
            .prepare_workspace_codex_config_args_with_disabled(
                workspace.to_string_lossy().as_ref(),
                &[TODO_MCP_SERVER_NAME.to_string()],
            )
            .unwrap();

        assert!(args.is_empty());

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
