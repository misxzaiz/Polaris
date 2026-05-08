//! Document-backed long goal service.

use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, BindLongGoalSessionParams, CompleteLongGoalParams,
    CreateLongGoalParams, FinishLongGoalSessionParams, LongGoalConfig, LongGoalDocuments,
    LongGoalPhase, LongGoalState, LongGoalStatus, RecordLongGoalStepParams,
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
            retry_count: 0,
            max_retries: params.max_retries,
            retry_backoff: params.retry_backoff,
            auto_pause_on_complete: params.auto_pause_on_complete,
            allow_code_changes: params.allow_code_changes,
            allow_git_commit: params.allow_git_commit,
            current_step_id: None,
            current_session_id: None,
            last_session_id: None,
            next_run_at: None,
            last_failure_at: None,
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

    pub fn bind_session(params: BindLongGoalSessionParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        config.current_session_id = Some(params.session_id.clone());
        config.last_session_id = Some(params.session_id);
        config.status = LongGoalStatus::Running;
        config.phase = params.phase;
        config.next_run_at = None;
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, &params.goal_id)
    }

    pub fn finish_session(params: FinishLongGoalSessionParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        let is_current = config.current_session_id.as_deref() == Some(params.session_id.as_str());
        if !is_current {
            return Self::read_goal_state(&workspace, &params.goal_id);
        }

        let now = Utc::now();
        let now_text = now.format("%Y-%m-%d %H:%M:%S UTC");
        let phase = config.phase;
        let result = empty_as_default(&params.result, "success");
        let summary = params.summary.trim();
        let session_doc = format!(
            "# 会话摘要 - {}\n\n\
             - 会话 ID: {}\n\
             - 阶段: {:?}\n\
             - 结果: {}\n\n\
             ## 摘要\n\n{}\n\n\
             ## 下一步\n\n{}\n",
            now_text,
            params.session_id,
            phase,
            result,
            empty_as_default(summary, "未捕获到会话摘要。"),
            params.next_step.as_deref().unwrap_or("待定")
        );
        let session_file = format!(
            "{}-{}-{}.md",
            now.format("%Y%m%d%H%M%S"),
            Self::phase_slug(phase),
            Self::safe_id(&params.session_id)
        );
        Self::write_text(&goal_dir.join("sessions").join(session_file), &session_doc)?;

        let mut progress = Self::read_text(&goal_dir.join("progress.md"))?;
        progress.push_str(&format!(
            "\n\n## 会话结束 - {} - {}\n\n\
             - 阶段: {:?}\n\
             - 结果: {}\n\
             - 摘要: {}\n\
             - 下一步: {}\n",
            now_text,
            params.session_id,
            phase,
            result,
            empty_as_default(summary, "未捕获到会话摘要。"),
            params.next_step.as_deref().unwrap_or("待定")
        ));
        Self::write_text(&goal_dir.join("progress.md"), &progress)?;

        if let Some(next_step) = params.next_step.as_deref() {
            let mut queue = Self::read_text(&goal_dir.join("queue.md"))?;
            queue.push_str(&format!(
                "\n\n## 会话建议下一步 - {}\n\n{}\n",
                now_text,
                next_step.trim()
            ));
            Self::write_text(&goal_dir.join("queue.md"), &queue)?;
        }

        config.current_session_id = None;
        config.last_session_id = Some(params.session_id);
        if params.retry_failure {
            Self::apply_retry_failure(&mut config, now.timestamp());
        } else if let Some(status) = params.goal_status {
            config.status = status;
            config.phase = if status == LongGoalStatus::Completed {
                LongGoalPhase::Review
            } else {
                phase
            };
        } else if config.status == LongGoalStatus::Running {
            match phase {
                LongGoalPhase::Planning | LongGoalPhase::Execution => {
                    config.status = LongGoalStatus::Active;
                    config.phase = LongGoalPhase::Execution;
                }
                LongGoalPhase::Maintenance | LongGoalPhase::Review => {
                    config.status = LongGoalStatus::Paused;
                    config.phase = LongGoalPhase::Review;
                }
            }
        }
        if Self::is_success_result(result) && !params.retry_failure {
            Self::reset_retry_state(&mut config);
        }
        if !params.retry_failure {
            Self::update_next_run_at(&mut config, now.timestamp());
        }
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

    pub fn prepare_execution_session(workspace_path: &str, goal_id: &str) -> Result<String> {
        let state = Self::read_goal(workspace_path, goal_id)?;
        Ok(format!(
            "# 长期目标执行会话\n\n\
             你正在推进 Polaris 长期目标中的一个小模块。本轮必须保持边界清晰，只处理任务队列中的第一个可执行小模块。\n\n\
             ## 目标元数据\n\n\
             - 目标 ID: {}\n\
             - 目标标题: {}\n\
             - 工作区: {}\n\
             - AI 引擎: {}\n\
             - 当前状态: {:?}\n\
             - 当前阶段: {:?}\n\
             - 允许修改代码: {}\n\
             - 允许提交 git: {}\n\n\
             ## 本轮执行规则\n\n\
             - 执行前必须阅读目标协议、计划、进度、队列、用户补充和上一轮摘要。\n\
             - 本轮只推进 `queue.md` 中最靠前的一个可执行小模块，不要顺手扩大范围。\n\
             - 如果任务需要修改代码，必须保持改动集中，并在结束前说明修改文件和验证方式。\n\
             - 如果 `allowGitCommit` 为 true 且本轮有代码变更、验证通过，可以提交 git；否则不要提交。\n\
             - 如果发现信息不足、权限不足、测试失败且无法在本轮修复，请明确标记阻塞点和建议下一步。\n\
             - 如果你判断长期目标已经满足验收标准，请在最终回答中明确写出完成判定、剩余风险和复审建议。\n\n\
             ## 结束前输出格式\n\n\
             请在最终回答中包含以下小节：\n\n\
             - 本轮结果\n\
             - 修改文件\n\
             - 验证\n\
             - Commit\n\
             - 下一步\n\
             - 是否完成长期目标\n\n\
             ## 目标协议\n\n{}\n\n\
             ## 当前计划\n\n{}\n\n\
             ## 当前进度\n\n{}\n\n\
             ## 当前队列\n\n{}\n\n\
             ## 用户补充\n\n{}\n\n\
             ## 上一轮摘要\n\n{}\n",
            state.config.id,
            state.config.title,
            state.config.workspace_path,
            state.config.engine_id,
            state.config.status,
            state.config.phase,
            state.config.allow_code_changes,
            state.config.allow_git_commit,
            state.documents.protocol,
            state.documents.plan,
            state.documents.progress,
            state.documents.queue,
            state.documents.supplement,
            state
                .documents
                .last_session_summary
                .as_deref()
                .unwrap_or("暂无")
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
        let now = Utc::now().timestamp();
        if params.retry_failure {
            Self::apply_retry_failure(&mut config, now);
        } else if let Some(status) = params.goal_status {
            config.status = status;
            if status == LongGoalStatus::Completed {
                config.phase = LongGoalPhase::Review;
                config.next_run_at = None;
            }
        } else {
            config.status = LongGoalStatus::Active;
            config.phase = LongGoalPhase::Execution;
        }
        if Self::is_success_result(empty_as_default(&params.result, "unknown"))
            && !params.retry_failure
        {
            Self::reset_retry_state(&mut config);
        }
        config.current_session_id = None;
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
        config.current_session_id = None;
        config.next_run_at = None;
        Self::reset_retry_state(&mut config);
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
        config.current_session_id = None;
        Self::update_next_run_at(&mut config, Utc::now().timestamp());
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

    fn phase_slug(phase: LongGoalPhase) -> &'static str {
        match phase {
            LongGoalPhase::Planning => "planning",
            LongGoalPhase::Execution => "execution",
            LongGoalPhase::Maintenance => "maintenance",
            LongGoalPhase::Review => "review",
        }
    }

    fn update_next_run_at(config: &mut LongGoalConfig, now: i64) {
        if config.status == LongGoalStatus::Active {
            config.next_run_at =
                Self::parse_interval_seconds(&config.interval).map(|seconds| now + seconds);
        } else {
            config.next_run_at = None;
        }
    }

    fn apply_retry_failure(config: &mut LongGoalConfig, now: i64) {
        config.retry_count = config.retry_count.saturating_add(1);
        config.last_failure_at = Some(now);
        config.current_session_id = None;
        if config.retry_count <= config.max_retries {
            config.status = LongGoalStatus::Active;
            config.phase = LongGoalPhase::Execution;
            let retry_seconds = Self::parse_interval_seconds(&config.retry_backoff).unwrap_or(300);
            config.next_run_at = Some(now + retry_seconds);
        } else {
            config.status = LongGoalStatus::Blocked;
            config.next_run_at = None;
        }
    }

    fn reset_retry_state(config: &mut LongGoalConfig) {
        config.retry_count = 0;
        config.last_failure_at = None;
    }

    fn is_success_result(result: &str) -> bool {
        matches!(result, "success" | "completed")
    }

    fn parse_interval_seconds(interval: &str) -> Option<i64> {
        let trimmed = interval.trim();
        if trimmed.is_empty() {
            return None;
        }

        let number_len = trimmed
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .map(char::len_utf8)
            .sum::<usize>();
        let amount = trimmed.get(..number_len)?.parse::<i64>().ok()?;
        if amount <= 0 {
            return None;
        }
        let unit = trimmed
            .get(number_len..)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let multiplier = match unit.as_str() {
            "" | "s" | "sec" | "secs" | "second" | "seconds" => 1,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "h" | "hr" | "hrs" | "hour" | "hours" => 60 * 60,
            "d" | "day" | "days" => 24 * 60 * 60,
            _ => return None,
        };
        amount.checked_mul(multiplier)
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
            max_retries: 2,
            retry_backoff: "5m".to_string(),
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

        let prompt = LongGoalService::prepare_execution_session(
            &workspace.path().to_string_lossy(),
            &state.config.id,
        )
        .unwrap();
        assert!(prompt.contains("长期目标执行会话"));
        assert!(prompt.contains("Build a long goal executor"));
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
            max_retries: 2,
            retry_backoff: "5m".to_string(),
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

    #[test]
    fn binds_session_and_marks_goal_running() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Session Goal".to_string(),
            goal: "Track session lifecycle".to_string(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            engine_id: "codex".to_string(),
            interval: "10m".to_string(),
            max_retries: 2,
            retry_backoff: "5m".to_string(),
            auto_pause_on_complete: true,
            allow_code_changes: true,
            allow_git_commit: true,
        })
        .unwrap();

        let bound = LongGoalService::bind_session(BindLongGoalSessionParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            session_id: "session-1".to_string(),
            phase: LongGoalPhase::Planning,
        })
        .unwrap();

        assert_eq!(bound.config.status, LongGoalStatus::Running);
        assert_eq!(bound.config.phase, LongGoalPhase::Planning);
        assert_eq!(
            bound.config.current_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(bound.config.last_session_id.as_deref(), Some("session-1"));

        let finished = LongGoalService::finish_session(FinishLongGoalSessionParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: bound.config.id,
            session_id: "session-1".to_string(),
            summary: "Planning completed".to_string(),
            result: "success".to_string(),
            next_step: Some("Run first execution step".to_string()),
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();

        assert_eq!(finished.config.status, LongGoalStatus::Active);
        assert_eq!(finished.config.phase, LongGoalPhase::Execution);
        assert_eq!(finished.config.current_session_id, None);
        assert!(finished.config.next_run_at.is_some());
        assert!(finished.documents.progress.contains("Planning completed"));
        assert!(finished
            .documents
            .queue
            .contains("Run first execution step"));
        assert!(Path::new(&finished.goal_path).join("sessions").is_dir());
    }

    #[test]
    fn parses_interval_values() {
        assert_eq!(LongGoalService::parse_interval_seconds("30m"), Some(1800));
        assert_eq!(LongGoalService::parse_interval_seconds("1h"), Some(3600));
        assert_eq!(
            LongGoalService::parse_interval_seconds("2 days"),
            Some(172800)
        );
        assert_eq!(LongGoalService::parse_interval_seconds("0m"), None);
        assert_eq!(LongGoalService::parse_interval_seconds("later"), None);
    }

    #[test]
    fn retry_failure_reschedules_then_blocks_after_limit() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Retry Goal".to_string(),
            goal: "Retry failed execution".to_string(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            engine_id: "codex".to_string(),
            interval: "10m".to_string(),
            max_retries: 1,
            retry_backoff: "5m".to_string(),
            auto_pause_on_complete: true,
            allow_code_changes: true,
            allow_git_commit: true,
        })
        .unwrap();

        let first_failure = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "auto-start".to_string(),
            summary: "failed to start".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "failed".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: true,
        })
        .unwrap();
        assert_eq!(first_failure.config.status, LongGoalStatus::Active);
        assert_eq!(first_failure.config.retry_count, 1);
        assert!(first_failure.config.next_run_at.is_some());

        let blocked = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            step_id: "auto-start-2".to_string(),
            summary: "failed again".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "failed".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: true,
        })
        .unwrap();
        assert_eq!(blocked.config.status, LongGoalStatus::Blocked);
        assert_eq!(blocked.config.retry_count, 2);
        assert_eq!(blocked.config.next_run_at, None);
    }
}
