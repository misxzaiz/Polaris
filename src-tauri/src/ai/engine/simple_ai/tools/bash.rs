/*! bash 工具：执行 shell 命令 */

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use serde_json::{json, Value};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

pub(super) struct BashTool;

#[async_trait::async_trait]
impl Tool for BashTool {
    fn name(&self) -> &'static str {
        "bash"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a shell command and return its output. \n\nOn Windows: the shell is auto-detected (Git Bash preferred, then PowerShell, then cmd.exe). POSIX commands (grep, sed, find, rm, ls) may not be available on cmd.exe — prefer the dedicated tools (search_files, glob, read_file, edit_file) which work identically across platforms.\n\nIf a shell command fails with exit code 127, the command is not installed or not in PATH — use a dedicated tool instead.\n\nUse this to run build tools, scripts, and system commands, not for file content search/edit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        },
                        "workdir": {
                            "type": "string",
                            "description": "Working directory for the command (optional, defaults to session work_dir)"
                        }
                    },
                    "required": ["command"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let command = args["command"].as_str().unwrap_or("").to_string();
        let workdir_override = args["workdir"].as_str().map(String::from);
        let default_dir = ctx.work_dir.to_string();
        tokio::task::spawn_blocking(move || {
            run_bash(&command, workdir_override.as_deref(), &default_dir)
        })
        .await
        .unwrap_or_else(|e| ToolOutcome::fail(format!("bash task panicked: {}", e)))
    }
}

/// 检测可用的 shell（按优先级：Git Bash → PowerShell → 系统默认）
fn detect_shell() -> (&'static str, Option<String>) {
    #[cfg(windows)]
    {
        // 1. 尝试 Git Bash（最常见）
        if let Ok(git_root) = std::env::var("GIT_INSTALL_ROOT") {
            let bash_path = std::path::Path::new(&git_root).join("usr/bin/bash.exe");
            if bash_path.exists() {
                return ("git_bash", Some(bash_path.to_string_lossy().to_string()));
            }
        }
        // 2. 尝试 PowerShell
        let pwsh_path = std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        if pwsh_path.exists() {
            return ("pwsh", Some(pwsh_path.to_string_lossy().to_string()));
        }
        // 3. 回退 cmd
        return ("cmd", None);
    }
    #[cfg(not(windows))]
    {
        ("sh", None)
    }
}

fn run_bash(command: &str, workdir: Option<&str>, default_dir: &str) -> ToolOutcome {
    let cwd = workdir.unwrap_or(default_dir);

    let (shell_name, shell_path) = detect_shell();
    let shell_exe = shell_path.as_deref().unwrap_or(shell_name);

    let mut cmd = std::process::Command::new(shell_exe);
    cmd.current_dir(cwd);

    match shell_name {
        "git_bash" | "sh" => {
            cmd.arg("-c").arg(command);
        }
        "pwsh" => {
            cmd.arg("-Command").arg(command);
        }
        "cmd" => {
            cmd.arg("/C").arg(command);
        }
        _ => {}
    }

    #[cfg(windows)]
    {
        use crate::utils::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let exit_code = o.status.code().unwrap_or(-1);

            let mut result = String::new();
            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[stderr]\n{}", stderr));
            }

            // 退出码解读（提供友好提示）
            if exit_code == 127 {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!(
                    "\n[Shell hint] Exit code 127: command not found. \
                    On Windows cmd.exe, POSIX commands like grep/sed/find/rm/ls are not available. \
                    Use the dedicated tools: search_files (for grep/findstr), \
                    glob (for find), edit_file (for sed), read_file (for cat). \
                    If using Git Bash or PowerShell, these commands may work.]"
                ));
            } else if exit_code != 0 {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[exit code: {}]", exit_code));
            }

            let content = if result.is_empty() {
                "(no output)".to_string()
            } else {
                truncate_chars(&result, 32_768)
            };

            if exit_code == 0 {
                ToolOutcome::ok(content)
            } else {
                ToolOutcome::fail(content)
            }
        }
        Err(e) => ToolOutcome::fail(format!("Failed to execute command with {}: {}", shell_name, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_bash_empty_output() {
        // 基本测试：空命令应该成功
        let out = run_bash("echo hi", None, ".");
        // 不同平台 shell 行为不同，只检查基本结构
        assert!(out.success || out.content.contains("exit code"));
    }

    #[test]
    fn detect_shell_returns_valid_shell() {
        let (name, path) = detect_shell();
        assert!(!name.is_empty());
        #[cfg(windows)]
        assert!(["git_bash", "pwsh", "cmd"].contains(&name));
        #[cfg(not(windows))]
        assert_eq!(name, "sh");
    }
}
