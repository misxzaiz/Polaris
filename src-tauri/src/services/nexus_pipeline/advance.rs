//! advance_pipeline / final report / on_dispatch_terminal / fixing / 对外 API（K-R4 迁入）

use super::types::WAVE_SIZE;
use std::path::Path;
use serde_json::Value;
use super::types::*;
use super::agents::load_roles;
use super::persistence::{save_pipeline, load_pipeline, pipelines_dir};
use super::dispatch::{dispatch_pending, find_loop_developer, format_fix_prompt, MAX_FIX_ATTEMPTS};
fn advance_pipeline(
    state: &crate::AppState,
    pipeline: &mut RosterPipeline,
    dispatch_id: &str,
    ok: bool,
    verdict_status: Option<&str>,
) {
    let advance = pipeline.on_member_terminal(dispatch_id, ok, verdict_status);
    if !advance.to_dispatch.is_empty() {
        let roles = load_roles();
        dispatch_pending(state, pipeline, &roles);
    }
    if advance.completed {
        tracing::info!("[Nexus] roster {} 全部波次完成", pipeline.id);
        pipeline.final_report = Some(build_final_report(pipeline));
    }
}

/// 场景终局 Pipeline Status Report(注入来源会话,M3)
fn build_final_report(pipeline: &RosterPipeline) -> String {
    let mut lines = vec![format!(
        "NEXUS 专家团「{}」已完成(模式 {},{} 波 {} 人)。目标:{}",
        pipeline.scenario,
        pipeline.mode,
        pipeline.waves.len(),
        pipeline.waves.iter().map(|w| w.len()).sum::<usize>(),
        pipeline.goal,
    )];
    for (i, wave) in pipeline.waves.iter().enumerate() {
        for slug in wave {
            let st = pipeline.members.get(slug).map(|m| m.status.as_str()).unwrap_or("?");
            let summary = pipeline
                .member_summaries
                .get(slug)
                .map(|s| {
                    let head: String = s.chars().take(160).collect();
                    format!(" — {head}")
                })
                .unwrap_or_default();
            lines.push(format!("- [波{}] {slug}({st}){summary}", i + 1));
        }
    }
    if !pipeline.escalations.is_empty() {
        lines.push(format!("升级处置记录 {} 条。", pipeline.escalations.len()));
    }
    lines.join("\n")
}

/// 派发任务到达终态时推进流水线(report_dispatch_status 完成路径调用)。
/// Dev↔QA loop(B2):QA 结构化 qa-fail → continue developer 修复 → continue QA 复验,
/// 重试 ≤3 次,耗尽则记 escalation 待用户处置(nexus_resolve_escalation)。

pub fn on_dispatch_terminal(state: &crate::AppState, task: &crate::state::DispatchedTask) {
    let Some(roster_id) = task.roster_id.as_deref() else {
        return;
    };
    let dir = pipelines_dir();
    let Ok(mut pipeline) = load_pipeline(&dir, roster_id) else {
        tracing::warn!("[Nexus] pipeline {} 不可读,跳过推进", roster_id);
        return;
    };
    let ok = task.status == "completed";
    if let Some(summary) = task.summary.as_deref() {
        pipeline.record_summary(&task.dispatch_id, summary);
    }
    let roles = load_roles();
    let slug = pipeline.slug_by_dispatch(&task.dispatch_id);

    // ── 进行中的 Dev↔QA loop ──
    if let (Some(lp), Some(sl)) = (pipeline.loop_state.clone(), slug.as_deref()) {
        if lp.phase == "fixing" && sl == lp.dev_slug {
            // developer 修复完成 → 复验(continue 原 QA 会话,context 保留)
            let qa_dispatch = pipeline
                .members
                .get(&lp.qa_slug)
                .and_then(|m| m.dispatch_id.clone());
            if let Some(qa_id) = qa_dispatch {
                let prompt = format!(
                    "开发者已按你上一轮列出的问题完成修复(修复摘要见下)。请复验:逐条确认问题是否解决,并按结构化要求输出 qa-pass 或 qa-fail verdict。\n\n修复摘要:\n{}",
                    task.summary.as_deref().unwrap_or("(无摘要)")
                );
                match crate::services::ask_listener::trigger_dispatch_continue(state, &qa_id, &prompt) {
                    Ok(()) => {
                        if let Some(m) = pipeline.members.get_mut(&lp.qa_slug) {
                            m.status = "running".into();
                        }
                        pipeline.loop_state = Some(LoopState { phase: "reverifying".into(), ..lp });
                        save_and_emit(state, &dir, &pipeline);
                        return;
                    }
                    Err(e) => tracing::warn!("[Nexus] 复验 continue 失败,按普通终态处理: {e}"),
                }
            }
            pipeline.loop_state = None;
        } else if lp.phase == "reverifying" && sl == lp.qa_slug {
            let failed_again = task
                .verdict
                .as_ref()
                .and_then(|v| v.get("schema"))
                .and_then(Value::as_str)
                == Some("qa-fail");
            if failed_again {
                let attempts = pipeline.fix_attempts.get(&lp.dev_slug).copied().unwrap_or(0);
                if attempts < MAX_FIX_ATTEMPTS {
                    if try_enter_fixing(state, &mut pipeline, &lp.dev_slug, &lp.qa_slug, task) {
                        save_and_emit(state, &dir, &pipeline);
                        return;
                    }
                } else {
                    // 重试耗尽 → 升级,QA 记失败,正常推进(用户可在进行中卡片处置)
                    pipeline.escalations.push(Escalation {
                        qa_slug: lp.qa_slug.clone(),
                        dev_slug: lp.dev_slug.clone(),
                        attempts,
                        resolution: "pending".into(),
                    });
                    tracing::warn!(
                        "[Nexus] roster {} 修复重试耗尽({}次),升级用户处置",
                        pipeline.id, attempts
                    );
                }
            }
            pipeline.loop_state = None;
            advance_pipeline(state, &mut pipeline, &task.dispatch_id, ok && !failed_again, task.verdict_status.as_deref());
            save_and_emit(state, &dir, &pipeline);
            return;
        }
    }

    // ── 新 loop 触发:QA/gate 成员结构化 qa-fail ──
    let is_qa = slug
        .as_deref()
        .is_some_and(|sl| matches!(roles.get(sl).map(String::as_str), Some("qa") | Some("gate-keeper")));
    let qa_failed = task
        .verdict
        .as_ref()
        .and_then(|v| v.get("schema"))
        .and_then(Value::as_str)
        == Some("qa-fail");
    if pipeline.loop_state.is_none() && is_qa && qa_failed && ok {
        if let (Some(qa_slug), Some(dev_slug)) = (slug.clone(), find_loop_developer(&pipeline, &roles)) {
            let attempts = pipeline.fix_attempts.get(&dev_slug).copied().unwrap_or(0);
            if attempts < MAX_FIX_ATTEMPTS
                && try_enter_fixing(state, &mut pipeline, &dev_slug, &qa_slug, task)
            {
                save_and_emit(state, &dir, &pipeline);
                return;
            }
        }
    }

    // ── 正常推进 ──
    advance_pipeline(state, &mut pipeline, &task.dispatch_id, ok, task.verdict_status.as_deref());
    save_and_emit(state, &dir, &pipeline);
}

/// 进入 fixing 阶段:continue developer 会话下发修复指令

fn try_enter_fixing(
    state: &crate::AppState,
    pipeline: &mut RosterPipeline,
    dev_slug: &str,
    qa_slug: &str,
    qa_task: &crate::state::DispatchedTask,
) -> bool {
    let Some(dev_dispatch) = pipeline
        .members
        .get(dev_slug)
        .and_then(|m| m.dispatch_id.clone())
    else {
        return false;
    };
    let prompt = qa_task
        .verdict
        .as_ref()
        .map(format_fix_prompt)
        .unwrap_or_else(|| "QA 复验未通过,请根据其反馈修复。".into());
    match crate::services::ask_listener::trigger_dispatch_continue(state, &dev_dispatch, &prompt) {
        Ok(()) => {
            *pipeline.fix_attempts.entry(dev_slug.to_string()).or_insert(0) += 1;
            for sl in [dev_slug, qa_slug] {
                if let Some(m) = pipeline.members.get_mut(sl) {
                    m.status = "running".into();
                }
            }
            pipeline.loop_state = Some(LoopState {
                dev_slug: dev_slug.to_string(),
                qa_slug: qa_slug.to_string(),
                phase: "fixing".into(),
            });
            tracing::info!(
                "[Nexus] Dev↔QA loop: {} 修复第 {} 轮(QA={})",
                dev_slug, pipeline.fix_attempts[dev_slug], qa_slug
            );
            true
        }
        Err(e) => {
            tracing::warn!("[Nexus] 修复 continue 失败: {e}");
            false
        }
    }
}

fn save_and_emit(state: &crate::AppState, dir: &Path, pipeline: &RosterPipeline) {
    if let Err(e) = save_pipeline(dir, pipeline) {
        tracing::warn!("[Nexus] pipeline {} 保存失败: {}", pipeline.id, e.to_message());
    }
    emit_pipeline_update(state, pipeline);
}

/// 用户处置升级(accept=视为通过继续 / fail=记失败继续)

pub fn resolve_escalation(
    state: &crate::AppState,
    roster_id: &str,
    qa_slug: &str,
    action: &str,
) -> std::result::Result<(), String> {
    let dir = pipelines_dir();
    let mut pipeline = load_pipeline(&dir, roster_id).map_err(|e| e.to_message())?;
    let esc = pipeline
        .escalations
        .iter_mut()
        .find(|e| e.qa_slug == qa_slug && e.resolution == "pending")
        .ok_or_else(|| format!("无待处置升级: {qa_slug}"))?;
    esc.resolution = if action == "accept" { "accepted".into() } else { "failed".into() };
    if let Some(m) = pipeline.members.get_mut(qa_slug) {
        m.status = if action == "accept" { "completed" } else { "failed" }.into();
        m.verdict_status = Some("escalated".into());
    }
    save_and_emit(state, &dir, &pipeline);
    Ok(())
}

/// 追派 later group(week 3+ / post-fix):按角色排波追加并派发
pub fn dispatch_group(
    state: &crate::AppState,
    roster_id: &str,
    activation: &str,
) -> std::result::Result<Vec<String>, String> {
    let dir = pipelines_dir();
    let mut pipeline = load_pipeline(&dir, roster_id).map_err(|e| e.to_message())?;
    if pipeline.dispatched_groups.iter().any(|g| g == activation) {
        return Err(format!("组「{activation}」已追派过"));
    }
    let group = pipeline
        .later_groups
        .iter()
        .find(|g| g.activation == activation)
        .cloned()
        .ok_or_else(|| format!("场景无「{activation}」组"))?;
    let roles = load_roles();
    let waves = plan_waves(&group.members, &roles, WAVE_SIZE);
    pipeline.append_waves(waves);
    pipeline.dispatched_groups.push(activation.to_string());
    let dispatched = dispatch_pending(state, &mut pipeline, &roles);
    save_and_emit(state, &dir, &pipeline);
    Ok(dispatched)
}

/// 前端进度事件(U1-1):按 pipeline 粒度整体推送,天然低频(每成员终态一次)
pub fn emit_pipeline_update(state: &crate::AppState, pipeline: &RosterPipeline) {
    if let Ok(payload) = serde_json::to_value(pipeline) {
        crate::services::ask_listener::emit_event(state, "nexus-pipeline-update", &payload);
    }
}

/// 列出全部 pipeline(按创建时间倒序,U1-1 查询命令用)
pub fn list_pipelines() -> Vec<RosterPipeline> {
    let dir = pipelines_dir();
    let mut out: Vec<RosterPipeline> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
                .filter_map(|e| {
                    let stem = e.path().file_stem()?.to_str()?.to_string();
                    load_pipeline(&dir, &stem).ok()
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|p| std::cmp::Reverse(p.created_at));
    out
}

