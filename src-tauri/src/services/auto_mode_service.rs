//! Auto-Mode 服务
//!
//! 封装 Claude CLI 的 auto-mode 命令调用

use std::process::Command;

use crate::error::{AppError, Result};
use crate::models::auto_mode::{AutoModeConfig, AutoModeDefaults};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// Auto-Mode 服务
pub struct AutoModeService {
    /// Claude CLI 路径
    claude_path: String,
}

impl AutoModeService {
    /// 创建新的 Auto-Mode 服务
    pub fn new(claude_path: String) -> Self {
        Self { claude_path }
    }

    /// 执行 Claude CLI 命令并获取输出
    fn execute_claude(&self, args: &[&str]) -> Result<String> {
        let mut cmd = self.build_command();
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

    /// 获取当前配置
    ///
    /// 调用 `claude auto-mode config`
    pub fn get_config(&self) -> Result<AutoModeConfig> {
        let output = self.execute_claude(&["auto-mode", "config"])?;

        let config: AutoModeConfig = serde_json::from_str(&output).map_err(|e| {
            AppError::ProcessError(format!("解析自动模式配置失败: {}", e))
        })?;

        Ok(config)
    }

    /// 获取默认配置
    ///
    /// 调用 `claude auto-mode defaults`
    pub fn get_defaults(&self) -> Result<AutoModeDefaults> {
        let output = self.execute_claude(&["auto-mode", "defaults"])?;

        let defaults: AutoModeDefaults = serde_json::from_str(&output).map_err(|e| {
            AppError::ProcessError(format!("解析默认配置失败: {}", e))
        })?;

        Ok(defaults)
    }
}
