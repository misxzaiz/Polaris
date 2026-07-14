//! CLI 信息服务
//!
//! 封装 Claude CLI 的信息查询命令 (agents, auth status, version, check installed)

use std::path::Path;
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

        let output = cmd
            .output()
            .map_err(|e| AppError::ProcessError(format!("执行 Claude CLI 失败: {}", e)))?;

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
        let auth: CliAuthStatus = serde_json::from_str(&output)
            .map_err(|e| AppError::ParseError(format!("解析认证状态失败: {}", e)))?;
        Ok(auth)
    }

    /// 获取 CLI 版本
    ///
    /// 调用 `claude --version`
    pub fn get_version(&self) -> Result<String> {
        let output = self.execute_claude(&["--version"])?;
        Ok(output.trim().to_string())
    }

    /// 运行 ultrareview 云端多 agent 代码审查
    ///
    /// 在指定工作区目录下执行
    /// `claude ultrareview [target] --timeout <mins> [--json]`。
    /// `target` 为空时审查当前分支，也可传 PR 号或 base 分支名。
    ///
    /// 注意：云端审查可能耗时数分钟至数十分钟。本方法为同步阻塞调用，
    /// 调用方（Tauri 命令）应放入 `tokio::task::spawn_blocking` 执行，
    /// 避免阻塞 async runtime。CLI 自带 `--timeout` 会在超时后自行退出，
    /// 无需在 Rust 侧额外计时。
    pub fn run_ultrareview(
        &self,
        workspace_dir: &str,
        target: Option<&str>,
        timeout_mins: u32,
        json: bool,
    ) -> Result<String> {
        let mut cmd = self.build_command();
        // ultrareview 审查的是"当前仓库/分支"，必须在工作区目录下执行
        cmd.current_dir(workspace_dir);
        cmd.arg("ultrareview");
        if let Some(t) = target {
            let t = t.trim();
            if !t.is_empty() {
                cmd.arg(t);
            }
        }
        cmd.arg("--timeout").arg(timeout_mins.to_string());
        if json {
            cmd.arg("--json");
        }

        let output = cmd
            .output()
            .map_err(|e| AppError::ProcessError(format!("执行 claude ultrareview 失败: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::ProcessError(format!(
                "claude ultrareview 执行失败: {}",
                stderr.trim()
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// 调用 Claude CLI 进行结构化提取（`--json-schema`）
    ///
    /// 以自然语言 `prompt` 为输入（经 **stdin** 传入，规避命令行长度限制），
    /// 用 `schema_json`（JSON Schema 字符串）约束模型输出结构，执行：
    /// `claude --print --output-format json --json-schema <schema-file> [--model <m>]`。
    ///
    /// 返回 CLI 的完整 stdout（`--output-format json` 的结果对象 JSON 字符串）。
    /// 结构化结果的解包（从结果包装中取出符合 schema 的对象）交由前端 service
    /// 层完成，以兼容不同 CLI 版本的结果包装结构。
    ///
    /// 注意：
    /// - `--json-schema` 接受 schema **文件路径**，故先将 schema 写入系统临时文件，
    ///   执行完成后清理；
    /// - 该命令会真实调用模型（需有效认证），耗时取决于模型响应，
    ///   调用方（Tauri 命令）应放入 `tokio::task::spawn_blocking` 执行。
    pub fn extract_structured(
        &self,
        prompt: &str,
        schema_json: &str,
        workspace_dir: Option<&str>,
        model: Option<&str>,
    ) -> Result<String> {
        use std::io::Write;
        use std::process::Stdio;

        if prompt.trim().is_empty() {
            return Err(AppError::ValidationError("提取内容不能为空".to_string()));
        }
        if schema_json.trim().is_empty() {
            return Err(AppError::ValidationError(
                "JSON Schema 不能为空".to_string(),
            ));
        }

        // `--json-schema` 接受文件路径：写入系统临时文件，执行后删除。
        // 用进程 ID + 纳秒时间戳生成唯一文件名，避免并发冲突。
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let schema_path = std::env::temp_dir().join(format!(
            "polaris-schema-{}-{}.json",
            std::process::id(),
            suffix
        ));
        std::fs::write(&schema_path, schema_json)
            .map_err(|e| AppError::ProcessError(format!("写入 JSON Schema 临时文件失败: {}", e)))?;

        let mut cmd = self.build_command();
        if let Some(dir) = workspace_dir {
            let dir = dir.trim();
            if !dir.is_empty() {
                cmd.current_dir(dir);
            }
        }
        cmd.arg("--print")
            .arg("--output-format")
            .arg("json")
            .arg("--json-schema")
            .arg(&schema_path);
        if let Some(m) = model {
            let m = m.trim();
            if !m.is_empty() {
                cmd.arg("--model").arg(m);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&schema_path);
                return Err(AppError::ProcessError(format!(
                    "执行 claude 结构化提取失败: {}",
                    e
                )));
            }
        };

        // 通过 stdin 写入 prompt，写完 drop 触发 EOF
        if let Some(mut stdin) = child.stdin.take() {
            let write_result = stdin.write_all(prompt.as_bytes());
            drop(stdin);
            if let Err(e) = write_result {
                let _ = child.kill();
                let _ = std::fs::remove_file(&schema_path);
                return Err(AppError::ProcessError(format!(
                    "向 claude 写入提取内容失败: {}",
                    e
                )));
            }
        }

        let wait_result = child.wait_with_output();
        // 无论成功与否都清理临时文件
        let _ = std::fs::remove_file(&schema_path);

        let output = wait_result.map_err(|e| {
            AppError::ProcessError(format!("等待 claude 结构化提取结果失败: {}", e))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::ProcessError(format!(
                "claude 结构化提取执行失败: {}",
                stderr.trim()
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

/// 检查指定 CLI 是否已安装
///
/// 使用 which/where 命令查找可执行文件路径
pub fn check_cli_installed(cli_name: &str) -> bool {
    // 首先检查是否为绝对路径
    if Path::new(cli_name).is_absolute() {
        return Path::new(cli_name).exists();
    }

    // 使用 which 查找可执行文件
    #[cfg(windows)]
    {
        // Windows 使用 where 命令
        let output = Command::new("where")
            .arg(cli_name)
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }

    #[cfg(not(windows))]
    {
        // Unix 使用 which 命令
        let output = Command::new("which").arg(cli_name).output();

        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }
}

/// 查找指定 CLI 的所有可用完整路径
///
/// 使用 which/where 命令解析 PATH 中的实际安装位置（绝对路径）。
/// 输入若已是存在的绝对路径则原样返回。
pub fn find_cli_paths(cli_name: &str) -> Vec<String> {
    if Path::new(cli_name).is_absolute() {
        return if Path::new(cli_name).exists() {
            vec![cli_name.to_string()]
        } else {
            Vec::new()
        };
    }

    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = Command::new(which_cmd);
    cmd.arg(cli_name);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = match cmd.output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut paths: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && Path::new(l).exists())
        .collect();

    // Windows: 优先可执行的扩展名（where 可能先输出无扩展名的 shell 脚本）
    #[cfg(windows)]
    paths.sort_by_key(|p| {
        let lower = p.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            0
        } else if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            1
        } else {
            2
        }
    });

    paths.dedup();
    paths
}

/// 获取指定 CLI 的版本
///
/// 通用版本获取函数，执行 `<cli_name> --version`。
/// Windows 下 .cmd/.bat 脚本（npm shim）无法被 CreateProcess 直接执行，
/// 自动解析真实路径并用 cmd /c 包装。
pub fn get_cli_version(cli_name: &str) -> Result<String> {
    #[cfg(windows)]
    let output = {
        // 解析为完整路径（处理 "mimo" → "...\npm\mimo.cmd" 的情况）
        let resolved = if Path::new(cli_name).is_absolute() {
            cli_name.to_string()
        } else {
            find_cli_paths(cli_name)
                .into_iter()
                .next()
                .unwrap_or_else(|| cli_name.to_string())
        };

        let lower = resolved.to_ascii_lowercase();
        let mut cmd = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(&resolved);
            c
        } else {
            Command::new(&resolved)
        };
        cmd.arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| {
                AppError::ProcessError(format!("执行 {} --version 失败: {}", cli_name, e))
            })?
    };

    #[cfg(not(windows))]
    let output = Command::new(cli_name)
        .arg("--version")
        .output()
        .map_err(|e| AppError::ProcessError(format!("执行 {} --version 失败: {}", cli_name, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::ProcessError(format!(
            "{} --version 执行失败: {}",
            cli_name,
            stderr.trim()
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

    let mut parts = id.split(':');
    let display = parts.next_back().unwrap_or(id);

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
        assert_eq!(
            format_agent_display_name("superpowers:code-reviewer"),
            "Code Reviewer"
        );
        assert_eq!(
            format_agent_display_name("general-purpose"),
            "General Purpose"
        );
        assert_eq!(format_agent_display_name("Explore"), "Explore");
    }

    #[test]
    fn test_parse_agent_line() {
        assert_eq!(
            parse_agent_line("pua:cto-p10 · opus"),
            Some(("pua:cto-p10".into(), "opus".into()))
        );
        assert_eq!(
            parse_agent_line("Explore · haiku"),
            Some(("Explore".into(), "haiku".into()))
        );
        assert_eq!(
            parse_agent_line("general-purpose · inherit"),
            Some(("general-purpose".into(), "inherit".into()))
        );
        assert_eq!(parse_agent_line(""), None);
        assert_eq!(parse_agent_line("8 active agents"), None);
    }
}
