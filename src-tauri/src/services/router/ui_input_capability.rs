//! cap.ui.input —— AI 即时调节输入区（悬浮层参数 + 动态横幅）
//!
//! 与 cap.ui.theme / cap.ui.chat 同架构位：状态真相在前端 `inputUIStore`（Zustand），
//! 本能力只校验 + 审计 + describe。效果经引擎 tool_call_end 事件（uiDispatchService）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`   `{}` → 前端应答当前输入区 UI 状态
//! - `patch` `{ "config": { "floating": {...}, "showContextMeter": bool } }`
//! - `banner` `{ "banner": { "text": "...", "tone": "info|warn|success", "action": { "label": "...", "dispatch": {target,payload} } } }`
//!   → 在输入区上方注入一条动态横幅；`banner: null` 清除
//! - `reset` `{}` → 恢复默认（清横幅 + 复原悬浮层）
//!
//! 字段集（白名单校验，防静默漂移）：
//! - `floating.enabled`（bool：是否显示发送按钮上的悬浮浮窗）
//! - `floating.height`（number：悬浮浮窗高度上限 px）
//! - `floating.gap`（string：悬浮浮窗与输入框间距，rem/px）
//! - `showContextMeter`（bool：上下文用量条是否可见）

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Value};

/// cap.ui.input —— 输入区即时调节能力（无状态，前端为真相）
pub struct UiInputCapability;

impl UiInputCapability {
    /// 校验 config 结构：非空对象、字段白名单、类型校验。
    fn check_config(config: &Value) -> Result<(), String> {
        let obj = config
            .as_object()
            .ok_or_else(|| "cap.ui.input patch 需要 config 对象".to_string())?;
        if obj.is_empty() {
            return Err("cap.ui.input patch config 不能为空".to_string());
        }
        const KNOWN: &[&str] = &["floating", "showContextMeter"];
        for k in obj.keys() {
            if !KNOWN.contains(&k.as_str()) {
                return Err(format!("cap.ui.input 未知配置字段: {}", k));
            }
        }
        if let Some(f) = obj.get("floating") {
            let fobj = f
                .as_object()
                .ok_or_else(|| "floating 必须是对象".to_string())?;
            const FLOATING_KNOWN: &[&str] = &["enabled", "height", "gap"];
            for k in fobj.keys() {
                if !FLOATING_KNOWN.contains(&k.as_str()) {
                    return Err(format!("cap.ui.input floating 未知字段: {}", k));
                }
            }
            if let Some(en) = fobj.get("enabled") {
                if !en.is_boolean() {
                    return Err("floating.enabled 必须是布尔".to_string());
                }
            }
            if let Some(h) = fobj.get("height") {
                if !h.is_number() || h.as_f64().is_none_or(|x| x <= 0.0 || x > 1200.0) {
                    return Err("floating.height 必须是 (0, 1200] 的数值".to_string());
                }
            }
            if let Some(g) = fobj.get("gap") {
                if !g.is_string() {
                    return Err("floating.gap 必须是字符串".to_string());
                }
            }
        }
        if let Some(scm) = obj.get("showContextMeter") {
            if !scm.is_boolean() {
                return Err("showContextMeter 必须是布尔".to_string());
            }
        }
        Ok(())
    }

    /// 校验 banner 结构。
    fn check_banner(banner: &Value) -> Result<(), String> {
        if banner.is_null() {
            return Ok(()); // null = 清除
        }
        let obj = banner
            .as_object()
            .ok_or_else(|| "banner 必须是对象或 null".to_string())?;
        let text = obj
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if text.is_none() {
            return Err("banner.text 必填（非空字符串）".to_string());
        }
        if obj.get("text").and_then(Value::as_str).unwrap_or("").chars().count() > 500 {
            return Err("banner.text 过长（≤500 字符）".to_string());
        }
        if let Some(tone) = obj.get("tone").and_then(Value::as_str) {
            if !matches!(tone, "info" | "warn" | "success" | "danger") {
                return Err(format!("banner.tone 必须是 info/warn/success/danger，收到 {}", tone));
            }
        }
        if let Some(action) = obj.get("action") {
            let aobj = action
                .as_object()
                .ok_or_else(|| "banner.action 必须是对象".to_string())?;
            let label = aobj
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if label.is_none() {
                return Err("banner.action.label 必填".to_string());
            }
            if aobj.get("dispatch").is_some() {
                let d = aobj.get("dispatch").unwrap();
                let dobj = d
                    .as_object()
                    .ok_or_else(|| "banner.action.dispatch 必须是对象".to_string())?;
                if dobj
                    .get("target")
                    .and_then(Value::as_str)
                    .filter(|t| t.starts_with("cap.")).is_none()
                {
                    return Err("banner.action.dispatch.target 必须是 cap.*".to_string());
                }
            }
        }
        Ok(())
    }
}

impl Capability for UiInputCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ui.input".into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "即时调节输入区 UI（悬浮层参数 / 上下文条可见性 / 动态横幅）",
            "actions": {
                "get": { "params": {}, "returns": "前端应答当前输入区 UI 状态" },
                "patch": { "params": { "config": { "floating": { "enabled": "bool?", "height": "number?", "gap": "string?" }, "showContextMeter": "bool?" } }, "returns": "{ applied: true }" },
                "banner": { "params": { "banner": "object（text/tonne/action 见 actions.banner）或 null 清除横幅" }, "returns": "{ shown: true }" },
                "reset": { "params": {}, "returns": "{ reset: true }" }
            },
            "note": "状态在前端 inputUIStore；字段白名单 + 类型校验在此层。banner=null 清除横幅。效果经 tool_call_end 事件即时生效。"
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "cap.ui.input 需要 action 参数".to_string())?;

        // 业务写动作落审计（与 cap.ui.chat 同款：转发前记录轨迹）
        if matches!(action, "patch" | "banner" | "reset") {
            if let Ok(mut txn) = ctx.storage().and_then(|s| s.begin()) {
                let _ = txn.append_audit(
                    "ui.input",
                    &AuditEntry {
                        timestamp_ms: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        capability: CapabilityId("cap.ui.input".into()),
                        source: ctx.source().clone(),
                        action: format!("ui.input.{}", action),
                        prev_hash: String::new(),
                    },
                );
                let _ = txn.commit();
            }
        }

        match action {
            "get" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.input", "action": "get" })),
            "patch" => {
                let config = params
                    .get("config")
                    .ok_or_else(|| "patch 需要 config 参数".to_string())?;
                Self::check_config(config)?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.input", "action": "patch", "config": config }))
            }
            "banner" => {
                let banner = params
                    .get("banner")
                    .ok_or_else(|| "banner 需要 banner 参数（或 null 清除）".to_string())?;
                Self::check_banner(banner)?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.input", "action": "banner", "banner": banner }))
            }
            "reset" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.input", "action": "reset" })),
            other => Err(format!("cap.ui.input 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CapabilityId as CId, PluginId, Source};

    struct TestCtx {
        _caller: PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("no storage in test".into())
        }
        fn check_permission(&self, _req: &crate::contracts::PermissionRequest) -> Result<crate::contracts::PermissionVerdict, String> {
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
            _caller: PluginId("cap.ui.input".into()),
        }
    }

    #[test]
    fn patch_valid_config_forwards() {
        let cap = UiInputCapability;
        let r = cap
            .invoke(
                serde_json::json!({"action": "patch", "config": {"floating": {"enabled": true, "height": 400, "gap": "0.5rem"}, "showContextMeter": false}}),
                &ctx(),
            )
            .unwrap();
        assert_eq!(r["action"], "patch");
        assert_eq!(r["config"]["floating"]["enabled"], true);
    }

    #[test]
    fn patch_rejects_unknown_field() {
        let cap = UiInputCapability;
        assert!(cap.invoke(serde_json::json!({"action": "patch", "config": {"evil": true}}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "patch", "config": {"floating": {"bogus": 1}}}), &ctx()).is_err());
    }

    #[test]
    fn banner_requires_text_and_valid_tone() {
        let cap = UiInputCapability;
        assert!(cap.invoke(serde_json::json!({"action": "banner", "banner": {"text": ""}}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "banner", "banner": {"text": "hi", "tone": "evil"}}), &ctx()).is_err());
        // null = 清除，合法
        let r = cap.invoke(serde_json::json!({"action": "banner", "banner": null}), &ctx()).unwrap();
        assert_eq!(r["ok"], true);
    }

    #[test]
    fn banner_accepted_with_dispatch_action() {
        let cap = UiInputCapability;
        let r = cap
            .invoke(
                serde_json::json!({"action": "banner", "banner": {"text": "有新版本可用", "tone": "info", "action": {"label": "查看", "dispatch": {"target": "cap.help", "payload": {"action": "index"}}}}}),
                &ctx(),
            )
            .unwrap();
        assert_eq!(r["banner"]["action"]["dispatch"]["target"], "cap.help");
        // 非法 target 拒绝
        assert!(cap.invoke(
            serde_json::json!({"action": "banner", "banner": {"text": "x", "action": {"label": "go", "dispatch": {"target": "http://evil"}}}}),
            &ctx(),
        ).is_err());
    }

    #[test]
    fn unknown_action_errs() {
        let cap = UiInputCapability;
        assert!(cap.invoke(serde_json::json!({"action": "boom"}), &ctx()).is_err());
    }
}