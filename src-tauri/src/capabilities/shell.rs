/*! Shell Capability Seam
 *
 * 定义 shell 命令执行的核心操作，不依赖具体实现（本地/远程/沙箱）。
 *
 * 参考设计：deepseek-harness `dsh-subprocess` + `dsh-shell` + `dsh-bash-local`
 * 的 Service Definition / Provider / Consumer 三层分离。
 *
 * 默认 Provider：`DefaultShellProvider`（从 SimpleAI `run_bash()` 迁移）。
 * 插件可通过 toolProvider 覆盖（capability: "shell"）。
 */

use std::collections::HashMap;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// shell 能力抽象 trait
#[async_trait]
pub trait ShellCapability: Send + Sync {
    /// 执行 shell 命令，返回 stdout/stderr/exit_code
    async fn execute(
        &self,
        command: &str,
        workdir: Option<&str>,
        env: Option<&HashMap<String, String>>,
    ) -> Result<ShellResult>;

    /// 返回当前 shell 类型描述（用于模型上下文注入）
    fn shell_type(&self) -> ShellType;
}

/// shell 执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// shell 类型描述
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ShellType {
    GitBash { path: String },
    PowerShell,
    Cmd,
    Sh,
    Custom(String),
}

impl ShellType {
    /// 简短描述（用于模型上下文注入）
    pub fn description(&self) -> String {
        match self {
            ShellType::GitBash { path } => format!("Git Bash ({})", path),
            ShellType::PowerShell => "PowerShell".to_string(),
            ShellType::Cmd => "cmd.exe".to_string(),
            ShellType::Sh => "sh".to_string(),
            ShellType::Custom(name) => name.clone(),
        }
    }
}
