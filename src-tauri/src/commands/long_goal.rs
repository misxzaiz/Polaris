//! Long goal executor commands.

use crate::error::Result;
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, BindLongGoalSessionParams, CompleteLongGoalParams,
    CreateLongGoalParams, FinishLongGoalSessionParams, LongGoalState, RecordLongGoalStepParams,
    UpdateLongGoalDocumentsParams,
};
use crate::services::long_goal_service::LongGoalService;

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_create(params: CreateLongGoalParams) -> Result<LongGoalState> {
    LongGoalService::create_goal(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_list(workspace_path: String) -> Result<Vec<LongGoalState>> {
    LongGoalService::list_goals(&workspace_path)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_read(workspace_path: String, goal_id: String) -> Result<LongGoalState> {
    LongGoalService::read_goal(&workspace_path, &goal_id)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_append_supplement(
    params: AppendLongGoalSupplementParams,
) -> Result<LongGoalState> {
    LongGoalService::append_supplement(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_bind_session(params: BindLongGoalSessionParams) -> Result<LongGoalState> {
    LongGoalService::bind_session(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_finish_session(
    params: FinishLongGoalSessionParams,
) -> Result<LongGoalState> {
    LongGoalService::finish_session(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_pause(workspace_path: String, goal_id: String) -> Result<LongGoalState> {
    LongGoalService::pause_goal(&workspace_path, &goal_id)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_resume(workspace_path: String, goal_id: String) -> Result<LongGoalState> {
    LongGoalService::resume_goal(&workspace_path, &goal_id)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_prepare_planning(workspace_path: String, goal_id: String) -> Result<String> {
    LongGoalService::prepare_planning_session(&workspace_path, &goal_id)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_prepare_execution(
    workspace_path: String,
    goal_id: String,
) -> Result<String> {
    LongGoalService::prepare_execution_session(&workspace_path, &goal_id)
}

/// 记录长期目标本轮执行进度。
///
/// **命名映射 (LG-006)**：本 IPC 命令对外暴露三套同义名称，**有意保留分叉**，不要轻易统一：
///
/// | 表面层 | 名称 | 维护者 |
/// |---|---|---|
/// | MCP 工具 (外部接口)         | `long_goal_record_progress` | `services::long_goal_mcp_server` |
/// | Tauri IPC 命令 (前端调用)   | `long_goal_record_step`     | 本文件                            |
/// | Service 方法 (Rust 内部)    | `LongGoalService::record_step` | `services::long_goal_service` |
///
/// MCP 名 `record_progress` 是已发布的外部接口（外部插件 / agent prompt 已硬编码），改名属于
/// breaking change，需要走 deprecation 周期。三个名字语义等价：MCP 调用最终会 fan-in 到
/// `LongGoalService::record_step`。完整对照表见 `docs/mcp/6-long-goal-executor-plugin.md`
/// 的"MCP / IPC / Service 三方命名对照（LG-006）"小节。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_record_step(params: RecordLongGoalStepParams) -> Result<LongGoalState> {
    LongGoalService::record_step(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_update_documents(
    params: UpdateLongGoalDocumentsParams,
) -> Result<LongGoalState> {
    LongGoalService::update_documents(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_complete(params: CompleteLongGoalParams) -> Result<LongGoalState> {
    LongGoalService::complete_goal(params)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_prepare_maintenance(
    workspace_path: String,
    goal_id: String,
) -> Result<String> {
    LongGoalService::prepare_maintenance_session(&workspace_path, &goal_id)
}
