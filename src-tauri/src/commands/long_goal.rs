//! Long goal executor commands.

use crate::error::Result;
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, BindLongGoalSessionParams, CompleteLongGoalParams,
    CreateLongGoalParams, FinishLongGoalSessionParams, LongGoalState, RecordLongGoalStepParams,
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
pub async fn long_goal_finish_session(params: FinishLongGoalSessionParams) -> Result<LongGoalState> {
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
pub async fn long_goal_prepare_planning(
    workspace_path: String,
    goal_id: String,
) -> Result<String> {
    LongGoalService::prepare_planning_session(&workspace_path, &goal_id)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn long_goal_record_step(params: RecordLongGoalStepParams) -> Result<LongGoalState> {
    LongGoalService::record_step(params)
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
