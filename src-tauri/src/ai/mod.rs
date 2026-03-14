/**
 * 统一 AI 引擎模块
 *
 * 提供统一的 AI 引擎接口，支持多种 AI CLI 工具：
 * - Claude Code
 * - IFlow
 * - Codex
 * - OpenAI 兼容 API
 */

mod traits;
mod types;
mod session;
mod registry;
mod engine;
mod history;
mod history_claude;
mod history_iflow;
mod event_parser;

pub use traits::{AIEngine, EngineId, SessionOptions, HistoryEntry};
pub use types::{EngineStatus, EngineDescriptor};
pub use session::SessionManager;
pub use registry::EngineRegistry;
pub use engine::{ClaudeEngine, IFlowEngine, CodexEngine, OpenAIEngine, OpenAIProviderConfig};
pub use history::{
    Pagination, PagedResult, SessionMeta, HistoryMessage,
    ToolCallInfo, ToolResultInfo, TokenUsage, SessionHistoryProvider,
};
pub use history_claude::ClaudeHistoryProvider;
pub use history_iflow::IFlowHistoryProvider;
pub use event_parser::{EventParser, ToolCallManager};
