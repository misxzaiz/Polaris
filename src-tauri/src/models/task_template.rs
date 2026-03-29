//! Task Template Models
//!
//! Data models for document template system.

use serde::{Deserialize, Serialize};

// ============================================================================
// Variable Types
// ============================================================================

/// 变量类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum VariableType {
    #[default]
    String,
    Number,
    Date,
    Boolean,
    Select,
}

/// 模板变量定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVariable {
    /// 变量 ID
    pub id: String,
    /// 变量名称
    pub name: String,
    /// 变量类型
    #[serde(rename = "type")]
    pub var_type: VariableType,
    /// 默认值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// 是否必填
    #[serde(default)]
    pub required: bool,
    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 选项（type 为 select 时使用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

// ============================================================================
// Document Template
// ============================================================================

/// 模板文档文件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDocument {
    /// 文件名
    pub filename: String,
    /// 文件内容模板（支持变量占位符 {{variableName}}）
    pub content: String,
    /// 是否为主文档（优先传递给 AI）
    #[serde(default)]
    pub is_primary: bool,
    /// 文件描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 任务模板
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTemplate {
    /// 模板 ID
    pub id: String,
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 模板版本
    #[serde(default = "default_version")]
    pub version: String,
    /// 是否为内置模板
    #[serde(default)]
    pub builtin: bool,
    /// 模板图标
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 变量定义
    #[serde(default)]
    pub variables: Vec<TemplateVariable>,
    /// 文档模板集合
    pub documents: Vec<TemplateDocument>,
    /// 默认主文档文件名
    pub primary_document: String,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
    /// 作者
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

/// 创建模板参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateParams {
    /// 模板名称
    pub name: String,
    /// 模板描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 变量定义
    #[serde(default)]
    pub variables: Vec<TemplateVariable>,
    /// 文档模板集合
    pub documents: Vec<TemplateDocument>,
    /// 默认主文档文件名
    pub primary_document: String,
    /// 标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// 模板存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TemplateStore {
    pub templates: Vec<TaskTemplate>,
}
