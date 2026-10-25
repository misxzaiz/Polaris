//! cap.ui.theme —— AI 控制主题（配色/设计 token）
//!
//! 架构位：AI 经 `bus_dispatch(target="cap.ui.theme")` 调本能力改界面主题。
//! 状态真相在前端 `themeStore`（Zustand，写 `--c-*` CSS 变量 + localStorage），
//! 本能力**不存状态**：只做参数校验 + 审计 + describe。
//!
//! 生效链路：AI 工具调用 → MCP `bus_dispatch` → RouterBus dispatch 本能力 →
//! 引擎发出 tool_call_start 事件（tool=cap.ui.theme, args=payload）→ 前端
//! eventHandler 在 tool_call_start 分支消费（eventHandler.ts 唯一消费点）→
//! 调 `themeStore` 落 DOM + 持久化。三端（App/Web/桌面）同一事件管线。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`          `{}`                                  → 指示前端返回当前主题（`{ forwarded: true }`）
//! - `patch`        `{ "palette": { "primary": "#ff0", "background.base": "#111", ... } }` → 语义色 patch
//! - `applyPreset`  `{ "preset": "dark" | "light" }`  → 切内置主题
//! - `listThemes`   `{}`                                  → 内置 + 用户主题（前端聚合）
//! - `setActive`    `{ "id": "<themeId>" }`               → 切到已存在主题
//! - `export`       `{}`                                  → 当前完整 ThemeDefinition
//! - `import`       `{ "theme": { ...ThemeDefinition } }` → 新建用户主题
//! - `delete`       `{ "id": "<themeId>" }`               → 删除用户主题（前端拒绝内置）
//!
//! 语义色映射（palette 键 → 88 维度 token）是前端映射层的职责；后端只校验
//! 结构合法（object / 值非空），不引入第二套主题模型。

use crate::contracts::{
    standard_describe, unsupported_action, AuditEntry, Capability, CapabilityId, Context, Value,
};

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
        // 2026-10-25 审计归一：returns 改为实际同步回包形状（转发声明，非执行结果）；
        // 真实效果由前端在 tool_call_start 事件消费（eventHandler 唯一消费点）。
        standard_describe(
            "cap.ui.theme",
            "主题控制",
            "控制应用主题配色（AI patch 语义色 / 切换内置主题 / 导入导出用户主题）",
            Some("状态真相在前端 themeStore，本能力只校验+审计+转发：同步回包是转发声明（{ ok, forwarded, capability, action, … }），不是执行结果；真实效果由前端消费 tool_call_start 事件落 DOM（不发生在 tool_call_end）。写类动作（patch/applyPreset/setActive/import/delete）落域审计。"),
            serde_json::json!({
                "get": { "params": {}, "returns": "{ ok, forwarded, capability, to: \"frontend\" }（当前主题由前端消费侧应答，不作为同步返回值）" },
                "patch": { "params": { "palette": "object（必填，非空）：语义色键→CSS 色值字符串，如 primary→#ff0、text.muted→#888" }, "returns": "{ ok, forwarded, capability, action, palette }" },
                "applyPreset": { "params": { "preset": "dark|light（必填）" }, "returns": "{ ok, forwarded, capability, action, preset }" },
                "listThemes": { "params": {}, "returns": "{ ok, forwarded, capability, action }（内置+用户主题列表由前端消费侧聚合，不作为同步返回值）" },
                "setActive": { "params": { "id": "string（必填，非空）：目标主题 id" }, "returns": "{ ok, forwarded, capability, action, id }" },
                "export": { "params": {}, "returns": "{ ok, forwarded, capability, action }（当前完整 ThemeDefinition 由前端消费侧导出，不作为同步返回值）" },
                "import": { "params": { "theme": "object（必填）：完整或部分 ThemeDefinition；后端仅校验为对象，缺失维度由前端以 Dark 兜底补全（mergeThemes）" }, "returns": "{ ok, forwarded, capability, action, theme }" },
                "delete": { "params": { "id": "string（必填，非空）：用户主题 id（前端拒绝内置主题）" }, "returns": "{ ok, forwarded, capability, action, id }" }
            }),
        )
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.ui.theme 需要 action 参数".to_string())?;

        // 写类动作落域审计（读类不落）——事务内 append_audit（同 kv 写路径）
        let is_write = matches!(action, "patch" | "applyPreset" | "setActive" | "import" | "delete");
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
                        detail: None,
                        duration_ms: None,
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
                    .filter(|s| matches!(*s, "dark" | "light"))
                    .ok_or_else(|| "applyPreset preset 必须是 dark/light".to_string())?;
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
            "delete" => {
                let id = params
                    .get("id")
                    .and_then(|i| i.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "delete 需要 id 参数".to_string())?;
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "delete", "id": id }))
            }
            "import" => {
                let theme = params
                    .get("theme")
                    .ok_or_else(|| "import 需要 theme 参数".to_string())?;
                if !theme.is_object() {
                    return Err("import theme 必须是对象".to_string());
                }
                Ok(serde_json::json!({ "ok": true, "forwarded": true, "capability": "cap.ui.theme", "action": "import", "theme": theme }))
            }
            other => Err(unsupported_action(
                "cap.ui.theme",
                other,
                &[
                    "get",
                    "patch",
                    "applyPreset",
                    "listThemes",
                    "setActive",
                    "export",
                    "delete",
                    "import",
                ],
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
        assert!(cap.invoke(serde_json::json!({"action": "applyPreset"}), &ctx()).is_err());
    }

    #[test]
    fn list_themes_forwards() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "listThemes"}), &ctx()).unwrap();
        assert_eq!(r["action"], "listThemes");
    }

    #[test]
    fn set_active_validates_id() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "setActive", "id": "theme-1"}), &ctx()).unwrap();
        assert_eq!(r["id"], "theme-1");
        // 缺 id / 空 id 均拒绝
        assert!(cap.invoke(serde_json::json!({"action": "setActive"}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "setActive", "id": ""}), &ctx()).is_err());
    }

    #[test]
    fn export_forwards() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "export"}), &ctx()).unwrap();
        assert_eq!(r["action"], "export");
    }

    #[test]
    fn delete_validates_id() {
        let cap = UiThemeCapability;
        let r = cap.invoke(serde_json::json!({"action": "delete", "id": "theme-1"}), &ctx()).unwrap();
        assert_eq!(r["action"], "delete");
        assert_eq!(r["id"], "theme-1");
        // 缺 id / 空 id 均拒绝
        assert!(cap.invoke(serde_json::json!({"action": "delete"}), &ctx()).is_err());
        assert!(cap.invoke(serde_json::json!({"action": "delete", "id": ""}), &ctx()).is_err());
    }

    #[test]
    fn import_validates_theme_object() {
        let cap = UiThemeCapability;
        let r = cap.invoke(
            serde_json::json!({"action": "import", "theme": {"name": "x", "colors": {}}}),
            &ctx(),
        ).unwrap();
        assert_eq!(r["action"], "import");
        assert_eq!(r["theme"]["name"], "x");
        // 非对象 theme 拒绝
        assert!(cap.invoke(serde_json::json!({"action": "import", "theme": "nope"}), &ctx()).is_err());
        // 缺 theme 拒绝
        assert!(cap.invoke(serde_json::json!({"action": "import"}), &ctx()).is_err());
    }

    #[test]
    fn palette_must_be_nonempty_object_of_strings() {
        let cap = UiThemeCapability;
        // 非对象
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": ["#fff"]}), &ctx()).is_err());
        // 空对象
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": {}}), &ctx()).is_err());
        // 空键
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": {"": "#fff"}}), &ctx()).is_err());
        // 非字符串值
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": {"primary": 42}}), &ctx()).is_err());
        // 空字符串值
        assert!(cap.invoke(serde_json::json!({"action": "patch", "palette": {"primary": ""}}), &ctx()).is_err());
    }

    #[test]
    fn unknown_action_errs() {
        let cap = UiThemeCapability;
        assert!(cap.invoke(serde_json::json!({"action": "explode"}), &ctx()).is_err());
    }

    /// describe 契约测试：标准形状 + 动作集与实现 match 分支一致
    /// （审计 actionDrift：外部协议串曾漏 delete——此处以实现为锚自动跟随）
    #[test]
    fn describe_contract() {
        use crate::contracts::validate_describe;

        let cap = UiThemeCapability;
        let d = cap.describe();
        let problems = validate_describe("cap.ui.theme", &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");

        const ACTIONS: [&str; 8] = [
            "get",
            "patch",
            "applyPreset",
            "listThemes",
            "setActive",
            "export",
            "delete",
            "import",
        ];
        for action in ACTIONS {
            assert!(d["actions"].get(action).is_some(), "describe 缺动作 {action}");
        }
        // 未知动作错误自纠文案列出全部合法动作（错误即文档）
        let err = cap
            .invoke(serde_json::json!({"action": "explode"}), &ctx())
            .unwrap_err();
        for action in ACTIONS {
            assert!(err.contains(action), "错误文案缺合法动作 {action}: {err}");
        }
        assert!(err.contains("cap.help show target=cap.ui.theme"), "{err}");
    }
}