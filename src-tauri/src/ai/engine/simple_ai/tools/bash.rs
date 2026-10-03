/*! bash 工具：cap.bash 直通代理
 *
 * SimpleAI 的 bash 工具不再自带 shell 执行逻辑（原 500 行 spawn/超时/编码/127 提示
 * 已全部收敛到宿主级 `cap.bash`（services/router/bash_capability.rs），此处只做薄封装：
 *
 * - 同步模式（默认）：`cap.bash run (async=false)` → 宿主等待完成 → 返回含全量输出与
 *   退出码的结果（cap.bash 同步 run 已附带 output/exitCode），语义与旧 bash 工具一致。
 * - 异步模式（async=true）：`cap.bash run (async=true)` → 立即返回 taskId，任务归宿主
 *   后台运行、不随会话结束而终止；结果可在后续轮询 cap.bash status/log/wait/kill。
 *
 * 收益：单一 shell 执行实现（cap.bash）、天然获得后台任务/会话解耦、跨会话可查。
 */

use serde_json::{json, Value};

use crate::contracts::Capability as _;
use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

/// BashTool：cap.bash 直通代理
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
                "description": "Execute a shell command and return its output. Backed by the host-level cap.bash task runner. \n\n\
On Windows: the shell is auto-detected (Git Bash preferred, then PowerShell, then cmd.exe). POSIX commands (grep, sed, find, rm, ls) may not be available on cmd.exe — prefer the dedicated tools (search_files, glob, read_file, edit_file) which work identically across platforms.\n\n\
IMPORTANT: Bash-specific syntax (&&, ||, 2>/dev/null, $(...)) only works with Git Bash. When the auto-detected shell is PowerShell or cmd.exe, these constructs fail. Rewrite using PowerShell syntax (-and, -or, 2>$null, Get-Content, Select-String) or use dedicated tools instead.\n\n\
If a shell command fails with exit code 127, the command is not installed or not in PATH — use a dedicated tool instead.\n\n\
Use this to run build tools, scripts, and system commands, not for file content search/edit.\n\n\
ASYNC MODE: set `async` to true for long-running tasks (e.g. builds > 1 min, servers, watch loops). The command then runs as a host-level background task that survives this conversation; the result contains a taskId, and you can poll with cap.bash (action: status/log/wait, taskId) or stop it with action: kill. Default async=false waits for completion and returns full output like a normal tool.",
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
                        },
                        "async": {
                            "type": "boolean",
                            "description": "Run as a host-level background task (default false). Use true for long-running commands that should survive the conversation."
                        }
                    },
                    "required": ["command"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let command = args["command"].as_str().unwrap_or("").to_string();
        if command.trim().is_empty() {
            return ToolOutcome::fail("bash: command 不能为空");
        }
        let async_run = args["async"].as_bool().unwrap_or(false);
        let workdir = args["workdir"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| ctx.work_dir.to_string());

        // 执行前 abort 检查：用户已中断则不再启动宿主任务。
        if *ctx.abort_rx.borrow() {
            return ToolOutcome::fail("bash: 会话已中断，命令未执行");
        }

        // cap.bash 同步 run 会 Condvar 阻塞等待命令结束（最长 timeoutMs）。
        // 用 spawn_blocking 包住，避免阻塞 tokio worker 线程池。
        let (command, workdir, async_run) = (command, workdir, async_run);
        let reply = tokio::task::spawn_blocking(move || {
            let cap = crate::services::router::BashCapability::new();
            let cap_ctx = crate::services::router::RealContext::new(
                crate::contracts::Source::Plugin {
                    caller: crate::contracts::PluginId("simple-ai".into()),
                },
                None,
                json!({}),
            );
            let params = json!({
                "action": "run",
                "command": command,
                "workdir": workdir,
                "async": async_run,
            });
            cap.invoke(params, &cap_ctx)
        })
        .await
        .unwrap_or_else(|e| Err(format!("bash (cap.bash): 任务线程失败: {}", e)));

        let reply = match reply {
            Ok(v) => v,
            Err(e) => return ToolOutcome::fail(e),
        };

        if async_run {
            // 异步模式：返回 taskId + 状态 + 后续指引。
            let task_id = reply["taskId"].as_str().unwrap_or("").to_string();
            let status = reply["status"].as_str().unwrap_or("running").to_string();
            let pid = reply["pid"].as_i64().unwrap_or(0);
            let content = format!(
                "[async task started] taskId={task_id} status={status} pid={pid}\n\
                 The command runs as a host-level background task and survives this conversation.\n\
                 Poll progress with cap.bash: {{\"action\":\"log\"|\"status\"|\"wait\",\"taskId\":\"{task_id}\"}}\n\
                 Stop it with cap.bash: {{\"action\":\"kill\",\"taskId\":\"{task_id}\"}}"
            );
            return ToolOutcome::ok(content);
        }

        // 同步模式：cap.bash 同步 run 已等待完成，返回含 output/exitCode。
        let output = reply["output"].as_str().unwrap_or("").to_string();
        let exit_code = reply["exitCode"].as_i64().unwrap_or(-1);

        let mut result = String::new();
        if !output.is_empty() {
            result.push_str(&output);
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
        if exit_code == 0 {
            ToolOutcome::ok(content)
        } else {
            ToolOutcome::fail(content)
        }
    }
}

/// 供 context.rs 注入 `<environment_context>` 的 shell 探测（复用 cap.bash 实现）。
pub(crate) fn detect_shell() -> (&'static str, Option<String>) {
    crate::services::router::detect_shell()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_shell_reuses_cap_bash() {
        let (name, _) = detect_shell();
        assert!(!name.is_empty());
        #[cfg(windows)]
        assert!(["git_bash", "pwsh", "cmd"].contains(&name));
        #[cfg(not(windows))]
        assert_eq!(name, "sh");
    }

    #[test]
    fn empty_command_fails_fast() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tool = BashTool;
            let ctx = super::super::make_test_context(".");
            let out = tool.execute(&json!({"command": "  "}), &ctx).await;
            assert!(!out.success);
            assert!(out.content.contains("command 不能为空"));
        });
    }
}
