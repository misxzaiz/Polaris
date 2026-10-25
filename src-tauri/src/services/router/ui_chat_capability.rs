//! cap.ui.chat —— AI 控制对话渲染配置
//!
//! 与 cap.ui.theme 同架构位：状态真相在前端 `chatRenderStore`（Zustand + localStorage），
//! 本能力只校验 + 审计 + describe。效果经引擎 tool_call_start 事件落前端
//! （eventHandler 在 tool_call_start 分支消费，tool_call_end 不消费）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`   `{}` → 同步回包转发标记，当前渲染配置由前端消费侧应答
//! - `patch` `{ "config": { "fontSize": 18, "messageSpacing": "spacious", "contentWidth": 720, ... } }`
//! - `reset` `{}` → 恢复默认渲染配置
//!
//! 字段白名单（UNKNOWN 字段拒绝，防静默漂移）：fontSize / lineHeight /
//! paragraphSpacing / messageSpacing / contentWidth / codeFontSize /
//! inputFontSize / fontFamily —— 对齐前端真实消费的 ChatDisplaySettings
//! （src/types/config.ts）。不含工具块折叠 / Markdown 开关等字段。

use crate::contracts::{
    standard_describe, unsupported_action, AuditEntry, Capability, CapabilityId, Context, Value,
};

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
        ];
        for k in obj.keys() {
            if !KNOWN.contains(&k.as_str()) {
                // 错误即文档：列出合法字段集，AI 可自我纠正（审计 errorErgonomics）
                return Err(format!(
                    "cap.ui.chat 未知配置字段: {}（合法集: {}）",
                    k,
                    KNOWN.join(", ")
                ));
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
        Ok(())
    }
}

impl Capability for UiChatCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ui.chat".into())
    }

    fn describe(&self) -> Value {
        // 2026-10-25 审计归一：summary 删除 KNOWN 白名单外的「工具块折叠/Markdown 开关」
        // （patch 未知字段会被硬拒，照旧文案构造必失败）；patch.params 列全白名单 8 字段；
        // returns 改为实际同步回包形状（转发声明），效果由前端消费 tool_call_start 事件。
        standard_describe(
            "cap.ui.chat",
            "对话渲染",
            "控制对话渲染配置（正文字号/行高/段距/消息间距/内容宽度/代码与输入框字号/字体族）",
            Some("状态真相在前端 chatRenderStore，本能力只校验+审计+转发：同步回包是转发声明（{ ok, forwarded, capability, action, … }），真实效果由前端消费 tool_call_start 事件落 DOM。patch 字段白名单硬校验（未知字段拒绝）：fontSize/codeFontSize 限 (0, 64] 数值，messageSpacing 限 compact/comfortable/spacious，fontFamily 限 system/serif/mono；lineHeight/paragraphSpacing/contentWidth/inputFontSize 后端不校验类型、原样转发前端消费。"),
            serde_json::json!({
                "get": { "params": {}, "returns": "{ ok, forwarded, capability, action }（当前渲染配置由前端消费侧应答，不作为同步返回值）" },
                "patch": { "params": { "config": { "fontSize": "number?：(0, 64]", "lineHeight": "number?（后端不校验）", "paragraphSpacing": "number?（后端不校验）", "messageSpacing": "compact|comfortable|spacious（可省）", "contentWidth": "number?（后端不校验）", "codeFontSize": "number?：(0, 64]", "inputFontSize": "number?（后端不校验）", "fontFamily": "system|serif|mono（可省）" } }, "returns": "{ ok, forwarded, capability, action, config }（config 必填且至少含一个合法字段，空对象拒绝）" },
                "reset": { "params": {}, "returns": "{ ok, forwarded, capability, action }" }
            }),
        )
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
            other => Err(unsupported_action(
                "cap.ui.chat",
                other,
                &["get", "patch", "reset"],
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

    /// describe 契约测试：标准形状 + patch 白名单 8 字段全部入 describe
    /// （审计 high：summary 曾宣称 KNOWN 外的「工具块折叠/Markdown 开关」）
    #[test]
    fn describe_contract() {
        use crate::contracts::validate_describe;

        let cap = UiChatCapability;
        let d = cap.describe();
        let problems = validate_describe("cap.ui.chat", &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");

        const ACTIONS: [&str; 3] = ["get", "patch", "reset"];
        for action in ACTIONS {
            assert!(d["actions"].get(action).is_some(), "describe 缺动作 {action}");
        }
        // KNOWN 白名单 8 字段必须全部出现在 patch.params（文档面与实现同源）
        const KNOWN: [&str; 8] = [
            "fontSize",
            "lineHeight",
            "paragraphSpacing",
            "messageSpacing",
            "contentWidth",
            "codeFontSize",
            "inputFontSize",
            "fontFamily",
        ];
        for field in KNOWN {
            assert!(
                d["actions"]["patch"]["params"]["config"].get(field).is_some(),
                "describe patch.params.config 缺白名单字段 {field}"
            );
        }
        // 未知动作错误自纠文案列出全部合法动作
        let err = cap
            .invoke(serde_json::json!({"action": "boom"}), &ctx())
            .unwrap_err();
        for action in ACTIONS {
            assert!(err.contains(action), "错误文案缺合法动作 {action}: {err}");
        }
        assert!(err.contains("cap.help show target=cap.ui.chat"), "{err}");
    }
}