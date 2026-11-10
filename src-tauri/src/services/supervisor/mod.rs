//! 插件服务生命周期基建与治理（needs 067/068 / 重构 spec）
//!
//! - [`job`]：Windows Job Object 收容所（宿主死亡 → OS 保证子进程全灭）。
//! - [`proc_kill`]：sysinfo 原生进程枚举与清杀（取代 wmic/taskkill 外部命令链）。
//! - [`reconciler`]：纯函数决策核心（期望 ↔ 账本 ↔ 观测 → 动作表，全单测）。
//! - [`registry`]：服务账本落盘（epoch 归属 + 诊断，非状态权威）。
//! - [`service`]：ServiceSupervisor 执行层（单写者 tick，唯一进程动作入口）。

pub mod job;
pub mod proc_kill;
pub mod reconciler;
pub mod registry;
pub mod service;

pub use service::{ServiceState, ServiceStatus, ServiceSupervisor, StartContext};
