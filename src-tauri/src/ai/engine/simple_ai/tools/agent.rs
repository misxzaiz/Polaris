/*! dispatch_agent 工具（Phase 5）：subagent 委派
 *
 * 模型调用后 spawn 一个子 SimpleAI 会话（独立 context + agent 定义作为 system prompt，
 * 复用父会话的 profile / MCP server 列表 / skills），完成后取最后一条 assistant 文本
 * 作为结果返回给父会话。对齐 Claude Code 的 Task 工具。
 *
 * 约束：
 * - 深度限制 `SUBAGENT_MAX_DEPTH`（默认 3）防递归失控。
 * - 子会话不继承父历史（隔离 context）。
 * - 子会话复用父 MCP server 列表（输入参数级别复用；MCP client 进程会重新 spawn——
 *   TODO: 后续可共享 Arc<McpClientPool> 避免重复 spawn）。
 * - `SIMPLE_AI_DISABLE_SUBAGENT=1` 时不注册本工具（决策 §12-4）。
 */

use serde_json::{json, Value};

use crate::error::Result;
use crate::models::AIEvent;

use super::super::agent;
use super::super::chat_loop::run_chat_loop;
use super::{truncate_chars, Tool, ToolContext, ToolOutcome, SUBAGENT_MAX_DEPTH};

pub(super) struct DispatchAgentTool;

#[async_trait::async_trait]
impl Tool for DispatchAgentTool {
    fn name(&self) -> &'static str {
        "dispatch_agent"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "dispatch_agent",
                "description": "Dispatch a sub-agent to handle a self-contained subtask with its own context. The sub-agent runs with the specified agent's system prompt and the same MCP tools/skills as the parent, but an independent message history (it does NOT see the parent conversation). Use this to delegate well-scoped subtasks — e.g. 'investigate module X', 'draft tests for Y' — then incorporate the result. Avoid nesting deeply.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent": { "type": "string", "description": "Agent name (a .polaris/agents/<name>.md file stem)" },
                        "task": { "type": "string", "description": "The self-contained subtask description. Must include all context the sub-agent needs, since it has no access to the parent conversation." }
                    },
                    "required": ["agent", "task"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let agent_name = args["agent"].as_str().unwrap_or("");
        let task = args["task"].as_str().unwrap_or("");
        if agent_name.is_empty() || task.is_empty() {
            return ToolOutcome::fail(
                "dispatch_agent requires 'agent' and 'task' parameters".to_string(),
            );
        }
        if ctx.subagent_depth >= SUBAGENT_MAX_DEPTH {
            return ToolOutcome::fail(format!(
                "subagent depth limit reached (max {}); cannot dispatch further. \
                 Complete the current task and let the parent dispatch instead.",
                SUBAGENT_MAX_DEPTH
            ));
        }

        let agent_def = match agent::load_agent(ctx.work_dir, agent_name) {
            Some(a) => a,
            None => {
                return ToolOutcome::fail(format!(
                    "agent '{}' not found in .polaris/agents/",
                    agent_name
                ))
            }
        };

        // 子会话 messages：system=agent.prompt + user=task（不继承父历史）。
        let mut child_messages = vec![
            json!({ "role": "system", "content": agent_def.system_prompt }),
            json!({ "role": "user", "content": task }),
        ];

        // 子会话共享父 abort_rx（父中断时联动子会话）
        let mut child_abort_rx = ctx.abort_rx.clone();

        // 子会话复用父 skills（read_skill 可用）。
        let child_skills = ctx.skills.clone();

        // 子会话 session_id：带深度前缀，便于事件区分。
        let child_session_id = format!(
            "{}#sub{}-{}",
            ctx.session_id,
            ctx.subagent_depth + 1,
            agent_name
        );

        let _ = (ctx.event_callback)(AIEvent::Progress(
            crate::models::ai_event::ProgressEvent::new(
                ctx.session_id,
                format!("dispatching sub-agent '{}' (depth {})", agent_name, ctx.subagent_depth + 1),
            ),
        ));

        let profile = ctx.profile.clone();
        let result: Result<()> = run_chat_loop(
            &child_session_id,
            &mut child_messages,
            &profile,
            ctx.work_dir,
            ctx.event_callback,
            &mut child_abort_rx,
            ctx.mcp_servers,
            &child_skills,
            ctx.subagent_depth + 1,
        )
        .await;

        match result {
            Ok(()) => {
                let last_assistant = child_messages
                    .iter()
                    .rev()
                    .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
                    .and_then(|m| m.get("content").and_then(|c| c.as_str()))
                    .unwrap_or("(sub-agent returned no output)");
                ToolOutcome::ok(truncate_chars(last_assistant, 8_192))
            }
            Err(e) => ToolOutcome::fail(format!("sub-agent '{}' failed: {}", agent_name, e)),
        }
    }
}
