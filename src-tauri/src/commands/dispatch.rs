/*! 派发任务命令
 *
 * dispatch_task MCP 工具把子任务转发到新的后台会话后，前端负责实际执行
 * （创建静默会话 + start_chat）。这里的命令供前端回报执行状态，使
 * check_dispatched_task 工具能向来源会话返回真实进度与结果摘要。
 */

use crate::error::{AppError, Result};
use crate::services::ask_listener::{register_dispatch_task, DispatchTaskParams};
use crate::state::{AppState, DispatchedTask};

/// 摘要长度上限（字符），防止前端回传超长内容撑爆注册表
const MAX_SUMMARY_CHARS: usize = 2000;

fn is_valid_dispatch_status(status: &str) -> bool {
    matches!(status, "running" | "completed" | "failed")
}

fn truncate_summary(summary: String) -> String {
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        let mut t: String = summary.chars().take(MAX_SUMMARY_CHARS).collect();
        t.push('…');
        t
    } else {
        summary
    }
}

/// 核心实现：更新派发任务状态（Tauri 命令与 Web IPC 桥共用）
///
/// `status` 允许重复回报（如 running 期间携带 latest_activity 的进度心跳）；
/// 每次回报都会刷新 updated_at，长任务因此不会被并发额度的陈旧判定误伤。
/// 回报结果:completed 且配置 resultSchema 时携带解析出的 verdict(P2-3/U1-2)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStatusResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict_status: Option<String>,
}

pub fn report_dispatch_status_impl(
    state: &AppState,
    dispatch_id: &str,
    status: &str,
    summary: Option<String>,
    latest_activity: Option<String>,
    conversation_id: Option<String>,
) -> Result<ReportStatusResult> {
    if !is_valid_dispatch_status(status) {
        return Err(AppError::ValidationError(format!(
            "无效的派发任务状态: {}（允许 running/completed/failed）",
            status
        )));
    }

    let truncated_summary = summary.map(truncate_summary);
    let updated = state.update_dispatched_task(dispatch_id, |task| {
        task.status = status.to_string();
        if truncated_summary.is_some() {
            task.summary = truncated_summary;
        }
        // 结构化 verdict 提取校验（P2-3）：completed 且指定了 resultSchema 时，
        // 从 summary 提取 JSON 并按 schema 校验；失败降级 unstructured，不阻塞回流。
        if task.status == "completed" {
            if let (Some(schema_id), Some(summary_text)) =
                (task.result_schema.clone(), task.summary.clone())
            {
                let (verdict, verdict_status) =
                    crate::services::nexus_verdict::process_summary(&schema_id, &summary_text);
                task.verdict = verdict;
                task.verdict_status = Some(verdict_status.to_string());
            }
        }
        if let Some(activity) = latest_activity {
            task.latest_activity = Some(truncate_summary(activity));
        }
        if let Some(conv_id) = conversation_id {
            if !conv_id.trim().is_empty() {
                task.conversation_id = Some(conv_id);
            }
        }
    });
    if !updated {
        return Err(AppError::ValidationError(format!(
            "未找到派发任务: {}",
            dispatch_id
        )));
    }

    tracing::debug!(
        "[Dispatch] 状态更新: dispatch_id={}, status={}",
        dispatch_id,
        status
    );

    // NEXUS roster 波次推进（P2-5）：成员任务到达终态时由 Rust 触发下波派发
    let mut result = ReportStatusResult { verdict: None, verdict_status: None };
    if status == "completed" || status == "failed" {
        if let Some(task) = state.get_dispatched_task(dispatch_id) {
            // verdict 校验失败自动重试一次（B2）：continue 原会话要求重发 JSON，
            // 任务回到 running，本次不做终态处理；重试后的 completed 再走完整链路。
            if status == "completed"
                && task.result_schema.is_some()
                && task.verdict_status.as_deref() == Some("unstructured")
                && !task.verdict_retry_done
            {
                let retry_prompt = "你上一条结果缺少要求的结构化 JSON verdict（或校验未通过）。请补发：只输出一个符合此前 system prompt 中结构化结果要求的 ```json 代码块，不要重复其他内容。";
                match crate::services::ask_listener::trigger_dispatch_continue(
                    state, dispatch_id, retry_prompt,
                ) {
                    Ok(()) => {
                        state.update_dispatched_task(dispatch_id, |t| t.verdict_retry_done = true);
                        tracing::info!("[Dispatch] verdict 缺失，已自动 continue 重试: {}", dispatch_id);
                        return Ok(result);
                    }
                    Err(e) => tracing::warn!("[Dispatch] verdict 重试失败，降级 unstructured: {}", e),
                }
            }
            result.verdict = task.verdict.clone();
            result.verdict_status = task.verdict_status.clone();
            if task.roster_id.is_some() {
                crate::services::nexus_pipeline::on_dispatch_terminal(state, &task);
            }
        }
    }
    Ok(result)
}

/// 核心实现：按目标会话 ID 查找派发任务（前端只有 sessionId 时使用）
pub fn get_dispatched_task_by_session_impl(
    state: &AppState,
    session_id: &str,
) -> Option<DispatchedTask> {
    state
        .dispatched_tasks
        .lock()
        .ok()
        .and_then(|tasks| {
            tasks
                .values()
                .find(|t| t.session_id == session_id)
                .cloned()
        })
}

/// 核心实现：用户侧派发登记（/dispatch 命令与 Web IPC 桥共用）。
///
/// 与 MCP dispatch 帧共享 register_dispatch_task（深度/并发校验 + role/provider
/// 解析）。命令直接把任务返回给调用方前端本地执行，**不 emit 事件**——
/// 避免与 dispatch-task-request 监听器双执行。
pub fn create_dispatch_task_impl(
    state: &AppState,
    params: DispatchTaskParams,
) -> Result<DispatchedTask> {
    register_dispatch_task(state, params).map_err(AppError::ValidationError)
}

/// 用户手动派发任务（/dispatch 斜杠命令）
#[cfg(feature = "tauri-app")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn dispatch_create_task(
    prompt: String,
    title: Option<String>,
    work_dir: Option<String>,
    engine_id: Option<String>,
    role: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    source_session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<DispatchedTask> {
    create_dispatch_task_impl(
        &state,
        DispatchTaskParams {
            source_session_id: source_session_id.unwrap_or_default(),
            prompt: prompt.trim().to_string(),
            title: title.filter(|t| !t.trim().is_empty()),
            work_dir: work_dir.filter(|d| !d.trim().is_empty()),
            engine_id: engine_id.filter(|e| !e.trim().is_empty()),
            role: role.filter(|r| !r.trim().is_empty()),
            provider: provider.filter(|p| !p.trim().is_empty()),
            model: model.filter(|m| !m.trim().is_empty()),
            dispatch_id: None,
            result_schema: None,
            roster_id: None,
        },
    )
}

/// 列出全部派发任务（任务中心数据源，按 updated_at 降序）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dispatch_list_tasks(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<DispatchedTask>> {
    Ok(state.list_dispatched_tasks())
}

/// 删除派发任务记录（不影响已存在的会话）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dispatch_delete_task(
    dispatch_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    if !state.delete_dispatched_task(&dispatch_id) {
        return Err(AppError::ValidationError(format!(
            "未找到派发任务: {}",
            dispatch_id
        )));
    }
    Ok(())
}

/// 前端回报派发任务执行状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dispatch_report_status(
    dispatch_id: String,
    status: String,
    summary: Option<String>,
    latest_activity: Option<String>,
    conversation_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ReportStatusResult> {
    report_dispatch_status_impl(
        &state,
        &dispatch_id,
        &status,
        summary,
        latest_activity,
        conversation_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_validation() {
        assert!(is_valid_dispatch_status("running"));
        assert!(is_valid_dispatch_status("completed"));
        assert!(is_valid_dispatch_status("failed"));
        assert!(!is_valid_dispatch_status("pending"));
        assert!(!is_valid_dispatch_status("bogus"));
    }

    #[test]
    fn summary_is_truncated() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 100);
        let truncated = truncate_summary(long);
        assert_eq!(truncated.chars().count(), MAX_SUMMARY_CHARS + 1);
        assert!(truncated.ends_with('…'));

        let short = truncate_summary("done".to_string());
        assert_eq!(short, "done");
    }
}
