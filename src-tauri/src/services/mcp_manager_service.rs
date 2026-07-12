//! MCP 管理器服务
//!
//! 提供对 Claude MCP 服务器的配置聚合与健康检查能力。
//! 读取多个来源的 MCP 配置文件（全局、用户、项目），并通过
//! `claude mcp list` / `claude mcp get` 获取运行时状态。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

// ============================================================================
// 类型定义
// ============================================================================

/// MCP 服务器传输协议
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    /// 标准输入/输出（stdio）
    Stdio,
    /// HTTP / SSE 远程传输
    Http,
}

impl std::fmt::Display for McpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpTransport::Stdio => write!(f, "stdio"),
            McpTransport::Http => write!(f, "http"),
        }
    }
}

/// MCP 配置作用域
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum McpScope {
    /// 全局配置 (~/.claude/settings.json)
    Global,
    /// 项目级配置 (.mcp.json)
    Project,
    /// 用户级配置 (.claude/settings.json / .claude/settings.local.json)
    User,
}

impl std::fmt::Display for McpScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpScope::Global => write!(f, "Global"),
            McpScope::Project => write!(f, "Project"),
            McpScope::User => write!(f, "User"),
        }
    }
}

/// 从配置文件中解析出的单个 MCP 服务器信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    /// 服务器名称
    pub name: String,
    /// 启动命令 (stdio) 或 URL (http)
    pub command: Option<String>,
    /// 命令参数
    pub args: Vec<String>,
    /// 传输协议
    pub transport: McpTransport,
    /// 配置来源作用域
    pub scope: McpScope,
    /// 环境变量
    pub env: HashMap<String, String>,
}

/// MCP 服务器健康状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthStatus {
    /// 服务器名称
    pub name: String,
    /// 是否已连接
    pub connected: bool,
    /// 状态文本（如 "Connected"、"Needs authentication"、"Error: ..."）
    pub status: String,
    /// 传输协议
    pub transport: Option<McpTransport>,
    /// 启动命令
    pub command: Option<String>,
}

/// 聚合了配置信息和健康状态的完整服务器视图
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerAggregate {
    /// 服务器名称
    pub name: String,
    /// 配置来源列表（可能出现在多个配置文件中）
    pub configs: Vec<McpServerInfo>,
    /// 运行时健康状态（如果已检查）
    pub health: Option<McpHealthStatus>,
}

// ============================================================================
// 服务
// ============================================================================

/// MCP 管理器服务
pub struct McpManagerService {
    /// Claude CLI 可执行路径
    claude_path: String,
}

impl McpManagerService {
    /// 创建新的 MCP 管理器服务
    pub fn new(claude_path: String) -> Self {
        Self { claude_path }
    }

    // ----------------------------------------------------------------
    // CLI 执行
    // ----------------------------------------------------------------

    /// 执行 Claude CLI 命令并获取标准输出
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

    /// 构建命令 (Windows)
    #[cfg(windows)]
    fn build_command(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.claude_path);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// 构建命令 (非 Windows)
    #[cfg(not(windows))]
    fn build_command(&self) -> std::process::Command {
        std::process::Command::new(&self.claude_path)
    }

    // ----------------------------------------------------------------
    // 配置读取
    // ----------------------------------------------------------------

    /// 列出所有需要检查的 MCP 配置文件路径及其对应作用域
    ///
    /// 返回 (路径, 作用域, 配置键名提示) 列表
    fn list_config_paths(workspace_path: &str) -> Vec<(PathBuf, McpScope)> {
        let mut paths = Vec::new();

        // 1. ~/.claude/settings.json (全局)
        if let Some(home) = dirs::home_dir() {
            let settings = home.join(".claude").join("settings.json");
            paths.push((settings, McpScope::Global));
        }

        // 2. <workspace>/.mcp.json (项目级)
        if !workspace_path.is_empty() {
            let project_mcp = PathBuf::from(workspace_path).join(".mcp.json");
            paths.push((project_mcp, McpScope::Project));
        }

        // 3. <workspace>/.claude/settings.json (用户/项目)
        if !workspace_path.is_empty() {
            let project_settings = PathBuf::from(workspace_path).join(".claude").join("settings.json");
            paths.push((project_settings, McpScope::User));
        }

        // 4. <workspace>/.claude/settings.local.json (用户/项目本地)
        if !workspace_path.is_empty() {
            let project_local = PathBuf::from(workspace_path).join(".claude").join("settings.local.json");
            paths.push((project_local, McpScope::User));
        }

        paths
    }

    /// 从所有配置文件中读取 MCP 服务器配置
    pub fn list_configs(&self, workspace_path: &str) -> Vec<McpServerInfo> {
        let mut servers = Vec::new();
        let paths = Self::list_config_paths(workspace_path);

        for (path, scope) in paths {
            if !path.exists() {
                continue;
            }

            match Self::read_mcp_config(&path, &scope) {
                Ok(mut list) => servers.append(&mut list),
                Err(e) => {
                    tracing::warn!(
                        "[McpManager] 读取配置文件失败 {}: {}",
                        path.display(),
                        e.to_message()
                    );
                }
            }
        }

        servers
    }

    /// 解析单个配置文件中的 MCP 服务器列表
    fn read_mcp_config(path: &PathBuf, scope: &McpScope) -> Result<Vec<McpServerInfo>> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            AppError::IoError(e)
        })?;

        let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
            AppError::ParseError(format!("解析 {} 失败: {}", path.display(), e))
        })?;

        // 尝试 "mcpServers" 或 "mcp_servers" 键
        let mcp_value = json
            .get("mcpServers")
            .or_else(|| json.get("mcp_servers"));

        let mcp_obj = match mcp_value {
            Some(serde_json::Value::Object(map)) => map,
            _ => return Ok(Vec::new()),
        };

        let mut servers = Vec::new();

        for (name, value) in mcp_obj {
            if let Some(info) = Self::parse_server_config(name, value, scope) {
                servers.push(info);
            }
        }

        Ok(servers)
    }

    /// 解析单个服务器配置条目
    fn parse_server_config(
        name: &str,
        value: &serde_json::Value,
        scope: &McpScope,
    ) -> Option<McpServerInfo> {
        let obj = value.as_object()?;

        // 判断传输协议
        let (transport, command) = if let Some(url) = obj.get("url").and_then(|v| v.as_str()) {
            (McpTransport::Http, Some(url.to_string()))
        } else if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            (McpTransport::Stdio, Some(cmd.to_string()))
        } else {
            (McpTransport::Stdio, None)
        };

        let args = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let env = obj
            .get("env")
            .and_then(|v| v.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        Some(McpServerInfo {
            name: name.to_string(),
            command,
            args,
            transport,
            scope: scope.clone(),
            env,
        })
    }

    // ----------------------------------------------------------------
    // 健康检查
    // ----------------------------------------------------------------

    /// 调用 `claude mcp list` 获取所有服务器的运行时状态
    pub fn health_check(&self) -> Result<Vec<McpHealthStatus>> {
        let output = self.execute_claude(&["mcp", "list"])?;
        Ok(Self::parse_mcp_list_output(&output))
    }

    /// 调用 `claude mcp get <name>` 获取单个服务器的运行时状态
    pub fn health_check_one(&self, name: &str) -> Result<McpHealthStatus> {
        let output = self.execute_claude(&["mcp", "get", name])?;
        Self::parse_mcp_get_output(name, &output)
    }

    /// 解析 `claude mcp list` 的文本输出
    ///
    /// 输出格式示例:
    /// ```text
    /// chrome-devtools: cmd /c npx @anthropic-ai/chrome-devtools-mcp@latest - ✓ Connected
    /// plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
    /// polaris-todo: /path/to/polaris-todo-mcp /config /workspace - ✓ Connected
    /// ```
    fn parse_mcp_list_output(output: &str) -> Vec<McpHealthStatus> {
        let mut statuses = Vec::new();

        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // 格式: <name>: <command_or_url> [(<transport>)] - <status_indicator> <status_text>
            // 分割符 " - " 分离左侧信息和右侧状态
            if let Some((left, status_part)) = trimmed.rsplit_once(" - ") {
                let status_part = status_part.trim();

                // 解析状态
                let (connected, status) = if status_part.starts_with("✓") {
                    (true, status_part.trim_start_matches("✓").trim().to_string())
                } else if status_part.starts_with("!") {
                    (false, status_part.trim_start_matches("!").trim().to_string())
                } else if status_part.starts_with("✗") {
                    (false, status_part.trim_start_matches("✗").trim().to_string())
                } else {
                    (false, status_part.to_string())
                };

                // 如果状态文本为空，填充默认值
                let status = if status.is_empty() {
                    if connected {
                        "Connected".to_string()
                    } else {
                        "Unknown".to_string()
                    }
                } else {
                    status
                };

                // 解析左侧: <name>: <command_info> [(<transport>)]
                if let Some((name, command_info)) = left.split_once(": ") {
                    let name = name.trim().to_string();
                    let command_info = command_info.trim();

                    // 检测传输协议标记
                    let (command, transport) = if command_info.ends_with("(HTTP)") {
                        (
                            Some(command_info.trim_end_matches("(HTTP)").trim().to_string()),
                            Some(McpTransport::Http),
                        )
                    } else if command_info.ends_with("(SSE)") {
                        (
                            Some(command_info.trim_end_matches("(SSE)").trim().to_string()),
                            Some(McpTransport::Http),
                        )
                    } else if command_info.ends_with("(stdio)") {
                        (
                            Some(command_info.trim_end_matches("(stdio)").trim().to_string()),
                            Some(McpTransport::Stdio),
                        )
                    } else {
                        (Some(command_info.to_string()), None)
                    };

                    statuses.push(McpHealthStatus {
                        name,
                        connected,
                        status,
                        transport,
                        command,
                    });
                }
            }
        }

        statuses
    }

    /// 解析 `claude mcp get <name>` 的多行输出
    ///
    /// 输出格式示例:
    /// ```text
    /// polaris-todo
    ///   Command: /path/to/polaris-todo-mcp arg1 arg2
    ///   Status: ✓ Connected
    /// ```
    fn parse_mcp_get_output(name: &str, output: &str) -> Result<McpHealthStatus> {
        let mut command: Option<String> = None;
        let mut connected = false;
        let mut status = String::from("Unknown");
        let mut transport: Option<McpTransport> = None;

        for line in output.lines() {
            let trimmed = line.trim();

            if let Some(cmd_val) = trimmed.strip_prefix("Command:") {
                command = Some(cmd_val.trim().to_string());
            } else if let Some(url_val) = trimmed.strip_prefix("URL:") {
                command = Some(url_val.trim().to_string());
                transport = Some(McpTransport::Http);
            } else if let Some(status_val) = trimmed.strip_prefix("Status:") {
                let status_val = status_val.trim();
                if status_val.starts_with("✓") {
                    connected = true;
                    let text = status_val.trim_start_matches("✓").trim();
                    status = if text.is_empty() {
                        "Connected".to_string()
                    } else {
                        text.to_string()
                    };
                } else if status_val.starts_with("!") {
                    connected = false;
                    let text = status_val.trim_start_matches("!").trim();
                    status = if text.is_empty() {
                        "Unknown".to_string()
                    } else {
                        text.to_string()
                    };
                } else if status_val.starts_with("✗") {
                    connected = false;
                    let text = status_val.trim_start_matches("✗").trim();
                    status = if text.is_empty() {
                        "Error".to_string()
                    } else {
                        text.to_string()
                    };
                } else {
                    status = status_val.to_string();
                }
            } else if let Some(t_val) = trimmed.strip_prefix("Transport:") {
                let t_str = t_val.trim().to_lowercase();
                transport = if t_str.contains("http") || t_str.contains("sse") {
                    Some(McpTransport::Http)
                } else {
                    Some(McpTransport::Stdio)
                };
            }
        }

        Ok(McpHealthStatus {
            name: name.to_string(),
            connected,
            status,
            transport,
            command,
        })
    }

    // ----------------------------------------------------------------
    // 聚合接口
    // ----------------------------------------------------------------

    /// 列出所有 MCP 服务器（聚合配置 + 健康状态）
    pub fn list_servers(&self, workspace_path: &str) -> Result<Vec<McpServerAggregate>> {
        let configs = self.list_configs(workspace_path);

        // 按名称聚合配置
        let mut config_map: HashMap<String, Vec<McpServerInfo>> = HashMap::new();
        for cfg in configs {
            config_map
                .entry(cfg.name.clone())
                .or_default()
                .push(cfg);
        }

        // 获取健康状态
        let health_list = self.health_check().unwrap_or_default();
        let mut health_map: HashMap<String, McpHealthStatus> = HashMap::new();
        for h in health_list {
            health_map.insert(h.name.clone(), h);
        }

        // 合并：配置中有但健康检查中没有的服务器也要列出
        let mut all_names: Vec<String> = config_map.keys().cloned().collect();
        for name in health_map.keys() {
            if !all_names.contains(name) {
                all_names.push(name.clone());
            }
        }
        all_names.sort();

        let aggregates = all_names
            .into_iter()
            .map(|name| {
                let configs = config_map.remove(&name).unwrap_or_default();
                let health = health_map.remove(&name);
                McpServerAggregate {
                    name,
                    configs,
                    health,
                }
            })
            .collect();

        Ok(aggregates)
    }

    /// 获取单个 MCP 服务器的聚合信息
    pub fn get_server(&self, name: &str, workspace_path: &str) -> Result<McpServerAggregate> {
        let configs = self.list_configs(workspace_path);
        let filtered: Vec<McpServerInfo> = configs
            .into_iter()
            .filter(|c| c.name == name)
            .collect();

        let health = self.health_check_one(name).ok();

        Ok(McpServerAggregate {
            name: name.to_string(),
            configs: filtered,
            health,
        })
    }

    // ----------------------------------------------------------------
    // 写操作（通过 Claude CLI）
    // ----------------------------------------------------------------

    /// 添加 MCP 服务器
    ///
    /// 通过 `claude mcp add` 命令添加服务器
    pub fn add_server(&self, name: &str, command: &str, args: &[String], transport: &str, scope: &str) -> Result<()> {
        let mut cmd_args = vec![
            "mcp".to_string(),
            "add".to_string(),
        ];

        // 传输类型
        if transport != "stdio" {
            cmd_args.push("--transport".to_string());
            cmd_args.push(transport.to_string());
        }

        // scope
        if scope != "local" {
            cmd_args.push("--scope".to_string());
            cmd_args.push(scope.to_string());
        }

        cmd_args.push(name.to_string());
        cmd_args.push(command.to_string());

        // 参数分隔符
        if !args.is_empty() {
            cmd_args.push("--".to_string());
            for arg in args {
                cmd_args.push(arg.clone());
            }
        }

        let output = self.execute_claude(&cmd_args.iter().map(|s| s.as_str()).collect::<Vec<_>>())?;
        tracing::info!("[McpManager] 添加 MCP 服务器 {}: {}", name, output.trim());
        Ok(())
    }

    /// 移除 MCP 服务器
    ///
    /// 通过 `claude mcp remove` 命令移除服务器
    pub fn remove_server(&self, name: &str, scope: Option<&str>) -> Result<()> {
        let mut cmd_args = vec!["mcp", "remove"];

        if let Some(s) = scope {
            cmd_args.push("--scope");
            cmd_args.push(s);
        }

        cmd_args.push(name);

        let output = self.execute_claude(&cmd_args)?;
        tracing::info!("[McpManager] 移除 MCP 服务器 {}: {}", name, output.trim());
        Ok(())
    }

    /// 启动 OAuth 认证流程
    ///
    /// 对于需要认证的 HTTP 服务器，调用 `claude mcp add` 重新触发认证
    pub fn start_auth(&self, name: &str, url: &str, scope: &str) -> Result<()> {
        let cmd_args = vec![
            "mcp", "add",
            "--transport", "http",
            "--scope", scope,
            name, url,
        ];

        let output = self.execute_claude(&cmd_args)?;
        tracing::info!("[McpManager] 启动 MCP 认证 {}: {}", name, output.trim());
        Ok(())
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_mcp_list_output_connected() {
        let output = r#"chrome-devtools: cmd /c npx @anthropic-ai/chrome-devtools-mcp@latest - ✓ Connected
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication"#;
        let statuses = McpManagerService::parse_mcp_list_output(output);
        assert_eq!(statuses.len(), 2);

        // chrome-devtools
        assert_eq!(statuses[0].name, "chrome-devtools");
        assert!(statuses[0].connected);
        assert_eq!(statuses[0].status, "Connected");
        assert_eq!(statuses[0].transport, None); // 无标记时为 None
        assert!(statuses[0].command.is_some());

        // figma
        assert_eq!(statuses[1].name, "plugin:figma:figma");
        assert!(!statuses[1].connected);
        assert_eq!(statuses[1].status, "Needs authentication");
        assert_eq!(statuses[1].transport, Some(McpTransport::Http));
    }

    #[test]
    fn test_parse_mcp_list_output_empty() {
        let output = "";
        let statuses = McpManagerService::parse_mcp_list_output(output);
        assert!(statuses.is_empty());
    }

    #[test]
    fn test_parse_mcp_get_output_connected() {
        let output = r#"polaris-todo
  Command: /path/to/polaris-todo-mcp /config /workspace
  Status: ✓ Connected"#;
        let status = McpManagerService::parse_mcp_get_output("polaris-todo", output).unwrap();
        assert_eq!(status.name, "polaris-todo");
        assert!(status.connected);
        assert_eq!(status.status, "Connected");
        assert_eq!(status.command, Some("/path/to/polaris-todo-mcp /config /workspace".to_string()));
    }

    #[test]
    fn test_parse_mcp_get_output_needs_auth() {
        let output = r#"plugin:figma:figma
  URL: https://mcp.figma.com/mcp
  Transport: http
  Status: ! Needs authentication"#;
        let status = McpManagerService::parse_mcp_get_output("plugin:figma:figma", output).unwrap();
        assert_eq!(status.name, "plugin:figma:figma");
        assert!(!status.connected);
        assert_eq!(status.status, "Needs authentication");
        assert_eq!(status.transport, Some(McpTransport::Http));
    }

    #[test]
    fn test_parse_server_config_stdio() {
        let value = serde_json::json!({
            "command": "npx",
            "args": ["-y", "@some/mcp-server"],
            "env": {
                "API_KEY": "test123"
            }
        });
        let info = McpManagerService::parse_server_config("test-server", &value, &McpScope::Global).unwrap();
        assert_eq!(info.name, "test-server");
        assert_eq!(info.command, Some("npx".to_string()));
        assert_eq!(info.args, vec!["-y", "@some/mcp-server"]);
        assert_eq!(info.transport, McpTransport::Stdio);
        assert_eq!(info.scope, McpScope::Global);
        assert_eq!(info.env.get("API_KEY").unwrap(), "test123");
    }

    #[test]
    fn test_parse_server_config_http() {
        let value = serde_json::json!({
            "url": "https://mcp.example.com/mcp"
        });
        let info = McpManagerService::parse_server_config("remote-server", &value, &McpScope::Project).unwrap();
        assert_eq!(info.name, "remote-server");
        assert_eq!(info.command, Some("https://mcp.example.com/mcp".to_string()));
        assert_eq!(info.transport, McpTransport::Http);
        assert_eq!(info.scope, McpScope::Project);
    }

    #[test]
    fn test_parse_server_config_invalid() {
        let value = serde_json::json!("not an object");
        let result = McpManagerService::parse_server_config("bad", &value, &McpScope::Global);
        assert!(result.is_none());
    }
}
