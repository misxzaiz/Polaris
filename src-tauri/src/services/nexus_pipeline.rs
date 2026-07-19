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

/// 成员派发 prompt:人格文件引用 + 场景目标 + 前波产出提示
fn build_member_prompt(pipeline: &RosterPipeline, slug: &str, roles: &HashMap<String, String>) -> String {
    let corpus_file = agents_install_dir().join("corpus").join(format!("{slug}.md"));
    let mut prompt = format!(
        "你将以专家「{slug}」的身份参与场景「{scenario}」的团队协作。开始前先读取该专家定义并遵循其中的人格、使命与规则:{file}\n\n团队目标:\n{goal}\n\n只做你职责范围内的部分,交付时给出简明的成果摘要。",
        slug = slug,
        scenario = pipeline.scenario,
        file = corpus_file.display(),
        goal = pipeline.goal,
    );
    let finished = pipeline.finished_summary_slugs();
    if !finished.is_empty() {
        prompt.push_str(&format!(
            "\n\n参考:前序波次成员({})已完成,其成果可在派发结果中查阅;你的工作应建立在其产出之上。",
            finished.join(", ")
        ));
    }
    if matches!(roles.get(slug).map(String::as_str), Some("qa") | Some("gate-keeper")) {
        prompt.push_str("\n\n你是质量验证角色:默认从严,要求证据,逐条对照验收标准。");
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
) -> std::result::Result<(RosterPipeline, Vec<String>), String> {
    let rosters_path = agents_install_dir().join("rosters.json");
    let content = std::fs::read_to_string(&rosters_path)
        .map_err(|e| format!("rosters.json 不可读({e});请先安装 agent corpus"))?;
    let file: RostersFile =
        serde_json::from_str(&content).map_err(|e| format!("rosters.json 解析失败: {e}"))?;
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

    let always: Vec<String> = def
        .groups
        .iter()
        .filter(|g| g.activation == "always")
        .flat_map(|g| g.members.iter().cloned())
        .collect();
    if always.is_empty() {
        return Err(format!("场景 {scenario} 无 always 组成员"));
    }

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

    let dispatched = dispatch_pending(state, &mut pipeline, &roles);
    save_pipeline(&pipelines_dir(), &pipeline).map_err(|e| e.to_message())?;
    Ok((pipeline, dispatched))
}

/// 派发当前波 pending 成员(并发满时部分成员留 pending,由完成事件补派)
fn dispatch_pending(
    state: &crate::AppState,
    pipeline: &mut RosterPipeline,
    roles: &HashMap<String, String>,
) -> Vec<String> {
    let mut dispatched = Vec::new();
    for slug in pipeline.current_wave_pending() {
        let params = super::ask_listener::DispatchTaskParams {
            source_session_id: pipeline.source_session_id.clone(),
            prompt: build_member_prompt(pipeline, &slug, roles),
            title: Some(format!("NEXUS·{slug}")),
            work_dir: pipeline.work_dir.clone(),
            engine_id: None,
            role: None,
            provider: None,
            model: None,
            dispatch_id: None,
            result_schema: member_result_schema(&slug, roles),
            roster_id: Some(pipeline.id.clone()),
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

/// 派发任务到达终态时推进流水线(report_dispatch_status 完成路径调用)
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
    let advance = pipeline.on_member_terminal(
        &task.dispatch_id,
        ok,
        task.verdict_status.as_deref(),
    );
    if !advance.to_dispatch.is_empty() {
        let roles = load_roles();
        dispatch_pending(state, &mut pipeline, &roles);
    }
    if advance.completed {
        tracing::info!("[Nexus] roster {} 全部波次完成", roster_id);
    }
    if let Err(e) = save_pipeline(&dir, &pipeline) {
        tracing::warn!("[Nexus] pipeline {} 保存失败: {}", roster_id, e.to_message());
    }
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
