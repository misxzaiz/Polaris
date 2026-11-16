//! 类型定义（K-R4 自 nexus_pipeline.rs 迁入）

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

// 分层:
// - 纯逻辑核心(`RosterPipeline` + 波次推进,无 IO,单测覆盖)
// - 持久化(`<DataRoot>/nexus/<id>.json`)
// - 编排集成(`start_roster` / `on_dispatch_terminal`,调 ask_listener 注册派发)

#[derive(Debug, Clone, Serialize, Deserialize)]
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

pub const WAVE_SIZE: usize = 3;
