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
use crate::services::form_core::{
    build_receipt, expand_dot_paths, normalize_payload_for_target, validate_fields,
};

/// 表单存活时长：超时后桥清理，迟到的提交被拒绝。
pub const FORM_WAIT_TIMEOUT_SECS: u64 = 600;

/// 表单目标能力白名单（阶段 E，安全兜底）。
///
/// 语义：**默认拒绝，仅白名单放行**——与全局权限矩阵（默认放行）方向相反，
/// 作为 form 工具这层的独立兜底。首个版本限数据域（kv / todo / context）；
/// cap.config 属管理面，后续阶段逐个放开。**放开即改这张表，不动架构。**
///
/// 双向拦截：拉起时（`handle_form_frame` 校验 target）与提交时（`submit_form`
/// 纵深防御）都会检查，防表单被篡改或绕过拉起校验。
pub const FORM_TARGET_WHITELIST: &[&str] = &["cap.kv", "cap.todo", "cap.context"];

/// 判断目标能力是否在表单白名单内（前缀不参与，精确匹配）。
pub fn target_allowed(target: &str) -> bool {
    FORM_TARGET_WHITELIST.contains(&target.trim())
}

/// 表单元数据。`form_id` 之外全部由 form 工具（AI 声明）生成，存储于 AppState。
#[derive(Debug, Clone)]
pub struct FormHold {
    pub form_id: String,
    /// 用户可见表单标题（可能为空）
    pub title: String,
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
    title: &str,
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
        title: title.to_string(),
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
    // 0. 白名单纵深防御：拉起时可能被绕过（如 hold 被篡改），提交时再兜底一次。
    //    不在白名单 → 构造失败回执，不转发目标能力。
    if !target_allowed(&hold.target) {
        let receipt = format!(
            "提交拒绝：目标能力 {} 不在表单白名单（{}）",
            hold.target,
            FORM_TARGET_WHITELIST.join(" / ")
        );
        let exec_result: Result<Value, String> = Err(receipt.clone());
        return (receipt, false, exec_result);
    }

    // 1. 点路径展开 + 字段名归一化（AI 声明的自由名 → 目标能力契约参数名）+ 注入 action
    let mut payload = expand_dot_paths(values);
    payload = normalize_payload_for_target(&hold.target, &payload, &hold.fields);
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
    fn target_allowed_permits_whitelist_only() {
        assert!(target_allowed("cap.kv"));
        assert!(target_allowed("cap.todo"));
        assert!(target_allowed("cap.context"));
        assert!(!target_allowed("cap.config"), "管理面目标必须拒绝");
        assert!(!target_allowed("cap.shell"), "未列名能力必须拒绝");
        assert!(!target_allowed(""), "空目标必须拒绝");
    }

    #[test]
    fn target_allowed_trims_whitespace() {
        assert!(target_allowed("  cap.kv  "));
        assert!(!target_allowed("  cap.config  "));
    }

    #[test]
    fn submit_form_rejects_non_whitelisted_target() {
        // 纵深防御：即使 hold 被篡改为非白名单 target，提交也应拒绝。
        let hold = build_hold(
            "f-evil", "s1", "cap.config", "write", "full",
            &json!([{"name": "a", "type": "string"}]),
            "恶意表单",
        ).unwrap();
        // build_hold 只校验 schema 与 target 非空，不校验白名单（拉起是校验点）。
        assert_eq!(hold.target, "cap.config");

        // 用一个永不调用的 dummy router —— 白名单拒绝不会走到 dispatch。
        struct DummyRouter;
        impl crate::contracts::Router for DummyRouter {
            fn dispatch(
                &self,
                _env: crate::contracts::Envelope,
            ) -> Result<crate::contracts::Reply, String> {
                unreachable!("白名单拒绝不应触发 dispatch")
            }
            fn subscribe(
                &self,
                _filter: crate::contracts::Filter,
            ) -> tokio::sync::mpsc::Receiver<crate::contracts::Event> {
                unreachable!("白名单拒绝不应触发 subscribe")
            }
            fn register_handle(
                &self,
                _cap: Box<dyn crate::contracts::Capability>,
            ) -> Result<crate::contracts::CapabilityHandle, String> {
                unreachable!("白名单拒绝不应触发 register_handle")
            }
        }

        let (receipt, ok, reply) = submit_form(&hold, &json!({"a": "1"}), &DummyRouter);
        assert!(!ok, "非白名单提交必须失败");
        assert!(reply.is_err());
        assert!(receipt.contains("cap.config"), "回执应指明被拒目标: {}", receipt);
    }

    #[test]
    fn build_hold_rejects_bad_fields() {
        let err = build_hold("f1", "s1", "cap.todo", "create", "full", &json!([]), "标题").unwrap_err();
        assert!(err.contains("fields"));
    }

    #[test]
    fn build_hold_accepts_valid() {
        let h = build_hold(
            "f2", "s1", "cap.todo", "create", "none",
            &json!([{"name": "content", "type": "string"}]),
            "标题",
        ).unwrap();
        assert_eq!(h.target, "cap.todo");
        assert_eq!(h.read, "none");
        assert_eq!(h.fields.len(), 1);
    }

    #[test]
    fn build_hold_read_defaults_full() {
        let h = build_hold("f3", "", "cap.kv", "", "", &json!([{"name": "a"}]), "标题").unwrap();
        assert_eq!(h.read, "full");
    }

    #[test]
    fn cleanup_removes_expired_only() {
        let mut holds = std::collections::HashMap::new();
        let mut old = build_hold("old", "", "cap.todo", "", "full", &json!([{"name": "a"}]), "标题").unwrap();
        old.created_at = Instant::now() - Duration::from_secs(601);
        let mut fresh = build_hold("fresh", "", "cap.todo", "", "full", &json!([{"name": "a"}]), "标题").unwrap();
        // fresh 保留
        holds.insert("old".into(), old);
        holds.insert("fresh".into(), fresh);
        let removed = cleanup_expired(&mut holds);
        assert_eq!(removed, 1);
        assert!(!holds.contains_key("old"));
        assert!(holds.contains_key("fresh"));
    }
}