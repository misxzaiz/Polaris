/*! 后台任务管理命令（Tauri 命令层）
 *
 * 前端后台任务面板调用：task_list / task_kill / task_read_log。
 * 底层状态由 services::task_registry::TaskRegistry 统一管理（bash background 同源）。
 */

use tauri::State;

use crate::services::TaskInfo;

#[tauri::command]
pub async fn task_list(
    state: State<'_, crate::state::AppState>,
    session_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<TaskInfo>, String> {
    Ok(state
        .task_registry
        .list_tasks(session_id.as_deref(), status.as_deref())
        .await)
}

#[tauri::command]
pub async fn task_kill(state: State<'_, crate::state::AppState>, task_id: String) -> Result<bool, String> {
    state.task_registry.kill_task(&task_id).await
}

#[tauri::command]
pub async fn task_read_log(
    state: State<'_, crate::state::AppState>,
    task_id: String,
    max_lines: Option<usize>,
) -> Result<String, String> {
    let lines = max_lines.unwrap_or(500).clamp(1, 5000);
    Ok(state.task_registry.read_log_tail(&task_id, lines).await)
}
