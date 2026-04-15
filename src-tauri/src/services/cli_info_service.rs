//! CLI 信息服务
//!
//! 封装 Claude CLI 的信息查询命令 (agents, auth status, version)

use std::process::Command;

use crate::error::{AppError, Result};
use crate::models::cli_info::{CliAgentInfo, CliAuthStatus};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// CLI 信息服务
pub struct CliInfoService {
    /// Claude CLI 路径
    claude_path: String,
}

impl CliInfoService {
    /// 创建新的 CLI 信息服务
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
                stderr.trim()
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

    /// 获取 Agent 列表
    ///
    /// 调用 `claude agents` 并解析文本输出
    pub fn get_agents(&self) -> Result<Vec<CliAgentInfo>> {
        let output = self.execute_claude(&["agents"])?;
        Ok(parse_agents_output(&output))
    }

    /// 获取认证状态
    ///
    /// 调用 `claude auth status` 并解析 JSON 输出
    pub fn get_auth_status(&self) -> Result<CliAuthStatus> {
        let output = self.execute_claude(&["auth", "status"])?;
        let auth: CliAuthStatus = serde_json::from_str(&output).map_err(|e| {
            AppError::ParseError(format!("解析认证状态失败: {}", e))
        })?;
        Ok(auth)
    }

    /// 获取 CLI 版本
    ///
    /// 调用 `claude --version`
    pub fn get_version(&self) -> Result<String> {
        let output = self.execute_claude(&["--version"])?;
        Ok(output.trim().to_string())
    }
}

/// 解析 `claude agents` 的文本输出
///
/// 输入格式:
/// ```text
/// 8 active agents
///
/// Plugin agents:
///   pua:cto-p10 · opus
///   pua:senior-engineer-p7 · inherit
///
/// Built-in agents:
///   Explore · haiku
///   general-purpose · inherit
/// ```
fn parse_agents_output(output: &str) -> Vec<CliAgentInfo> {
    let mut agents = Vec::new();
    let mut source = "builtin".to_string();

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.contains("Plugin agents:") {
            source = "plugin".to_string();
            continue;
        }
        if trimmed.contains("Built-in agents:") {
            source = "builtin".to_string();
            continue;
        }

        // 匹配: "  agent-name · model"
        if let Some((name, model)) = parse_agent_line(trimmed) {
            agents.push(CliAgentInfo {
                name: format_agent_display_name(&name),
                id: name,
                source: source.clone(),
                default_model: if model == "inherit" {
                    None
                } else {
                    Some(model)
                },
            });
        }
    }

    agents
}

/// 解析单行 Agent 信息
fn parse_agent_line(line: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = line.split("·").collect();
    if parts.len() == 2 {
        let name = parts[0].trim().to_string();
        let model = parts[1].trim().to_string();
        if !name.is_empty() && !model.is_empty() {
            return Some((name, model));
        }
    }
    None
}

/// 格式化 Agent 显示名称
fn format_agent_display_name(id: &str) -> String {
    // 尝试从 ID 中提取可读名称
    // pua:cto-p10 → "CTO P10"
    // superpowers:code-reviewer → "Code Reviewer"
    // general-purpose → "General Purpose"
    // Explore → "Explore"

    let display = id
        .split(':')
        .last()
        .unwrap_or(id);

    display
        .split('-')
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_agents_output() {
        let output = r#"8 active agents

Plugin agents:
  pua:cto-p10 · opus
  pua:senior-engineer-p7 · inherit
  pua:tech-lead-p9 · inherit
  superpowers:code-reviewer · inherit

Built-in agents:
  Explore · haiku
  general-purpose · inherit
  Plan · inherit
  statusline-setup · sonnet
"#;
        let agents = parse_agents_output(output);
        assert_eq!(agents.len(), 8);

        // 验证 Plugin agents
        let plugin_agents: Vec<_> = agents.iter().filter(|a| a.source == "plugin").collect();
        assert_eq!(plugin_agents.len(), 4);
        assert_eq!(plugin_agents[0].id, "pua:cto-p10");
        assert_eq!(plugin_agents[0].default_model, Some("opus".to_string()));

        // 验证 Built-in agents
        let builtin_agents: Vec<_> = agents.iter().filter(|a| a.source == "builtin").collect();
        assert_eq!(builtin_agents.len(), 4);
        assert_eq!(builtin_agents[0].id, "Explore");
        assert_eq!(builtin_agents[0].default_model, Some("haiku".to_string()));

        // inherit 应该是 None
        assert_eq!(builtin_agents[1].id, "general-purpose");
        assert_eq!(builtin_agents[1].default_model, None);
    }

    #[test]
    fn test_format_agent_display_name() {
        assert_eq!(format_agent_display_name("pua:cto-p10"), "Cto P10");
        assert_eq!(format_agent_display_name("superpowers:code-reviewer"), "Code Reviewer");
        assert_eq!(format_agent_display_name("general-purpose"), "General Purpose");
        assert_eq!(format_agent_display_name("Explore"), "Explore");
    }

    #[test]
    fn test_parse_agent_line() {
        assert_eq!(parse_agent_line("pua:cto-p10 · opus"), Some(("pua:cto-p10".into(), "opus".into())));
        assert_eq!(parse_agent_line("Explore · haiku"), Some(("Explore".into(), "haiku".into())));
        assert_eq!(parse_agent_line("general-purpose · inherit"), Some(("general-purpose".into(), "inherit".into())));
        assert_eq!(parse_agent_line(""), None);
        assert_eq!(parse_agent_line("8 active agents"), None);
    }
}
