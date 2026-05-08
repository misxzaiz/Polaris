//! Document-backed long goal service.

use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, CompleteLongGoalParams, CreateLongGoalParams, LongGoalConfig,
    LongGoalDocuments, LongGoalPhase, LongGoalState, LongGoalStatus, RecordLongGoalStepParams,
};

pub struct LongGoalService;

impl LongGoalService {
    pub fn create_goal(params: CreateLongGoalParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let now = Utc::now().timestamp();
        let id = Self::new_goal_id(&params.title);
        let goal_dir = Self::goal_dir(&workspace, &id);
        if goal_dir.exists() {
            return Err(AppError::ConfigError(format!("长期目标已存在: {}", id)));
        }

        std::fs::create_dir_all(goal_dir.join("sessions"))?;
        std::fs::create_dir_all(goal_dir.join("history").join("supplement"))?;
        std::fs::create_dir_all(goal_dir.join("history").join("documents"))?;

        let config = LongGoalConfig {
            id: id.clone(),
            title: params.title,
            goal: params.goal,
            status: LongGoalStatus::Planning,
            phase: LongGoalPhase::Planning,
            workspace_path: workspace.to_string_lossy().to_string(),
            engine_id: params.engine_id,
            trigger_mode: "afterCompletion".to_string(),
            interval: params.interval,
            auto_pause_on_complete: params.auto_pause_on_complete,
            allow_code_changes: params.allow_code_changes,
            allow_git_commit: params.allow_git_commit,
            current_step_id: None,
            current_session_id: None,
            last_session_id: None,
            next_run_at: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };

        let documents = Self::initial_documents(&config);
        Self::write_config(&goal_dir, &config)?;
        Self::write_documents(&goal_dir, &documents)?;
        Self::read_goal_state(&workspace, &id)
    }

    pub fn read_goal(workspace_path: &str, goal_id: &str) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(workspace_path)?;
        Self::read_goal_state(&workspace, goal_id)
    }

    pub fn list_goals(workspace_path: &str) -> Result<Vec<LongGoalState>> {
        let workspace = Self::canonical_workspace(workspace_path)?;
        let root = workspace.join(".polaris").join("long-goals");
        if !root.exists() {
            return Ok(Vec::new());
        }

        let mut goals = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let goal_id = entry.file_name().to_string_lossy().to_string();
            match Self::read_goal_state(&workspace, &goal_id) {
                Ok(goal) => goals.push(goal),
                Err(error) => {
                    tracing::warn!("[LongGoal] 跳过无法读取的长期目标 {}: {}", goal_id, error);
                }
            }
        }
        goals.sort_by(|left, right| right.config.updated_at.cmp(&left.config.updated_at));
        Ok(goals)
    }

    pub fn append_supplement(params: AppendLongGoalSupplementParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        let mut supplement = Self::read_text(&goal_dir.join("supplement.md"))?;
        let now_text = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
        let priority = params.priority.unwrap_or_else(|| "normal".to_string());
        supplement.push_str(&format!(
            "\n\n## 补充 - {} - {}\n\n{}\n",
            now_text,
            priority,
            params.content.trim()
        ));
        Self::write_text(&goal_dir.join("supplement.md"), &supplement)?;
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, &params.goal_id)
    }

    pub fn pause_goal(workspace_path: &str, goal_id: &str) -> Result<LongGoalState> {
        Self::set_status(
            workspace_path,
            goal_id,
            LongGoalStatus::Paused,
            LongGoalPhase::Review,
        )
    }

    pub fn resume_goal(workspace_path: &str, goal_id: &str) -> Result<LongGoalState> {
        Self::set_status(
            workspace_path,
            goal_id,
            LongGoalStatus::Active,
            LongGoalPhase::Execution,
        )
    }

    pub fn prepare_planning_session(workspace_path: &str, goal_id: &str) -> Result<String> {
        let state = Self::read_goal(workspace_path, goal_id)?;
        Ok(format!(
            "# 长期目标规划会话\n\n\
             你正在为 Polaris 长期目标执行系统进行第一次规划会话。\n\n\
             ## 目标元数据\n\n\
             - 目标 ID: {}\n\
             - 目标标题: {}\n\
             - 工作区: {}\n\
             - AI 引擎: {}\n\
             - 间隔策略: {}\n\
             - 允许修改代码: {}\n\
             - 允许提交 git: {}\n\n\
             ## 本轮边界\n\n\
             - 本轮只做目标拆解和协议文档规划。\n\
             - 本轮不要修改业务代码，不要提交 git。\n\
             - 请先阅读目标目录下的协议文档，再更新 plan.md、queue.md、progress.md。\n\
             - 规划要拆成可独立执行的小模块，每次后续会话只推进一个小模块。\n\
             - 每个小模块需要包含目标、输入文档、预期修改范围、验收方式、完成后如何记录进度。\n\
             - 若信息不足，请把阻塞点写入 supplement.md 或 progress.md，并把目标状态建议为 blocked/maintenance。\n\n\
             ## 期望产出\n\n\
             1. 明确阶段拆解和里程碑。\n\
             2. 生成下一轮执行队列，第一项必须足够小，可以在一次独立会话内完成。\n\
             3. 给出用户复审点和 AI 完成判定规则。\n\
             4. 本轮结束前总结下一次执行会话应该读取哪些文档、执行什么、完成后更新什么。\n\n\
             ## 目标协议\n\n{}\n\n\
             ## 当前计划\n\n{}\n\n\
             ## 当前进度\n\n{}\n\n\
             ## 当前队列\n\n{}\n\n\
             ## 用户补充\n\n{}\n",
            state.config.id,
            state.config.title,
            state.config.workspace_path,
            state.config.engine_id,
            state.config.interval,
            state.config.allow_code_changes,
            state.config.allow_git_commit,
            state.documents.protocol,
            state.documents.plan,
            state.documents.progress,
            state.documents.queue,
            state.documents.supplement
        ))
    }

    pub fn prepare_maintenance_session(workspace_path: &str, goal_id: &str) -> Result<String> {
        let state = Self::read_goal(workspace_path, goal_id)?;
        Ok(format!(
            "# 长期目标维护会话\n\n\
             目标：{}\n\n\
             当前状态：{:?}\n\n\
             本会话只能整理长期目标文档，不得修改业务代码，不得提交 git。\n\n\
             请先阅读以下文档并完成整理：\n\n\
             ## 目标协议\n\n{}\n\n\
             ## 计划\n\n{}\n\n\
             ## 进度\n\n{}\n\n\
             ## 队列\n\n{}\n\n\
             ## 用户补充\n\n{}\n",
            state.config.title,
            state.config.status,
            state.documents.protocol,
            state.documents.plan,
            state.documents.progress,
            state.documents.queue,
            state.documents.supplement
        ))
    }

    pub fn record_step(params: RecordLongGoalStepParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        let now_text = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");

        let mut progress = Self::read_text(&goal_dir.join("progress.md"))?;
        progress.push_str(&format!(
            "\n\n## 执行记录 - {} - {}\n\n\
             - 结果：{}\n\
             - 摘要：{}\n\
             - 修改文件：{}\n\
             - 验证：{}\n\
             - Commit：{}\n\
             - 下一步：{}\n",
            now_text,
            params.step_id,
            empty_as_default(&params.result, "unknown"),
            params.summary.trim(),
            list_or_none(&params.changed_files),
            list_or_none(&params.tests_run),
            params.commit_sha.as_deref().unwrap_or("无"),
            params.next_step.as_deref().unwrap_or("待定")
        ));
        Self::write_text(&goal_dir.join("progress.md"), &progress)?;

        if let Some(next_step) = params.next_step.as_deref() {
            let mut queue = Self::read_text(&goal_dir.join("queue.md"))?;
            queue.push_str(&format!(
                "\n\n## 下一步建议 - {}\n\n{}\n",
                now_text,
                next_step.trim()
            ));
            Self::write_text(&goal_dir.join("queue.md"), &queue)?;
        }

        config.current_step_id = params.next_step.as_ref().map(|_| params.step_id);
        if let Some(status) = params.goal_status {
            config.status = status;
            if status == LongGoalStatus::Completed {
                config.phase = LongGoalPhase::Review;
                config.next_run_at = None;
            }
        } else {
            config.status = LongGoalStatus::Active;
            config.phase = LongGoalPhase::Execution;
        }
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, &params.goal_id)
    }

    pub fn complete_goal(params: CompleteLongGoalParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        let now_text = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");

        let mut progress = Self::read_text(&goal_dir.join("progress.md"))?;
        progress.push_str(&format!(
            "\n\n## 完成判定 - {}\n\n{}\n\n### 剩余风险\n{}\n\n### 复审建议\n{}\n",
            now_text,
            params.completion_summary.trim(),
            list_or_none(&params.remaining_risks),
            list_or_none(&params.review_suggestions)
        ));
        Self::write_text(&goal_dir.join("progress.md"), &progress)?;

        config.status = LongGoalStatus::Completed;
        config.phase = LongGoalPhase::Review;
        config.next_run_at = None;
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, &params.goal_id)
    }

    fn set_status(
        workspace_path: &str,
        goal_id: &str,
        status: LongGoalStatus,
        phase: LongGoalPhase,
    ) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        config.status = status;
        config.phase = phase;
        if matches!(status, LongGoalStatus::Paused | LongGoalStatus::Completed) {
            config.next_run_at = None;
        }
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, goal_id)
    }

    fn read_goal_state(workspace: &Path, goal_id: &str) -> Result<LongGoalState> {
        let goal_dir = Self::checked_goal_dir(workspace, goal_id)?;
        let config = Self::read_config(&goal_dir)?;
        let documents = LongGoalDocuments {
            protocol: Self::read_text(&goal_dir.join("protocol.md"))?,
            plan: Self::read_text(&goal_dir.join("plan.md"))?,
            progress: Self::read_text(&goal_dir.join("progress.md"))?,
            queue: Self::read_text(&goal_dir.join("queue.md"))?,
            supplement: Self::read_text(&goal_dir.join("supplement.md"))?,
            last_session_summary: Self::read_last_session_summary(&goal_dir)?,
        };
        Ok(LongGoalState {
            config,
            documents,
            goal_path: goal_dir.to_string_lossy().to_string(),
        })
    }

    fn canonical_workspace(workspace_path: &str) -> Result<PathBuf> {
        let workspace = Path::new(workspace_path).canonicalize().map_err(|error| {
            AppError::InvalidPath(format!("无法读取工作区 {}: {}", workspace_path, error))
        })?;
        if !workspace.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "工作区不是目录: {}",
                workspace.display()
            )));
        }
        Ok(workspace)
    }

    fn checked_goal_dir(workspace: &Path, goal_id: &str) -> Result<PathBuf> {
        let root = workspace.join(".polaris").join("long-goals");
        let dir = root.join(Self::safe_id(goal_id));
        let canonical_root = root.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!(
                "无法读取长期目标目录 {}: {}",
                root.display(),
                error
            ))
        })?;
        let canonical_dir = dir.canonicalize().map_err(|error| {
            AppError::InvalidPath(format!("无法读取长期目标 {}: {}", goal_id, error))
        })?;
        if !canonical_dir.starts_with(&canonical_root) || canonical_dir == canonical_root {
            return Err(AppError::PermissionDenied(format!(
                "长期目标路径超出允许目录: {}",
                canonical_dir.display()
            )));
        }
        Ok(canonical_dir)
    }

    fn goal_dir(workspace: &Path, goal_id: &str) -> PathBuf {
        workspace.join(".polaris").join("long-goals").join(goal_id)
    }

    fn new_goal_id(title: &str) -> String {
        let prefix = Self::safe_id(title);
        let prefix = if prefix.is_empty() {
            "goal".to_string()
        } else {
            prefix
        };
        format!("{}-{}", prefix, Uuid::new_v4().simple())
    }

    fn safe_id(value: &str) -> String {
        value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    }

    fn initial_documents(config: &LongGoalConfig) -> LongGoalDocuments {
        LongGoalDocuments {
            protocol: format!(
                "# 长期目标协议\n\n## 目标\n\n{}\n\n## 执行规则\n\n- 第一次会话只拆解计划并落盘。\n- 后续每次新建独立会话，只推进一个小模块。\n- 每轮执行前必须读取目标状态和用户补充。\n- 每轮执行后必须更新进度、队列和会话摘要。\n- AI 判定完成后自动暂停，等待用户复审。\n",
                config.goal
            ),
            plan: "# 计划\n\n状态: 待拆解\n".to_string(),
            progress: "# 进度\n\n状态: 初始化\n进度: 0%\n".to_string(),
            queue: format!("# 任务队列\n\n1. 拆解长期目标：{}\n", config.title),
            supplement: "# 用户补充\n\n<!-- 在下方追加补充内容 -->\n".to_string(),
            last_session_summary: None,
        }
    }

    fn write_documents(goal_dir: &Path, documents: &LongGoalDocuments) -> Result<()> {
        Self::write_text(&goal_dir.join("protocol.md"), &documents.protocol)?;
        Self::write_text(&goal_dir.join("plan.md"), &documents.plan)?;
        Self::write_text(&goal_dir.join("progress.md"), &documents.progress)?;
        Self::write_text(&goal_dir.join("queue.md"), &documents.queue)?;
        Self::write_text(&goal_dir.join("supplement.md"), &documents.supplement)?;
        Ok(())
    }

    fn read_config(goal_dir: &Path) -> Result<LongGoalConfig> {
        let content = Self::read_text(&goal_dir.join("goal.json"))?;
        serde_json::from_str(&content).map_err(Into::into)
    }

    fn write_config(goal_dir: &Path, config: &LongGoalConfig) -> Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        Self::write_text(&goal_dir.join("goal.json"), &(content + "\n"))
    }

    fn touch_config(config: &mut LongGoalConfig) {
        config.revision += 1;
        config.updated_at = Utc::now().timestamp();
    }

    fn read_text(path: &Path) -> Result<String> {
        std::fs::read_to_string(path).map_err(Into::into)
    }

    fn write_text(path: &Path, content: &str) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content).map_err(Into::into)
    }

    fn read_last_session_summary(goal_dir: &Path) -> Result<Option<String>> {
        let sessions_dir = goal_dir.join("sessions");
        if !sessions_dir.exists() {
            return Ok(None);
        }
        let mut entries = std::fs::read_dir(sessions_dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        entries
            .last()
            .map(|entry| Self::read_text(&entry.path()).map(Some))
            .unwrap_or(Ok(None))
    }
}

fn list_or_none(items: &[String]) -> String {
    if items.is_empty() {
        "无".to_string()
    } else {
        items
            .iter()
            .map(|item| format!("- {}", item))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn empty_as_default<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.trim().is_empty() {
        default
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reads_long_goal_documents() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Test Goal".to_string(),
            goal: "Build a long goal executor".to_string(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            engine_id: "codex".to_string(),
            interval: "10m".to_string(),
            auto_pause_on_complete: true,
            allow_code_changes: true,
            allow_git_commit: true,
        })
        .unwrap();

        assert_eq!(state.config.status, LongGoalStatus::Planning);
        assert!(state
            .documents
            .protocol
            .contains("Build a long goal executor"));
        assert!(Path::new(&state.goal_path).join("goal.json").is_file());

        let reread =
            LongGoalService::read_goal(&workspace.path().to_string_lossy(), &state.config.id)
                .unwrap();
        assert_eq!(reread.config.id, state.config.id);
    }

    #[test]
    fn appends_supplement_and_pauses_goal() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Supplement Goal".to_string(),
            goal: "Keep state".to_string(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            engine_id: "codex".to_string(),
            interval: "10m".to_string(),
            auto_pause_on_complete: true,
            allow_code_changes: true,
            allow_git_commit: true,
        })
        .unwrap();

        let updated = LongGoalService::append_supplement(AppendLongGoalSupplementParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            content: "User changed priority".to_string(),
            priority: Some("high".to_string()),
        })
        .unwrap();
        assert!(updated
            .documents
            .supplement
            .contains("User changed priority"));

        let paused =
            LongGoalService::pause_goal(&workspace.path().to_string_lossy(), &state.config.id)
                .unwrap();
        assert_eq!(paused.config.status, LongGoalStatus::Paused);
    }
}
