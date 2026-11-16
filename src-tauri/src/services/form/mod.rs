//! 表单域（K-R4 目录化拆分）：flow（hold/submit/skip 流程）、core（字段校验/合并）、
//! template（模板存取）。对外路径 `services::form_flow` / `services::form_core` /
//! `services::form_template` 经 `pub use` 保持不变（消费方零改动）。

pub mod flow;
pub mod core;
pub mod template;

pub use flow::{build_component_hold, build_hold, build_skip_receipt, cleanup_expired, submit_form, FormHold};
pub use core::*;
pub use template::*;
