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
use serde_json::json;

/// 校验 fields schema（纯函数，供表单工具与单测复用）
///
/// 规则（最小化，与 sky 对齐）：
/// - fields 必须是非空数组
/// - 每个字段必须有非空 name
/// - select 类型必须带非空 options 数组
/// - 未知 type 不报错（前端回落 string 渲染）
/// - `hidden = true` 字段（值不进入 AI 上下文）与 `secret` 互斥：
///   secret 是「服务端掩码 + 前端密码框」，hidden 是「回执隐藏但值仍参与转发」。
///   两者语义不同，同时声明视为 schema 错误，避免歧义。
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
        // hidden 与 secret 互斥：secret 是服务端掩码 + 前端密码框，hidden 是
        // 「回执隐藏但值仍参与转发」——语义不同，同时声明视为歧义，拒绝 schema。
        let is_secret = ty == "secret" || f.get("secret").and_then(|v| v.as_bool()) == Some(true);
        let is_hidden = f.get("hidden").and_then(|v| v.as_bool()) == Some(true);
        if is_secret && is_hidden {
            return Err(format!(
                "fields[{}] (name={}) hidden 与 secret 互斥：secret 值前端即不可见，hidden 用于「值可转发但 AI 不可读」",
                i, name
            ));
        }
    }
    Ok(())
}

/// 收集 `hidden = true` 字段的 name 列表（回执掩码用）。
///
/// 隐藏字段的值仍随 payload 转发给目标能力（脚本 / 命令可读取原文），
/// 但 `build_receipt_opts` 在 `full` 模式下对这些字段显示 `<已隐藏>`，
/// AI 上下文拿不到原文。这是「隐藏值不进 AI 上下文」信任边界的服务端强制点。
pub fn hidden_field_names(fields: &[Value]) -> Vec<&str> {
    fields
        .iter()
        .filter(|f| f.get("hidden").and_then(|v| v.as_bool()) == Some(true))
        .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
        .collect()
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

/// 模板结构（form-templates/<name>.json 的落地格式）。
///
/// `fields` 是完整字段 schema（不含值——模板不存值，存结构），
/// `style` / `mode` / `title` 为可复用展示元数据。
#[derive(Debug, Clone)]
pub struct FormTemplate {
    pub name: String,
    pub version: Option<String>,
    pub title: Option<String>,
    pub mode: Option<String>,
    pub style: Value,
    pub fields: Value,
}

impl FormTemplate {
    /// 从服务端收到的模板定义对象构造（容错缺失字段）。
    pub fn from_value(v: &Value) -> Option<Self> {
        let name = v
            .get("name")
            .and_then(Value::as_str)?
            .trim()
            .to_string();
        if name.is_empty() {
            return None;
        }
        Some(Self {
            name,
            version: v
                .get("version")
                .and_then(Value::as_str)
                .map(String::from),
            title: v.get("title").and_then(Value::as_str).map(String::from),
            mode: v.get("mode").and_then(Value::as_str).map(String::from),
            style: v.get("style").cloned().unwrap_or_else(|| json!({})),
            fields: v
                .get("fields")
                .cloned()
                .unwrap_or_else(|| json!([])),
        })
    }

    /// 校验模板字段（复用 validate_fields 规则）。
    pub fn validate(&self) -> Result<(), String> {
        validate_fields(&self.fields)
    }
}

/// 把模板展开的元数据与 AI 本次声明的参数合并。
///
/// 规则（AI 显式声明 > 模板默认，避免模板喧宾夺主）：
/// - `fields`：模板提供 baseline，AI 本次传入的字段**按 name 覆盖/追加**
/// - `title`：AI 传了用 AI 的，否则用模板的
/// - `style`：AI 传了用 AI 的，否则用模板的
/// - `mode`：AI 传了用 AI 的，否则用模板的
///
/// 返回合并后的 `{ title, mode, style, fields }`，供 form_frame 组装用。
pub fn merge_template_defaults(
    template: Option<&FormTemplate>,
    ai_title: Option<&str>,
    ai_mode: Option<&str>,
    ai_style: &Value,
    ai_fields: &Value,
) -> Value {
    let t = match template {
        Some(t) => t,
        None => {
            // 无模板：直取 AI 声明（缺省 title/mode/style）
            return json!({
                "title": ai_title.unwrap_or(""),
                "mode": ai_mode.unwrap_or("dispatch"),
                "style": ai_style,
                "fields": ai_fields,
            });
        }
    };
    // 模板字段 + AI 覆盖字段
    let mut merged: Vec<Value> = t
        .fields
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(ai_arr) = ai_fields.as_array() {
        for ai_field in ai_arr {
            let ai_name = ai_field
                .get("name")
                .and_then(Value::as_str)
                .map(String::from);
            match ai_name {
                Some(n) => {
                    if let Some(idx) = merged.iter().position(|f| {
                        f.get("name").and_then(Value::as_str) == Some(n.as_str())
                    }) {
                        merged[idx] = ai_field.clone();
                    } else {
                        merged.push(ai_field.clone());
                    }
                }
                // AI 传了无名字段：直接追加（宽松处理）
                None => merged.push(ai_field.clone()),
            }
        }
    }
    json!({
        "title": ai_title.map(String::from).or_else(|| t.title.clone()).unwrap_or_default(),
        "mode": ai_mode.map(String::from).or_else(|| t.mode.clone()).unwrap_or_else(|| "dispatch".to_string()),
        "style": if ai_style.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            ai_style
        } else {
            &t.style
        },
        "fields": merged,
    })
}

/// 生成回执（信任边界所在 —— AI 只能看到这份文本）
///
/// 规则：
/// - `read_mode = "none"`：只列字段名，值全部不出现
/// - `read_mode = "full"`（默认）：完整字段值；但 secret 类型字段**无论模式**一律掩码
/// - `sanitize_exec = true`（用户私密提交）：exec_line 脱敏——成功只回"执行成功"，
///   失败只回"执行失败"，不携带目标能力返回/错误文案（否则目标能力的返回值会把
///   用户填写原文透出，见 form-隐私 回归测试）
/// - 附带 target capability 的执行结果
pub fn build_receipt(
    read_mode: &str,
    fields: &[Value],
    values: &Value,
    exec_result: &Result<Value, String>,
) -> String {
    build_receipt_opts(read_mode, fields, values, exec_result, false)
}

/// `build_receipt` 的隐私版：`sanitize_exec` 打开时脱敏执行结果，不透出字段原文。
///
/// 字段级隐藏（`hidden = true`）在 `full` 模式下按 secret 同款掩码处理——
/// 值仍随 payload 转发给目标能力（脚本 / 命令可读取原文），但回执中只显示
/// `<已隐藏>`，AI 上下文拿不到原文。这是方向 2「隐藏值不进 AI 上下文」的核心：
/// 信任边界与 `read="none"` 一致，但只针对 AI 声明的特定字段生效，其余字段
/// 仍可全量回显，便于 AI 知道哪些参数已收齐。
pub fn build_receipt_opts(
    read_mode: &str,
    fields: &[Value],
    values: &Value,
    exec_result: &Result<Value, String>,
    sanitize_exec: bool,
) -> String {
    let secret_names: Vec<&str> = fields
        .iter()
        .filter(|f| f.get("type").and_then(|t| t.as_str()) == Some("secret"))
        .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
        .collect();

    // hidden 字段：值仍参与转发，回执按已隐藏处理。
    let hidden_names: Vec<&str> = hidden_field_names(fields);

    let exec_line = if sanitize_exec {
        // 用户私密提交：不透出目标能力返回值/错误详情，仅回报成败。
        match exec_result {
            Ok(_) => "执行结果: 成功".to_string(),
            Err(_) => "执行失败: 目标能力拒绝或内部错误（详情已隐藏）".to_string(),
        }
    } else {
        match exec_result {
            Ok(v) => format!("执行结果: {}", serde_json::to_string(v).unwrap_or_default()),
            Err(e) => format!("执行失败: {}", e),
        }
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
                    } else if hidden_names.iter().any(|s| k.contains(s)) {
                        lines.push(format!("- {}: <已隐藏>", k));
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

/// 表单提交字段归一化：把提交 key 修正到字段 schema 声明的契约参数名。
///
/// 策略（纯函数，可独立单测）：**schema label→name 修正**——提交的 key 若等于
/// 某字段的 `label`（而非 `name`），换用该字段的 `name`——覆盖「AI 写了
/// name+label，但前端/FormCard 提交 label」的情况（当前 FormCard 用 name 作
/// key，此处为纵深防御）。未命中的 key 原样保留（不丢字段）。
///
/// （历史：曾按 per-target 别名表把中文/自然语言 key 归一化到契约参数名，
/// 唯一消费者 cap.todo 能力随内置 todo 插件移除（2026-11），别名层一并拆除。）
pub fn normalize_payload_for_target(
    payload: &Value,
    fields: &[Value],
) -> Value {
    let obj = match payload.as_object() {
        Some(o) => o,
        None => return payload.clone(),
    };

    // 1. 收集 label→name 映射（fields schema 声明的关系）
    use std::collections::HashMap;
    let mut label_to_name: HashMap<&str, &str> = HashMap::new();
    for f in fields {
        let name = f.get("name").and_then(|n| n.as_str());
        let label = f.get("label").and_then(|l| l.as_str());
        if let (Some(name), Some(label)) = (name, label) {
            if !name.trim().is_empty() && !label.trim().is_empty() && label != name {
                label_to_name.insert(label, name);
            }
        }
    }

    // 2. label→name 之外不做任何归一化（别名层已随 cap.todo 移除）。

    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        // label→name（schema 声明的显式关系，最强意图）
        let normalized = label_to_name
            .get(k.as_str())
            .copied()
            .map(str::to_string)
            .unwrap_or_else(|| k.clone());
        out.insert(normalized, v.clone());
    }
    Value::Object(out)
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
    fn validate_accepts_hidden_field() {
        // hidden 字段：值可转发但回执掩码——合法声明
        let fields = json!([{"name": "script", "type": "string", "hidden": true}]);
        assert!(validate_fields(&fields).is_ok());
    }

    #[test]
    fn validate_rejects_hidden_and_secret_conflict() {
        // hidden 与 secret 语义冲突，必须拒绝
        let fields = json!([{"name": "x", "type": "secret", "hidden": true}]);
        let err = validate_fields(&fields).unwrap_err();
        assert!(err.contains("互斥"), "应提示互斥: {}", err);

        // type=secret + hidden=true 也算冲突
        let fields2 = json!([{"name": "y", "type": "string", "secret": true, "hidden": true}]);
        let err2 = validate_fields(&fields2).unwrap_err();
        assert!(err2.contains("互斥"), "应提示互斥: {}", err2);
    }

    #[test]
    fn hidden_field_names_collects_hidden_only() {
        let fields = json!([
            {"name": "a", "type": "string"},
            {"name": "b", "type": "string", "hidden": true},
            {"name": "c", "type": "secret"},
            {"name": "d", "hidden": false}
        ]);
        let names = hidden_field_names(fields.as_array().unwrap());
        assert_eq!(names, vec!["b"], "仅收集 hidden=true 字段");
    }

    #[test]
    fn receipt_full_mode_masks_hidden_fields() {
        // 核心回归：hidden 字段值不得出现在回执里，普通字段正常回显
        let fields = json!([
            {"name": "project", "type": "string"},
            {"name": "api_token", "type": "string", "hidden": true},
            {"name": "count", "type": "number"}
        ]);
        let values = json!({
            "project": "my-app",
            "api_token": "sk-SECRET-9999",
            "count": 3
        });
        let receipt = build_receipt(
            "full",
            fields.as_array().unwrap(),
            &values,
            &Ok(json!({"ok": true})),
        );
        assert!(receipt.contains("my-app"), "普通字段应回显: {}", receipt);
        assert!(receipt.contains("count"), "数字字段应回显: {}", receipt);
        assert!(!receipt.contains("sk-SECRET"), "hidden 值不得泄露: {}", receipt);
        assert!(receipt.contains("api_token"), "字段名应保留");
        assert!(receipt.contains("已隐藏"), "应标记已隐藏: {}", receipt);
    }

    #[test]
    fn receipt_hidden_value_still_in_payload() {
        // hidden 只影响回执，不影响转发 payload——值仍进 target 能力
        let fields = json!([{"name": "cmd", "type": "string", "hidden": true}]);
        let values = json!({"cmd": "deploy --secret=x"});
        // 回执不含原文
        let receipt = build_receipt("full", fields.as_array().unwrap(), &values, &Ok(json!({})));
        assert!(!receipt.contains("deploy"), "回执不得含原文: {}", receipt);
        // 但 values 本身仍是原文（转发用）
        assert_eq!(values["cmd"], "deploy --secret=x");
    }

    #[test]
    fn receipt_none_mode_ignores_hidden() {
        // read=none 时全部隐藏，hidden 声明无额外影响
        let fields = json!([{"name": "a", "hidden": true}, {"name": "b"}]);
        let receipt = build_receipt("none", fields.as_array().unwrap(), &json!({"a": "1", "b": "2"}), &Ok(json!({})));
        assert!(!receipt.contains("1"));
        assert!(!receipt.contains("2"));
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

    #[test]
    fn normalize_keeps_unknown_keys_and_contract_names() {
        let fields = json!([{"name": "key"}]);
        // 已是契约参数名 + 未知 key 都应原样保留（无别名层，不做中文归一化）
        let payload = json!({
            "key": "已有正确契约名",
            "customField": "未知字段",
            "描述": "无别名层，原样保留",
        });
        let out = normalize_payload_for_target(&payload, fields.as_array().unwrap());
        assert_eq!(out.get("key"), Some(&json!("已有正确契约名")), "契约名不动");
        assert_eq!(out.get("customField"), Some(&json!("未知字段")), "未知 key 保留");
        assert_eq!(out.get("描述"), Some(&json!("无别名层，原样保留")), "无别名映射，中文 key 原样保留");
    }

    #[test]
    fn normalize_label_maps_to_name() {
        // 若提交 key 是字段的 label（非 name），归一化到 name
        let fields = json!([{"name": "key", "label": "存储键名"}]);
        let payload = json!({"存储键名": "通过 label 提交"});
        let out = normalize_payload_for_target(&payload, fields.as_array().unwrap());
        assert_eq!(out.get("key"), Some(&json!("通过 label 提交")), "label→name");
    }

    #[test]
    fn normalize_keeps_unrelated_fields() {
        // label→name 修正只作用于命中字段，其余字段原样保留
        let fields = json!([{"name": "key", "label": "键"}]);
        let payload = json!({"键": "v", "other": 1});
        let out = normalize_payload_for_target(&payload, fields.as_array().unwrap());
        assert_eq!(out.get("key"), Some(&json!("v")), "label→name 仍生效");
        assert_eq!(out.get("other"), Some(&json!(1)), "其他字段保留");
    }

    #[test]
    fn normalize_non_object_payload_passthrough() {
        let fields = json!([]);
        let out = normalize_payload_for_target(&json!("just-a-string"), fields.as_array().unwrap());
        assert_eq!(out, json!("just-a-string"));
    }

    // ===== 方向 4：模板合并 =====

    fn sample_template() -> FormTemplate {
        FormTemplate::from_value(&json!({
            "name": "project-bootstrap",
            "version": "v1",
            "title": "项目启动",
            "mode": "collect",
            "style": { "gridCols": 2 },
            "fields": [
                { "name": "name", "type": "string", "label": "项目名", "required": true },
                { "name": "engine", "type": "select", "options": ["ts", "rs"], "label": "引擎" },
            ],
        }))
        .expect("sample template parses")
    }

    #[test]
    fn template_from_value_parses() {
        let t = sample_template();
        assert_eq!(t.name, "project-bootstrap");
        assert_eq!(t.mode.as_deref(), Some("collect"));
        assert_eq!(t.style.get("gridCols"), Some(&json!(2)));
        assert_eq!(t.fields.as_array().map(|a| a.len()), Some(2));
        t.validate().expect("valid template passes");
    }

    #[test]
    fn template_from_value_rejects_missing_name() {
        assert!(FormTemplate::from_value(&json!({ "fields": [] })).is_none());
        assert!(FormTemplate::from_value(&json!({ "name": "" })).is_none());
    }

    #[test]
    fn merge_without_template_uses_ai_declaration() {
        let tmpl = None;
        let merged = merge_template_defaults(tmpl, Some("my title"), Some("dispatch"), &json!({"accent": "#f00"}), &json!([{"name": "a"}]));
        assert_eq!(merged.get("title").and_then(Value::as_str), Some("my title"));
        assert_eq!(merged.get("mode").and_then(Value::as_str), Some("dispatch"));
        assert_eq!(merged["style"]["accent"], json!("#f00"));
        assert_eq!(merged["fields"].as_array().map(|a| a.len()), Some(1));
    }

    #[test]
    fn merge_uses_template_when_ai_empty() {
        let tmpl = Some(&sample_template());
        let merged = merge_template_defaults(tmpl, None, None, &json!({}), &json!([]));
        assert_eq!(merged.get("title").and_then(Value::as_str), Some("项目启动"));
        assert_eq!(merged.get("mode").and_then(Value::as_str), Some("collect"));
        assert_eq!(merged["style"]["gridCols"], json!(2));
        assert_eq!(merged["fields"].as_array().map(|a| a.len()), Some(2), "模板字段成为 baseline");
    }

    #[test]
    fn merge_ai_overrides_template_by_name() {
        let tmpl = Some(&sample_template());
        // AI 覆盖 name 字段 + 追加新字段；style 用 AI 的
        let merged = merge_template_defaults(
            tmpl,
            Some("自定义标题"),
            Some("dispatch"),
            &json!({"accent": "#0af"}),
            &json!([
                { "name": "name", "type": "string", "label": "改名" },
                { "name": "extra", "type": "number" },
            ]),
        );
        assert_eq!(merged.get("title").and_then(Value::as_str), Some("自定义标题"), "AI 标题优先");
        assert_eq!(merged.get("mode").and_then(Value::as_str), Some("dispatch"), "AI 模式优先");
        assert_eq!(merged["style"]["accent"], json!("#0af"), "AI 样式优先");
        let fields = merged["fields"].as_array().unwrap();
        let name_field = fields.iter().find(|f| f.get("name").and_then(Value::as_str) == Some("name")).unwrap();
        assert_eq!(name_field.get("label").and_then(Value::as_str), Some("改名"), "字段按 name 覆盖");
        assert!(fields.iter().any(|f| f.get("name").and_then(Value::as_str) == Some("extra")), "新字段追加");
        assert!(fields.iter().any(|f| f.get("name").and_then(Value::as_str) == Some("engine")), "模板未覆盖字段保留");
    }
}