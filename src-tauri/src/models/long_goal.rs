//! Long goal executor models.
//!
//! These types describe the document-backed state used by the long goal MCP
//! plugin plan. The first implementation keeps orchestration out of the plugin:
//! Polaris owns sessions and scheduling, while the goal service owns documents.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LongGoalStatus {
    Planning,
    Active,
    Running,
    Paused,
    Maintenance,
    Blocked,
    Completed,
    Failed,
}

impl Default for LongGoalStatus {
    fn default() -> Self {
        Self::Planning
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LongGoalPhase {
    Planning,
    Execution,
    Maintenance,
    Review,
}

impl Default for LongGoalPhase {
    fn default() -> Self {
        Self::Planning
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongGoalConfig {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub status: LongGoalStatus,
    pub phase: LongGoalPhase,
    pub workspace_path: String,
    pub engine_id: String,
    pub trigger_mode: String,
    pub interval: String,
    pub auto_pause_on_complete: bool,
    pub allow_code_changes: bool,
    pub allow_git_commit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLongGoalParams {
    pub title: String,
    pub goal: String,
    pub workspace_path: String,
    pub engine_id: String,
    #[serde(default = "default_interval")]
    pub interval: String,
    #[serde(default = "default_true")]
    pub auto_pause_on_complete: bool,
    #[serde(default = "default_true")]
    pub allow_code_changes: bool,
    #[serde(default = "default_true")]
    pub allow_git_commit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongGoalDocuments {
    pub protocol: String,
    pub plan: String,
    pub progress: String,
    pub queue: String,
    pub supplement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongGoalState {
    pub config: LongGoalConfig,
    pub documents: LongGoalDocuments,
    pub goal_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendLongGoalSupplementParams {
    pub workspace_path: String,
    pub goal_id: String,
    pub content: String,
    #[serde(default)]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLongGoalStepParams {
    pub workspace_path: String,
    pub goal_id: String,
    pub step_id: String,
    pub summary: String,
    #[serde(default)]
    pub changed_files: Vec<String>,
    #[serde(default)]
    pub tests_run: Vec<String>,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub next_step: Option<String>,
    #[serde(default)]
    pub goal_status: Option<LongGoalStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteLongGoalParams {
    pub workspace_path: String,
    pub goal_id: String,
    pub completion_summary: String,
    #[serde(default)]
    pub remaining_risks: Vec<String>,
    #[serde(default)]
    pub review_suggestions: Vec<String>,
}

fn default_interval() -> String {
    "30m".to_string()
}

fn default_true() -> bool {
    true
}
