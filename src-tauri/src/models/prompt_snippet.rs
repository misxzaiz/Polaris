/*! 快捷片段数据模型
 *
 * 用户自定义的 prompt 模板片段，支持变量注入。
 */

use serde::{Deserialize, Serialize};

/// 片段变量类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SnippetVarType {
    /// 单行文本
    #[default]
    Text,
    /// 多行文本
    Textarea,
}

/// 片段变量定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetVariable {
    /// 变量键名（对应模板中的 {{key}}）
    pub key: String,
    /// 显示标签
    pub label: String,
    /// 变量类型
    #[serde(rename = "type")]
    pub var_type: SnippetVarType,
    /// 是否必填
    #[serde(default)]
    pub required: bool,
    /// 默认值
    #[serde(default)]
    pub default_value: Option<String>,
    /// 占位提示
    #[serde(default)]
    pub placeholder: Option<String>,
}

/// 快捷片段
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSnippet {
    /// 片段 ID
    pub id: String,
    /// 片段名称（也作为 /name 快捷调用）
    pub name: String,
    /// 描述
    #[serde(default)]
    pub description: Option<String>,
    /// 模板内容，支持 {{variable}} 占位符
    pub content: String,
    /// 用户定义的变量列表
    #[serde(default)]
    pub variables: Vec<SnippetVariable>,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

fn default_enabled() -> bool {
    true
}

/// 创建片段参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnippetParams {
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub variables: Vec<SnippetVariable>,
    pub enabled: Option<bool>,
}

/// 更新片段参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnippetParams {
    pub name: Option<String>,
    pub description: Option<String>,
    pub content: Option<String>,
    pub variables: Option<Vec<SnippetVariable>>,
    pub enabled: Option<bool>,
}

/// 片段存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnippetStore {
    pub version: String,
    pub snippets: Vec<PromptSnippet>,
}
