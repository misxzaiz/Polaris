/*! 统一 AI 引擎模块
 *
 * 提供统一的 AI 引擎接口，支持多种 AI CLI 工具：
 * - Claude Code
 * - OpenAI 兼容 API
 */

pub mod traits;
pub mod types;
pub mod session;
pub mod registry;
pub mod engine;
pub mod history;
pub mod history_claude;
pub mod event_parser;
pub mod adapters;
pub mod tools;

pub use traits::{EngineId, SessionOptions, HistoryEntry};
pub use registry::EngineRegistry;
pub use engine::ClaudeEngine;
pub use history::{
    Pagination, PagedResult, SessionMeta, HistoryMessage, SessionHistoryProvider,
};
pub use history_claude::ClaudeHistoryProvider;
