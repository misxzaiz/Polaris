//! cap.ui.theme —— AI 控制主题（配色/设计 token）
//!
//! 架构位：AI 经 `bus_dispatch(target="cap.ui.theme")` 调本能力改界面主题。
//! 状态真相在前端 `themeStore`（Zustand，写 `--c-*` CSS 变量 + localStorage），
//! 本能力**不存状态**：只做参数校验 + 审计 + describe。
//!
//! 生效链路：AI 工具调用 → MCP `bus_dispatch` → RouterBus dispatch 本能力 →
//! 引擎发出 tool_call_end 事件（tool=cap.ui.theme, args=payload）→ 前端
//! eventHandler 解析 args → 调 `themeStore` 落 DOM + 持久化。三端（App/Web/桌面）
//! 同一事件管线。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`          `{}`                                  → 指示前端返回当前主题（`{ forwarded: true }`）
//! - `patch`        `{ "palette": { "primary": "#ff0", "background.base": "#111", ... } }` → 语义色 patch
//! - `applyPreset`  `{ "preset": "dark" | "light" | "spiderman" }`  → 切内置主题
//! - `listThemes`   `{}`                                  → 内置 + 用户主题（前端聚合）
//! - `setActive`    `{ "id": "<themeId>" }`               → 切到已存在主题
//! - `export`       `{}`                                  → 当前完整 ThemeDefinition
//! - `import`       `{ "theme": { ...ThemeDefinition } }` → 新建用户主题
//!
//! 语义色映射（palette 键 → 88 维度 token）是前端映射层的职责；后端只校验
//! 结构合法（object / 值非空），不引入第二套主题模型。

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Value};

/// cap.ui.theme —— 主题控制能力（无状态，前端为真相）
pub struct UiThemeCapability;

impl UiThemeCapability {
    /// 校验 palette 结构：非空对象、键非空、值非空字符串
    fn check_palette(palette: &Value) -> Result<(), String> {
        let obj = palette
            .as_object()
            .ok_or_else(|| "cap.ui.theme patch 需要 palette 对象".to_string())?;
        if obj.is_empty() {
            return Err("cap.ui.theme patch palette 不能为空".to_string());
        }
        for (k, v) in obj {
            if k.is_empty() {
                return Err("palette 键不能为空".to_string());
            }
            if !v.is_string() || v.as_str().is_none_or(|s| s.is_empty()) {
                return Err(format!("palette[{}] 必须是非空字符串", k));
            }
        }
        Ok(())
    }
}

impl Capability for UiThemeCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ui.theme".into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "控制应用主题配色（AI 改 88 维度设计 token / 切换内置主题）",
            "actions": {
                "get": { "params": {}, "returns": "前端应答当前主题", "note": "前端 store 为真相" },
                "patch": { "params": { "palette": "object：语义色键→CSS 色值" }, "returns": "{ applied: true }" },
                "applyPreset": { "params": { "preset": "dark|light|spiderman" }, "returns": "{ applied: string }" },
                "listThemes": { "params": {}, "returns": "内置+用户主题列表" },
                "setActive": { "params": { "id": "主题 id" }, "returns": "{ applied: id }" },
                "export": { "params": {}, "returns": "当前完整 ThemeDefinition" },
                "import": { "params": { "theme": "完整 ThemeDefinition" }, "returns": "{ installed: id }" }
            },
            "note": "状态在前端 themeStore；本能力只校验+审计，效果经 tool_call_end 事件落前端"
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.ui.theme 需要 action 参数".to_string())?;

        // 写类动作落域审计（读类不落）——事务内 append_audit（同 kv 写路径）
        let is_write = matches!(action, "patch" | "applyPreset" | "setActive" | "import");
        if is_write {
            if let Ok(mut txn) = ctx.storage().and_then(|s| s.begin()) {
                let _ = txn.append_audit(
                    "ui.theme",
                    &AuditEntry {
                        timestamp_ms: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        capability: CapabilityId("cap.ui.theme".into()),
                        source: ctx.source().clone(),
                        action: format!("ui.theme.{}", action),
                        prev_hash: String::new(),
                    },
                );
                let _ = txn.commit();
            }
        }

        match action {
            "get" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "to": "frontend" })),
            "patch" => {
                let palette = params
                    .get("palette")
                    .ok_or_else(|| "patch 需要 palette 参数".to_string())?;
                Self::check_palette(palette)?;
                Ok(serde_json::json!({
                    "ok": true,
                    "forwarded": true,
                    "capability": "cap.ui.theme",
                    "action": "patch",
                    "palette": palette,
                }))
            }
            "applyPreset" => {
                let preset = params
                    .get("preset")
                    .and_then(|p| p.as_str())
                    .filter(|s| matches!(*s, "dark" | "light" | "spiderman"))
                    .ok_or_else(|| "applyPreset preset 必须是 dark/light/spiderman".to_string())?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "applyPreset", "preset": preset }))
            }
            "listThemes" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "listThemes" })),
            "setActive" => {
                let id = params
                    .get("id")
                    .and_then(|i| i.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "setActive 需要 id 参数".to_string())?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "setActive", "id": id }))
            }
            "export" => Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "export" })),
            "import" => {
                let theme = params
                    .get("theme")
                    .ok_or_else(|| "import 需要 theme 参数".to_string())?;
                if !theme.is_object() {
                    return Err("import theme 必须是对象".to_string());
                }
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "import", "theme": theme }))
            }
            other => Err(format!("cap.ui.theme 不支持动作: {}", other)),
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
            caller: PluginId("cap.ui.theme".into()),
        }
    }

    #[test]
    fn get_forwards() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "get"}), &ctx()).unwrap();
        assert_eq!(r["forwarded"], true);
    }

    #[test]
    fn patch_requires_palette() {
        let cap = UiThemeCapability;
        assert!(cap.invoke(serde_json::json!({"action": "patch"}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": {}}), &ctx()).is_err());
    }

    #[test]
    fn patch_valid_palette_forwards() {
        let cap = UiThemeCapability;
        let r = cap
            .invoke(serde_json::json!({"action": "patch", "palette": {"primary": "#ff0", "text.muted": "#888"}}), &ctx())
            .unwrap();
        assert_eq!(r["action"], "patch");
        assert_eq!(r["palette"]["primary"], "#ff0");
    }

    #[test]
    fn apply_preset_validates() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "applyPreset", "preset": "dark"}), &ctx()).unwrap();
        assert_eq!(r["preset"], "dark");
        assert!(cap.invoke(serde_json::json!({"action": "applyPreset", "preset": "unknown"}), &ctx()).is_err());
    }

    #[test]
    fn unknown_action_errs() {
        let cap = UiThemeCapability;
        assert!(cap.invoke(serde_json::json!({"action": "explode"}), &ctx()).is_err());
    }
}