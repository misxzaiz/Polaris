pub mod auth;
pub mod files;
// git_dispatch.rs 已删（PR-1）；Git 域整体出仓后（2026-11-12）ipc.rs 的 git_* 转发臂
// 与 cap.git 一并删除，Git 数据由 polaris-git 插件服务提供。原说明：
// 见 plans/git-panel-p0-spec.md。
pub mod health;
pub mod ipc;
pub mod settings;
pub mod ws;

pub use crate::web::error::WebError;
