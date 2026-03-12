/**
 * 会话历史抽象模块
 *
 * 提供统一的会话历史查询接口，支持分页。
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::Result;

/// 分页参数
#[derive(Debug, Clone, Deserialize)]
pub struct Pagination {
    /// 页码（从 1 开始）
    pub page: usize,
    /// 每页数量
    pub page_size: usize,
}

impl Default for Pagination {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: 50,
        }
    }
}

impl Pagination {
    /// 创建新的分页参数
    pub fn new(page: usize, page_size: usize) -> Self {
        Self { page, page_size }
    }

    /// 计算跳过的数量
    pub fn skip(&self) -> usize {
        self.page.saturating_sub(1) * self.page_size
    }

    /// 计算获取的数量
    pub fn take(&self) -> usize {
        self.page_size
    }
}

/// 分页结果
#[derive(Debug, Clone, Serialize)]
pub struct PagedResult<T> {
    /// 数据列表
    pub items: Vec<T>,
    /// 总数量
    pub total: usize,
    /// 当前页码
    pub page: usize,
    /// 每页数量
    pub page_size: usize,
    /// 总页数
    pub total_pages: usize,
}

impl<T> PagedResult<T> {
    /// 创建分页结果
    pub fn new(items: Vec<T>, total: usize, page: usize, page_size: usize) -> Self {
        let total_pages = if page_size > 0 {
            (total + page_size - 1) / page_size
        } else {
            1
        };

        Self {
            items,
            total,
            page,
            page_size,
            total_pages,
        }
    }

    /// 创建空结果
    pub fn empty(page: usize, page_size: usize) -> Self {
        Self::new(vec![], 0, page, page_size)
    }
}

/// 统一的会话元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// 会话 ID
    pub session_id: String,
    /// 引擎 ID
    pub engine_id: String,
    /// 项目路径
    pub project_path: Option<String>,
    /// 创建时间
    pub created_at: Option<String>,
    /// 更新时间
    pub updated_at: Option<String>,
    /// 消息数量
    pub message_count: Option<usize>,
    /// 摘要（第一条用户消息的截断）
    pub summary: Option<String>,
    /// 额外信息（引擎特定）
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// 统一的历史消息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    /// 消息 ID
    pub message_id: Option<String>,
    /// 角色: user, assistant, system, tool
    pub role: String,
    /// 消息内容
    pub content: String,
    /// 时间戳
    pub timestamp: Option<String>,
    /// 工具调用（如果有）
    pub tool_calls: Option<Vec<ToolCallInfo>>,
    /// 工具调用结果（如果有）
    pub tool_result: Option<ToolResultInfo>,
    /// Token 使用情况
    pub usage: Option<TokenUsage>,
}

/// 工具调用信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInfo {
    /// 工具 ID
    pub tool_id: String,
    /// 工具名称
    pub tool_name: String,
    /// 工具参数（JSON 字符串）
    pub arguments: Option<String>,
}

/// 工具调用结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultInfo {
    /// 工具 ID
    pub tool_id: String,
    /// 工具名称
    pub tool_name: Option<String>,
    /// 执行结果
    pub output: Option<String>,
    /// 是否成功
    pub success: bool,
}

/// Token 使用情况
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// 输入 Token
    pub input_tokens: u64,
    /// 输出 Token
    pub output_tokens: u64,
}

/// 会话历史提供者 Trait
pub trait SessionHistoryProvider: Send + Sync {
    /// 引擎 ID
    fn engine_id(&self) -> &'static str;

    /// 列出会话（支持分页）
    fn list_sessions(
        &self,
        work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>>;

    /// 获取会话历史（支持分页）
    fn get_session_history(
        &self,
        session_id: &str,
        pagination: Pagination,
    ) -> Result<PagedResult<HistoryMessage>>;

    /// 获取单条消息
    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>>;

    /// 删除会话
    fn delete_session(&self, session_id: &str) -> Result<()>;
}
