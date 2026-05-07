//! Plugin 服务
//!
//! 封装 Claude CLI 的 plugin 命令调用

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, Result};
use crate::models::plugin::{
    Marketplace, PluginDiscoveryError, PluginDiscoveryResult, PluginInstallLocations,
    PluginListResult, PluginManifestFile, PluginManifestSource, PluginManifestSourceKind,
    PluginOperationResult, PluginScope,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// Plugin 服务
pub struct PluginService {
    /// Claude CLI 路径
    claude_path: String,
}

impl PluginService {
    /// 创建新的 Plugin 服务
    pub fn new(claude_path: String) -> Self {
        Self { claude_path }
    }

    /// 执行 Claude CLI 命令并获取输出
    fn execute_claude(&self, args: &[&str]) -> Result<String> {
        let mut cmd = self.build_command();

        cmd.args(args);

        let output = cmd
            .output()
            .map_err(|e| AppError::ProcessError(format!("执行 Claude CLI 失败: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::ProcessError(format!(
                "Claude CLI 执行失败: {}",
                stderr
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// 构建命令
    #[cfg(windows)]
    fn build_command(&self) -> Command {
        let mut cmd = Command::new(&self.claude_path);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// 构建命令 (非 Windows)
    #[cfg(not(windows))]
    fn build_command(&self) -> Command {
        Command::new(&self.claude_path)
    }

    /// 列出插件
    ///
    /// 调用 `claude plugin list --json [--available]`
    pub fn list_plugins(&self, available: bool) -> Result<PluginListResult> {
        let mut args = vec!["plugin", "list", "--json"];
        if available {
            args.push("--available");
        }

        let output = self.execute_claude(&args)?;

        // 解析 JSON 输出
        // CLI 返回格式：
        // - 不带 --available: 直接返回已安装插件数组
        // - 带 --available: 返回 { installed: [...], available: [...] }
        if available {
            let result: PluginListResult = serde_json::from_str(&output)
                .map_err(|e| AppError::ProcessError(format!("解析插件列表失败: {}", e)))?;
            Ok(result)
        } else {
            // 直接是已安装插件数组
            let installed: Vec<crate::models::plugin::InstalledPlugin> =
                serde_json::from_str(&output).map_err(|e| {
                    AppError::ProcessError(format!("解析已安装插件列表失败: {}", e))
                })?;
            Ok(PluginListResult {
                installed,
                available: None,
            })
        }
    }

    /// 安装插件
    ///
    /// 调用 `claude plugin install <id> -s <scope>`
    pub fn install_plugin(
        &self,
        plugin_id: &str,
        scope: PluginScope,
    ) -> Result<PluginOperationResult> {
        let args = vec!["plugin", "install", plugin_id, "-s", scope.as_str()];

        match self.execute_claude(&args) {
            Ok(output) => Ok(PluginOperationResult {
                success: true,
                message: Some(output),
                error: None,
            }),
            Err(e) => Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// 启用插件
    ///
    /// 调用 `claude plugin enable <id> -s <scope>`
    pub fn enable_plugin(
        &self,
        plugin_id: &str,
        scope: PluginScope,
    ) -> Result<PluginOperationResult> {
        let args = vec!["plugin", "enable", plugin_id, "-s", scope.as_str()];

        match self.execute_claude(&args) {
            Ok(output) => Ok(PluginOperationResult {
                success: true,
                message: Some(output),
                error: None,
            }),
            Err(e) => Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// 禁用插件
    ///
    /// 调用 `claude plugin disable <id> -s <scope>`
    pub fn disable_plugin(
        &self,
        plugin_id: &str,
        scope: PluginScope,
    ) -> Result<PluginOperationResult> {
        let args = vec!["plugin", "disable", plugin_id, "-s", scope.as_str()];

        match self.execute_claude(&args) {
            Ok(output) => Ok(PluginOperationResult {
                success: true,
                message: Some(output),
                error: None,
            }),
            Err(e) => Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// 更新插件
    ///
    /// 调用 `claude plugin update <id> -s <scope>`
    pub fn update_plugin(
        &self,
        plugin_id: &str,
        scope: PluginScope,
    ) -> Result<PluginOperationResult> {
        let args = vec!["plugin", "update", plugin_id, "-s", scope.as_str()];

        match self.execute_claude(&args) {
            Ok(output) => Ok(PluginOperationResult {
                success: true,
                message: Some(output),
                error: None,
            }),
            Err(e) => Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// 卸载插件
    ///
    /// 调用 `claude plugin uninstall <id> -s <scope> [--keep-data]`
    pub fn uninstall_plugin(
        &self,
        plugin_id: &str,
        scope: PluginScope,
        keep_data: bool,
    ) -> Result<PluginOperationResult> {
        let mut args = vec!["plugin", "uninstall", plugin_id, "-s", scope.as_str()];
        if keep_data {
            args.push("--keep-data");
        }

        match self.execute_claude(&args) {
            Ok(output) => Ok(PluginOperationResult {
                success: true,
                message: Some(output),
                error: None,
            }),
            Err(e) => Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// 列出市场
    ///
    /// 调用 `claude plugin marketplace list --json`
    pub fn list_marketplaces(&self) -> Result<Vec<Marketplace>> {
        let output = self.execute_claude(&["plugin", "marketplace", "list", "--json"])?;

        let marketplaces: Vec<Marketplace> = serde_json::from_str(&output)
            .map_err(|e| AppError::ProcessError(format!("解析市场列表失败: {}", e)))?;

        Ok(marketplaces)
    }

    /// 添加市场
    ///
    /// 调用 `claude plugin marketplace add <source>`
    pub fn add_marketplace(&self, source: &str) -> Result<Marketplace> {
        let _ = self.execute_claude(&["plugin", "marketplace", "add", source])?;

        // CLI 不返回市场信息，重新获取
        let marketplaces = self.list_marketplaces()?;
        marketplaces
            .into_iter()
            .find(|m| m.source == source || m.repo.as_deref() == Some(source))
            .ok_or_else(|| AppError::ProcessError("无法找到添加的市场".to_string()))
    }

    /// 移除市场
    ///
    /// 调用 `claude plugin marketplace remove <name>`
    pub fn remove_marketplace(&self, name: &str) -> Result<()> {
        self.execute_claude(&["plugin", "marketplace", "remove", name])?;
        Ok(())
    }

    /// 更新市场
    ///
    /// 调用 `claude plugin marketplace update [name]`
    pub fn update_marketplace(&self, name: Option<&str>) -> Result<()> {
        match name {
            Some(n) => {
                self.execute_claude(&["plugin", "marketplace", "update", n])?;
            }
            None => {
                self.execute_claude(&["plugin", "marketplace", "update"])?;
            }
        }
        Ok(())
    }

    /// 扫描 Polaris 插件目录，返回已安装插件 manifest。
    ///
    /// 当前仅发现 metadata，不执行插件代码。
    pub fn discover_installed_plugins(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
    ) -> PluginDiscoveryResult {
        let mut result = PluginDiscoveryResult::default();

        Self::scan_plugin_root(
            &app_config_dir.join("plugins"),
            PluginManifestSource {
                kind: PluginManifestSourceKind::User,
                workspace_path: None,
            },
            &mut result,
        );

        if let Some(workspace_path) = workspace_path {
            let workspace = workspace_path.to_string_lossy().to_string();
            for root in [
                workspace_path.join(".polaris").join("plugins"),
                workspace_path.join(".codex").join("plugins"),
            ] {
                Self::scan_plugin_root(
                    &root,
                    PluginManifestSource {
                        kind: PluginManifestSourceKind::Project,
                        workspace_path: Some(workspace.clone()),
                    },
                    &mut result,
                );
            }
        }

        result
    }

    pub fn install_locations(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
    ) -> PluginInstallLocations {
        let user_root = app_config_dir.join("plugins");
        let _ = std::fs::create_dir_all(&user_root);
        let user_path = user_root.to_string_lossy().to_string();
        let project_path = workspace_path.map(|path| {
            let project_root = path.join(".polaris").join("plugins");
            let _ = std::fs::create_dir_all(&project_root);
            project_root.to_string_lossy().to_string()
        });
        let mut discovery_paths = vec![user_path.clone()];

        if let Some(workspace_path) = workspace_path {
            discovery_paths.push(
                workspace_path
                    .join(".polaris")
                    .join("plugins")
                    .to_string_lossy()
                    .to_string(),
            );
            discovery_paths.push(
                workspace_path
                    .join(".codex")
                    .join("plugins")
                    .to_string_lossy()
                    .to_string(),
            );
        }

        PluginInstallLocations {
            user_path,
            project_path,
            discovery_paths,
        }
    }

    pub fn install_local_plugin(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        source_path: &Path,
        scope: PluginManifestSourceKind,
    ) -> Result<PluginOperationResult> {
        let source_dir = source_path.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!(
                "无法读取插件目录 {}: {}",
                source_path.display(),
                error
            ))
        })?;

        if !source_dir.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "插件来源不是目录: {}",
                source_dir.display()
            )));
        }

        let manifest_path = Self::find_manifest_path(&source_dir).ok_or_else(|| {
            AppError::ConfigError(
                "插件目录必须包含 plugin.json 或 .codex-plugin/plugin.json".to_string(),
            )
        })?;
        let manifest = Self::read_manifest(&manifest_path)?;

        let install_root = match scope {
            PluginManifestSourceKind::User => app_config_dir.join("plugins"),
            PluginManifestSourceKind::Project => workspace_path
                .map(|path| path.join(".polaris").join("plugins"))
                .ok_or_else(|| AppError::ConfigError("项目插件安装需要当前工作区".to_string()))?,
        };
        std::fs::create_dir_all(&install_root)?;

        let target_dir = install_root.join(Self::safe_plugin_dir_name(&manifest.id));
        if target_dir.exists() {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(format!("插件已存在: {}", target_dir.display())),
            });
        }

        let canonical_root = install_root.canonicalize()?;
        if source_dir.starts_with(&canonical_root) {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some("来源目录已经位于插件安装目录中，请直接刷新已安装插件".to_string()),
            });
        }

        Self::copy_dir_recursive(&source_dir, &target_dir)?;

        Ok(PluginOperationResult {
            success: true,
            message: Some(format!(
                "已安装插件 {} 到 {}",
                manifest.id,
                target_dir.display()
            )),
            error: None,
        })
    }

    pub fn uninstall_local_plugin(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        install_path: &Path,
    ) -> Result<PluginOperationResult> {
        let target = install_path.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!(
                "无法读取插件安装目录 {}: {}",
                install_path.display(),
                error
            ))
        })?;

        let mut allowed_roots = vec![app_config_dir.join("plugins")];
        if let Some(workspace_path) = workspace_path {
            allowed_roots.push(workspace_path.join(".polaris").join("plugins"));
            allowed_roots.push(workspace_path.join(".codex").join("plugins"));
        }

        let is_allowed = allowed_roots.iter().any(|root| {
            root.canonicalize()
                .map(|canonical| target.starts_with(&canonical) && target != canonical)
                .unwrap_or(false)
        });

        if !is_allowed {
            return Err(AppError::PermissionDenied(format!(
                "只能卸载已发现插件目录下的插件: {}",
                target.display()
            )));
        }

        std::fs::remove_dir_all(&target)?;

        Ok(PluginOperationResult {
            success: true,
            message: Some(format!("已卸载插件目录 {}", target.display())),
            error: None,
        })
    }

    fn scan_plugin_root(
        root: &Path,
        source: PluginManifestSource,
        result: &mut PluginDiscoveryResult,
    ) {
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                result.errors.push(PluginDiscoveryError {
                    path: root.to_string_lossy().to_string(),
                    error: error.to_string(),
                });
                return;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    result.errors.push(PluginDiscoveryError {
                        path: root.to_string_lossy().to_string(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };

            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }

            if let Some(manifest_path) = Self::find_manifest_path(&plugin_dir) {
                match Self::read_manifest(&manifest_path) {
                    Ok(manifest) => result
                        .plugins
                        .push(manifest.into_discovered(source.clone(), plugin_dir)),
                    Err(error) => result.errors.push(PluginDiscoveryError {
                        path: manifest_path.to_string_lossy().to_string(),
                        error: error.to_string(),
                    }),
                }
            }
        }
    }

    fn find_manifest_path(plugin_dir: &Path) -> Option<PathBuf> {
        [
            plugin_dir.join("plugin.json"),
            plugin_dir.join(".codex-plugin").join("plugin.json"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }

    fn read_manifest(path: &Path) -> Result<PluginManifestFile> {
        let content = std::fs::read_to_string(path)?;
        serde_json::from_str::<PluginManifestFile>(&content)
            .map_err(|error| AppError::ConfigError(format!("插件 manifest 格式错误: {}", error)))
    }

    fn safe_plugin_dir_name(plugin_id: &str) -> String {
        let name: String = plugin_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                    ch
                } else {
                    '-'
                }
            })
            .collect();
        let trimmed = name.trim_matches(|ch| matches!(ch, '.' | '-' | '_'));
        if trimmed.is_empty() {
            "plugin".to_string()
        } else {
            trimmed.to_string()
        }
    }

    fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let target_path = target.join(entry.file_name());
            let file_type = entry.file_type()?;

            if file_type.is_dir() {
                Self::copy_dir_recursive(&source_path, &target_path)?;
            } else if file_type.is_file() {
                std::fs::copy(&source_path, &target_path)?;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_user_and_project_plugin_manifests() {
        let app_config = tempfile::tempdir().unwrap();
        let user_plugin = app_config.path().join("plugins").join("sample-user");
        std::fs::create_dir_all(&user_plugin).unwrap();
        std::fs::write(
            user_plugin.join("plugin.json"),
            r#"{
              "id": "example.user",
              "name": "Example User",
              "version": "0.1.0",
              "enabledByDefault": true,
              "contributes": {
                "mcpServers": [
                  {
                    "id": "example-user",
                    "transport": "stdio",
                    "command": "example-user"
                  }
                ]
              },
              "permissions": { "workspaceRead": true }
            }"#,
        )
        .unwrap();

        let workspace = tempfile::tempdir().unwrap();
        let project_plugin = workspace
            .path()
            .join(".polaris")
            .join("plugins")
            .join("sample-project")
            .join(".codex-plugin");
        std::fs::create_dir_all(&project_plugin).unwrap();
        std::fs::write(
            project_plugin.join("plugin.json"),
            r#"{
              "id": "example.project",
              "name": "Example Project",
              "version": "0.1.0",
              "permissions": {}
            }"#,
        )
        .unwrap();

        let result =
            PluginService::discover_installed_plugins(app_config.path(), Some(workspace.path()));

        assert!(result.errors.is_empty());
        assert_eq!(result.plugins.len(), 2);
        assert!(result.plugins.iter().any(|plugin| {
            plugin.id == "example.user"
                && plugin.source.kind == PluginManifestSourceKind::User
                && plugin.enabled_by_default
        }));
        assert!(result.plugins.iter().any(|plugin| {
            plugin.id == "example.project"
                && plugin.source.kind == PluginManifestSourceKind::Project
                && !plugin.enabled_by_default
        }));
    }

    #[test]
    fn reports_invalid_manifest_without_stopping_scan() {
        let app_config = tempfile::tempdir().unwrap();
        let invalid_plugin = app_config.path().join("plugins").join("invalid");
        let valid_plugin = app_config.path().join("plugins").join("valid");
        std::fs::create_dir_all(&invalid_plugin).unwrap();
        std::fs::create_dir_all(&valid_plugin).unwrap();
        std::fs::write(invalid_plugin.join("plugin.json"), "{").unwrap();
        std::fs::write(
            valid_plugin.join("plugin.json"),
            r#"{
              "id": "example.valid",
              "name": "Example Valid",
              "version": "0.1.0"
            }"#,
        )
        .unwrap();

        let result = PluginService::discover_installed_plugins(app_config.path(), None);

        assert_eq!(result.plugins.len(), 1);
        assert_eq!(result.plugins[0].id, "example.valid");
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].path.ends_with("plugin.json"));
    }

    #[test]
    fn installs_and_uninstalls_local_plugin_within_allowed_root() {
        let app_config = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        std::fs::write(
            source.path().join("plugin.json"),
            r#"{
              "id": "example.local",
              "name": "Example Local",
              "version": "0.1.0"
            }"#,
        )
        .unwrap();

        let installed = PluginService::install_local_plugin(
            app_config.path(),
            None,
            source.path(),
            PluginManifestSourceKind::User,
        )
        .unwrap();
        assert!(installed.success);

        let install_path = app_config.path().join("plugins").join("example.local");
        assert!(install_path.join("plugin.json").is_file());

        let uninstalled =
            PluginService::uninstall_local_plugin(app_config.path(), None, &install_path).unwrap();
        assert!(uninstalled.success);
        assert!(!install_path.exists());
    }

    #[test]
    fn refuses_to_uninstall_outside_plugin_roots() {
        let app_config = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        let result = PluginService::uninstall_local_plugin(app_config.path(), None, outside.path());

        assert!(result.is_err());
    }
}
