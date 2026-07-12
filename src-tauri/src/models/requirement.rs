use serde::{Deserialize, Serialize};

/// 查询范围
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QueryScope {
    /// 仅当前工作区
    #[default]
    Workspace,
    /// 全部
    All,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Draft,
    #[default]
    Pending,
    Approved,
    Rejected,
    Executing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementPriority {
    Low,
    #[default]
    Normal,
    High,
    Urgent,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementSource {
    #[default]
    Ai,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequirementExecuteConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequirementItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: RequirementStatus,
    pub priority: RequirementPriority,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prototype_path: Option<String>,
    pub has_prototype: bool,
    pub generated_by: RequirementSource,
    pub generated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_config: Option<RequirementExecuteConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 所属工作区路径（None 表示无工作区关联）
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// 所属工作区名称（用于显示）
    #[serde(default)]
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementFileData {
    pub version: String,
    pub updated_at: String,
    pub requirements: Vec<RequirementItem>,
}

#[derive(Debug, Clone, Default)]
pub struct RequirementCreateParams {
    pub title: String,
    pub description: String,
    pub priority: Option<RequirementPriority>,
    pub tags: Option<Vec<String>>,
    pub has_prototype: Option<bool>,
    pub generated_by: Option<RequirementSource>,
    pub generator_task_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RequirementUpdateParams {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<RequirementStatus>,
    pub priority: Option<RequirementPriority>,
    pub tags: Option<Vec<String>>,
    pub prototype_path: Option<String>,
    pub has_prototype: Option<bool>,
    pub review_note: Option<String>,
    pub execute_config: Option<RequirementExecuteConfig>,
    pub execute_log: Option<String>,
    pub execute_error: Option<String>,
    pub generated_by: Option<RequirementSource>,
    pub session_id: Option<String>,
}
