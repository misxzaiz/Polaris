//! NEXUS roster 波次流水线(P2-4/P2-5)
//!
//! 「拓扑波次调度」:roster 的 always 组按角色排序(规划/实现在前,QA/gate-keeper 次之,
//! orchestrator 汇总最后),按每波 ≤3 切波;前波全部终态后 Rust 触发下波,不靠 LLM 记得。
//!
//! 分层:
//! - 纯逻辑核心(`RosterPipeline` + 波次推进,无 IO,单测覆盖)
//! - 持久化(`<DataRoot>/nexus/<id>.json`)
//! - 编排集成(`start_roster` / `on_dispatch_terminal`,调 ask_listener 注册派发)

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::services::nexus_verdict;

/// 每波成员上限(与 dispatch-task 并发上限对齐)
pub const WAVE_SIZE: usize = 3;

// ============================================================================
// 纯逻辑核心
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberState {
    pub slug: String,
    /// pending | dispatching | running | completed | failed
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_status: Option<String>,
}

/// Dev↔QA 修复循环状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopState {
    pub dev_slug: String,
    pub qa_slug: String,
    /// fixing(developer 修复中) | reverifying(QA 复验中)
    pub phase: String,
}

/// 升级记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Escalation {
    pub qa_slug: String,
    pub dev_slug: String,
    pub attempts: u32,
    /// pending | accepted | failed
    pub resolution: String,
}

/// 非 always 的 roster 组(按需追派)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaterGroup {
    pub activation: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterPipeline {
    pub id: String,
    pub scenario: String,
    pub goal: String,
    pub source_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    /// 波次划分(slug 列表)
    pub waves: Vec<Vec<String>>,
    /// 当前推进到的波(0-based)
    pub current_wave: usize,
    /// slug → 成员状态
    pub members: HashMap<String, MemberState>,
    /// slug → 完成摘要(截断,填入后续波次 prompt 的 REFERENCE 段,U2-2)
    #[serde(default)]
    pub member_summaries: HashMap<String, String>,
    /// developer slug → 修复重试次数(Dev↔QA loop,B2)
    #[serde(default)]
    pub fix_attempts: HashMap<String, u32>,
    /// 进行中的修复→复验循环
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_state: Option<LoopState>,
    /// 升级记录(3 次重试耗尽,待用户处置)
    #[serde(default)]
    pub escalations: Vec<Escalation>,
    /// 非 always 组(week 3+ / post-fix 等,按需追派)
    #[serde(default)]
    pub later_groups: Vec<LaterGroup>,
    /// 已追派的 activation 组名
    #[serde(default)]
    pub dispatched_groups: Vec<String>,
    /// 运行模式:sprint(默认,全量 always 组) | micro(截前 5 人轻量)
    #[serde(default)]
    pub mode: String,
    /// 场景终局 Pipeline Status Report(全部波次完成时生成,M3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_report: Option<String>,
    /// running | completed
    pub status: String,
    pub created_at: i64,
}

/// 角色 → 波次排序权重:规划/实现(0) → QA/gate-keeper(1) → orchestrator 汇总(2)
fn role_rank(role: Option<&str>) -> u8 {
    match role {
        Some("qa") | Some("gate-keeper") => 1,
        Some("orchestrator") => 2,
        _ => 0,
    }
}

/// 按角色权重稳定排序后切波(每波 ≤ wave_size)
pub fn plan_waves(
    members: &[String],
    roles: &HashMap<String, String>,
    wave_size: usize,
) -> Vec<Vec<String>> {
    let mut ordered: Vec<&String> = members.iter().collect();
    ordered.sort_by_key(|slug| role_rank(roles.get(*slug).map(String::as_str)));
    ordered
        .chunks(wave_size.max(1))
        .map(|c| c.iter().map(|s| (*s).clone()).collect())
        .collect()
}

/// 波次推进结果
#[derive(Debug, Default)]
pub struct AdvanceResult {
    /// 需要派发的下一波成员(空 = 无推进)
    pub to_dispatch: Vec<String>,
    /// 全部波完成
    pub completed: bool,
}

impl RosterPipeline {
    pub fn new(
        id: String,
        scenario: String,
        goal: String,
        source_session_id: String,
        work_dir: Option<String>,
        waves: Vec<Vec<String>>,
    ) -> Self {
        let members = waves
            .iter()
            .flatten()
            .map(|slug| {
                (
                    slug.clone(),
                    MemberState {
                        slug: slug.clone(),
                        status: "pending".into(),
                        dispatch_id: None,
                        verdict_status: None,
                    },
                )
            })
            .collect();
        Self {
            id,
            scenario,
            goal,
            source_session_id,
            work_dir,
            waves,
            current_wave: 0,
            members,
            member_summaries: HashMap::new(),
            fix_attempts: HashMap::new(),
            loop_state: None,
            escalations: Vec::new(),
            later_groups: Vec::new(),
            dispatched_groups: Vec::new(),
            mode: "sprint".into(),
            final_report: None,
            status: "running".into(),
            created_at: chrono::Utc::now().timestamp(),
        }
    }

    /// 当前波中仍待派发的成员
    pub fn current_wave_pending(&self) -> Vec<String> {
        self.waves
            .get(self.current_wave)
            .map(|wave| {
                wave.iter()
                    .filter(|slug| {
                        self.members
                            .get(*slug)
                            .is_some_and(|m| m.status == "pending")
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 按 dispatch_id 反查成员 slug
    pub fn slug_by_dispatch(&self, dispatch_id: &str) -> Option<String> {
        self.members
            .values()
            .find(|m| m.dispatch_id.as_deref() == Some(dispatch_id))
            .map(|m| m.slug.clone())
    }

    /// 追加一组新波次(追派 later group 用);重复 slug 跳过
    pub fn append_waves(&mut self, waves: Vec<Vec<String>>) {
        for wave in waves {
            let fresh: Vec<String> = wave
                .into_iter()
                .filter(|slug| !self.members.contains_key(slug))
                .collect();
            if fresh.is_empty() {
                continue;
            }
            for slug in &fresh {
                self.members.insert(
                    slug.clone(),
                    MemberState {
                        slug: slug.clone(),
                        status: "pending".into(),
                        dispatch_id: None,
                        verdict_status: None,
                    },
                );
            }
            self.waves.push(fresh);
        }
        if self.status == "completed" && self.current_wave + 1 < self.waves.len() {
            self.status = "running".into();
            self.current_wave += 1;
        }
    }

    /// 记录成员完成摘要(按字符截断,防 prompt 膨胀)
    pub fn record_summary(&mut self, dispatch_id: &str, summary: &str) {
        const MAX_CHARS: usize = 800;
        let Some(slug) = self
            .members
            .values()
            .find(|m| m.dispatch_id.as_deref() == Some(dispatch_id))
            .map(|m| m.slug.clone())
        else {
            return;
        };
        let mut text: String = summary.chars().take(MAX_CHARS).collect();
        if summary.chars().count() > MAX_CHARS {
            text.push('…');
        }
        self.member_summaries.insert(slug, text);
    }

    pub fn record_dispatched(&mut self, slug: &str, dispatch_id: &str) {
        if let Some(m) = self.members.get_mut(slug) {
            m.status = "running".into();
            m.dispatch_id = Some(dispatch_id.to_string());
        }
    }

    fn wave_terminal(&self, wave_idx: usize) -> bool {
        self.waves.get(wave_idx).is_some_and(|wave| {
            wave.iter().all(|slug| {
                self.members
                    .get(slug)
                    .is_some_and(|m| m.status == "completed" || m.status == "failed")
            })
        })
    }

    /// 成员到达终态;若当前波全部终态则推进到下一波。
    /// 返回需要派发的成员(下一波,或当前波尚未派出的 pending——并发满时的补派)。
    pub fn on_member_terminal(
        &mut self,
        dispatch_id: &str,
        ok: bool,
        verdict_status: Option<&str>,
    ) -> AdvanceResult {
        let Some(slug) = self
            .members
            .values()
            .find(|m| m.dispatch_id.as_deref() == Some(dispatch_id))
            .map(|m| m.slug.clone())
        else {
            return AdvanceResult::default();
        };
        if let Some(m) = self.members.get_mut(&slug) {
            m.status = if ok { "completed" } else { "failed" }.into();
            m.verdict_status = verdict_status.map(String::from);
        }

        // 当前波还有 pending(此前并发满未派出)→ 先补派
        let pending = self.current_wave_pending();
        if !pending.is_empty() {
            return AdvanceResult {
                to_dispatch: pending,
                completed: false,
            };
        }

        // 当前波全部终态 → 推进
        if self.wave_terminal(self.current_wave) {
            if self.current_wave + 1 < self.waves.len() {
                self.current_wave += 1;
                return AdvanceResult {
                    to_dispatch: self.current_wave_pending(),
                    completed: false,
                };
            }
            self.status = "completed".into();
            return AdvanceResult {
                to_dispatch: Vec::new(),
                completed: true,
            };
        }
        AdvanceResult::default()
    }

    /// 已完成波的成员摘要(填入下波 prompt 的 REFERENCE 部分)
    pub fn finished_summary_slugs(&self) -> Vec<String> {
        self.waves
            .iter()
            .take(self.current_wave)
            .flatten()
            .cloned()
            .collect()
    }
}

// ============================================================================
// 持久化
// ============================================================================

pub fn save_pipeline(dir: &Path, pipeline: &RosterPipeline) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", pipeline.id));
    let json = serde_json::to_string_pretty(pipeline)?;
    std::fs::write(path, json)?;
    Ok(())
}

pub fn load_pipeline(dir: &Path, id: &str) -> Result<RosterPipeline> {
    let path = dir.join(format!("{id}.json"));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::ConfigError(format!("读取 pipeline 失败: {e} ({})", path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| AppError::ConfigError(format!("pipeline 解析失败: {e}")))
}

fn pipelines_dir() -> PathBuf {
    crate::services::data_root::data_root().root().join("nexus")
}

// ============================================================================
// 编排集成(依赖 AppState / ask_listener)
// ============================================================================

/// rosters.json 结构(生成脚本产物)
#[derive(Debug, Deserialize)]
struct RostersFile {
    rosters: Vec<RosterDef>,
}

#[derive(Debug, Deserialize)]
struct RosterDef {
    slug: String,
    #[serde(default)]
    title: String,
    groups: Vec<RosterGroup>,
}

#[derive(Debug, Deserialize)]
struct RosterGroup {
    #[serde(default)]
    activation: String,
    members: Vec<String>,
}

fn agents_install_dir() -> PathBuf {
    crate::services::data_root::data_root().root().join("agents")
}

/// 读取专家 corpus 人格 body,作为 system prompt 注入派发会话。
/// 复用 agent_corpus::load_claude_agent_def(解析 frontmatter + body system prompt);
/// 命中失败返回 None(未安装或无该 slug),调用方回退默认行为。
fn load_agent_persona(slug: &str) -> Option<String> {
    let install_dir = agents_install_dir();
    let (_s, _desc, body) = crate::services::agent_corpus::load_claude_agent_def(&install_dir, slug)?;
    if body.trim().is_empty() {
        return None;
    }
    Some(body)
}

fn load_roles() -> HashMap<String, String> {
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
fn build_member_prompt(pipeline: &RosterPipeline, slug: &str, roles: &HashMap<String, String>) -> String {
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
fn member_result_schema(slug: &str, roles: &HashMap<String, String>) -> Option<String> {
    match roles.get(slug).map(String::as_str) {
        Some("qa") | Some("gate-keeper") => Some(nexus_verdict::QA_VERDICT.to_string()),
        _ => None,
    }
}

/// 启动 roster:解析场景 → 排波 → 落盘 → 派发第一波。
/// 返回 (pipeline, 本次实际派出的 slug 列表)。
pub fn start_roster(
    state: &crate::AppState,
    scenario: &str,
    goal: &str,
    source_session_id: &str,
    work_dir: Option<String>,
    mode: Option<&str>,
) -> std::result::Result<(RosterPipeline, Vec<String>), String> {
    let rosters_path = agents_install_dir().join("rosters.json");
    let content = std::fs::read_to_string(&rosters_path)
        .map_err(|e| format!("rosters.json 不可读({e});请先安装 agent corpus"))?;
    let mut file: RostersFile =
        serde_json::from_str(&content).map_err(|e| format!("rosters.json 解析失败: {e}"))?;
    // 合并用户自建 roster(rosters-user.json,同 slug 用户覆盖内置)
    if let Ok(user_content) =
        std::fs::read_to_string(agents_install_dir().join("rosters-user.json"))
    {
        if let Ok(user_file) = serde_json::from_str::<RostersFile>(&user_content) {
            for r in user_file.rosters {
                file.rosters.retain(|b| b.slug != r.slug);
                file.rosters.push(r);
            }
        }
    }
    let def = file
        .rosters
        .iter()
        .find(|r| r.slug == scenario)
        .ok_or_else(|| {
            format!(
                "未知场景 {scenario};可用: {}",
                file.rosters.iter().map(|r| r.slug.as_str()).collect::<Vec<_>>().join(", ")
            )
        })?;

    let mode = mode.unwrap_or("sprint").to_string();
    let mut always: Vec<String> = def
        .groups
        .iter()
        .filter(|g| g.activation == "always")
        .flat_map(|g| g.members.iter().cloned())
        .collect();
    // micro 模式(NEXUS-Micro):轻量小队,只取 always 组前 5 人(1-5 天级任务)
    if mode == "micro" {
        always.truncate(5);
    }
    if always.is_empty() {
        return Err(format!("场景 {scenario} 无 always 组成员"));
    }
    // 非 always 组保留(week 3+ / post-fix 按需追派;as needed 仅展示不追派)
    let later_groups: Vec<LaterGroup> = def
        .groups
        .iter()
        .filter(|g| g.activation != "always" && g.activation != "as needed")
        .map(|g| LaterGroup {
            activation: g.activation.clone(),
            members: g.members.clone(),
        })
        .collect();

    let roles = load_roles();
    let waves = plan_waves(&always, &roles, WAVE_SIZE);
    let id = format!("nexus-{}", uuid::Uuid::new_v4().simple());
    let mut pipeline = RosterPipeline::new(
        id,
        scenario.to_string(),
        goal.to_string(),
        source_session_id.to_string(),
        work_dir,
        waves,
    );
    pipeline.later_groups = later_groups;
    pipeline.mode = mode;

    let dispatched = dispatch_pending(state, &mut pipeline, &roles);
    save_pipeline(&pipelines_dir(), &pipeline).map_err(|e| e.to_message())?;
    emit_pipeline_update(state, &pipeline);
    Ok((pipeline, dispatched))
}

/// 派发当前波 pending 成员(并发满时部分成员留 pending,由完成事件补派)
fn dispatch_pending(
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
            tracing::warn!("[Nexus] 成员 {slug} 未找到 corpus 人格,回退默认行为(建议先安装 corpus)");
        }
        let params = super::ask_listener::DispatchTaskParams {
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
        match super::ask_listener::register_dispatch_task(state, params) {
            Ok(task) => {
                pipeline.record_dispatched(&slug, &task.dispatch_id);
                super::ask_listener::emit_dispatch_request(state, &task);
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
fn format_fix_prompt(verdict: &Value) -> String {
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
fn find_loop_developer(
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

/// 通用推进:成员终态 → 波次推进/补派/完成
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
                match super::ask_listener::trigger_dispatch_continue(state, &qa_id, &prompt) {
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
    match super::ask_listener::trigger_dispatch_continue(state, &dev_dispatch, &prompt) {
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
        super::ask_listener::emit_event(state, "nexus-pipeline-update", &payload);
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

// ============================================================================
// 测试(纯逻辑)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn roles() -> HashMap<String, String> {
        [
            ("pm", "developer"),
            ("ux", "developer"),
            ("fe", "developer"),
            ("be", "developer"),
            ("devops", "developer"),
            ("qa1", "qa"),
            ("rc", "gate-keeper"),
            ("orch", "orchestrator"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn slugs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plan_waves_orders_by_role_and_chunks() {
        let members = slugs(&["orch", "pm", "ux", "fe", "be", "devops", "qa1", "rc"]);
        let waves = plan_waves(&members, &roles(), 3);
        // developer 5 人在前(保持相对顺序),qa/gate 次之,orchestrator 最后
        assert_eq!(waves[0], slugs(&["pm", "ux", "fe"]));
        assert_eq!(waves[1], slugs(&["be", "devops", "qa1"]));
        assert_eq!(waves[2], slugs(&["rc", "orch"]));
    }

    #[test]
    fn wave_advance_and_completion() {
        let waves = vec![slugs(&["a", "b"]), slugs(&["c"])];
        let mut p = RosterPipeline::new(
            "t1".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        assert_eq!(p.current_wave_pending(), slugs(&["a", "b"]));
        p.record_dispatched("a", "d-a");
        p.record_dispatched("b", "d-b");

        // a 完成:b 未终态,不推进
        let r = p.on_member_terminal("d-a", true, Some("structured"));
        assert!(r.to_dispatch.is_empty() && !r.completed);

        // b 失败:波终态(失败也算终态),推进到波2
        let r = p.on_member_terminal("d-b", false, None);
        assert_eq!(r.to_dispatch, slugs(&["c"]));
        assert_eq!(p.current_wave, 1);

        p.record_dispatched("c", "d-c");
        let r = p.on_member_terminal("d-c", true, None);
        assert!(r.completed);
        assert_eq!(p.status, "completed");
    }

    #[test]
    fn concurrency_backfill_before_advance() {
        // 波内 3 人,只派出 2 人(并发满),完成 1 人后应先补派 pending 而非推进
        let waves = vec![slugs(&["a", "b", "c"]), slugs(&["d"])];
        let mut p = RosterPipeline::new(
            "t2".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        p.record_dispatched("a", "d-a");
        p.record_dispatched("b", "d-b");
        // c 留 pending
        let r = p.on_member_terminal("d-a", true, None);
        assert_eq!(r.to_dispatch, slugs(&["c"]));
        assert_eq!(p.current_wave, 0);
    }

    #[test]
    fn unknown_dispatch_id_is_noop() {
        let mut p = RosterPipeline::new(
            "t3".into(), "s".into(), "g".into(), "src".into(), None, vec![slugs(&["a"])],
        );
        let r = p.on_member_terminal("nope", true, None);
        assert!(r.to_dispatch.is_empty() && !r.completed);
    }

    #[test]
    fn record_summary_truncates_and_feeds_reference() {
        let waves = vec![slugs(&["a"]), slugs(&["b"])];
        let mut p = RosterPipeline::new(
            "t5".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        p.record_dispatched("a", "d-a");
        let long: String = "摘".repeat(1000);
        p.record_summary("d-a", &long);
        assert_eq!(p.member_summaries["a"].chars().count(), 801); // 800 + 省略号
        p.record_summary("nope", "ignored"); // 未知 dispatch_id 无操作
        assert_eq!(p.member_summaries.len(), 1);

        // 推进到波2后,b 的 prompt 应含 a 的摘要
        p.on_member_terminal("d-a", true, None);
        let prompt = build_member_prompt(&p, "b", &roles());
        assert!(prompt.contains("### a"));
        assert!(prompt.contains("摘摘摘"));
        assert!(prompt.contains("REFERENCE"));
    }

    #[test]
    fn persistence_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = RosterPipeline::new(
            "t4".into(), "s".into(), "g".into(), "src".into(), None, vec![slugs(&["a"])],
        );
        save_pipeline(tmp.path(), &p).unwrap();
        let loaded = load_pipeline(tmp.path(), "t4").unwrap();
        assert_eq!(loaded.id, "t4");
        assert_eq!(loaded.waves, vec![slugs(&["a"])]);
    }
}
