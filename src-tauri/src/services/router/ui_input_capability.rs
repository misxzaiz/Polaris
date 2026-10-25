//! cap.ui.input —— AI 即时调节输入区（悬浮层参数 + 动态横幅）
//!
//! 与 cap.ui.theme / cap.ui.chat 同架构位：状态真相在前端 `inputUIStore`（Zustand），
//! 本能力只校验 + 审计 + describe。效果经引擎 tool_call_start 事件（uiDispatchService，
//! eventHandler 在 tool_call_start 分支消费，tool_call_end 不消费）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`   `{}` → 同步回包转发标记，当前输入区 UI 状态由前端消费侧应答
//! - `patch` `{ "config": { "floating": {...}, "showContextMeter": bool } }`
//! - `banner` `{ "banner": { "text": "...", "tone": "info|warn|success|danger", "action": { "label": "...", "dispatch": {target,payload} } } }`
//!   → 在输入区上方注入一条动态横幅；`banner: null` 清除
//! - `reset` `{}` → 恢复默认（清横幅 + 复原悬浮层）
//!
//! 字段集（白名单校验，防静默漂移）：
//! - `floating.enabled`（bool：是否显示发送按钮上的悬浮浮窗）
//! - `floating.height`（number：悬浮浮窗高度上限 px）
//! - `floating.gap`（string：悬浮浮窗与输入框间距，rem/px）
//! - `showContextMeter`（bool：上下文用量条是否可见）

use crate::contracts::{
    standard_describe, unsupported_action, AuditEntry, Capability, CapabilityId, Context, Value,
};

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
                // 错误即文档：列出合法字段集（审计 errorErgonomics）
                return Err(format!(
                    "cap.ui.input 未知配置字段: {}（合法集: {}）",
                    k,
                    KNOWN.join(", ")
                ));
            }
        }
        if let Some(f) = obj.get("floating") {
            let fobj = f
                .as_object()
                .ok_or_else(|| "floating 必须是对象".to_string())?;
            const FLOATING_KNOWN: &[&str] = &["enabled", "height", "gap"];
            for k in fobj.keys() {
                if !FLOATING_KNOWN.contains(&k.as_str()) {
                    return Err(format!(
                        "cap.ui.input floating 未知字段: {}（合法集: {}）",
                        k,
                        FLOATING_KNOWN.join(", ")
                    ));
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
        // 2026-10-25 审计归一：修正 banner 参数「tonne」拼写错误并写全约束
        // （text 必填 ≤500 / tone 枚举 / action.label 必填 / dispatch.target 须 cap.*），
        // returns 改为实际同步回包形状，效果消费点改为 tool_call_start。
        standard_describe(
            "cap.ui.input",
            "输入区调节",
            "即时调节输入区 UI（悬浮层参数 / 上下文用量条可见性 / 动态横幅）",
            Some("状态真相在前端 inputUIStore，本能力只校验+审计+转发：同步回包是转发声明（{ ok, forwarded, capability, action, … }），真实效果由前端消费 tool_call_start 事件即时生效。banner=null 清除横幅。字段白名单硬校验（未知字段拒绝）。"),
            serde_json::json!({
                "get": { "params": {}, "returns": "{ ok, forwarded, capability, action }（当前输入区 UI 状态由前端消费侧应答，不作为同步返回值）" },
                "patch": { "params": { "config": { "floating": { "enabled": "bool?：悬浮浮窗开关", "height": "number?：(0, 1200] px", "gap": "string?：浮窗与输入框间距（rem/px）" }, "showContextMeter": "bool?：上下文用量条可见性" } }, "returns": "{ ok, forwarded, capability, action, config }（config 必填且至少含一个合法字段，空对象拒绝）" },
                "banner": { "params": { "banner": "object 或 null（null=清除横幅）：text 必填（非空，≤500 字符）；tone 可选，枚举 info/warn/success/danger；action 可选但提供时 label 必填，action.dispatch 可选、target 必须以 cap.* 开头" }, "returns": "{ ok, forwarded, capability, action, banner }" },
                "reset": { "params": {}, "returns": "{ ok, forwarded, capability, action }" }
            }),
        )
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
                        detail: None,
                        duration_ms: None,
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
            other => Err(unsupported_action(
                "cap.ui.input",
                other,
                &["get", "patch", "banner", "reset"],
            )),
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

    /// describe 契约测试：标准形状 + banner 约束写全（审计：tonne 拼写错误、
    /// tone 枚举/text≤500/label 必填/dispatch.target 约束此前未进任何文档面）
    #[test]
    fn describe_contract() {
        use crate::contracts::validate_describe;

        let cap = UiInputCapability;
        let d = cap.describe();
        let problems = validate_describe("cap.ui.input", &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");

        const ACTIONS: [&str; 4] = ["get", "patch", "banner", "reset"];
        for action in ACTIONS {
            assert!(d["actions"].get(action).is_some(), "describe 缺动作 {action}");
        }
        // 「tonne」拼写错误已修正，tone 枚举四值写全
        let banner_desc = d["actions"]["banner"]["params"]["banner"].as_str().unwrap();
        assert!(!banner_desc.contains("tonne"), "banner 参数仍有 tonne 拼写错误");
        for tone in ["info", "warn", "success", "danger"] {
            assert!(banner_desc.contains(tone), "banner 约束缺 tone 枚举值 {tone}");
        }
        // 未知动作错误自纠文案列出全部合法动作
        let err = cap
            .invoke(serde_json::json!({"action": "boom"}), &ctx())
            .unwrap_err();
        for action in ACTIONS {
            assert!(err.contains(action), "错误文案缺合法动作 {action}: {err}");
        }
        assert!(err.contains("cap.help show target=cap.ui.input"), "{err}");
    }
}