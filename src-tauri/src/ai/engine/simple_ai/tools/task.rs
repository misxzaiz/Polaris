/*! 后台任务管理工具：task_status / task_kill / task_wait / task_list
 *
 * 与 bash `background: true` 配套：bash 后台启动后返回 taskId，
 * 模型通过这些工具轮询状态、读日志、杀掉/等待任务，闭环管理。
 */

use serde_json::{json, Value};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

pub(super) struct TaskStatusTool;
pub(super) struct TaskKillTool;
pub(super) struct TaskWaitTool;
pub(super) struct TaskListTool;

#[async_trait::async_trait]
impl Tool for TaskStatusTool {
    fn name(&self) -> &'static str {
        "task_status"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "task_status",
                "description": "Query the status of a background task started with bash(background: true). Returns status (running/done/failed/killed/timeout), exit code, elapsed time, and the tail of the task's log output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "taskId": {
                            "type": "string",
                            "description": "The taskId returned by bash with background: true"
                        }
                    },
                    "required": ["taskId"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let task_id = args["taskId"].as_str().unwrap_or("");
        if task_id.is_empty() {
            return ToolOutcome::fail("taskId is required");
        }
        match ctx.task_registry.task_info(task_id).await {
            Some(info) => ToolOutcome::ok(json!({
                "taskId": info.task_id,
                "status": info.status,
                "pid": info.pid,
                "exitCode": info.exit_code,
                "elapsedMs": info.elapsed_ms,
                "logTail": info.log_tail,
            })
            .to_string()),
            None => ToolOutcome::fail(format!("Task {} not found", task_id)),
        }
    }
}

#[async_trait::async_trait]
impl Tool for TaskKillTool {
    fn name(&self) -> &'static str {
        "task_kill"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "task_kill",
                "description": "Terminate a background task (and its whole process tree). Use for dev servers, watchers, or stuck long-running tasks started with bash(background: true).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "taskId": {
                            "type": "string",
                            "description": "The taskId returned by bash with background: true"
                        }
                    },
                    "required": ["taskId"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let task_id = args["taskId"].as_str().unwrap_or("");
        if task_id.is_empty() {
            return ToolOutcome::fail("taskId is required");
        }
        match ctx.task_registry.kill_task(task_id).await {
            Ok(true) => ToolOutcome::ok(format!("Task {} kill signal sent (process tree terminated)", task_id)),
            Ok(false) => ToolOutcome::fail(format!("Task {} not found", task_id)),
            Err(e) => ToolOutcome::fail(format!("Failed to kill task {}: {}", task_id, e)),
        }
    }
}

#[async_trait::async_trait]
impl Tool for TaskWaitTool {
    fn name(&self) -> &'static str {
        "task_wait"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "task_wait",
                "description": "Wait for a background task to finish, polling every 2s up to timeoutMs (default 60000). Returns final status and log tail. Use after bash(background: true) when you need the result before continuing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "taskId": {
                            "type": "string",
                            "description": "The taskId returned by bash with background: true"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time to wait in milliseconds (optional, default 60000)"
                        }
                    },
                    "required": ["taskId"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let task_id = args["taskId"].as_str().unwrap_or("").to_string();
        if task_id.is_empty() {
            return ToolOutcome::fail("taskId is required");
        }
        let timeout_ms = args["timeoutMs"].as_u64().unwrap_or(60_000);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

        loop {
            match ctx.task_registry.task_info(&task_id).await {
                Some(info) => {
                    let terminal = info.status != "running";
                    if terminal {
                        return ToolOutcome::ok(json!({
                            "taskId": info.task_id,
                            "status": info.status,
                            "pid": info.pid,
                            "exitCode": info.exit_code,
                            "elapsedMs": info.elapsed_ms,
                            "logTail": truncate_chars(&info.log_tail, 16_384),
                        })
                        .to_string());
                    }
                }
                None => return ToolOutcome::fail(format!("Task {} not found", task_id)),
            }
            if std::time::Instant::now() >= deadline {
                return ToolOutcome::fail(format!(
                    "Task {} still running after {}ms (use task_status / task_kill)",
                    task_id, timeout_ms
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        }
    }
}

#[async_trait::async_trait]
impl Tool for TaskListTool {
    fn name(&self) -> &'static str {
        "task_list"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "task_list",
                "description": "List background tasks for the current session (optionally filtered by status). Returns taskId, command, status, pid, elapsed time.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["running", "done", "failed", "killed", "timeout"],
                            "description": "Optional filter by status"
                        }
                    }
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let status = args["status"].as_str();
        let tasks = ctx
            .task_registry
            .list_tasks(Some(ctx.session_id), status)
            .await;
        let items: Vec<Value> = tasks
            .iter()
            .map(|t| {
                json!({
                    "taskId": t.task_id,
                    "command": truncate_chars(&t.command, 200),
                    "status": t.status,
                    "pid": t.pid,
                    "elapsedMs": t.elapsed_ms,
                })
            })
            .collect();
        if items.is_empty() {
            ToolOutcome::ok("(no background tasks)".to_string())
        } else {
            ToolOutcome::ok(json!({ "tasks": items }).to_string())
        }
    }
}
