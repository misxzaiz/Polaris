/*! 派发任务命令
 *
 * dispatch_task MCP 工具把子任务转发到新的后台会话后，前端负责实际执行
 * （创建静默会话 + start_chat）。这里的命令供前端回报执行状态，使
 * check_dispatched_task 工具能向来源会话返回真实进度与结果摘要。
 */

use crate::error::{AppError, Result};
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
pub fn report_dispatch_status_impl(
    state: &AppState,
    dispatch_id: &str,
    status: &str,
    summary: Option<String>,
) -> Result<()> {
    if !is_valid_dispatch_status(status) {
        return Err(AppError::ValidationError(format!(
            "无效的派发任务状态: {}（允许 running/completed/failed）",
            status
        )));
    }

    if !state.update_dispatched_task_status(dispatch_id, status, summary.map(truncate_summary)) {
        return Err(AppError::ValidationError(format!(
            "未找到派发任务: {}",
            dispatch_id
        )));
    }

    tracing::info!(
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

/// 前端回报派发任务执行状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dispatch_report_status(
    dispatch_id: String,
    status: String,
    summary: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    report_dispatch_status_impl(&state, &dispatch_id, &status, summary)
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
