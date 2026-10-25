//! Demo capability（阶段 B：验证 dispatch 全链路）
//!
//! - `EchoCapability`（cap.echo）：原样返回 payload，验证 dispatch 请求/响应
//! - `FaultyCapability`（cap.faulty）：总是返回 Err，验证 dispatch.end 的 error 分支
//!
//! 两能力均为**测试夹具**，未注册生产总线（state.rs / bus_mcp_server.rs 注册块
//! 均无；仅 `router/mod.rs` 等 `#[cfg(test)]` 装配）——AI 经 cap_dispatch /
//! bus_dispatch 不可达。describe() 仅作夹具自描述（describe 契约归一后所有
//! Capability 一律经 standard_describe 声明），不构成 AI 可达协议。

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

    fn describe(&self) -> Value {
        // 无 action 分发（invoke 不读 action 键，任意 payload 原样回传）——
        // 动作键 "echo" 仅为文档占位（validate_describe 要求 actions 非空）。
        standard_describe(
            "cap.echo",
            "回显自检",
            "原样返回整个 payload 的 dispatch 链路自检夹具（无 action 分发）",
            Some(
                "测试夹具：未注册生产总线（仅 #[cfg(test)] 装配），AI 经 cap_dispatch / bus_dispatch 不可达",
            ),
            serde_json::json!({
                "echo": {
                    "params": {},
                    "returns": "与请求 payload 完全相同的 JSON 值（invoke 不读 action，任意字段原样回传）",
                }
            }),
        )
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

    fn describe(&self) -> Value {
        // 恒 Err 系夹具设计（无自我纠正语义可言）；动作键 "fail" 仅为文档占位
        // （invoke 不读 action，任意 payload 恒 Err）。
        standard_describe(
            "cap.faulty",
            "故障自检",
            "恒返回 Err 的 dispatch 错误分支自检夹具（验证 dispatch.end 的 error 路径）",
            Some(
                "测试夹具：未注册生产总线（仅 #[cfg(test)] 装配）；invoke 恒 Err: cap.faulty 总是失败",
            ),
            serde_json::json!({
                "fail": {
                    "params": {},
                    "returns": "（不可达）恒返回 Err（\"cap.faulty 总是失败\"）",
                }
            }),
        )
    }
}

// ───────────────────────── 单元测试 ─────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// describe 契约巡逻（2026-10-25 审计）：standard_describe 标准形状，
    /// validate_describe 零违例（夹具虽不进生产索引，形状一律合规）。
    #[test]
    fn echo_describe_contract() {
        let d = EchoCapability.describe();
        assert_eq!(d["id"], "cap.echo");
        assert_eq!(d["name"], "回显自检");
        let problems = crate::contracts::validate_describe("cap.echo", &d);
        assert!(
            problems.is_empty(),
            "cap.echo describe 契约违例: {problems:?}"
        );
    }

    #[test]
    fn faulty_describe_contract() {
        let d = FaultyCapability.describe();
        assert_eq!(d["id"], "cap.faulty");
        assert_eq!(d["name"], "故障自检");
        let problems = crate::contracts::validate_describe("cap.faulty", &d);
        assert!(
            problems.is_empty(),
            "cap.faulty describe 契约违例: {problems:?}"
        );
    }
}
