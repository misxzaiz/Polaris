/*! SubAgent Capability Seam
 *
 * 定义子代理派发的核心接口，不依赖具体实现（本地 spawn/远程/DSH fork）。
 *
 * 参考设计：deepseek-harness `dsh-subagent` + spawn/fork provider。
 *
 * 默认 Provider：`DefaultSubAgentProvider`（从 DispatchAgentTool 迁移）。
 * 插件可通过 toolProvider 覆盖（capability: "subagent"）。
 */

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 子代理能力抽象 trait
#[async_trait]
pub trait SubAgentCapability: Send + Sync {
    /// 派发子代理任务
    async fn dispatch(&self, task: SubAgentTask) -> Result<SubAgentResult>;

    /// 检查子代理状态
    async fn check_status(&self, task_id: &str) -> Result<SubAgentStatus>;
}

/// 子代理任务
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentTask {
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub mcp_servers: Vec<McpServerConfig>,
    pub max_depth: u32,
}

/// MCP server 配置（简化版）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
}

/// 子代理结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentResult {
    pub task_id: String,
    pub output: String,
    pub success: bool,
}

/// 子代理状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubAgentStatus {
    Running,
    Completed,
    Failed { error: String },
}
