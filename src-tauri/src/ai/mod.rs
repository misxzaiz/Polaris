/*! 统一 AI 引擎模块
 *
 * 提供统一的 AI 引擎接口，支持多种 AI CLI 工具：
 * - Claude Code
 * - OpenAI 兼容 API
 */

mod traits;
mod types;
mod session;
mod registry;
mod engine;
mod history;
mod history_claude;
mod event_parser;

pub use traits::{EngineId, SessionOptions, HistoryEntry};
pub use registry::EngineRegistry;
pub use engine::{ClaudeEngine, OpenAIEngine};
pub use history::{
    Pagination, PagedResult, SessionMeta, HistoryMessage, SessionHistoryProvider,
};
pub use history_claude::ClaudeHistoryProvider;
