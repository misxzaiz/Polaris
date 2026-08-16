/*! Compaction Capability Seam
 *
 * 定义对话历史压缩的核心接口，不依赖具体实现（默认摘要/智能压缩/远程压缩）。
 *
 * 参考设计：deepseek-harness `dsh-compaction` + `dsh-compaction-basic`。
 *
 * 默认 Provider：`DefaultCompactionProvider`（从 messageCompactor 逻辑迁移）。
 * 插件可通过 toolProvider 覆盖（capability: "compaction"）。
 */

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 压缩能力抽象 trait
#[async_trait]
pub trait CompactionCapability: Send + Sync {
    /// 判断当前上下文是否需要压缩
    async fn should_compact(&self, context: &CompactionContext) -> bool;

    /// 执行压缩，返回压缩后的摘要
    async fn compact(&self, context: &CompactionContext) -> Result<CompactionResult>;
}

/// 压缩上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionContext {
    pub session_id: String,
    pub message_count: usize,
    pub total_tokens: usize,
    pub max_tokens: usize,
    pub messages: Vec<CompactionMessage>,
}

/// 压缩用消息（简化版）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_count: Option<usize>,
}

/// 压缩结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    pub summary: String,
    pub compressed_count: usize,
    pub saved_tokens: usize,
}
