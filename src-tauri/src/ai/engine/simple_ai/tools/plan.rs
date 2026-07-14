/*! update_plan 工具：维护并上报扁平步骤计划
 *
 * 借鉴 codex `update_plan`（扁平 step 列表），但映射到 Polaris 现有的 PlanMode 事件体系
 * （[`PlanContentEvent`]，两层 stage→task 结构）以复用前端计划面板：
 * - 所有扁平 step 装入**单个 stage** 的 tasks；
 * - plan 整体状态用 `Executing`（未全完成）或 `Completed`（全完成），**绝不**用
 *   `PendingApproval` —— 那会触发前端审批阻塞 UI，而 SimpleAI 不处理审批响应；
 * - 每轮对话首次调用先发 `plan_start` 创建面板 block（`appendPlanModeBlock` 非幂等，
 *   故由 [`ToolContext::plan_started`] 标志确保每轮仅发一次），其后只发 `plan_content` 更新。
 */

use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use super::{Tool, ToolContext, ToolOutcome};
use crate::models::ai_event::{
    PlanContentEvent, PlanStage, PlanStageStatus, PlanStartEvent, PlanStatus, PlanTask,
    PlanTaskStatus,
};
use crate::models::AIEvent;

pub(super) struct UpdatePlanTool;

#[async_trait::async_trait]
impl Tool for UpdatePlanTool {
    fn name(&self) -> &'static str {
        "update_plan"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "update_plan",
                "description": "Maintain a short step-by-step plan for the current task and report progress to the user. Call this when starting a non-trivial multi-step task, and again whenever a step's status changes. Keep at most one step 'in_progress' at a time. Skip this for trivial single-step requests.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "explanation": {
                            "type": "string",
                            "description": "Optional short note about this update (e.g. why the plan changed)"
                        },
                        "plan": {
                            "type": "array",
                            "description": "The ordered list of steps",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": { "type": "string", "description": "Short description of the step" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed"],
                                        "description": "Status of this step"
                                    }
                                },
                                "required": ["step", "status"]
                            }
                        }
                    },
                    "required": ["plan"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let Some(plan_arr) = args["plan"].as_array() else {
            return ToolOutcome::fail("update_plan requires a 'plan' array".to_string());
        };
        if plan_arr.is_empty() {
            return ToolOutcome::fail("update_plan 'plan' array must not be empty".to_string());
        }
        let explanation = args["explanation"].as_str().filter(|s| !s.is_empty());

        let mut tasks: Vec<PlanTask> = Vec::new();
        let mut all_completed = true;
        let mut rendered = String::new();

        for (idx, item) in plan_arr.iter().enumerate() {
            let step = item["step"].as_str().unwrap_or("").to_string();
            let status = map_task_status(item["status"].as_str().unwrap_or("pending"));
            if status != PlanTaskStatus::Completed {
                all_completed = false;
            }
            let mark = match status {
                PlanTaskStatus::Completed => "x",
                PlanTaskStatus::InProgress => "~",
                _ => " ",
            };
            rendered.push_str(&format!("\n[{}] {}", mark, step));
            tasks.push(PlanTask {
                task_id: format!("step-{}", idx + 1),
                description: step,
                status,
            });
        }

        let (stage_status, plan_status) = if all_completed {
            (PlanStageStatus::Completed, PlanStatus::Completed)
        } else {
            (PlanStageStatus::InProgress, PlanStatus::Executing)
        };

        let stage = PlanStage {
            stage_id: "main".to_string(),
            name: "Plan".to_string(),
            description: explanation.map(|s| s.to_string()),
            status: stage_status,
            tasks,
        };

        let mut content =
            PlanContentEvent::new(ctx.session_id, ctx.plan_id, vec![stage], plan_status);
        if let Some(ex) = explanation {
            content = content.with_description(ex);
        }

        // 每轮首次调用：先创建面板 block（appendPlanModeBlock 非幂等，靠标志防重复）。
        if !ctx.plan_started.swap(true, Ordering::SeqCst) {
            (ctx.event_callback)(AIEvent::PlanStart(PlanStartEvent::new(
                ctx.session_id,
                ctx.plan_id,
            )));
        }
        (ctx.event_callback)(AIEvent::PlanContent(content));

        let header = match explanation {
            Some(ex) => format!("Plan updated ({}):", ex),
            None => "Plan updated:".to_string(),
        };
        ToolOutcome::ok(format!("{}{}", header, rendered))
    }
}

fn map_task_status(s: &str) -> PlanTaskStatus {
    match s {
        "in_progress" => PlanTaskStatus::InProgress,
        "completed" => PlanTaskStatus::Completed,
        _ => PlanTaskStatus::Pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tokio::sync::watch;

    fn collector() -> (Arc<Mutex<Vec<AIEvent>>>, Arc<dyn Fn(AIEvent) + Send + Sync>) {
        let events: Arc<Mutex<Vec<AIEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> =
            Arc::new(move |e| sink.lock().unwrap().push(e));
        (events, cb)
    }

    #[tokio::test]
    async fn first_call_emits_plan_start_then_content() {
        let (events, cb) = collector();
        let started = AtomicBool::new(false);
        let skills = std::collections::HashMap::new();
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = ToolContext {
            work_dir: ".",
            session_id: "s1",
            event_callback: &cb,
            plan_id: "s1-plan",
            plan_started: &started,
            skills: &skills,
            profile: &profile,
            mcp_servers: &mcp_servers,
            subagent_depth: 0,
            abort_rx: &{ watch::channel(false).1 },
        };
        let args = json!({
            "explanation": "kick off",
            "plan": [
                {"step": "first", "status": "completed"},
                {"step": "second", "status": "in_progress"},
                {"step": "third", "status": "pending"}
            ]
        });
        let out = UpdatePlanTool.execute(&args, &ctx).await;
        assert!(out.success);
        assert!(out.content.contains("[x] first"));
        assert!(out.content.contains("[~] second"));
        assert!(out.content.contains("[ ] third"));

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 2);
        assert!(matches!(evs[0], AIEvent::PlanStart(_)));
        match &evs[1] {
            AIEvent::PlanContent(pc) => {
                assert_eq!(pc.stages.len(), 1);
                assert_eq!(pc.stages[0].tasks.len(), 3);
                assert_eq!(pc.status, PlanStatus::Executing);
            }
            other => panic!("expected PlanContent, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn second_call_does_not_reemit_plan_start_and_completes() {
        let (events, cb) = collector();
        let started = AtomicBool::new(false);
        let skills = std::collections::HashMap::new();
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = ToolContext {
            work_dir: ".",
            session_id: "s1",
            event_callback: &cb,
            plan_id: "s1-plan",
            plan_started: &started,
            skills: &skills,
            profile: &profile,
            mcp_servers: &mcp_servers,
            subagent_depth: 0,
            abort_rx: &{ watch::channel(false).1 },
        };
        let first = json!({ "plan": [{"step": "a", "status": "in_progress"}] });
        UpdatePlanTool.execute(&first, &ctx).await;
        let second = json!({ "plan": [{"step": "a", "status": "completed"}] });
        UpdatePlanTool.execute(&second, &ctx).await;

        let evs = events.lock().unwrap();
        // 首次 2 个（start+content），二次仅 1 个（content）
        assert_eq!(evs.len(), 3);
        assert!(matches!(evs[0], AIEvent::PlanStart(_)));
        assert!(matches!(evs[1], AIEvent::PlanContent(_)));
        assert!(matches!(evs[2], AIEvent::PlanContent(_)));
        match &evs[2] {
            AIEvent::PlanContent(pc) => assert_eq!(pc.status, PlanStatus::Completed),
            other => panic!("expected PlanContent, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn empty_plan_is_rejected() {
        let (_events, cb) = collector();
        let started = AtomicBool::new(false);
        let skills = std::collections::HashMap::new();
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = ToolContext {
            work_dir: ".",
            session_id: "s1",
            event_callback: &cb,
            plan_id: "s1-plan",
            plan_started: &started,
            skills: &skills,
            profile: &profile,
            mcp_servers: &mcp_servers,
            subagent_depth: 0,
            abort_rx: &{ watch::channel(false).1 },
        };
        let out = UpdatePlanTool.execute(&json!({ "plan": [] }), &ctx).await;
        assert!(!out.success);
    }
}
