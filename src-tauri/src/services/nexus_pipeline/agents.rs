//! rosters/agents 载入与 persona/prompt/schema 构造（K-R4 迁入）

use std::path::PathBuf;
use crate::services::nexus_verdict;
use std::collections::HashMap;
use super::types::RosterPipeline;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
// ============================================================================
// 编排集成(依赖 AppState / ask_listener)
// ============================================================================

/// rosters.json 结构(生成脚本产物)
#[derive(Debug, Deserialize)]
pub struct RostersFile {
    pub rosters: Vec<RosterDef>,
}

#[derive(Debug, Deserialize)]
pub struct RosterDef {
    pub slug: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub title: String,
    pub groups: Vec<RosterGroup>,
}

#[derive(Debug, Deserialize)]
pub struct RosterGroup {
    #[serde(default)]
    pub activation: String,
    pub members: Vec<String>,
}

pub fn agents_install_dir() -> PathBuf {
    crate::services::data_root::data_root().root().join("agents")
}

/// 读取全局专家人格 body,作为 system prompt 注入派发会话。
/// 复用 simple_ai::load_agent_def(解析 frontmatter + body system prompt);
/// 命中失败返回 None(无该 slug),调用方回退默认行为。
pub fn load_agent_persona(slug: &str) -> Option<String> {
    let (_s, _desc, body) = crate::ai::engine::simple_ai::load_agent_def(slug)?;
    if body.trim().is_empty() {
        return None;
    }
    Some(body)
}

pub fn load_roles() -> HashMap<String, String> {
    let path = agents_install_dir().join("agent-roles.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| {
            v.get("roles")
                .and_then(Value::as_object)
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// 成员派发 prompt:团队目标 + 前波产出提示(人格已注入 system prompt,不在此重复)
pub fn build_member_prompt(pipeline: &RosterPipeline, slug: &str, roles: &HashMap<String, String>) -> String {
    let mut prompt = format!(
        "你将以专家「{slug}」的身份参与场景「{scenario}」的团队协作。你的专家人格(使命、规则、交付标准)已在系统提示词中注入,严格遵循其中定义。\n\n团队目标:\n{goal}\n\n只做你职责范围内的部分,交付时给出简明的成果摘要。",
        slug = slug,
        scenario = pipeline.scenario,
        goal = pipeline.goal,
    );
    let finished = pipeline.finished_summary_slugs();
    if !finished.is_empty() {
        prompt.push_str("\n\n## 前序波次产出(REFERENCE,你的工作应建立在其之上)\n");
        for f in &finished {
            match pipeline.member_summaries.get(f) {
                Some(summary) => prompt.push_str(&format!("\n### {f}\n{summary}\n")),
                None => prompt.push_str(&format!("\n### {f}\n(已完成,无摘要)\n")),
            }
        }
    }
    if matches!(roles.get(slug).map(String::as_str), Some("qa") | Some("gate-keeper")) {
        prompt.push_str("\n\n你是质量验证角色:默认从严,要求证据,逐条对照验收标准。");
    }
    // orchestrator(O3 混合,M3):注入 pipeline 状态,LLM 只做汇总决策——
    // 派发/波次/重试均由系统执行,不要求其记住流程
    if roles.get(slug).map(String::as_str) == Some("orchestrator") {
        let member_lines: Vec<String> = pipeline
            .waves
            .iter()
            .enumerate()
            .flat_map(|(i, wave)| {
                wave.iter().map(move |sl| {
                    let st = pipeline
                        .members
                        .get(sl)
                        .map(|m| m.status.as_str())
                        .unwrap_or("pending");
                    format!("- 波{} {sl}: {st}", i + 1)
                })
            })
            .collect();
        prompt.push_str(&format!(
            "\n\n## Pipeline 状态(系统注入,派发与波次推进由 Polaris 执行,你只负责汇总)\n模式: {}\n{}\n\nNEXUS phase 手册可参考: {}\n\n请基于全部前序产出,输出「Pipeline 状态报告」:整体结论 / 各成员成果一句话 / 未决风险 / 建议下一步。",
            pipeline.mode,
            member_lines.join("\n"),
            agents_install_dir().join("playbooks").display(),
        ));
    }
    prompt
}

/// QA/gate-keeper 成员强制 qa-verdict 结构化回流
pub fn member_result_schema(slug: &str, roles: &HashMap<String, String>) -> Option<String> {
    match roles.get(slug).map(String::as_str) {
        Some("qa") | Some("gate-keeper") => Some(nexus_verdict::QA_VERDICT.to_string()),
        _ => None,
    }
}
