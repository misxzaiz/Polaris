//! start_roster（K-R4 迁入）

use super::persistence::{save_pipeline, pipelines_dir};
use super::advance::emit_pipeline_update;
use super::dispatch::dispatch_pending;
use super::types::WAVE_SIZE;
use super::agents::{agents_install_dir, RostersFile};
use super::types::*;
use super::agents::*;
pub fn start_roster(
    state: &crate::AppState,
    scenario: &str,
    goal: &str,
    source_session_id: &str,
    work_dir: Option<String>,
    mode: Option<&str>,
) -> std::result::Result<(RosterPipeline, Vec<String>), String> {
    let mut file = RostersFile { rosters: vec![] };
    // 内置 rosters.json(可选;旧用户已安装的残留,新装机无此文件)
    if let Ok(content) = std::fs::read_to_string(agents_install_dir().join("rosters.json")) {
        if let Ok(f) = serde_json::from_str::<RostersFile>(&content) {
            file.rosters.extend(f.rosters);
        }
    }
    // 用户自建 rosters-user.json(同 slug 覆盖内置)
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
    if file.rosters.is_empty() {
        return Err("无可用专家团;请先用 save_roster 创建".into());
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
