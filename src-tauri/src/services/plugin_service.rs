//! Plugin 服务
//!
//! 封装 Claude CLI 的 plugin 命令调用

use std::fs::File;
use std::io::{Cursor, Read, Seek};
use std::path::{Path, PathBuf};

use std::process::Command;

use crate::error::{AppError, Result};
use crate::models::plugin::{
    Marketplace, PluginDiscoveryError, PluginDiscoveryResult, PluginInstallLocations,
    PluginListResult, PluginManifestFile, PluginManifestSource, PluginManifestSourceKind,
    PluginManifestValidationResult, PluginOperationResult, PluginScope, PluginUpdateCheckResult,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

const VALID_PLUGIN_ICONS: &[&str] = &[
    "Files",
    "GitPullRequest",
    "CheckSquare",
    "Languages",
    "Clock",
    "Target",
    "ClipboardList",
    "Terminal",
    "Code2",
    "Bot",
    "BookOpen",
    "AlertCircle",
];
const VALID_TRANSPORTS: &[&str] = &["stdio", "http"];

struct PreparedPluginSource {
    path: PathBuf,
    _temp_dir: Option<tempfile::TempDir>,
}

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

    pub fn validate_plugin_manifest(source_path: &Path) -> PluginManifestValidationResult {
        let manifest_path = if source_path.is_file() {
            Some(source_path.to_path_buf())
        } else if source_path.is_dir() {
            Self::find_manifest_path(source_path)
        } else {
            None
        };

        match manifest_path {
            Some(path) => Self::validate_manifest_file_path(&path),
            None => {
                let mut result = PluginManifestValidationResult::default();
                Self::push_validation_error(
                    &mut result,
                    &source_path.to_string_lossy(),
                    "插件路径不存在，或目录内缺少 plugin.json / .codex-plugin/plugin.json",
                );
                result
            }
        }
    }

    pub fn install_local_plugin(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        source_path: &Path,
        scope: PluginManifestSourceKind,
    ) -> Result<PluginOperationResult> {
        let path = source_path.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!(
                "无法读取插件目录 {}: {}",
                source_path.display(),
                error
            ))
        })?;

        if !path.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "插件来源不是目录: {}",
                path.display()
            )));
        }

        let source = PreparedPluginSource {
            path,
            _temp_dir: None,
        };
        Self::install_prepared_plugin_source(app_config_dir, workspace_path, &source, scope, false)
    }

    pub fn install_plugin_package(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        package_path: &Path,
        scope: PluginManifestSourceKind,
    ) -> Result<PluginOperationResult> {
        let source = Self::prepare_package_source(package_path)?;
        Self::install_prepared_plugin_source(app_config_dir, workspace_path, &source, scope, false)
    }

    pub async fn install_remote_plugin(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        source_url: &str,
        scope: PluginManifestSourceKind,
    ) -> Result<PluginOperationResult> {
        let source = Self::download_plugin_source(source_url).await?;
        Self::install_prepared_plugin_source(app_config_dir, workspace_path, &source, scope, false)
    }

    pub async fn apply_local_plugin_update(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        install_path: &Path,
    ) -> Result<PluginOperationResult> {
        let target = Self::canonicalize_allowed_plugin_dir(
            app_config_dir,
            workspace_path,
            install_path,
        )?;
        let installed_manifest_path = Self::find_manifest_path(&target).ok_or_else(|| {
            AppError::ConfigError("插件目录缺少 plugin.json / .codex-plugin/plugin.json".to_string())
        })?;
        let installed_manifest = Self::read_manifest(&installed_manifest_path)?;
        let update_url = installed_manifest.origin.update_url.clone().ok_or_else(|| {
            AppError::ConfigError("插件 manifest 未声明 origin.updateUrl，无法应用更新".to_string())
        })?;
        let latest_manifest = Self::read_update_manifest(&update_url).await?;
        if latest_manifest.id != installed_manifest.id {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(format!(
                    "更新 manifest 插件 ID 不匹配: 当前 {}，远端 {}",
                    installed_manifest.id,
                    latest_manifest.id
                )),
            });
        }
        if !Self::is_version_newer(&latest_manifest.version, &installed_manifest.version) {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(format!(
                    "未发现可应用的新版本: 当前 {}，远端 {}",
                    installed_manifest.version,
                    latest_manifest.version
                )),
            });
        }

        let download_url = latest_manifest.origin.download_url.clone().ok_or_else(|| {
            AppError::ConfigError("更新 manifest 未声明 origin.downloadUrl，无法下载安装包".to_string())
        })?;
        let download_url = Self::resolve_source_url(&update_url, &download_url);
        let source = Self::download_plugin_source(&download_url).await?;
        let temp_parent = target.parent().ok_or_else(|| {
            AppError::InvalidPath(format!("插件安装目录缺少父目录: {}", target.display()))
        })?;
        let staging = tempfile::Builder::new()
            .prefix(".polaris-plugin-update-")
            .tempdir_in(temp_parent)?;
        let validation = Self::copy_prepared_plugin_source(&source, staging.path())?;
        let candidate_manifest_path = Self::find_manifest_path(staging.path()).ok_or_else(|| {
            AppError::ConfigError("更新包缺少 plugin.json / .codex-plugin/plugin.json".to_string())
        })?;
        let candidate_manifest = Self::read_manifest(&candidate_manifest_path)?;
        if candidate_manifest.id != installed_manifest.id {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(format!(
                    "更新包插件 ID 不匹配: 当前 {}，安装包 {}",
                    installed_manifest.id,
                    candidate_manifest.id
                )),
            });
        }
        if !Self::is_version_newer(&candidate_manifest.version, &installed_manifest.version) {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(format!(
                    "更新包版本未高于当前版本: 当前 {}，安装包 {}",
                    installed_manifest.version,
                    candidate_manifest.version
                )),
            });
        }
        if !validation.valid {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(Self::format_validation_errors(&validation)),
            });
        }

        let staging_path = staging.path().to_path_buf();
        let backup = tempfile::Builder::new()
            .prefix(".polaris-plugin-backup-")
            .tempdir_in(temp_parent)?;
        let backup_path = backup.keep();
        std::fs::remove_dir(&backup_path)?;
        std::fs::rename(&target, &backup_path)?;

        let install_result: Result<()> = match std::fs::rename(&staging_path, &target) {
            Ok(()) => Ok(()),
            Err(_) => {
                Self::copy_dir_recursive(&staging_path, &target)
                    .and_then(|()| Ok(std::fs::remove_dir_all(&staging_path)?))
            }
        };

        if let Err(error) = install_result {
            if target.exists() {
                let _ = std::fs::remove_dir_all(&target);
            }
            if let Err(restore_error) = std::fs::rename(&backup_path, &target) {
                return Err(AppError::ConfigError(format!(
                    "插件更新失败且无法恢复旧版本: {}; 恢复错误: {}",
                    error, restore_error
                )));
            }
            return Err(error);
        }

        if let Err(cleanup_error) = std::fs::remove_dir_all(&backup_path) {
            return Ok(PluginOperationResult {
                success: true,
                message: Some(format!(
                    "已更新插件 {}: {} -> {}，但清理备份目录失败: {}",
                    installed_manifest.id,
                    installed_manifest.version,
                    candidate_manifest.version,
                    cleanup_error
                )),
                error: None,
            });
        }

        Ok(PluginOperationResult {
            success: true,
            message: Some(format!(
                "已更新插件 {}: {} -> {}",
                installed_manifest.id,
                installed_manifest.version,
                candidate_manifest.version
            )),
            error: None,
        })
    }

    pub fn uninstall_local_plugin(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        install_path: &Path,
    ) -> Result<PluginOperationResult> {
        let target = Self::canonicalize_allowed_plugin_dir(
            app_config_dir,
            workspace_path,
            install_path,
        )?;

        std::fs::remove_dir_all(&target)?;

        Ok(PluginOperationResult {
            success: true,
            message: Some(format!("已卸载插件目录 {}", target.display())),
            error: None,
        })
    }

    pub async fn check_local_plugin_update(install_path: &Path) -> PluginUpdateCheckResult {
        let manifest_path = match Self::find_manifest_path(install_path) {
            Some(path) => path,
            None => {
                return PluginUpdateCheckResult {
                    plugin_id: String::new(),
                    current_version: String::new(),
                    latest_version: None,
                    update_available: false,
                    checked: false,
                    source_url: None,
                    download_url: None,
                    error: Some("插件目录缺少 plugin.json / .codex-plugin/plugin.json".to_string()),
                };
            }
        };

        let manifest = match Self::read_manifest(&manifest_path) {
            Ok(manifest) => manifest,
            Err(error) => {
                return PluginUpdateCheckResult {
                    plugin_id: String::new(),
                    current_version: String::new(),
                    latest_version: None,
                    update_available: false,
                    checked: false,
                    source_url: None,
                    download_url: None,
                    error: Some(error.to_string()),
                };
            }
        };

        let Some(update_url) = manifest.origin.update_url.clone() else {
            return PluginUpdateCheckResult {
                plugin_id: manifest.id,
                current_version: manifest.version,
                latest_version: None,
                update_available: false,
                checked: false,
                source_url: None,
                download_url: None,
                error: Some("插件 manifest 未声明 origin.updateUrl，无法检查更新".to_string()),
            };
        };

        let latest_manifest = match Self::read_update_manifest(&update_url).await {
            Ok(manifest) => manifest,
            Err(error) => {
                return PluginUpdateCheckResult {
                    plugin_id: manifest.id,
                    current_version: manifest.version,
                    latest_version: None,
                    update_available: false,
                    checked: false,
                    source_url: Some(update_url),
                    download_url: None,
                    error: Some(error.to_string()),
                };
            }
        };

        let latest_version = latest_manifest.version;
        let update_available = Self::is_version_newer(&latest_version, &manifest.version);
        let download_url = latest_manifest
            .origin
            .download_url
            .as_deref()
            .map(|url| Self::resolve_source_url(&update_url, url));

        PluginUpdateCheckResult {
            plugin_id: manifest.id,
            current_version: manifest.version,
            latest_version: Some(latest_version),
            update_available,
            checked: true,
            source_url: Some(update_url),
            download_url,
            error: None,
        }
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
                let validation = Self::validate_manifest_file_path(&manifest_path);
                if !validation.valid {
                    result.errors.extend(validation.errors);
                    continue;
                }

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

    async fn read_update_manifest(update_url: &str) -> Result<PluginManifestFile> {
        if update_url.starts_with("http://") || update_url.starts_with("https://") {
            let content = reqwest::Client::new()
                .get(update_url)
                .send()
                .await
                .map_err(|error| AppError::ProcessError(format!("获取插件更新 manifest 失败: {}", error)))?
                .error_for_status()
                .map_err(|error| AppError::ProcessError(format!("获取插件更新 manifest 失败: {}", error)))?
                .text()
                .await
                .map_err(|error| AppError::ProcessError(format!("读取插件更新 manifest 失败: {}", error)))?;
            serde_json::from_str::<PluginManifestFile>(&content)
                .map_err(|error| AppError::ConfigError(format!("插件更新 manifest 格式错误: {}", error)))
        } else {
            Self::read_manifest(Path::new(update_url))
        }
    }

    fn install_prepared_plugin_source(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        source: &PreparedPluginSource,
        scope: PluginManifestSourceKind,
        replace_existing: bool,
    ) -> Result<PluginOperationResult> {
        let manifest_path = Self::find_manifest_path(&source.path).ok_or_else(|| {
            AppError::ConfigError(
                "插件目录必须包含 plugin.json 或 .codex-plugin/plugin.json".to_string(),
            )
        })?;
        let validation = Self::validate_manifest_file_path(&manifest_path);
        if !validation.valid {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(Self::format_validation_errors(&validation)),
            });
        }
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
            if !replace_existing {
                return Ok(PluginOperationResult {
                    success: false,
                    message: None,
                    error: Some(format!("插件已存在: {}", target_dir.display())),
                });
            }
            std::fs::remove_dir_all(&target_dir)?;
        }

        let canonical_root = install_root.canonicalize()?;
        if source
            .path
            .canonicalize()
            .map(|path| path.starts_with(&canonical_root))
            .unwrap_or(false)
        {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some("来源目录已经位于插件安装目录中，请直接刷新已安装插件".to_string()),
            });
        }

        let validation = Self::copy_prepared_plugin_source(source, &target_dir)?;
        if !validation.valid {
            return Ok(PluginOperationResult {
                success: false,
                message: None,
                error: Some(Self::format_validation_errors(&validation)),
            });
        }

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

    fn canonicalize_allowed_plugin_dir(
        app_config_dir: &Path,
        workspace_path: Option<&Path>,
        install_path: &Path,
    ) -> Result<PathBuf> {
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
                "只能操作已发现插件目录下的插件: {}",
                target.display()
            )));
        }

        Ok(target)
    }

    fn prepare_package_source(package_path: &Path) -> Result<PreparedPluginSource> {
        let path = package_path.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!(
                "无法读取插件安装包 {}: {}",
                package_path.display(),
                error
            ))
        })?;

        if path.is_dir() {
            return Ok(PreparedPluginSource {
                path,
                _temp_dir: None,
            });
        }

        if !path.is_file() {
            return Err(AppError::InvalidPath(format!(
                "插件安装包不存在: {}",
                path.display()
            )));
        }

        if Self::looks_like_zip_path(&path) {
            let temp_dir = tempfile::Builder::new()
                .prefix("polaris-plugin-package-")
                .tempdir()?;
            let file = File::open(&path)?;
            Self::extract_zip_reader(file, temp_dir.path())?;
            let source_path = Self::plugin_package_root(temp_dir.path())?;
            return Ok(PreparedPluginSource {
                path: source_path,
                _temp_dir: Some(temp_dir),
            });
        }

        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            let temp_dir = tempfile::Builder::new()
                .prefix("polaris-plugin-manifest-")
                .tempdir()?;
            std::fs::copy(&path, temp_dir.path().join("plugin.json"))?;
            return Ok(PreparedPluginSource {
                path: temp_dir.path().to_path_buf(),
                _temp_dir: Some(temp_dir),
            });
        }

        Err(AppError::InvalidPath(format!(
            "不支持的插件安装包格式: {}",
            path.display()
        )))
    }

    async fn download_plugin_source(source_url: &str) -> Result<PreparedPluginSource> {
        if source_url.starts_with("http://") || source_url.starts_with("https://") {
            let response = reqwest::Client::new()
                .get(source_url)
                .send()
                .await
                .map_err(|error| AppError::NetworkError(format!("下载插件失败: {}", error)))?
                .error_for_status()
                .map_err(|error| AppError::NetworkError(format!("下载插件失败: {}", error)))?;
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let bytes = response
                .bytes()
                .await
                .map_err(|error| AppError::NetworkError(format!("读取插件下载内容失败: {}", error)))?;
            return Self::prepare_downloaded_plugin_source(source_url, content_type.as_deref(), bytes.as_ref()).await;
        }

        Self::prepare_package_source(Path::new(source_url))
    }

    async fn prepare_downloaded_plugin_source(
        source_url: &str,
        content_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<PreparedPluginSource> {
        if Self::looks_like_zip_url(source_url, content_type, bytes) {
            let temp_dir = tempfile::Builder::new()
                .prefix("polaris-plugin-download-")
                .tempdir()?;
            Self::extract_zip_reader(Cursor::new(bytes), temp_dir.path())?;
            let source_path = Self::plugin_package_root(temp_dir.path())?;
            return Ok(PreparedPluginSource {
                path: source_path,
                _temp_dir: Some(temp_dir),
            });
        }

        match serde_json::from_slice::<PluginManifestFile>(bytes) {
            Ok(manifest) => {
                if let Some(download_url) = manifest.origin.download_url.as_deref() {
                    let resolved = Self::resolve_source_url(source_url, download_url);
                    if resolved != source_url {
                        return Box::pin(Self::download_plugin_source(&resolved)).await;
                    }
                }

                let temp_dir = tempfile::Builder::new()
                    .prefix("polaris-plugin-manifest-")
                    .tempdir()?;
                std::fs::write(temp_dir.path().join("plugin.json"), bytes)?;
                Ok(PreparedPluginSource {
                    path: temp_dir.path().to_path_buf(),
                    _temp_dir: Some(temp_dir),
                })
            }
            Err(error) => Err(AppError::ConfigError(format!(
                "远程插件来源既不是 zip 安装包，也不是有效 manifest: {}",
                error
            ))),
        }
    }

    fn copy_prepared_plugin_source(
        source: &PreparedPluginSource,
        target: &Path,
    ) -> Result<PluginManifestValidationResult> {
        Self::copy_dir_recursive(&source.path, target)?;
        let manifest_path = Self::find_manifest_path(target).ok_or_else(|| {
            AppError::ConfigError(
                "插件安装包必须包含 plugin.json 或 .codex-plugin/plugin.json".to_string(),
            )
        })?;
        Ok(Self::validate_manifest_file_path(&manifest_path))
    }

    fn plugin_package_root(root: &Path) -> Result<PathBuf> {
        if Self::find_manifest_path(root).is_some() {
            return Ok(root.to_path_buf());
        }

        let directories = std::fs::read_dir(root)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_type().ok().filter(|file_type| file_type.is_dir()).map(|_| entry.path()))
            .collect::<Vec<_>>();

        if directories.len() == 1 && Self::find_manifest_path(&directories[0]).is_some() {
            return Ok(directories[0].clone());
        }

        Err(AppError::ConfigError(
            "插件安装包必须在根目录或唯一顶层目录中包含 plugin.json / .codex-plugin/plugin.json".to_string(),
        ))
    }

    fn extract_zip_reader<R: Read + Seek>(reader: R, target: &Path) -> Result<()> {
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|error| AppError::ConfigError(format!("插件 zip 安装包格式错误: {}", error)))?;

        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .map_err(|error| AppError::ConfigError(format!("读取插件 zip 安装包失败: {}", error)))?;
            let enclosed_path = file.enclosed_name().ok_or_else(|| {
                AppError::PermissionDenied(format!("插件 zip 安装包包含不安全路径: {}", file.name()))
            })?;
            let output_path = target.join(enclosed_path);

            if file.is_dir() {
                std::fs::create_dir_all(&output_path)?;
            } else {
                if let Some(parent) = output_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut output = File::create(&output_path)?;
                std::io::copy(&mut file, &mut output)?;
            }
        }

        Ok(())
    }

    fn looks_like_zip_path(path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    }

    fn looks_like_zip_url(source_url: &str, content_type: Option<&str>, bytes: &[u8]) -> bool {
        source_url.to_ascii_lowercase().split('?').next().unwrap_or_default().ends_with(".zip")
            || content_type
                .map(|value| value.contains("application/zip") || value.contains("application/octet-stream"))
                .unwrap_or(false)
            || bytes.starts_with(b"PK\x03\x04")
    }

    fn resolve_source_url(base_url: &str, source_url: &str) -> String {
        if source_url.starts_with("http://")
            || source_url.starts_with("https://")
            || Path::new(source_url).is_absolute()
        {
            return source_url.to_string();
        }

        if let Ok(base) = url::Url::parse(base_url) {
            if let Ok(joined) = base.join(source_url) {
                return joined.to_string();
            }
        }

        Path::new(base_url)
            .parent()
            .map(|parent| parent.join(source_url).to_string_lossy().to_string())
            .unwrap_or_else(|| source_url.to_string())
    }

    fn validate_manifest_file_path(path: &Path) -> PluginManifestValidationResult {
        let path_text = path.to_string_lossy().to_string();
        let mut result = PluginManifestValidationResult {
            manifest_path: Some(path_text.clone()),
            ..Default::default()
        };

        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) => {
                Self::push_validation_error(&mut result, &path_text, format!("无法读取插件 manifest: {}", error));
                return result;
            }
        };
        let manifest = match serde_json::from_str::<PluginManifestFile>(&content) {
            Ok(manifest) => manifest,
            Err(error) => {
                Self::push_validation_error(&mut result, &path_text, format!("插件 manifest 格式错误: {}", error));
                return result;
            }
        };

        result.plugin_id = Some(manifest.id.clone());
        if manifest.id.trim().is_empty() {
            Self::push_validation_error(&mut result, &path_text, "id is required and must be a non-empty string");
        }
        if manifest.name.trim().is_empty() {
            Self::push_validation_error(&mut result, &path_text, "name is required and must be a non-empty string");
        }
        if manifest.version.trim().is_empty() {
            Self::push_validation_error(&mut result, &path_text, "version is required and must be a non-empty string");
        }

        for (index, view) in manifest.contributes.views.iter().enumerate() {
            let prefix = format!("contributes.views[{}]", index);
            if view.id.trim().is_empty() {
                Self::push_validation_error(&mut result, &path_text, format!("{}.id is required", prefix));
            }
            if view.area != "activityBar" {
                Self::push_validation_error(&mut result, &path_text, format!("{}.area has unsupported value: {}", prefix, view.area));
            }
            if view.panel_type.trim().is_empty() {
                Self::push_validation_error(&mut result, &path_text, format!("{}.panelType is required", prefix));
            }
            if !VALID_PLUGIN_ICONS.contains(&view.icon.as_str()) {
                Self::push_validation_error(&mut result, &path_text, format!("{}.icon has unsupported value: {}", prefix, view.icon));
            }
            if view.label_key.trim().is_empty() {
                Self::push_validation_error(&mut result, &path_text, format!("{}.labelKey is required", prefix));
            }
            if view.badge.as_deref().is_some_and(|badge| badge != "problems") {
                Self::push_validation_error(&mut result, &path_text, format!("{}.badge must be problems", prefix));
            }
        }

        for (index, server) in manifest.contributes.mcp_servers.iter().enumerate() {
            let prefix = format!("contributes.mcpServers[{}]", index);
            if server.id.trim().is_empty() {
                Self::push_validation_error(&mut result, &path_text, format!("{}.id is required", prefix));
            }
            if !VALID_TRANSPORTS.contains(&server.transport.as_str()) {
                Self::push_validation_error(&mut result, &path_text, format!("{}.transport has unsupported value: {}", prefix, server.transport));
            }
            if server.command.trim().is_empty() {
                Self::push_validation_error(&mut result, &path_text, format!("{}.command is required", prefix));
            }
        }

        result.valid = result.errors.is_empty();
        result
    }

    fn push_validation_error(
        result: &mut PluginManifestValidationResult,
        path: &str,
        error: impl Into<String>,
    ) {
        result.errors.push(PluginDiscoveryError {
            path: path.to_string(),
            error: error.into(),
        });
    }

    fn format_validation_errors(result: &PluginManifestValidationResult) -> String {
        let diagnostics = result
            .errors
            .iter()
            .map(|issue| format!("{}: {}", issue.path, issue.error))
            .collect::<Vec<_>>()
            .join("; ");
        format!("插件 manifest 校验失败: {}", diagnostics)
    }

    fn is_version_newer(latest: &str, current: &str) -> bool {
        let latest_parts = Self::version_parts(latest);
        let current_parts = Self::version_parts(current);
        for index in 0..latest_parts.len().max(current_parts.len()) {
            let latest_value = latest_parts.get(index).copied().unwrap_or(0);
            let current_value = current_parts.get(index).copied().unwrap_or(0);
            if latest_value != current_value {
                return latest_value > current_value;
            }
        }
        latest.trim() > current.trim()
    }

    fn version_parts(version: &str) -> Vec<u64> {
        version
            .split(|ch: char| !ch.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
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
    fn validates_plugin_manifest_schema() {
        let plugin = tempfile::tempdir().unwrap();
        std::fs::write(
            plugin.path().join("plugin.json"),
            r#"{
              "id": "example.demo-mcp",
              "name": "Demo MCP Plugin",
              "version": "0.1.0",
              "enabledByDefault": true,
              "contributes": {
                "views": [
                  {
                    "id": "example.demo-mcp.panel",
                    "area": "activityBar",
                    "panelType": "demoPlugin",
                    "icon": "Bot",
                    "labelKey": "plugins.demoMcpPanel",
                    "labelDefault": "Demo MCP",
                    "order": 85
                  }
                ],
                "mcpServers": [
                  {
                    "id": "example-demo-mcp",
                    "transport": "stdio",
                    "command": "node",
                    "argsTemplate": ["{{pluginDir}}/mcp/demo-mcp-server.js"]
                  }
                ]
              },
              "permissions": {
                "workspaceRead": true,
                "aiToolAccess": true
              }
            }"#,
        )
        .unwrap();

        let result = PluginService::validate_plugin_manifest(plugin.path());

        assert!(result.valid);
        assert_eq!(result.plugin_id.as_deref(), Some("example.demo-mcp"));
        assert!(result.errors.is_empty());
    }

    #[test]
    fn rejects_invalid_manifest_schema_before_install() {
        let app_config = tempfile::tempdir().unwrap();
        let plugin = tempfile::tempdir().unwrap();
        std::fs::write(
            plugin.path().join("plugin.json"),
            r#"{
              "id": "example.invalid",
              "name": "Invalid Plugin",
              "version": "0.1.0",
              "contributes": {
                "views": [
                  {
                    "id": "bad-view",
                    "area": "activityBar",
                    "panelType": "unknown",
                    "icon": "Bot",
                    "labelKey": "bad:view",
                    "order": 1
                  }
                ],
                "mcpServers": [
                  {
                    "id": "bad-server",
                    "transport": "websocket",
                    "command": "bad-server"
                  }
                ]
              }
            }"#,
        )
        .unwrap();

        let validation = PluginService::validate_plugin_manifest(plugin.path());
        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|issue| issue.error.contains("contributes.views[0].panelType")));
        assert!(validation
            .errors
            .iter()
            .any(|issue| issue.error.contains("contributes.mcpServers[0].transport")));

        let installed = PluginService::install_local_plugin(
            app_config.path(),
            None,
            plugin.path(),
            PluginManifestSourceKind::User,
        )
        .unwrap();
        assert!(!installed.success);
        assert!(installed
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("插件 manifest 校验失败"));
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

    #[tokio::test]
    async fn checks_local_plugin_update_manifest() {
        let plugin = tempfile::tempdir().unwrap();
        let latest = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            latest.path(),
            r#"{
              "id": "example.update",
              "name": "Example Update",
              "version": "0.2.0"
            }"#,
        )
        .unwrap();
        std::fs::write(
            plugin.path().join("plugin.json"),
            format!(
                r#"{{
                  "id": "example.update",
                  "name": "Example Update",
                  "version": "0.1.0",
                  "origin": {{
                    "repository": "https://example.test/example.update",
                    "updateUrl": "{}"
                  }}
                }}"#,
                latest.path().to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();

        let result = PluginService::check_local_plugin_update(plugin.path()).await;

        assert!(result.checked);
        assert!(result.update_available);
        assert_eq!(result.plugin_id, "example.update");
        assert_eq!(result.current_version, "0.1.0");
        assert_eq!(result.latest_version.as_deref(), Some("0.2.0"));
    }

    #[tokio::test]
    async fn applies_local_plugin_update_from_download_url() {
        let app_config = tempfile::tempdir().unwrap();
        let installed = app_config.path().join("plugins").join("example.update");
        std::fs::create_dir_all(&installed).unwrap();
        let package = tempfile::tempdir().unwrap();
        std::fs::write(
            package.path().join("plugin.json"),
            r#"{
              "id": "example.update",
              "name": "Example Update",
              "version": "0.2.0"
            }"#,
        )
        .unwrap();
        let latest = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            latest.path(),
            format!(
                r#"{{
                  "id": "example.update",
                  "name": "Example Update",
                  "version": "0.2.0",
                  "origin": {{
                    "downloadUrl": "{}"
                  }}
                }}"#,
                package.path().to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        std::fs::write(
            installed.join("plugin.json"),
            format!(
                r#"{{
                  "id": "example.update",
                  "name": "Example Update",
                  "version": "0.1.0",
                  "origin": {{
                    "updateUrl": "{}"
                  }}
                }}"#,
                latest.path().to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();

        let result = PluginService::apply_local_plugin_update(app_config.path(), None, &installed)
            .await
            .unwrap();

        assert!(result.success);
        let manifest = PluginService::read_manifest(&installed.join("plugin.json")).unwrap();
        assert_eq!(manifest.version, "0.2.0");
    }

    #[test]
    fn refuses_to_uninstall_outside_plugin_roots() {
        let app_config = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        let result = PluginService::uninstall_local_plugin(app_config.path(), None, outside.path());

        assert!(result.is_err());
    }
}
