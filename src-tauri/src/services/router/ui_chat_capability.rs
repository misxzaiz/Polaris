//! cap.ui.chat —— AI 控制对话渲染配置
//!
//! 与 cap.ui.theme 同架构位：状态真相在前端 `chatRenderStore`（Zustand + localStorage），
//! 本能力只校验 + 审计 + describe。效果经 tool_call_end 事件落前端。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`   `{}` → 前端应答当前 ChatConfig
//! - `patch` `{ "config": { "fontSize": 18, "messageGap": "16px", "toolCollapsed": false, ... } }`
//! - `reset` `{}` → 恢复默认渲染配置
//!
//! 字段集对齐 sky ChatConfig 中与 Polaris 渲染相关的子集（见前端 chatRenderStore）。

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Value};

/// cap.ui.chat —— 对话渲染配置能力（无状态，前端为真相）
pub struct UiChatCapability;

impl UiChatCapability {
    /// 校验 config 结构：非空对象、字段白名单、枚举/数值类型
    fn check_config(config: &Value) -> Result<(), String> {
        let obj = config
            .as_object()
            .ok_or_else(|| "cap.ui.chat patch 需要 config 对象".to_string())?;
        if obj.is_empty() {
            return Err("cap.ui.chat patch config 不能为空".to_string());
        }
        // 字段集对齐 front 端真实消费的 ChatDisplaySettings（src/types/config.ts）：
        // fontSize/lineHeight/paragraphSpacing/messageSpacing/codeFontSize/fontFamily 等。
        // AI 只 patch 其中子集；未知字段拒绝（防静默漂移）。
        const KNOWN: &[&str] = &[
            "fontSize", "lineHeight", "paragraphSpacing", "messageSpacing",
            "contentWidth", "codeFontSize", "inputFontSize", "fontFamily",
            "processBlockCollapse",
        ];
        for k in obj.keys() {
            if !KNOWN.contains(&k.as_str()) {
                return Err(format!("cap.ui.chat 未知配置字段: {}", k));
            }
        }
        if let Some(ts) = obj.get("messageSpacing") {
            let ts = ts.as_str().ok_or_else(|| "messageSpacing 必须是字符串".to_string())?;
            if !matches!(ts, "compact" | "comfortable" | "spacious") {
                return Err(format!("messageSpacing 必须是 compact/comfortable/spacious，收到 {}", ts));
            }
        }
        if let Some(fs) = obj.get("fontSize") {
            if !fs.is_number() || fs.as_f64().is_none_or(|f| f <= 0.0 || f > 64.0) {
                return Err("fontSize 必须是 (0, 64] 的数值".to_string());
            }
        }
        if let Some(f) = obj.get("fontFamily") {
            let f = f.as_str().ok_or_else(|| "fontFamily 必须是字符串".to_string())?;
            if !matches!(f, "system" | "serif" | "mono") {
                return Err(format!("fontFamily 必须是 system/serif/mono，收到 {}", f));
            }
        }
        if let Some(fs) = obj.get("codeFontSize") {
            if !fs.is_number() || fs.as_f64().is_none_or(|f| f <= 0.0 || f > 64.0) {
                return Err("codeFontSize 必须是 (0, 64] 的数值".to_string());
            }
        }
        if let Some(pc) = obj.get("processBlockCollapse") {
            let pc = pc.as_str().ok_or_else(|| "processBlockCollapse 必须是字符串".to_string())?;
            if !matches!(pc, "auto" | "legacy") {
                return Err(format!("processBlockCollapse 必须是 auto/legacy，收到 {}", pc));
            }
        }
        Ok(())
    }
}

impl Capability for UiChatCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ui.chat".into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "控制对话渲染配置（字号/消息宽度/工具块折叠/Markdown 开关）",
            "actions": {
                "get": { "params": {}, "returns": "前端应答当前 ChatConfig" },
                "patch": { "params": { "config": "object：渲染配置字段子集" }, "returns": "{ applied: true }" },
                "reset": { "params": {}, "returns": "{ reset: true }" }
            },
            "note": "状态在前端 chatRenderStore；字段白名单 + 类型校验在此层"
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.ui.chat 需要 action 参数".to_string())?;

        if matches!(action, "patch") {
            if let Ok(mut txn) = ctx.storage().and_then(|s| s.begin()) {
                let _ = txn.append_audit(
                    "ui.chat",
                    &AuditEntry {
                        timestamp_ms: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        capability: CapabilityId("cap.ui.chat".into()),
                        source: ctx.source().clone(),
                        action: "ui.chat.patch".to_string(),
                        prev_hash: String::new(),
                        detail: None,
                        duration_ms: None,
                    },
                );
                let _ = txn.commit();
            }
        }

        match action {
            "get" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.chat", "action": "get" })),
            "patch" => {
                let config = params
                    .get("config")
                    .ok_or_else(|| "patch 需要 config 参数".to_string())?;
                Self::check_config(config)?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.chat", "action": "patch", "config": config }))
            }
            "reset" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.chat", "action": "reset" })),
            other => Err(format!("cap.ui.chat 不支持动作: {}", other)),
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
        caller: PluginId,
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
            &self.caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn ctx() -> TestCtx {
        TestCtx {
            caller: PluginId("cap.ui.chat".into()),
        }
    }

    #[test]
    fn get_forwards() {
        let cap = UiChatCapability;
        let r = cap.invoke(serde_json::json!({"action": "get"}), &ctx()).unwrap();
        assert_eq!(r["forwarded"], true);
    }

    #[test]
    fn patch_requires_config() {
        let cap = UiChatCapability;
        assert!(cap.invoke(serde_json::json!({"action": "patch"}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "patch", "config": {}}), &ctx()).is_err());
    }

    #[test]
    fn patch_valid_config_forwards() {
        let cap = UiChatCapability;
        let r = cap
            .invoke(serde_json::json!({"action": "patch", "config": {"fontSize": 18, "messageSpacing": "spacious"}}), &ctx())
            .unwrap();
        assert_eq!(r["action"], "patch");
        assert_eq!(r["config"]["fontSize"], 18);
    }

    #[test]
    fn patch_rejects_unknown_field() {
        let cap = UiChatCapability;
        let r = cap.invoke(serde_json::json!({"action": "patch", "config": {"evil": true}}), &ctx());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("未知配置字段"));
    }

    #[test]
    fn patch_rejects_bad_enum() {
        let cap = UiChatCapability;
        assert!(cap.invoke(serde_json::json!({"action": "patch", "config": {"messageSpacing": "weird"}}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "patch", "config": {"fontFamily": "comic"}}), &ctx()).is_err());
    }

    #[test]
    fn unknown_action_errs() {
        let cap = UiChatCapability;
        assert!(cap.invoke(serde_json::json!({"action": "boom"}), &ctx()).is_err());
    }
}