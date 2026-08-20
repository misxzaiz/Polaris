/*! AI 引擎实现
 */

mod claude;
mod codex;
pub mod codex_parser;
pub mod dsh;
pub mod mcp_bridge;
mod pi;
pub mod plugin_engine;
pub mod plugin_process_engine;
pub(crate) mod pi_parser;
pub(crate) mod simple_ai;
pub(crate) mod simple_ai_protocol;
pub use claude::ClaudeEngine;
pub use codex::CodexEngine;
pub use dsh::DshEngine;
pub use pi::PiEngine;
pub use plugin_engine::PluginEngineRunner;
pub use plugin_process_engine::PluginProcessEngine;
pub use simple_ai::SimpleAIEngine;
