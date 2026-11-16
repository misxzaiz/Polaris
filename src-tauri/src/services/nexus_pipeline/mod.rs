//! 专家团编排流水线（K-R4 目录化拆分；原 1,073 行单文件）
//!
//! 对外路径 `services::nexus_pipeline::*` 经 `pub use` 保持不变（消费方零改动）。

mod agents;
mod advance;
mod dispatch;
mod persistence;
mod start;
mod types;

pub use agents::{load_agent_persona, load_roles};
pub use persistence::{load_pipeline, save_pipeline};
pub use start::start_roster;
pub use advance::on_dispatch_terminal;
pub use advance::{resolve_escalation, dispatch_group, emit_pipeline_update, list_pipelines};
pub use types::{AdvanceResult, Escalation, LaterGroup, LoopState, MemberState, RosterPipeline};
