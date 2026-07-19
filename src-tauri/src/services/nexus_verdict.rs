//! NEXUS 结构化 verdict:schema 注册表 + prompt 注入文本 + JSON 提取校验(P2-2/P2-3)
//!
//! 纯逻辑模块,不依赖 tauri/IO,可单测。schema 采用「必填字段清单」的轻量校验
//! (serde_json,不引 jsonschema crate);`resources/nexus/schemas/*.json` 为对应的
//! 文档形态,供人读与前端渲染。

use serde_json::Value;

/// 单个 verdict schema 定义
pub struct VerdictSchema {
    pub id: &'static str,
    /// 顶层必填字段
    pub required: &'static [&'static str],
    /// 注入到派发会话 system prompt 的输出要求(中文,面向执行模型)
    pub instruction: &'static str,
}

/// 7 种 handoff 模板中可机读回流的 4 种;standard/sprint/incident 为文档型交接,
/// 不做强制结构化回流(Phase 3 按需补充)。
pub const SCHEMAS: &[VerdictSchema] = &[
    VerdictSchema {
        id: "qa-pass",
        required: &["schema", "task", "acceptance"],
        instruction: "输出 QA PASS verdict:{\"schema\":\"qa-pass\",\"task\":\"任务ID或描述\",\"acceptance\":{\"passed\":N,\"failed\":0,\"total\":N},\"evidence\":[\"证据描述…\"],\"next\":\"建议下一步\"}",
    },
    VerdictSchema {
        id: "qa-fail",
        required: &["schema", "task", "issues"],
        instruction: "输出 QA FAIL verdict:{\"schema\":\"qa-fail\",\"task\":\"任务ID或描述\",\"attempt\":N,\"issues\":[{\"severity\":\"High|Medium|Low\",\"expected\":\"期望\",\"actual\":\"实际\",\"evidence\":[\"证据\"],\"fix_instruction\":\"怎么修\",\"file_to_modify\":\"改哪个文件\"}],\"acceptance\":{\"passed\":N,\"failed\":M,\"total\":T},\"next\":\"回传 developer,只修列出 issue\"}",
    },
    VerdictSchema {
        id: "phase-gate",
        required: &["schema", "gate", "verdict", "criteria"],
        instruction: "输出 Phase Gate verdict:{\"schema\":\"phase-gate\",\"gate\":\"gate 名称\",\"verdict\":\"PASS|FAIL\",\"criteria\":[{\"name\":\"标准\",\"pass\":true,\"evidence\":\"证据\"}],\"risks\":[\"风险…\"],\"carry_over\":[\"携带文档…\"]}",
    },
    VerdictSchema {
        id: "escalation",
        required: &["schema", "task", "attempts", "recommendation"],
        instruction: "输出 Escalation 报告:{\"schema\":\"escalation\",\"task\":\"任务\",\"attempts\":[{\"n\":1,\"failure\":\"失败原因\"}],\"root_cause\":\"根因分析\",\"recommendation\":\"reassign|decompose|revise|accept|defer\",\"impact\":\"影响评估\"}",
    },
];

pub fn schema_by_id(id: &str) -> Option<&'static VerdictSchema> {
    SCHEMAS.iter().find(|s| s.id == id)
}

/// 组合 id:QA 结果事先未知 PASS/FAIL,派发时用 `qa-verdict`,
/// 校验时按 verdict 内 `schema` 字段分派到 qa-pass / qa-fail。
pub const QA_VERDICT: &str = "qa-verdict";

fn is_known_schema(id: &str) -> bool {
    id == QA_VERDICT || schema_by_id(id).is_some()
}

/// 对外:resultSchema 参数合法性
pub fn schema_exists(id: &str) -> bool {
    is_known_schema(id)
}

/// resultSchema 对应的 system prompt 注入段(P2-2)
pub fn build_injection(schema_id: &str) -> Option<String> {
    if schema_id == QA_VERDICT {
        let pass = schema_by_id("qa-pass")?;
        let fail = schema_by_id("qa-fail")?;
        return Some(format!(
            "\n\n## 结构化结果要求(必须遵守)\n\n结束前的最后一条消息必须包含一个 ```json 代码块:验证通过时{},验证失败时{}。代码块外可以有简短说明,但 JSON 必须完整、可解析、独立成块。",
            pass.instruction, fail.instruction
        ));
    }
    let schema = schema_by_id(schema_id)?;
    Some(format!(
        "\n\n## 结构化结果要求(必须遵守)\n\n结束前的最后一条消息必须包含一个 ```json 代码块,内容为符合 `{}` schema 的 JSON 对象(顶层必填字段:{})。格式:{}\n代码块外可以有简短说明文字,但 JSON 必须完整、可解析、独立成块。",
        schema.id,
        schema.required.join(", "),
        schema.instruction
    ))
}

/// 从文本提取最后一个 ```json 代码块(优先)或整体裸 JSON 对象
pub fn extract_json_block(text: &str) -> Option<Value> {
    // 1) 最后一个 ```json ... ``` 代码块
    let mut best: Option<Value> = None;
    let mut rest = text;
    while let Some(start) = rest.find("```json") {
        let after = &rest[start + 7..];
        if let Some(end) = after.find("```") {
            if let Ok(v) = serde_json::from_str::<Value>(after[..end].trim()) {
                if v.is_object() {
                    best = Some(v);
                }
            }
            rest = &after[end + 3..];
        } else {
            break;
        }
    }
    if best.is_some() {
        return best;
    }
    // 2) 整体是裸 JSON 对象
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            if v.is_object() {
                return Some(v);
            }
        }
    }
    None
}

/// 校验 verdict 是否满足 schema 必填字段;通过返回 Ok(())
pub fn validate(schema_id: &str, value: &Value) -> Result<(), String> {
    if schema_id == QA_VERDICT {
        // 按 verdict 自带 schema 字段分派
        let inner = value
            .get("schema")
            .and_then(Value::as_str)
            .ok_or("qa-verdict 缺少 schema 字段")?;
        if inner != "qa-pass" && inner != "qa-fail" {
            return Err(format!("qa-verdict 的 schema 须为 qa-pass/qa-fail,实际 {inner}"));
        }
        return validate(inner, value);
    }
    let schema =
        schema_by_id(schema_id).ok_or_else(|| format!("未知 resultSchema: {schema_id}"))?;
    let obj = value.as_object().ok_or("verdict 不是 JSON 对象")?;
    let missing: Vec<&str> = schema
        .required
        .iter()
        .filter(|f| !obj.contains_key(**f))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!("缺少必填字段: {}", missing.join(", ")));
    }
    // schema 字段值须与 id 一致(存在时)
    if let Some(s) = obj.get("schema").and_then(Value::as_str) {
        if s != schema.id {
            return Err(format!("schema 字段不匹配: 期望 {}, 实际 {}", schema.id, s));
        }
    }
    Ok(())
}

/// 完成路径的一站式处理:提取 + 校验。
/// 返回 (verdict, status):structured=提取且校验通过;unstructured=提取失败或校验失败。
pub fn process_summary(schema_id: &str, summary: &str) -> (Option<Value>, &'static str) {
    match extract_json_block(summary) {
        Some(v) => match validate(schema_id, &v) {
            Ok(()) => (Some(v), "structured"),
            Err(_) => (Some(v), "unstructured"),
        },
        None => (None, "unstructured"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn injection_contains_schema_and_fields() {
        let text = build_injection("qa-fail").unwrap();
        assert!(text.contains("qa-fail") && text.contains("issues"));
        assert!(build_injection("nope").is_none());
    }

    #[test]
    fn extract_prefers_last_json_block() {
        let text = "说明\n```json\n{\"a\":1}\n```\n中间\n```json\n{\"b\":2}\n```\n尾";
        assert_eq!(extract_json_block(text).unwrap(), json!({"b":2}));
    }

    #[test]
    fn extract_bare_json_and_none() {
        assert_eq!(extract_json_block("{\"x\":1}").unwrap(), json!({"x":1}));
        assert!(extract_json_block("no json here").is_none());
        assert!(extract_json_block("```json\nnot json\n```").is_none());
    }

    #[test]
    fn validate_required_and_schema_match() {
        let ok = json!({"schema":"qa-fail","task":"T-1","issues":[]});
        assert!(validate("qa-fail", &ok).is_ok());
        let missing = json!({"schema":"qa-fail","task":"T-1"});
        assert!(validate("qa-fail", &missing).unwrap_err().contains("issues"));
        let mismatch = json!({"schema":"qa-pass","task":"T","issues":[]});
        assert!(validate("qa-fail", &mismatch).unwrap_err().contains("不匹配"));
    }

    #[test]
    fn process_summary_paths() {
        let good = "结论:\n```json\n{\"schema\":\"qa-pass\",\"task\":\"T\",\"acceptance\":{\"passed\":3,\"failed\":0,\"total\":3}}\n```";
        let (v, s) = process_summary("qa-pass", good);
        assert_eq!(s, "structured");
        assert!(v.unwrap().get("acceptance").is_some());

        let (v2, s2) = process_summary("qa-pass", "自由文本总结");
        assert_eq!(s2, "unstructured");
        assert!(v2.is_none());
    }
}
