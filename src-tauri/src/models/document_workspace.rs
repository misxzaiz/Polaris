//! Document Workspace Models
//!
//! Data models for task document workspace system.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Document Types
// ============================================================================

/// 文档类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DocumentType {
    #[default]
    Task,
    User,
    Memory,
    Custom,
}

/// 工作区文档
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    /// 文件名
    pub filename: String,
    /// 文档类型
    #[serde(rename = "type")]
    pub doc_type: DocumentType,
    /// 文档内容
    pub content: String,
    /// 是否为主文档
    #[serde(default)]
    pub is_primary: bool,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

// ============================================================================
// Variable Instance
// ============================================================================

/// 变量实例值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableInstance {
    /// 变量 ID（对应模板变量）
    pub variable_id: String,
    /// 变量名
    pub name: String,
    /// 当前值
    pub value: String,
    /// 是否来自模板
    #[serde(default)]
    pub from_template: bool,
}

// ============================================================================
// Execution History
// ============================================================================

/// 执行摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSummary {
    /// 执行时间
    pub timestamp: String,
    /// 执行状态
    pub status: String,
    /// 执行时长（秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// 简要说明
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 是否有用户补充
    #[serde(default)]
    pub has_user_supplement: bool,
}

// ============================================================================
// Document Workspace
// ============================================================================

/// 文档工作区
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWorkspace {
    /// 工作区 ID（与任务 ID 相同）
    pub id: String,
    /// 关联的任务 ID
    pub task_id: String,
    /// 使用的模板 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// 文档列表
    pub documents: Vec<WorkspaceDocument>,
    /// 主文档文件名
    pub primary_document: String,
    /// 变量实例
    #[serde(default)]
    pub variables: Vec<VariableInstance>,
    /// 执行历史摘要
    #[serde(default)]
    pub execution_history: Vec<ExecutionSummary>,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

/// 创建工作区参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceParams {
    /// 任务 ID
    pub task_id: String,
    /// 使用的模板 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// 初始变量值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_variables: Option<HashMap<String, String>>,
}

/// 更新工作区参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceParams {
    /// 模板 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// 文档列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documents: Option<Vec<WorkspaceDocument>>,
    /// 主文档文件名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_document: Option<String>,
    /// 变量实例
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variables: Option<Vec<VariableInstance>>,
}

// ============================================================================
// Render Result
// ============================================================================

/// 渲染后的文档
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDocument {
    /// 文件名
    pub filename: String,
    /// 渲染后的内容
    pub content: String,
    /// 是否为主文档
    #[serde(default)]
    pub is_primary: bool,
}

/// 渲染结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    /// 渲染后的文档列表
    pub documents: Vec<RenderedDocument>,
    /// 变量映射
    pub variables: HashMap<String, String>,
    /// 主文档
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_document: Option<RenderedDocument>,
}
