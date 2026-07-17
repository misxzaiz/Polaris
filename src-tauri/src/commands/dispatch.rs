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
pub fn report_dispatch_status_impl(
    state: &AppState,
    dispatch_id: &str,
    status: &str,
    summary: Option<String>,
    latest_activity: Option<String>,
    conversation_id: Option<String>,
) -> Result<()> {
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
    Ok(())
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
        },
    )
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
) -> Result<()> {
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
