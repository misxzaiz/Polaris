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
                "description": "Execute a shell command and return its output. Use this to run scripts, install packages, check system state, etc.",
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
        // bash 可能长时阻塞（npm install / dev server），用 spawn_blocking 避免占用 tokio worker。
        tokio::task::spawn_blocking(move || {
            run_bash(&command, workdir_override.as_deref(), &default_dir)
        })
        .await
        .unwrap_or_else(|e| ToolOutcome::fail(format!("bash task panicked: {}", e)))
    }
}

fn run_bash(command: &str, workdir: Option<&str>, default_dir: &str) -> ToolOutcome {
    let cwd = workdir.unwrap_or(default_dir);

    let shell;
    let flag;
    #[cfg(windows)]
    {
        shell = "cmd";
        flag = "/C";
    }
    #[cfg(not(windows))]
    {
        shell = "sh";
        flag = "-c";
    }

    let mut cmd = std::process::Command::new(shell);
    cmd.args([flag, command])
        .current_dir(cwd);

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
            if exit_code != 0 {
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
            // exit code 非 0 视为失败，但 content 仍含完整输出，供模型据此自我纠正。
            if exit_code == 0 {
                ToolOutcome::ok(content)
            } else {
                ToolOutcome::fail(content)
            }
        }
        Err(e) => ToolOutcome::fail(format!("Failed to execute command: {}", e)),
    }
}
