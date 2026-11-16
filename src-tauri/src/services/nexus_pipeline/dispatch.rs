//! dispatch_pending（K-R4 迁入）

use super::agents::{load_agent_persona, build_member_prompt, member_result_schema, agents_install_dir, RostersFile};
use serde_json::Value;
use super::types::*;
use std::collections::HashMap;
pub fn dispatch_pending(
    state: &crate::AppState,
    pipeline: &mut RosterPipeline,
    roles: &HashMap<String, String>,
) -> Vec<String> {
    let mut dispatched = Vec::new();
    // 预读配置:roster 成员按 slug 匹配 DispatchPreset(约定 preset.name == 专家 slug),
    // 命中则把 slug 作为 role 传入,由 register_dispatch_task 应用 preset 的引擎/模型/profile/权限;
    // 未命中保持 role=None,继承来源会话(与改造前行为一致)。
    let config = state.clone_config().unwrap_or_default();
    for slug in pipeline.current_wave_pending() {
        let role = config
            .dispatch
            .presets
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(slug.as_str()))
            .map(|_| slug.clone());
        if role.is_some() {
            tracing::info!("[Nexus] 成员 {slug} 命中 DispatchPreset,按预设应用引擎/模型");
        }
        // 专家人格内联注入 system prompt(不再依赖"模型自己去读文件")
        let persona = load_agent_persona(&slug);
        if persona.is_some() {
            tracing::info!("[Nexus] 成员 {slug} 专家人格已注入 system prompt");
        } else {
            tracing::warn!("[Nexus] 成员 {slug} 未找到项目级专家人格,回退默认行为(建议先用 save_agent 创建)");
        }
        let params = crate::services::ask_listener::DispatchTaskParams {
            source_session_id: pipeline.source_session_id.clone(),
            prompt: build_member_prompt(pipeline, &slug, roles),
            title: Some(format!("NEXUS·{slug}")),
            work_dir: pipeline.work_dir.clone(),
            engine_id: None,
            role,
            provider: None,
            model: None,
            dispatch_id: None,
            result_schema: member_result_schema(&slug, roles),
            roster_id: Some(pipeline.id.clone()),
            append_system_prompt: persona,
        };
        match crate::services::ask_listener::register_dispatch_task(state, params) {
            Ok(task) => {
                pipeline.record_dispatched(&slug, &task.dispatch_id);
                crate::services::ask_listener::emit_dispatch_request(state, &task);
                dispatched.push(slug);
            }
            Err(message) => {
                // 并发满等原因:留 pending,后续完成事件触发补派
                tracing::info!("[Nexus] {} 暂缓派发: {}", slug, message);
            }
        }
    }
    dispatched
}

/// 修复重试上限(超过即升级用户处置)
pub const MAX_FIX_ATTEMPTS: u32 = 3;

/// 把 qa-fail verdict 的 issues 渲染为修复指令文本
pub fn format_fix_prompt(verdict: &Value) -> String {
    let mut out = String::from("QA 复验未通过。请只修复下列问题,不要新增功能:\n");
    if let Some(issues) = verdict.get("issues").and_then(Value::as_array) {
        for (i, issue) in issues.iter().enumerate() {
            let g = |k: &str| issue.get(k).and_then(Value::as_str).unwrap_or("—");
            out.push_str(&format!(
                "\n{}. [{}] 期望: {} | 实际: {} | 修复: {} | 文件: {}",
                i + 1,
                g("severity"),
                g("expected"),
                g("actual"),
                g("fix_instruction"),
                g("file_to_modify"),
            ));
        }
    }
    out.push_str("\n\n完成后给出简明修复摘要。");
    out
}

/// 找 loop 的 developer 目标:同/前波中最近完成的 developer 角色成员
pub fn find_loop_developer(
    pipeline: &RosterPipeline,
    roles: &HashMap<String, String>,
) -> Option<String> {
    pipeline
        .waves
        .iter()
        .take(pipeline.current_wave + 1)
        .flatten()
        .rev()
        .find(|slug| {
            let is_dev = !matches!(
                roles.get(*slug).map(String::as_str),
                Some("qa") | Some("gate-keeper") | Some("orchestrator")
            );
            let done = pipeline
                .members
                .get(*slug)
                .is_some_and(|m| m.status == "completed" && m.dispatch_id.is_some());
            is_dev && done
        })
        .cloned()
}
