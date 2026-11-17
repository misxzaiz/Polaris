//! storage_exec —— 会话存储执行体（kernel-5k 方案 S3.3：物理域墙）
//!
//! 把 session_db / session_state / turn_persist / dialog_index / base(sqlite 底座)
//! 集中到本目录，为 storage-sqlite 插件接管做准备（plans/s3-storage-plugin-spec.md）。
//! 本 mod.rs 纯再导出：宿主消费方继续走 `crate::services::session_db` 等旧路径，
//! 零 diff；插件接管时整体移出本目录即可。

pub mod base;
pub mod dialog_index;
pub mod session_db;
pub mod session_state;
pub mod turn_persist;
