//! Plugin 服务
//!
//! 封装 Claude CLI 的 plugin 命令调用

use crate::error::{AppError, Result};
use crate::models::plugin::{
    Marketplace, PluginListResult, PluginOperationResult,
    PluginScope,
};
use crate::services::cli_resolver;

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
        let mut cmd = cli_resolver::build_cli_command(&self.claude_path)?;

        cmd.args(args);

        let output = cmd.output().map_err(|e| {
            AppError::ProcessError(format!("执行 Claude CLI 失败: {}", e))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::ProcessError(format!(
                "Claude CLI 执行失败: {}",
                stderr
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
            let result: PluginListResult = serde_json::from_str(&output).map_err(|e| {
                AppError::ProcessError(format!("解析插件列表失败: {}", e))
            })?;
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

        let marketplaces: Vec<Marketplace> =
            serde_json::from_str(&output).map_err(|e| {
                AppError::ProcessError(format!("解析市场列表失败: {}", e))
            })?;

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
}
