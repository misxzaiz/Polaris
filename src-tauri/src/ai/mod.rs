/*! 统一 AI 引擎模块
 *
 * 提供统一的 AI 引擎接口，支持多种 AI CLI 工具：
 * - Claude Code
 * - OpenAI Codex
 * - Simple AI
 * - Pi
 */

pub mod traits;
pub mod types;
pub mod session;
pub mod registry;
pub mod engine;
pub mod history;
pub mod history_claude;
pub mod history_codex;
pub mod history_plugin;
pub mod event_parser;
pub mod launcher;

pub use traits::{
    EngineId, SessionOptions, HistoryEntry, ImageAttachment, EngineMetadata,
    EngineDistribution, EngineCapabilities, EnvKeyMapping, PlatformBinary, PiProviderConfig,
    PluginEngineConfig, EngineCliConfig, RpcProtocol, PluginEngineCapabilities,
    SessionFlags, ProviderConfigDeclaration, ProviderConfigFormat, McpConsumptionStrategy,
};
pub use registry::EngineRegistry;
pub use engine::ClaudeEngine;
pub use engine::CodexEngine;
pub use engine::SimpleAIEngine;
pub use engine::PiEngine;
pub use engine::PluginEngineRunner;
pub use engine::PluginProcessEngine;
pub use launcher::{McpSessionConfig, prepare_mcp_config, inject_mcp_into_session_opts, McpConfigParams};
pub use history::{
    Pagination, PagedResult, SessionMeta, HistoryMessage, SessionHistoryProvider,
};
pub use history_claude::ClaudeHistoryProvider;
pub use history_codex::CodexHistoryProvider;
pub use history_plugin::PluginHistoryProvider;
