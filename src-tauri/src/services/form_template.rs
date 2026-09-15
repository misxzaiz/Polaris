//! form_template —— 表单模板存储（方向 4：AI 复用表单结构）
//!
//! 模板落地在工作区 DataRoot 的 `form-templates/` 目录，每个模板一个
//! `<name>.json`。内容是**结构**（title/mode/style/fields），不含任何用户填值
//! —— 模板只存"长什么样"，不存"填了什么"，隐私边界与字段原文天然隔离。
//!
//! # 信任边界
//!
//! - 模板文件只读写结构（fields schema / style），值永不落盘
//! - name 严格校验：只允许 `[A-Za-z0-9._-]`，防路径穿越
//! - 读失败（不存在 / 损坏）返回明确错误，不静默降级为空

use std::fs;
use std::path::{Path, PathBuf};

use crate::contracts::Value;
use serde_json::json;

use super::form_core::{self, FormTemplate};

/// 模板根目录（相对 DataRoot）。
const TEMPLATE_DIR: &str = "form-templates";

/// 校验模板 name：只允许安全字符，防空/点穿越。
pub fn validate_template_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("模板名称不能为空".to_string());
    }
    if trimmed.len() > 64 {
        return Err("模板名称过长（≤64）".to_string());
    }
    let ok = trimmed.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
    });
    if !ok {
        return Err(format!(
            "模板名称含非法字符（仅允许字母/数字/.-_）：{}",
            trimmed
        ));
    }
    Ok(())
}

/// 把任意模板名（含中文/空格/emoji）转为安全 slug。
///
/// 规则：保留 ASCII 字母数字与 `.-_`，其余字符全部替换为 `-`；
/// 连续替换符合并为一个 `-`；首尾的 `-`/`.` 去掉；结果再次过
/// `validate_template_name` 兜底。空结果返回 `form-template`。
/// 不检查唯一性（唯一化交给 `save_template` 的 `-2/-3` 追加）。
pub fn slugify_template_name(input: &str) -> String {
    let trimmed = input.trim();
    let mut out = String::with_capacity(trimmed.len().min(64));
    let mut last_sep = false;
    for c in trimmed.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
            last_sep = false;
        } else if !last_sep {
            out.push('-');
            last_sep = true;
        }
    }
    // 去掉首尾分隔符（可能残留 `-`/`.`），再补验证
    let out = out.trim_matches(['-', '.']).to_string();
    let out = if out.is_empty() {
        "form-template".to_string()
    } else {
        out
    };
    if out.len() > 64 {
        // 超长 slug：截断到 64，再修剪尾部分隔符；空则兜底
        let mut s = out[..64].to_string();
        s = s.trim_matches(['-', '.']).to_string();
        if s.is_empty() { s = "form-template".to_string(); }
        s
    } else {
        out
    }
}

/// 保存模板时对 name 的最终处理：
/// 合法的直接用，非法则 slug 化（不报错）。
fn resolve_template_name(raw: &str) -> String {
    if validate_template_name(raw).is_ok() {
        raw.trim().to_string()
    } else {
        slugify_template_name(raw)
    }
}

/// 如果模板路径已存在，追加 `-2`/`-3`/… 生成不存在的新名。
fn unique_name(root: &Path, name: &str) -> String {
    if !template_path(root, name).exists() {
        return name.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}-{}", name, n);
        if !template_path(root, &candidate).exists() {
            return candidate;
        }
        n += 1;
        if n > 999 {
            // 理论不可达（已建 999 个同前缀）：带时间戳兜底
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            return format!("{}-{}", name, ts);
        }
    }
}

/// 模板文件路径（name 已校验，join 安全）。
fn template_path(root: &Path, name: &str) -> PathBuf {
    root.join(TEMPLATE_DIR).join(format!("{}.json", name))
}

/// 保存一个模板。`source` 是待保存的结构对象：
/// `{ name, version?, title?, mode?, style?, fields }`。
///
/// 名称处理：合法的直接使用；含中文/非法字符的自动 slug 化（不报错）；
/// 与已有模板同名时追加 `-2/-3/…` 唯一化。返回最终落盘名。
pub fn save_template(root: &Path, source: &Value) -> Result<Value, String> {
    let template = form_core::FormTemplate::from_value(source)
        .ok_or_else(|| "模板缺少 name 或 name 为空".to_string())?;
    // 字段 schema 校验（非法结构直接拒绝，不落盘）——名称 slug 化不代表结构合法
    template.validate().map_err(|e| format!("模板字段非法: {}", e))?;
    let resolved = resolve_template_name(&template.name);
    let name = unique_name(root, &resolved);
    let dir = root.join(TEMPLATE_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("创建模板目录失败: {}", e))?;
    let path = template_path(root, &name);
    // 写盘时把 name 替换为最终落盘名（slug/唯一化后），文件系统与内容一致。
    // 若内容里原本 name 与落盘名不同（中文→slug），用 slug 覆盖 name，
    // 保留 title 存展示名（避免丢失中文标题）。
    let mut content = source.clone();
    if let Some(obj) = content.as_object_mut() {
        obj.insert("name".to_string(), json!(name));
        // name 被 slug 化时，title 兜底为原始名，保证 UI 仍能显示中文
        if obj.get("title").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).is_none() {
            if let Some(orig) = source.get("name").and_then(|v| v.as_str()) {
                obj.insert("title".to_string(), json!(orig));
            }
        }
    }
    serde_json::to_string_pretty(&content)
        .map_err(|e| format!("序列化模板失败: {}", e))
        .and_then(|s| fs::write(&path, s).map_err(|e| format!("写入模板失败: {}", e)))?;
    Ok(json!({ "ok": true, "name": name }))
}

/// 按 name 读取模板（返回展开后的 FormTemplate）。不存在返回明确错误。
pub fn load_template(root: &Path, name: &str) -> Result<FormTemplate, String> {
    validate_template_name(name)?;
    let path = template_path(root, name);
    if !path.exists() {
        return Err(format!("模板「{}」不存在", name));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取模板「{}」失败: {}", name, e))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("模板「{}」损坏: {}", name, e))?;
    FormTemplate::from_value(&value)
        .ok_or_else(|| format!("模板「{}」缺 name 字段", name))
}

/// 列出所有已保存模板的元信息（name/version/title/mode/字段数）。
pub fn list_templates(root: &Path) -> Result<Vec<Value>, String> {
    let dir = root.join(TEMPLATE_DIR);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("读取模板目录失败: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            // 文件名 stem 即模板名（文件系统是真相）。load 用 stem 找文件，
            // 展示时也用 stem 而非文件内容的 name —— 兼容旧代码写入的
            // 「内容 name 与文件名不一致」的历史脏数据。
            if let Ok(t) = load_template(root, stem) {
                out.push(json!({
                    "name": stem,
                    "version": t.version,
                    "title": t.title,
                    "mode": t.mode,
                    "fieldCount": t.fields.as_array().map(|a| a.len()).unwrap_or(0),
                    "styleKeys": t.style.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                }));
            }
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// 构造唯一临时目录作为 DataRoot，测后清理。
    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let unique = format!(
            "form-tpl-test-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_name_rejects_bad() {
        assert!(validate_template_name("").is_err());
        assert!(validate_template_name("  ").is_err());
        assert!(validate_template_name("../evil").is_err());
        assert!(validate_template_name("a/b").is_err());
        assert!(validate_template_name("a b").is_err());
        assert!(validate_template_name(&"x".repeat(65)).is_err(), "超长拒绝");
    }

    #[test]
    fn validate_name_accepts_good() {
        assert!(validate_template_name("project-bootstrap").is_ok());
        assert!(validate_template_name("form_v1.2").is_ok());
        assert!(validate_template_name("A1_b-c").is_ok());
    }

    #[test]
    fn slugify_handles_chinese_and_spaces() {
        // 中文标题 → ASCII slug
        assert_eq!(slugify_template_name("项目启动参数"), "form-template");
        // 混合：中文+ASCII 保留 ASCII 部分
        assert_eq!(slugify_template_name("项目-Project"), "Project");
        assert_eq!(slugify_template_name("Form 一"), "Form");
        // 空白/emoji/符号 → 连字符，连续合并
        assert_eq!(slugify_template_name("a  b"), "a-b");
        assert_eq!(slugify_template_name("a...b"), "a-b");
        assert_eq!(slugify_template_name(" a "), "a");
        assert_eq!(slugify_template_name("!!!"), "form-template");
        assert_eq!(slugify_template_name(""), "form-template");
        // 保留合法字符
        assert_eq!(slugify_template_name("project_bootstrap.v2"), "project_bootstrap.v2");
    }

    #[test]
    fn slugified_name_is_always_valid() {
        for input in ["项目启动参数", "Form 一", "a/b", "a b c", "你好世界", "foo.bar", "A1_b-c", "  "] {
            let slug = slugify_template_name(input);
            assert!(
                validate_template_name(&slug).is_ok(),
                "slug '{}' 来自 '{}' 应合法",
                slug,
                input
            );
        }
    }

    #[test]
    fn save_slugifies_chinese_name() {
        let root = tmp_root("chinesename");
        // 中文 name 不再报错，自动 slug 化
        let res = save_template(&root, &json!({
            "name": "项目启动参数",
            "title": "项目启动参数",
            "mode": "collect",
            "fields": [{"name": "x", "type": "string"}],
        }))
        .expect("中文名自动 slug 化");
        assert_eq!(res["name"], json!("form-template"));
        // 文件确实落在 form-template.json
        assert!(root.join("form-templates/form-template.json").exists());
        // 能读回
        let loaded = load_template(&root, "form-template").expect("加载成功");
        assert_eq!(loaded.title.as_deref(), Some("项目启动参数"));
        cleanup(&root);
    }

    #[test]
    fn save_makes_unique_name_on_conflict() {
        let root = tmp_root("unique");
        let base = json!({
            "name": "dup",
            "title": "Dup",
            "mode": "collect",
            "fields": [{"name": "x", "type": "string"}],
        });
        let r1 = save_template(&root, &base).expect("first");
        let r2 = save_template(&root, &base).expect("second");
        let r3 = save_template(&root, &base).expect("third");
        assert_eq!(r1["name"], json!("dup"));
        assert_eq!(r2["name"], json!("dup-2"));
        assert_eq!(r3["name"], json!("dup-3"));
        // 三个文件都在
        assert!(root.join("form-templates/dup.json").exists());
        assert!(root.join("form-templates/dup-2.json").exists());
        assert!(root.join("form-templates/dup-3.json").exists());
        cleanup(&root);
    }

    #[test]
    fn saved_file_name_field_matches_slug() {
        let root = tmp_root("namesync");
        // 中文标题 → slug 落盘。文件内 name 字段必须是 form-template（与文件名一致）
        // 而 title 保留中文（UI 展示用），保证 list/load 不会对不上文件系统。
        save_template(&root, &json!({
            "name": "项目启动参数",
            "title": "项目启动参数",
            "mode": "collect",
            "fields": [{"name": "x", "type": "string"}],
        }))
        .expect("save");
        let raw = std::fs::read_to_string(root.join("form-templates/form-template.json")).expect("read");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        assert_eq!(v["name"], json!("form-template"), "文件内 name 与文件名一致");
        assert_eq!(v["title"], json!("项目启动参数"), "title 保留中文");
        let loaded = load_template(&root, "form-template").expect("load by slug");
        assert_eq!(loaded.name, "form-template");
        assert_eq!(loaded.title.as_deref(), Some("项目启动参数"));
        cleanup(&root);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let root = tmp_root("roundtrip");
        let source = json!({
            "name": "bootstrap",
            "version": "v1",
            "title": "项目启动",
            "mode": "collect",
            "style": { "gridCols": 2 },
            "fields": [
                { "name": "name", "type": "string", "label": "项目名", "required": true },
            ],
        });
        save_template(&root, &source).expect("save succeeds");
        let loaded = load_template(&root, "bootstrap").expect("load succeeds");
        assert_eq!(loaded.name, "bootstrap");
        assert_eq!(loaded.title.as_deref(), Some("项目启动"));
        assert_eq!(loaded.mode.as_deref(), Some("collect"));
        assert_eq!(loaded.fields.as_array().map(|a| a.len()), Some(1));
        cleanup(&root);
    }

    #[test]
    fn save_rejects_invalid_fields() {
        let root = tmp_root("badfields");
        // select 缺 options 应被 validate_fields 拦下，不落盘
        let source = json!({
            "name": "bad",
            "fields": [{ "name": "pick", "type": "select" }],
        });
        let err = save_template(&root, &source).expect_err("save rejects invalid");
        assert!(
            err.contains("模板字段非法"),
            "err = {}",
            err
        );
        cleanup(&root);
    }

    #[test]
    fn load_missing_reports_error() {
        let root = tmp_root("missing");
        let err = load_template(&root, "nope").expect_err("missing reports");
        assert!(err.contains("不存在"), "err = {}", err);
        cleanup(&root);
    }

    #[test]
    fn list_returns_saved_metadata() {
        let root = tmp_root("list");
        save_template(&root, &json!({
            "name": "tpl-a",
            "version": "v1",
            "title": "表单 A",
            "mode": "collect",
            "fields": [{"name": "x"}],
        }))
        .expect("save a");
        let list = list_templates(&root).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], json!("tpl-a"));
        assert_eq!(list[0]["fieldCount"], json!(1));
        assert_eq!(list[0]["title"], json!("表单 A"));
        cleanup(&root);
    }
}
