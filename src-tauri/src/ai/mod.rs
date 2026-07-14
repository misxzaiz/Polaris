/*! 统一 AI 引擎模块
 *
 * 提供统一的 AI 引擎接口，支持多种 AI CLI 工具：
 * - Claude Code
 * - OpenAI Codex
 * - Simple AI
 * - Mimo Code (Mimocode)
 */

pub mod engine;
pub mod event_parser;
pub mod history;
pub mod history_claude;
pub mod history_codex;
pub mod registry;
pub mod session;
pub mod traits;
pub mod types;

pub use engine::ClaudeEngine;
pub use engine::CodexEngine;
pub use engine::MimocodeEngine;
pub use engine::SimpleAIEngine;
pub use history::{HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta};
pub use history_claude::ClaudeHistoryProvider;
pub use history_codex::CodexHistoryProvider;
pub use registry::EngineRegistry;
pub use traits::{
    EngineCapabilities, EngineDistribution, EngineId, EngineMetadata, EnvKeyMapping, HistoryEntry,
    ImageAttachment, PlatformBinary, SessionOptions,
};
