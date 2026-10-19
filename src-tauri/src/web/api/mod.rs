pub mod auth;
pub mod files;
// git_dispatch.rs 已删（PR-1）：git_* 命令经 ipc.rs 路由臂转发 cap.git（RouterBus），
// 见 plans/git-panel-p0-spec.md。
pub mod health;
pub mod ipc;
pub mod settings;
pub mod ws;

pub use crate::web::error::WebError;
