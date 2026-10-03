/*! bash 工具：cap.bash 直通代理
 *
 * SimpleAI 的 bash 工具不再自带 shell 执行逻辑（原 500 行 spawn/超时/编码/127 提示
 * 已全部收敛到宿主级 `cap.bash`（services/router/bash_capability.rs），此处只做薄封装：
 *
 * - 异步模式（默认 async=true）：命令以宿主后台任务启动，立即返回 taskId，不阻塞
 *   会话；任务归宿主运行、不随会话结束而终止，可后续轮询 cap.bash status/log/wait
 *   或 kill 终止。taskId 随 ToolCallEnd 事件透传前端，供任务管理面板关联/停止。
 * - 同步模式（async=false）：仍需等待命令结束（内部轮询 wait + abort 检查），返回
 *   全量输出与退出码；语义与旧 bash 工具一致，且用户中断可即时 kill 宿主任务。
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
ASYNC MODE: commands run as host-level background tasks by DEFAULT (async=true) and never block this conversation — the result contains a taskId immediately, and you can poll with cap.bash (action: status/log/wait, taskId) or stop it with action: kill. Set `async` to false only when you need synchronous output before continuing (waits for completion, still interruptible).",
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
                            "description": "Run as a host-level background task (default true). The command starts immediately and this conversation does not wait; poll/stop via cap.bash with the returned taskId. Set false to wait for completion before continuing."
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
        // 默认异步（cap.bash 后台任务）：不阻塞会话、可跨会话管理。
        // AI 可显式 async=false 走同步（等命令结束拿全量输出），语义与旧工具一致。
        let async_run = args["async"].as_bool().unwrap_or(true);
        let workdir = args["workdir"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| ctx.work_dir.to_string());

        // 执行前 abort 检查：用户已中断则不再启动宿主任务。
        if *ctx.abort_rx.borrow() {
            return ToolOutcome::fail("bash: 会话已中断，命令未执行");
        }

        // cap.bash run 走宿主 TaskManager（线程 + Condvar 等待），用 spawn_blocking
        // 包住避免阻塞 tokio worker 线程池。返回后即可拿到 taskId。
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
                "async": true, // 一律先异步启动拿 taskId；同步模式随后轮询 wait + abort 可中断
            });
            cap.invoke(params, &cap_ctx)
        })
        .await
        .unwrap_or_else(|e| Err(format!("bash (cap.bash): 任务线程失败: {}", e)));

        let reply = match reply {
            Ok(v) => v,
            Err(e) => return ToolOutcome::fail(e),
        };
        let task_id = reply["taskId"].as_str().unwrap_or("").to_string();

        if async_run {
            // 异步模式：任务已在宿主后台启动，立即返回（不阻塞会话）。
            // 结果回传 taskId 供前端管理面板关联；模型可后续经 cap.bash 查询。
            let status = reply["status"].as_str().unwrap_or("running").to_string();
            let pid = reply["pid"].as_i64().unwrap_or(0);
            let content = format!(
                "[async task started] taskId={task_id} status={status} pid={pid}\n\
                 The command runs as a host-level background task and survives this conversation.\n\
                 Poll progress with cap.bash: {{\"action\":\"log\"|\"status\"|\"wait\",\"taskId\":\"{task_id}\"}}\n\
                 Stop it with cap.bash: {{\"action\":\"kill\",\"taskId\":\"{task_id}\"}}"
            );
            return ToolOutcome::ok_task(content, task_id);
        }

        // 同步模式：轮询 wait + abort 检查（可中断）。cap.bash run 已以 async=true
        // 启动（见上），这里每 200ms 检查一次终端状态与用户中断信号：中断则 kill
        // 宿主任务并立即返回，不再让「停止」按钮失效。
        loop {
            if *ctx.abort_rx.borrow() {
                let cap = crate::services::router::BashCapability::new();
                let cap_ctx = crate::services::router::RealContext::new(
                    crate::contracts::Source::Plugin {
                        caller: crate::contracts::PluginId("simple-ai".into()),
                    },
                    None,
                    json!({}),
                );
                let _ = cap.invoke(
                    json!({ "action": "kill", "taskId": task_id }),
                    &cap_ctx,
                );
                return ToolOutcome::fail("bash: 会话已中断，命令已终止");
            }

            let wait_task_id = task_id.clone();
            let wait = tokio::task::spawn_blocking(move || {
                let cap = crate::services::router::BashCapability::new();
                let cap_ctx = crate::services::router::RealContext::new(
                    crate::contracts::Source::Plugin {
                        caller: crate::contracts::PluginId("simple-ai".into()),
                    },
                    None,
                    json!({}),
                );
                cap.invoke(
                    json!({ "action": "wait", "taskId": wait_task_id, "timeoutMs": 200 }),
                    &cap_ctx,
                )
            })
            .await
            .unwrap_or_else(|e| Err(format!("bash (cap.bash): 任务线程失败: {}", e)));

            let v = match wait {
                Ok(v) => v,
                Err(e) => return ToolOutcome::fail(e),
            };
            if v["status"].as_str() == Some("running") {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }

            // 已终态：读日志返回全量输出
            let log_task_id = task_id.clone();
            let log = tokio::task::spawn_blocking(move || {
                let cap = crate::services::router::BashCapability::new();
                let cap_ctx = crate::services::router::RealContext::new(
                    crate::contracts::Source::Plugin {
                        caller: crate::contracts::PluginId("simple-ai".into()),
                    },
                    None,
                    json!({}),
                );
                cap.invoke(json!({ "action": "log", "taskId": log_task_id }), &cap_ctx)
            })
            .await
            .unwrap_or_else(|e| Err(format!("bash (cap.bash): 任务线程失败: {}", e)));

            let output = log
                .ok()
                .and_then(|l| l["lines"].as_array().cloned())
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(|l| l.as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let exit_code = v["exitCode"].as_i64().unwrap_or(-1);
            let status_str = v["status"].as_str().unwrap_or("");

            let mut result = String::new();
            if !output.is_empty() {
                result.push_str(&output);
            }
            if !result.is_empty() {
                result.push('\n');
            }
            result.push_str(&format!("[status: {status_str}]"));
            if exit_code != 0 {
                result.push_str(&format!(" [exit code: {exit_code}]"));
            }
            let content = truncate_chars(&result, 32_768);
            if status_str == "completed" {
                return ToolOutcome::ok(content);
            } else {
                return ToolOutcome::fail(content);
            }
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
