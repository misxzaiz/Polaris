//! form_flow —— 表单业务逻辑（挂起 / 提交 / 回执）
//!
//! 对应 `dev/docs/sky/step9-forms.md` 阶段 B：form 工具生成的 hold 元数据存储
//! 与 form_submit 提交的转发闭环。
//!
//! # 与 sky 的关键差异
//!
//! sky 的 form 工具返回 hold JSON 后 **chat_loop 挂起** 等待桥喂回；Polaris 这里
//! form 工具经 MCP 直接返回 hold JSON 作为 tool_result（引擎不挂起，AI 继续下一轮），
//! 用户提交后由前端 `router_dispatch("cap.ai.chat", { action: "form_submit", ... })`
//! 触发本模块的提交逻辑。字段原文只在服务端流转，AI 上下文只见 build_receipt。

use std::time::{Duration, Instant};

use crate::contracts::Value;
use crate::services::form_core::{build_receipt, expand_dot_paths, validate_fields};

/// 表单存活时长：超时后桥清理，迟到的提交被拒绝。
pub const FORM_WAIT_TIMEOUT_SECS: u64 = 600;

/// 表单元数据。`form_id` 之外全部由 form 工具（AI 声明）生成，存储于 AppState。
#[derive(Debug, Clone)]
pub struct FormHold {
    pub form_id: String,
    /// 定位会话 / 前端事件路由（可能为空，未绑定时提交降级拒绝）
    pub session_id: String,
    /// 目标能力（cap.todo / cap.kv / cap.context …）
    pub target: String,
    /// 目标动作（cap.todo 的 create 等）
    pub action: String,
    /// read 模式：full 或 none
    pub read: String,
    /// 字段 schema（AI 声明，前端据此渲染控件）
    pub fields: Vec<Value>,
    /// 创建时刻（超时清理用）
    pub created_at: Instant,
}

/// 从 form 工具参数构造 hold。
///
/// 返回 Err 时携带给 AI 的可读失败信息（字段 schema 非法等）。
pub fn build_hold(
    form_id: &str,
    session_id: &str,
    target: &str,
    action: &str,
    read: &str,
    fields: &Value,
) -> Result<FormHold, String> {
    if target.trim().is_empty() {
        return Err("缺少 target 参数（dispatch 目标 capability）".into());
    }
    validate_fields(fields)?;
    let fields_vec = fields
        .as_array()
        .cloned()
        .unwrap_or_default();
    let read_mode = match read {
        "none" => "none",
        _ => "full",
    };
    Ok(FormHold {
        form_id: form_id.to_string(),
        session_id: session_id.to_string(),
        target: target.trim().to_string(),
        action: action.to_string(),
        read: read_mode.to_string(),
        fields: fields_vec,
        created_at: Instant::now(),
    })
}

/// 提交表单：组 payload、转发目标、生成回执。
///
/// 返回 `(receipt, ok, reply)`——receipt 是可以安全喂给 AI 的文本，
/// reply 是目标能力的执行结果。调用方负责把 receipt 回显给 AI / 前端。
pub fn submit_form(
    hold: &FormHold,
    values: &Value,
    router: &dyn crate::contracts::Router,
) -> (String, bool, Result<Value, String>) {
    // 1. 点路径展开 + 注入 action
    let mut payload = expand_dot_paths(values);
    if !hold.action.is_empty() {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("action".into(), Value::String(hold.action.clone()));
        }
    }

    // 2. 原文转发目标 capability（敏感值只在这里流经，不进 AI 上下文）
    let exec_result: Result<Value, String> = {
        use crate::contracts::{Envelope, MsgId, Source, TraceId};
        let env = Envelope {
            id: MsgId(format!("form-exec-{}", uuid::Uuid::new_v4())),
            source: Source::Plugin {
                caller: crate::contracts::PluginId("cap.form".into()),
            },
            target: crate::contracts::CapabilityId(hold.target.clone()),
            payload,
            trace: TraceId(format!("form-exec-{}", uuid::Uuid::new_v4())),
        };
        match router.dispatch(env) {
            Ok(reply) => reply.result,
            Err(e) => Err(e),
        }
    };

    // 3. 生成回执（信任边界：AI 只见这份文本）
    let receipt = build_receipt(&hold.read, &hold.fields, values, &exec_result);
    let ok = exec_result.is_ok();
    (receipt, ok, exec_result)
}

/// 清理超时的表单（由表单工具生成后延迟清理，或提交后由 form_submit 触发）。
/// 返回被移除的 form_id 数量。
pub fn cleanup_expired(
    holds: &mut std::collections::HashMap<String, FormHold>,
) -> usize {
    let now = Instant::now();
    let before = holds.len();
    holds.retain(|_, h| now.duration_since(h.created_at) < Duration::from_secs(FORM_WAIT_TIMEOUT_SECS));
    before - holds.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_hold_rejects_bad_fields() {
        let err = build_hold("f1", "s1", "cap.todo", "create", "full", &json!([]));
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("fields"));
    }

    #[test]
    fn build_hold_accepts_valid() {
        let h = build_hold(
            "f2", "s1", "cap.todo", "create", "none",
            &json!([{"name": "content", "type": "string"}]),
        ).unwrap();
        assert_eq!(h.target, "cap.todo");
        assert_eq!(h.read, "none");
        assert_eq!(h.fields.len(), 1);
    }

    #[test]
    fn build_hold_read_defaults_full() {
        let h = build_hold("f3", "", "cap.kv", "", "", &json!([{"name": "a"}])).unwrap();
        assert_eq!(h.read, "full");
    }

    #[test]
    fn cleanup_removes_expired_only() {
        let mut holds = std::collections::HashMap::new();
        let mut old = build_hold("old", "", "cap.todo", "", "full", &json!([{"name": "a"}])).unwrap();
        old.created_at = Instant::now() - Duration::from_secs(601);
        let mut fresh = build_hold("fresh", "", "cap.todo", "", "full", &json!([{"name": "a"}])).unwrap();
        // fresh 保留
        holds.insert("old".into(), old);
        holds.insert("fresh".into(), fresh);
        let removed = cleanup_expired(&mut holds);
        assert_eq!(removed, 1);
        assert!(!holds.contains_key("old"));
        assert!(holds.contains_key("fresh"));
    }
}