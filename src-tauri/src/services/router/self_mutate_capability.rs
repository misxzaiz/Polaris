//! cap.self.mutate —— 自身管理·改造（具名 UI 部件插槽注入/替换/移除）
//!
//! 目标（goal 衍生）：「支持 AI 对自身任意操作和改造」的 UI 部件层。
//! 与 cap.ui.input 同架构位：状态真相在前端 `uiSlotStore`（Zustand），
//! 本能力只校验 + 审计 + describe。效果经引擎 tool_call_end 事件（uiDispatchService）。
//!
//! # 插槽模型
//!
//! 插槽 = **白名单具名组件挂载点**（`input-extra` / `app-badge` / `message-extra` 等），
//! 不是任意 HTML/脚本注入。AI 只能往已存在的具名插槽里放预置组件种类：
//! - `setSlot   { slotId, kind, props? }` → 往插槽放置组件（kind 白名单内）
//! - `clearSlot { slotId }`               → 移除插槽组件（回落空/内置）
//! - `listSlots {}`                       → 列出全部插槽与当前状态
//!
//! 安全边界：kind 必须在前端注册的 SLOT_KINDS 白名单内；props 顶层白名单校验。
//! 禁止任意 HTML/脚本字符串 —— 这是「改造」与「注入攻击」的分界线。

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Value};

/// 合法插槽 id 白名单（前端 uiSlotStore 注册的具名挂载点）
const SLOT_IDS: &[&str] = &["input-extra", "app-badge", "message-extra"];

/// 合法组件种类白名单（前端 SLOT_KINDS 注册表 —— 单一事实源在前端）
const SLOT_KINDS: &[&str] = &["status-badge", "tooltip-label", "quick-action"];

/// 组件 props 白名单（key 集合，容忍未知 props 但拒绝非对象）
const PROPS_KEYS: &[&str] = &["label", "text", "tone", "target", "height"];

/// cap.self.mutate —— 自身管理·改造（无状态，前端为真相）
pub struct SelfMutateCapability;

impl SelfMutateCapability {
    /// 校验 slot 操作参数
    fn check_slot_params(action: &str, params: &Value) -> Result<(), String> {
        let slot_id = params
            .get("slotId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "cap.self.mutate 需要非空 slotId".to_string())?;

        if !SLOT_IDS.contains(&slot_id) {
            return Err(format!(
                "cap.self.mutate 非法插槽: {}（合法集: {}）",
                slot_id,
                SLOT_IDS.join(", ")
            ));
        }

        match action {
            "setSlot" => {
                let kind = params
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty());
                let Some(kind) = kind else {
                    return Err("setSlot 需要非空 kind".to_string());
                };
                if !SLOT_KINDS.contains(&kind) {
                    return Err(format!(
                        "cap.self.mutate 非法组件种类: {}（合法集: {}）",
                        kind,
                        SLOT_KINDS.join(", ")
                    ));
                }
                // props 可选，但必须是对象且 key 在白名单内（防任意 payload 漂移）
                if let Some(props) = params.get("props") {
                    if !props.is_null() && !props.is_object() {
                        return Err("props 必须是对象或省略".to_string());
                    }
                    if let Some(obj) = props.as_object() {
                        for k in obj.keys() {
                            if !PROPS_KEYS.contains(&k.as_str()) {
                                return Err(format!(
                                    "cap.self.mutate props 未知字段: {}（合法集: {}）",
                                    k,
                                    PROPS_KEYS.join(", ")
                                ));
                            }
                        }
                    }
                }
            }
            "clearSlot" => {}
            _ => return Err(format!("cap.self.mutate 不支持动作: {}", action)),
        }
        Ok(())
    }

    /// 构造成功后回显的结构（前端消费）
    fn echo(action: &str, params: &Value) -> Value {
        serde_json::json!({
            "ok": true,
            "capability": "cap.self.mutate",
            "action": action,
            "slotId": params.get("slotId"),
            "kind": params.get("kind"),
        })
    }
}

impl Capability for SelfMutateCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.self.mutate".into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "自身管理·改造：具名 UI 部件插槽注入/替换/移除",
            "note": "插槽是白名单具名挂载点（input-extra/app-badge/message-extra），组件种类同样白名单（status-badge/tooltip-label/quick-action）；禁止任意 HTML/脚本注入。状态在前端 uiSlotStore，经 tool_call_end 事件即时生效。",
            "actions": {
                "listSlots": { "params": {}, "returns": "{ slots: [{ id, current: null | { kind, ts } }] }" },
                "setSlot": { "params": { "slotId": "input-extra|app-badge|message-extra（必填）", "kind": "status-badge|tooltip-label|quick-action（必填）", "props": "object?（可选，见 UI 注册表）" }, "returns": "{ ok, slotId, kind }" },
                "clearSlot": { "params": { "slotId": "input-extra|app-badge|message-extra（必填）" }, "returns": "{ ok, slotId }" }
            }
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "cap.self.mutate 需要 action 参数".to_string())?;

        match action {
            "listSlots" => {
                // 前端 store 为真相；此处仅转发动作，返回 { ok } 由前端应答
                Ok(serde_json::json!({
                    "ok": true,
                    "forwarded": true,
                    "capability": "cap.self.mutate",
                    "action": "listSlots",
                }))
            }
            "setSlot" | "clearSlot" => {
                SelfMutateCapability::check_slot_params(action, &params)?;
                // 写动作审计（同 cap.kv 事务模式：begin → append_audit → commit）
                // 只 append 不 commit 会在 Drop 时自动 ROLLBACK，审计记录丢失。
                if let Ok(mut txn) = ctx.storage().and_then(|s| s.begin()) {
                    let _ = txn.append_audit(
                        "self.mutate",
                        &AuditEntry {
                            timestamp_ms: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0),
                            capability: CapabilityId("cap.self.mutate".into()),
                            source: ctx.source().clone(),
                            action: format!("{}.{}", action, params.get("slotId").and_then(Value::as_str).unwrap_or("")),
                            prev_hash: String::new(),
                        },
                    );
                    // 审计写入失败不阻塞改造生效，但记录到日志便于追溯
                    if let Err(e) = txn.commit() {
                        tracing::warn!("[cap.self.mutate] 审计提交失败: {}", e);
                    }
                }
                Ok(SelfMutateCapability::echo(action, &params))
            }
            other => Err(format!("cap.self.mutate 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::contracts::{CapabilityId as CId, PermissionRequest, PluginId, Source, Storage};
    use std::sync::Arc;

    /// 测试 Context（对照 registry_capability 的 TestCtx）
    struct TestCtx {
        storage: Option<Arc<dyn Storage>>,
        _caller: PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn Storage, String> {
            match &self.storage {
                Some(s) => Ok(s.as_ref()),
                None => Err("no storage in test".into()),
            }
        }
        fn check_permission(
            &self,
            _req: &PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            static S: Source = Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &PluginId {
            &self._caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }
    fn ctx() -> TestCtx {
        TestCtx {
            storage: None,
            _caller: PluginId("cap.self.mutate".into()),
        }
    }

    #[test]
    fn set_slot_validates_kind_and_slot() {
        let cap = SelfMutateCapability;
        // 合法：input-extra + status-badge
        cap.invoke(
            json!({ "action": "setSlot", "slotId": "input-extra", "kind": "status-badge" }),
            &ctx(),
        )
        .unwrap();
        // 非法插槽
        assert!(cap
            .invoke(
                json!({ "action": "setSlot", "slotId": "evil-slot", "kind": "status-badge" }),
                &ctx()
            )
            .is_err());
        // 非法 kind
        assert!(cap
            .invoke(
                json!({ "action": "setSlot", "slotId": "input-extra", "kind": "<script>" }),
                &ctx()
            )
            .is_err());
        // 无 slotId
        assert!(cap
            .invoke(json!({ "action": "setSlot", "kind": "status-badge" }), &ctx())
            .is_err());
        // props 非对象
        assert!(cap
            .invoke(
                json!({ "action": "setSlot", "slotId": "input-extra", "kind": "status-badge", "props": "x" }),
                &ctx()
            )
            .is_err());
        // props 未知 key
        assert!(cap
            .invoke(
                json!({ "action": "setSlot", "slotId": "input-extra", "kind": "status-badge", "props": { "evil": 1 } }),
                &ctx()
            )
            .is_err());
    }

    #[test]
    fn clear_slot_validates_and_echoes() {
        let cap = SelfMutateCapability;
        let r = cap
            .invoke(json!({ "action": "clearSlot", "slotId": "input-extra" }), &ctx())
            .unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["slotId"], "input-extra");
        // 非法插槽
        assert!(cap
            .invoke(json!({ "action": "clearSlot", "slotId": "x" }), &ctx())
            .is_err());
    }

    #[test]
    fn list_slots_forwards() {
        let cap = SelfMutateCapability;
        let r = cap.invoke(json!({ "action": "listSlots" }), &ctx()).unwrap();
        assert_eq!(r["forwarded"], true);
        assert_eq!(r["action"], "listSlots");
    }

    #[test]
    fn unknown_action_rejected() {
        let cap = SelfMutateCapability;
        assert!(cap.invoke(json!({ "action": "nope" }), &ctx()).is_err());
    }
}