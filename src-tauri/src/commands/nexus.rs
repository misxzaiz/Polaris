//! NEXUS roster 相关 Tauri 命令(P2-5/P2-7)
//!
//! `/nexus <scenario> <goal>` slash 命令的桌面端入口:与 MCP `dispatch_roster`
//! 工具共用 `nexus_pipeline::start_roster`(深度/并发治理与波次推进一致)。

use serde::Serialize;

use crate::services::nexus_pipeline;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterStartResult {
    pub roster_id: String,
    pub scenario: String,
    pub waves: Vec<Vec<String>>,
    pub dispatched_now: Vec<String>,
}

pub fn nexus_start_roster_impl(
    state: &AppState,
    scenario: &str,
    goal: &str,
    source_session_id: Option<String>,
    work_dir: Option<String>,
) -> std::result::Result<RosterStartResult, String> {
    let (pipeline, dispatched) = nexus_pipeline::start_roster(
        state,
        scenario,
        goal,
        source_session_id.as_deref().unwrap_or_default(),
        work_dir,
    )?;
    Ok(RosterStartResult {
        roster_id: pipeline.id,
        scenario: pipeline.scenario,
        waves: pipeline.waves,
        dispatched_now: dispatched,
    })
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn nexus_start_roster(
    state: tauri::State<'_, AppState>,
    scenario: String,
    goal: String,
    source_session_id: Option<String>,
    work_dir: Option<String>,
) -> Result<RosterStartResult, String> {
    nexus_start_roster_impl(&state, &scenario, &goal, source_session_id, work_dir)
}
