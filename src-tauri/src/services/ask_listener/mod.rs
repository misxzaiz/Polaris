//! Ask User Question — TCP Listener（K-R3 目录化拆分）
//!
//! 原 1,812 行单文件按职能拆为子模块；对外路径 `services::ask_listener::*`
//! 经 `pub use` 保持不变（消费方零改动）。详见各子模块与
//! `services::ask_mcp_server`（伴生进程侧）。

pub mod answers;
pub mod cancel;
pub mod dispatch;
pub mod emit;
pub mod form;
pub mod frames;
pub mod listener;
pub mod parsed;
pub mod plugin_card;
pub mod types;

pub use answers::{build_outcome_for_multiple_answers, AskAnswerEntry, FormAnswerEntry, PluginCardAnswerEntry};
pub use dispatch::{emit_dispatch_request, emit_event, register_dispatch_task, trigger_dispatch_continue, DispatchTaskParams};
pub use parsed::{parse_questions, ParsedOption, ParsedQuestion};
pub use emit::emit_plugin_card_event;
pub use listener::spawn_ask_listener;
pub use types::{AskListenerHandle, ASK_LISTENER_PORT_POOL, PluginCardOutcome, QuestionAnswerPayload, QuestionOutcome};
