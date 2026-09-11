//! Demo capability（阶段 B：验证 dispatch 全链路）
//!
//! - `EchoCapability`（cap.echo）：原样返回 payload，验证 dispatch 请求/响应
//! - `FaultyCapability`（cap.faulty）：总是返回 Err，验证 dispatch.end 的 error 分支

use crate::contracts::*;

/// cap.echo：原样返回 payload
pub struct EchoCapability;

impl Capability for EchoCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.echo".into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        Ok(params)
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

/// cap.faulty：总是返回 Err，验证 dispatch.end 的 error 分支
pub struct FaultyCapability;

impl Capability for FaultyCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.faulty".into())
    }

    fn invoke(&self, _params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        Err("cap.faulty 总是失败".into())
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}