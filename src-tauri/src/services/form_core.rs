//! form_core —— 表单共享业务核（纯函数，可独立单测）
//!
//! 对应 `dev/docs/sky/step9-forms.md` 阶段 A：AI ↔ 用户的结构化输入闭环的
//! 三个纯函数信任边界。从 sky（`plugins/tools/form.rs` + `ai/form_bridge.rs`）
//! 提取移植，去 Tool trait 依赖，统一使用 `contracts::Value`。
//!
//! # 信任边界
//!
//! 字段原文只在服务端流转，AI 上下文只见 `build_receipt` 生成的文本。
//! 三态 read 模式由服务端强制，不是提示词约束：
//! - `read = "full"`（默认）：AI 可读全部字段值，secret 类型仍掩码
//! - `read = "none"`：AI 只见字段名列表，值全部 `<已隐藏>`
//! - `secret` 字段无论模式一律掩码

use crate::contracts::Value;

/// 校验 fields schema（纯函数，供表单工具与单测复用）
///
/// 规则（最小化，与 sky 对齐）：
/// - fields 必须是非空数组
/// - 每个字段必须有非空 name
/// - select 类型必须带非空 options 数组
/// - 未知 type 不报错（前端回落 string 渲染）
pub fn validate_fields(fields: &Value) -> Result<(), String> {
    let arr = fields
        .as_array()
        .ok_or("fields 必须是数组")?;
    if arr.is_empty() {
        return Err("fields 不能为空".into());
    }
    for (i, f) in arr.iter().enumerate() {
        let name = f
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if name.is_empty() {
            return Err(format!("fields[{}] 缺少 name", i));
        }
        let ty = f.get("type").and_then(|v| v.as_str()).unwrap_or("string");
        if ty == "select" {
            let has_opts = f
                .get("options")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !has_opts {
                return Err(format!("fields[{}] type=select 需要 options 数组", i));
            }
        }
    }
    Ok(())
}

/// 点路径展开：`{"a.b": 1, "a.c": 2, "d": 3}` → `{"a": {"b": 1, "c": 2}, "d": 3}`
///
/// 无点路径的 key 原样保留；空段跳过。
pub fn expand_dot_paths(flat: &Value) -> Value {
    let obj = match flat.as_object() {
        Some(o) => o,
        None => return flat.clone(),
    };
    let mut root = serde_json::Map::new();
    for (k, v) in obj {
        let segments: Vec<&str> = k.split('.').filter(|s| !s.is_empty()).collect();
        if segments.len() <= 1 {
            root.insert(k.clone(), v.clone());
            continue;
        }
        // 逐层深入，中途遇到非 object 就地建表
        let mut cur = &mut root;
        for seg in &segments[..segments.len() - 1] {
            cur = cur
                .entry(seg.to_string())
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .expect("expand_dot_paths: 非对象节点被意外覆盖");
        }
        cur.insert(segments[segments.len() - 1].to_string(), v.clone());
    }
    Value::Object(root)
}

/// 生成回执（信任边界所在 —— AI 只能看到这份文本）
///
/// 规则：
/// - `read = "none"`：只列字段名，值全部不出现
/// - `read = "full"`（默认）：完整字段值；但 secret 类型字段**无论模式**一律掩码
/// - 附带 target capability 的执行结果
pub fn build_receipt(
    read_mode: &str,
    fields: &[Value],
    values: &Value,
    exec_result: &Result<Value, String>,
) -> String {
    let secret_names: Vec<&str> = fields
        .iter()
        .filter(|f| f.get("type").and_then(|t| t.as_str()) == Some("secret"))
        .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
        .collect();

    let exec_line = match exec_result {
        Ok(v) => format!("执行结果: {}", serde_json::to_string(v).unwrap_or_default()),
        Err(e) => format!("执行失败: {}", e),
    };

    let mut lines = Vec::new();
    match read_mode {
        "none" => {
            lines.push("用户已提交表单（隐私模式：AI 不可读取字段值）".to_string());
            for f in fields {
                if let Some(name) = f.get("name").and_then(|n| n.as_str()) {
                    lines.push(format!("- {}: <已隐藏>", name));
                }
            }
        }
        _ => {
            lines.push("用户已提交表单".to_string());
            if let Some(obj) = values.as_object() {
                for (k, v) in obj {
                    if secret_names.iter().any(|s| k.contains(s)) {
                        lines.push(format!("- {}: <secret 已掩码>", k));
                    } else {
                        lines.push(format!("- {}: {}", k, v));
                    }
                }
            }
        }
    }
    lines.push(exec_line);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_accepts_valid_fields() {
        let fields = json!([
            {"name": "id", "type": "string", "value": "deepseek", "editable": false},
            {"name": "api_key", "type": "secret"},
            {"name": "wire", "type": "select", "options": ["a", "b"], "value": "a"},
            {"name": "ctx", "type": "number"},
            {"name": "enabled", "type": "boolean"},
            {"name": "day", "type": "date"}
        ]);
        assert!(validate_fields(&fields).is_ok());
    }

    #[test]
    fn validate_rejects_empty_and_missing_name() {
        assert!(validate_fields(&json!([])).is_err());
        assert!(validate_fields(&json!("not-array")).is_err());
        assert!(validate_fields(&json!([{"type": "string"}])).is_err()); // 缺 name
        assert!(validate_fields(&json!([{"name": "  "}])).is_err()); // 空白 name
        assert!(validate_fields(&json!([{"name": "x", "type": "select"}])).is_err()); // select 无 options
    }

    #[test]
    fn validate_tolerates_unknown_type() {
        // 未知 type 不报错——前端回落普通输入框
        let fields = json!([{"name": "x", "type": "color"}]);
        assert!(validate_fields(&fields).is_ok());
    }

    #[test]
    fn expand_dot_paths_nests() {
        let flat = json!({"profile.id": "x", "profile.api_key": "sk-1", "action": "save"});
        let out = expand_dot_paths(&flat);
        assert_eq!(out["profile"]["id"], "x");
        assert_eq!(out["profile"]["api_key"], "sk-1");
        assert_eq!(out["action"], "save");
    }

    #[test]
    fn expand_dot_paths_no_dots_passthrough() {
        let flat = json!({"a": 1, "b": "x"});
        assert_eq!(expand_dot_paths(&flat), flat);
    }

    #[test]
    fn receipt_none_mode_hides_all_values() {
        let fields = json!([
            {"name": "profile.id", "type": "string"},
            {"name": "profile.api_key", "type": "secret"}
        ]);
        let values = json!({"profile.id": "deepseek", "profile.api_key": "sk-real-9999"});
        let receipt = build_receipt("none", fields.as_array().unwrap(), &values, &Ok(json!({"ok": true})));
        assert!(!receipt.contains("deepseek"), "none 模式不得泄露字段值: {}", receipt);
        assert!(!receipt.contains("sk-real"), "none 模式不得泄露 secret: {}", receipt);
        assert!(receipt.contains("已隐藏"));
        assert!(receipt.contains("执行结果"));
    }

    #[test]
    fn receipt_full_mode_shows_values_but_masks_secrets() {
        let fields = json!([
            {"name": "profile.id", "type": "string"},
            {"name": "profile.api_key", "type": "secret"}
        ]);
        let values = json!({"profile.id": "deepseek", "profile.api_key": "sk-real-9999"});
        let receipt = build_receipt("full", fields.as_array().unwrap(), &values, &Ok(json!({"ok": true})));
        assert!(receipt.contains("deepseek"), "full 模式应展示普通值: {}", receipt);
        assert!(!receipt.contains("sk-real"), "secret 无论模式必须掩码: {}", receipt);
        assert!(receipt.contains("已掩码"));
    }

    #[test]
    fn receipt_exec_failure_reported() {
        let fields = json!([{"name": "a"}]);
        let receipt = build_receipt("full", fields.as_array().unwrap(), &json!({"a": "1"}), &Err("base_url 不能为空".into()));
        assert!(receipt.contains("执行失败"));
        assert!(receipt.contains("base_url 不能为空"));
    }
}