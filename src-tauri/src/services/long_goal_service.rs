//! Document-backed long goal service.

use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, BindLongGoalSessionParams, CompleteLongGoalParams,
    CreateLongGoalParams, FinishLongGoalSessionParams, LongGoalConfig, LongGoalDocuments,
    LongGoalPhase, LongGoalState, LongGoalStatus, RecordLongGoalStepParams,
    SetLongGoalStatusParams, UpdateLongGoalDocumentsParams,
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
            Self::ensure_status_not_running(status)?;
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
        let prompt = format!(
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
        );
        Ok(format!(
            "{}\n\n{}",
            prompt,
            Self::mcp_usage_rules(&state.config.id, "planning")
        ))
    }

    pub fn prepare_execution_session(workspace_path: &str, goal_id: &str) -> Result<String> {
        let state = Self::read_goal(workspace_path, goal_id)?;
        let prompt = format!(
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
             - 如果 `allowCodeChanges` 为 false，本轮不得修改代码或提交 git，只能分析、规划和更新长期目标文档。\n\
             - 如果 `allowCodeChanges` 为 true 且任务需要修改代码，必须保持改动集中，并在结束前说明修改文件和验证方式。\n\
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
        );
        Ok(format!(
            "{}\n\n{}",
            prompt,
            Self::mcp_usage_rules(&state.config.id, "execution")
        ))
    }

    pub fn prepare_maintenance_session(workspace_path: &str, goal_id: &str) -> Result<String> {
        let state = Self::read_goal(workspace_path, goal_id)?;
        let prompt = format!(
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
        );
        Ok(format!(
            "{}\n\n{}",
            prompt,
            Self::mcp_usage_rules(&state.config.id, "maintenance")
        ))
    }

    fn mcp_usage_rules(goal_id: &str, phase: &str) -> String {
        let write_rule = match phase {
            "planning" | "maintenance" => {
                "- 结束前必须调用 `mcp__polaris-long-goal__long_goal_update_documents` 写回 `plan`、`queue`、`progress` 等已整理文档。"
            }
            _ => {
                "- 结束前必须调用 `mcp__polaris-long-goal__long_goal_record_progress` 记录本轮结果、验证、修改文件、commit 和下一步。"
            }
        };
        format!(
            "## MCP 工具写回要求\n\n\
             - 开始执行前先调用 `mcp__polaris-long-goal__long_goal_read` 读取最新目标状态，参数：`{{\"goalId\":\"{}\"}}`。\n\
             - 优先使用 `polaris-long-goal` MCP tools 读写长期目标文档，不要直接把 `.polaris/long-goals` 当成唯一写回通道。\n\
             {}\n\
             - 如果判断长期目标完成，必须调用 `mcp__polaris-long-goal__long_goal_complete`，写入完成判定、剩余风险和复审建议。\n\
             - 如果信息不足或需要用户补充，调用 `mcp__polaris-long-goal__long_goal_append_supplement` 或 `mcp__polaris-long-goal__long_goal_set_status` 标记 `blocked`/`maintenance`。\n\
             - 最终回答中简要说明已经调用了哪些长期目标 MCP tools；宿主仍会在会话结束时做兜底摘要写回。\n",
            goal_id, write_rule
        )
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

        // current_step_id 语义：始终记录"刚完成的步骤标识"。
        // 旧实现把 current_step_id 与 next_step 是否存在绑定 —— 不传 next_step 时
        // current_step_id 直接被清空，导致 LongGoalPanel 永远拿不到最新一步标识，
        // UI"当前步骤"展示断档。next_step 内容已经在 line 429-437 写入 queue.md，
        // 不应该再反向影响 current_step_id 的写入。LG-002。
        config.current_step_id = Some(params.step_id);
        let now = Utc::now().timestamp();
        if params.retry_failure {
            Self::apply_retry_failure(&mut config, now);
        } else if let Some(status) = params.goal_status {
            Self::ensure_status_not_running(status)?;
            config.status = status;
            if status == LongGoalStatus::Completed {
                config.phase = LongGoalPhase::Review;
                config.next_run_at = None;
            }
        } else if config.status == LongGoalStatus::Running {
            // 仅当当前状态是 Running（即正在被绑定的会话刚执行完）时，
            // 才回落到 Active+Execution。其他状态（Paused / Maintenance / Blocked /
            // Completed / Active 等）保持原值，避免 record_step 静默篡改用户在
            // UI 中明确设定的状态。LG-001。
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

    pub fn update_documents(params: UpdateLongGoalDocumentsParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        let mut changed = Vec::new();

        if let Some(content) = params.protocol {
            Self::write_text(
                &goal_dir.join("protocol.md"),
                &ensure_trailing_newline(content),
            )?;
            changed.push("protocol.md");
        }
        if let Some(content) = params.plan {
            Self::write_text(&goal_dir.join("plan.md"), &ensure_trailing_newline(content))?;
            changed.push("plan.md");
        }
        if let Some(content) = params.progress {
            Self::write_text(
                &goal_dir.join("progress.md"),
                &ensure_trailing_newline(content),
            )?;
            changed.push("progress.md");
        }
        if let Some(content) = params.queue {
            Self::write_text(
                &goal_dir.join("queue.md"),
                &ensure_trailing_newline(content),
            )?;
            changed.push("queue.md");
        }
        if let Some(content) = params.supplement {
            Self::write_text(
                &goal_dir.join("supplement.md"),
                &ensure_trailing_newline(content),
            )?;
            changed.push("supplement.md");
        }

        if changed.is_empty() {
            return Err(AppError::ValidationError(
                "至少需要更新一个长期目标文档".to_string(),
            ));
        }

        if let Some(note) = params
            .note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let now_text = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
            let mut progress = Self::read_text(&goal_dir.join("progress.md"))?;
            progress.push_str(&format!(
                "\n\n## 文档更新 - {}\n\n- 文件: {}\n- 说明: {}\n",
                now_text,
                changed.join(", "),
                note
            ));
            Self::write_text(&goal_dir.join("progress.md"), &progress)?;
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

        // LG-003: auto_pause_on_complete 字段语义贯通。
        // 字段字面语义 = "完成时自动暂停"，所以：
        //   - auto_pause_on_complete=true 且当前不是 Paused+Review：
        //     首次完成调用 → 设 Paused+Review，等待用户在 UI 复审后再确认；
        //   - auto_pause_on_complete=true 且当前已是 Paused+Review：
        //     用户复审后 UI 二次调用 → 进入终态 Completed；
        //   - auto_pause_on_complete=false：
        //     跳过暂停一步到位 → Completed（旧行为）。
        // progress.md 里"完成判定"无论哪个分支都先落盘，避免 AI 第一次填写的判定丢失。
        let was_paused_for_review = config.status == LongGoalStatus::Paused
            && config.phase == LongGoalPhase::Review;
        let final_status = if config.auto_pause_on_complete && !was_paused_for_review {
            LongGoalStatus::Paused
        } else {
            LongGoalStatus::Completed
        };
        config.status = final_status;
        config.phase = LongGoalPhase::Review;
        config.current_session_id = None;
        config.next_run_at = None;
        Self::reset_retry_state(&mut config);
        Self::touch_config(&mut config);
        Self::write_config(&goal_dir, &config)?;
        Self::read_goal_state(&workspace, &params.goal_id)
    }

    pub fn set_goal_status(params: SetLongGoalStatusParams) -> Result<LongGoalState> {
        let workspace = Self::canonical_workspace(&params.workspace_path)?;
        let goal_dir = Self::checked_goal_dir(&workspace, &params.goal_id)?;
        let mut config = Self::read_config(&goal_dir)?;
        Self::ensure_status_not_running(params.status)?;
        config.status = params.status;
        if let Some(phase) = params.phase {
            config.phase = phase;
        } else if params.status == LongGoalStatus::Completed {
            config.phase = LongGoalPhase::Review;
        }
        if params.status != LongGoalStatus::Running {
            config.current_session_id = None;
        }
        if let Some(next_run_at) = params.next_run_at {
            if params.status != LongGoalStatus::Active {
                return Err(AppError::ValidationError(
                    "只有 active 状态可以设置 nextRunAt".to_string(),
                ));
            }
            config.next_run_at = Some(next_run_at);
        } else {
            Self::update_next_run_at(&mut config, Utc::now().timestamp());
        }
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

    fn ensure_status_not_running(status: LongGoalStatus) -> Result<()> {
        if status == LongGoalStatus::Running {
            return Err(AppError::ValidationError(
                "running 状态只能通过绑定长期目标会话进入".to_string(),
            ));
        }
        Ok(())
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
        // LG-009: strip the `\\?\` verbatim prefix on Windows so the path
        // persisted into `goal.config.workspace_path` matches the non-UNC
        // form held by the frontend (`longGoalSessionTracker`'s
        // `currentWorkspacePath`). The path-traversal check inside
        // `checked_goal_dir` re-canonicalizes both sides before comparing,
        // so this is purely an output-shape concern and does not weaken
        // the security boundary.
        Ok(strip_verbatim_prefix(workspace))
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
        // The traversal check happens BEFORE the prefix is stripped, while
        // both sides are still in canonicalized (UNC on Windows) form. We
        // only strip on the returned value so that `goal_path` exposed via
        // `LongGoalState` stays in the non-UNC shape the frontend expects.
        if !canonical_dir.starts_with(&canonical_root) || canonical_dir == canonical_root {
            return Err(AppError::PermissionDenied(format!(
                "长期目标路径超出允许目录: {}",
                canonical_dir.display()
            )));
        }
        Ok(strip_verbatim_prefix(canonical_dir))
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
            // retry 耗尽属于"系统判定不可恢复"，写 Failed 而非 Blocked。
            // Blocked 专用于"等待用户输入"语义（AI 主动声明 blocker / 用户从 UI
            // 显式 set_status=Blocked），两类来源混用同一个状态会让用户分不清
            // 该去看 supplement 还是去做根因分析。LG-007。
            config.status = LongGoalStatus::Failed;
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

/// Strip the `\\?\` verbatim prefix that `Path::canonicalize` emits on
/// Windows so persisted/exposed paths stay in the plain `D:\…` form the
/// frontend uses (LG-009).
///
/// Only strips the disk-letter form (`\\?\D:\…`); UNC server paths
/// (`\\?\UNC\server\share`) are returned unchanged because they have no
/// canonical non-verbatim equivalent. On non-Windows targets this is a
/// no-op.
#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return PathBuf::from(rest.to_string());
        }
    }
    path
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn empty_as_default<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.trim().is_empty() {
        default
    } else {
        value
    }
}

fn ensure_trailing_newline(mut value: String) -> String {
    if !value.ends_with('\n') {
        value.push('\n');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_disk_form_is_stripped() {
        // LG-009: the disk-letter verbatim form must lose the `\\?\` prefix
        // so `goal.config.workspace_path` matches the renderer-side path.
        let unc = PathBuf::from(r"\\?\D:\space\base\Polaris");
        assert_eq!(
            strip_verbatim_prefix(unc),
            PathBuf::from(r"D:\space\base\Polaris")
        );
    }

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_unc_server_form_is_preserved() {
        // LG-009: UNC server paths have no canonical non-verbatim
        // equivalent — strip would be unsafe, so they must pass through.
        let server = PathBuf::from(r"\\?\UNC\server\share\foo");
        assert_eq!(strip_verbatim_prefix(server.clone()), server);
    }

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_plain_path_is_passthrough() {
        // LG-009: paths that already lack the `\\?\` prefix must be
        // returned unchanged, including standard UNC shares without the
        // verbatim escape (`\\server\share\…`).
        let plain = PathBuf::from(r"D:\already\plain");
        assert_eq!(strip_verbatim_prefix(plain.clone()), plain);
        let standard_unc = PathBuf::from(r"\\server\share\foo");
        assert_eq!(strip_verbatim_prefix(standard_unc.clone()), standard_unc);
    }

    #[cfg(windows)]
    #[test]
    fn create_goal_persists_non_unc_workspace_path() {
        // LG-009 regression guard: the workspace_path written to goal.json
        // and exposed via LongGoalState must not retain the `\\?\` verbatim
        // prefix on Windows, otherwise `longGoalSessionTracker` cannot
        // string-match it against the renderer's currentWorkspacePath.
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "LG-009 Guard".to_string(),
            goal: "Verify workspace_path is non-UNC".to_string(),
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

        assert!(
            !state.config.workspace_path.starts_with(r"\\?\"),
            "workspace_path must not retain the verbatim prefix: {}",
            state.config.workspace_path
        );
        assert!(
            !state.goal_path.starts_with(r"\\?\"),
            "goal_path must not retain the verbatim prefix: {}",
            state.goal_path
        );
    }

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
    fn retry_failure_reschedules_then_fails_after_limit() {
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

        // retry 耗尽 → 写 Failed（系统判定不可恢复），区别于 Blocked（等待用户输入）。LG-007。
        let failed = LongGoalService::record_step(RecordLongGoalStepParams {
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
        assert_eq!(failed.config.status, LongGoalStatus::Failed);
        assert_eq!(failed.config.retry_count, 2);
        assert_eq!(failed.config.next_run_at, None);
    }

    #[test]
    fn record_step_preserves_paused_status() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Pause Goal".to_string(),
            goal: "Verify record_step does not override paused state".to_string(),
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

        // Paused：用户主动暂停后，record_step 不应该把它撩回 Active
        let paused =
            LongGoalService::pause_goal(&workspace.path().to_string_lossy(), &state.config.id)
                .unwrap();
        assert_eq!(paused.config.status, LongGoalStatus::Paused);

        let after_paused_step = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "step-while-paused".to_string(),
            summary: "user paused goal then AI submitted progress".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(
            after_paused_step.config.status,
            LongGoalStatus::Paused,
            "Paused 状态在 record_step 后必须保持，不能被静默重置为 Active"
        );

        // Maintenance：长期维护态同样不应被 record_step 重置
        let maintenance = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            status: LongGoalStatus::Maintenance,
            phase: Some(LongGoalPhase::Maintenance),
            next_run_at: None,
        })
        .unwrap();
        assert_eq!(maintenance.config.status, LongGoalStatus::Maintenance);

        let after_maintenance_step = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "step-while-maintenance".to_string(),
            summary: "maintenance submission".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(
            after_maintenance_step.config.status,
            LongGoalStatus::Maintenance
        );

        // Blocked：等待用户输入态，record_step 不应解锁
        let blocked = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            status: LongGoalStatus::Blocked,
            phase: Some(LongGoalPhase::Review),
            next_run_at: None,
        })
        .unwrap();
        assert_eq!(blocked.config.status, LongGoalStatus::Blocked);

        let after_blocked_step = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "step-while-blocked".to_string(),
            summary: "blocked submission".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(after_blocked_step.config.status, LongGoalStatus::Blocked);

        // 回归保护：Running → record_step（goal_status=None）应仍然回落到 Active+Execution
        let bound = LongGoalService::bind_session(BindLongGoalSessionParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            session_id: "running-session".to_string(),
            phase: LongGoalPhase::Execution,
        })
        .unwrap();
        assert_eq!(bound.config.status, LongGoalStatus::Running);

        let after_running_step = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            step_id: "step-from-running".to_string(),
            summary: "AI completed a step inside the bound session".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(after_running_step.config.status, LongGoalStatus::Active);
        assert_eq!(after_running_step.config.phase, LongGoalPhase::Execution);
    }

    #[test]
    fn record_step_keeps_current_step_id_without_next_step() {
        // LG-002 回归测试：current_step_id 字段语义是"刚完成的步骤"，
        // 必须无条件写入；不能因为调用方未传 next_step 就清空。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Step ID Goal".to_string(),
            goal: "Verify current_step_id is always recorded".to_string(),
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
        // 初始：未执行任何步骤，current_step_id 应为 None
        assert_eq!(state.config.current_step_id, None);

        // 维度 1（核心）：不传 next_step 时，current_step_id 仍必须写入刚完成步骤
        let after_no_next = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "step-alpha".to_string(),
            summary: "first step without next_step".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(
            after_no_next.config.current_step_id.as_deref(),
            Some("step-alpha"),
            "不传 next_step 时 current_step_id 必须记录刚完成的 step_id（LG-002 核心断言）"
        );

        // 维度 2（回归）：传 next_step 时 current_step_id 也必须正确写入
        let after_with_next = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            step_id: "step-beta".to_string(),
            summary: "second step with next_step".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: Some("step-gamma".to_string()),
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(
            after_with_next.config.current_step_id.as_deref(),
            Some("step-beta"),
            "传 next_step 时 current_step_id 必须记录刚完成的 step_id，不能记成 next_step 的值"
        );

        // 维度 3（语义正确性）：连续调用，current_step_id 始终反映最新一步，
        // 而不是被清空或保留旧值
        let after_third = LongGoalService::record_step(RecordLongGoalStepParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            step_id: "step-delta".to_string(),
            summary: "third step without next_step again".to_string(),
            changed_files: Vec::new(),
            tests_run: Vec::new(),
            commit_sha: None,
            result: "success".to_string(),
            next_step: None,
            goal_status: None,
            retry_failure: false,
        })
        .unwrap();
        assert_eq!(
            after_third.config.current_step_id.as_deref(),
            Some("step-delta"),
            "连续调用时 current_step_id 必须更新为最新的 step_id"
        );
    }

    #[test]
    fn complete_goal_pauses_when_auto_pause_true_first_call() {
        // LG-003 维度 1（核心）：auto_pause_on_complete=true（默认）时，
        // AI 首次调用 complete_goal 应设 Paused+Review，等待用户在 UI 复审。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Auto Pause Goal".to_string(),
            goal: "Verify auto pause on first complete call".to_string(),
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
        assert!(state.config.auto_pause_on_complete);

        let completed = LongGoalService::complete_goal(CompleteLongGoalParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            completion_summary: "AI 判定目标完成，等待复审".to_string(),
            remaining_risks: vec!["需要用户复核测试覆盖".to_string()],
            review_suggestions: vec!["请检查 commit 列表".to_string()],
        })
        .unwrap();

        assert_eq!(
            completed.config.status,
            LongGoalStatus::Paused,
            "auto_pause_on_complete=true 时首次 complete 必须设 Paused 等待用户复审（LG-003 核心断言）"
        );
        assert_eq!(completed.config.phase, LongGoalPhase::Review);
        assert_eq!(completed.config.current_session_id, None);
        assert_eq!(completed.config.next_run_at, None);
        // 完成判定文本无论分支都必须落盘
        assert!(completed
            .documents
            .progress
            .contains("AI 判定目标完成，等待复审"));
        assert!(completed
            .documents
            .progress
            .contains("需要用户复核测试覆盖"));
    }

    #[test]
    fn complete_goal_skips_pause_when_auto_pause_false() {
        // LG-003 维度 2：auto_pause_on_complete=false 时，complete_goal 一步到位 Completed。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Skip Pause Goal".to_string(),
            goal: "Verify auto pause off bypasses paused state".to_string(),
            workspace_path: workspace.path().to_string_lossy().to_string(),
            engine_id: "codex".to_string(),
            interval: "10m".to_string(),
            max_retries: 2,
            retry_backoff: "5m".to_string(),
            auto_pause_on_complete: false,
            allow_code_changes: true,
            allow_git_commit: true,
        })
        .unwrap();
        assert!(!state.config.auto_pause_on_complete);

        let completed = LongGoalService::complete_goal(CompleteLongGoalParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            completion_summary: "auto_pause 关闭，直接终态".to_string(),
            remaining_risks: vec![],
            review_suggestions: vec![],
        })
        .unwrap();

        assert_eq!(
            completed.config.status,
            LongGoalStatus::Completed,
            "auto_pause_on_complete=false 时 complete 必须一步到位进入 Completed"
        );
        assert_eq!(completed.config.phase, LongGoalPhase::Review);
        assert_eq!(completed.config.current_session_id, None);
        assert_eq!(completed.config.next_run_at, None);
    }

    #[test]
    fn complete_goal_advances_to_completed_on_second_call() {
        // LG-003 维度 3：auto_pause_on_complete=true 时，
        // 第一次 complete → Paused+Review；
        // 用户在 UI 复审后第二次 complete → Completed（终态）。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Two-Phase Complete Goal".to_string(),
            goal: "Verify second complete advances to Completed".to_string(),
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

        // 第一次：AI 触发完成 → Paused + Review
        let after_first = LongGoalService::complete_goal(CompleteLongGoalParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            completion_summary: "AI 判定完成".to_string(),
            remaining_risks: vec![],
            review_suggestions: vec![],
        })
        .unwrap();
        assert_eq!(after_first.config.status, LongGoalStatus::Paused);
        assert_eq!(after_first.config.phase, LongGoalPhase::Review);

        // 第二次：UI 用户复审确认 → Completed
        let after_second = LongGoalService::complete_goal(CompleteLongGoalParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            completion_summary: "用户复审确认完成".to_string(),
            remaining_risks: vec![],
            review_suggestions: vec![],
        })
        .unwrap();
        assert_eq!(
            after_second.config.status,
            LongGoalStatus::Completed,
            "auto_pause=true 且当前已 Paused+Review 时，二次 complete 必须进入终态 Completed"
        );
        assert_eq!(after_second.config.phase, LongGoalPhase::Review);
        // 两次完成判定都应该写入 progress.md，第二次不能覆盖第一次
        assert!(after_second.documents.progress.contains("AI 判定完成"));
        assert!(after_second
            .documents
            .progress
            .contains("用户复审确认完成"));
    }

    #[test]
    fn updates_documents_and_rejects_empty_updates() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Document Goal".to_string(),
            goal: "Keep planning documents current".to_string(),
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

        let updated = LongGoalService::update_documents(UpdateLongGoalDocumentsParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            protocol: None,
            plan: Some("# Plan\n\nUpdated plan".to_string()),
            progress: None,
            queue: Some("# Queue\n\n1. First executable step".to_string()),
            supplement: None,
            note: Some("Planning pass completed".to_string()),
        })
        .unwrap();

        assert!(updated.documents.plan.contains("Updated plan"));
        assert!(updated.documents.queue.contains("First executable step"));
        assert!(updated
            .documents
            .progress
            .contains("Planning pass completed"));

        let empty = LongGoalService::update_documents(UpdateLongGoalDocumentsParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            protocol: None,
            plan: None,
            progress: None,
            queue: None,
            supplement: None,
            note: Some("No document".to_string()),
        });
        assert!(empty.is_err());
    }

    #[test]
    fn set_goal_status_rejects_running_and_non_active_schedule() {
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Status Goal".to_string(),
            goal: "Constrain status transitions".to_string(),
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

        let running = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id.clone(),
            status: LongGoalStatus::Running,
            phase: Some(LongGoalPhase::Execution),
            next_run_at: None,
        });
        assert!(running.is_err());

        let paused_with_schedule = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace.path().to_string_lossy().to_string(),
            goal_id: state.config.id,
            status: LongGoalStatus::Paused,
            phase: Some(LongGoalPhase::Review),
            next_run_at: Some(Utc::now().timestamp() + 60),
        });
        assert!(paused_with_schedule.is_err());
    }

    #[test]
    fn set_goal_status_clears_next_run_at_when_transitioning_to_non_active() {
        // LG-004 维度 1（核心隐性副作用）：
        // set_goal_status 把目标从 Active 切到 非-Active（Paused / Maintenance / Blocked）时，
        // 即使调用方不传 next_run_at，update_next_run_at 也会把已存在的 nextRunAt 清空。
        // 这是 set_goal_status 的隐性契约：调度只对 Active 生效，状态一旦离开 Active，
        // 调度信号必须立刻失效，避免 sessionTracker 在已暂停的目标上继续触发。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Schedule Clear Goal".to_string(),
            goal: "Verify nextRunAt clears on non-Active transition".to_string(),
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
        let workspace_str = workspace.path().to_string_lossy().to_string();

        // 把目标分别切到 Paused / Maintenance / Blocked，每次先用 set_goal_status
        // 把 status 拉回 Active 并显式带上 nextRunAt，再切到目标状态验证清零。
        for target_status in [
            LongGoalStatus::Paused,
            LongGoalStatus::Maintenance,
            LongGoalStatus::Blocked,
        ] {
            let scheduled_at = Utc::now().timestamp() + 600;
            let active = LongGoalService::set_goal_status(SetLongGoalStatusParams {
                workspace_path: workspace_str.clone(),
                goal_id: state.config.id.clone(),
                status: LongGoalStatus::Active,
                phase: Some(LongGoalPhase::Execution),
                next_run_at: Some(scheduled_at),
            })
            .unwrap();
            assert_eq!(active.config.status, LongGoalStatus::Active);
            assert_eq!(
                active.config.next_run_at,
                Some(scheduled_at),
                "前置条件：Active + 显式 nextRunAt 必须落盘"
            );

            let target_phase = if target_status == LongGoalStatus::Maintenance {
                Some(LongGoalPhase::Maintenance)
            } else {
                Some(LongGoalPhase::Review)
            };
            let transitioned = LongGoalService::set_goal_status(SetLongGoalStatusParams {
                workspace_path: workspace_str.clone(),
                goal_id: state.config.id.clone(),
                status: target_status,
                phase: target_phase,
                next_run_at: None,
            })
            .unwrap();

            assert_eq!(transitioned.config.status, target_status);
            assert_eq!(
                transitioned.config.next_run_at,
                None,
                "切到 {:?} 时 nextRunAt 必须被清空（LG-004 设计契约：调度只对 Active 生效）",
                target_status
            );
        }
    }

    #[test]
    fn set_goal_status_recomputes_next_run_at_when_returning_to_active() {
        // LG-004 维度 2（核心隐性副作用）：
        // set_goal_status 把目标切到 Active 且不传 next_run_at 时，
        // update_next_run_at 会基于 interval 重新计算 nextRunAt。
        // 这条契约支撑用户在 UI 暂停后"恢复"目标的体验——
        // 不需要用户提供时间戳，调度器自动接力。
        let workspace = tempfile::tempdir().unwrap();
        let state = LongGoalService::create_goal(CreateLongGoalParams {
            title: "Schedule Recompute Goal".to_string(),
            goal: "Verify nextRunAt recomputes on Active transition".to_string(),
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
        let workspace_str = workspace.path().to_string_lossy().to_string();

        // Step 1：把目标先暂停，确保 nextRunAt 已经为 None。
        let paused = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace_str.clone(),
            goal_id: state.config.id.clone(),
            status: LongGoalStatus::Paused,
            phase: Some(LongGoalPhase::Review),
            next_run_at: None,
        })
        .unwrap();
        assert_eq!(paused.config.status, LongGoalStatus::Paused);
        assert_eq!(paused.config.next_run_at, None);

        // Step 2：切回 Active 但不传 next_run_at，update_next_run_at 应基于 interval 重算。
        let before = Utc::now().timestamp();
        let active = LongGoalService::set_goal_status(SetLongGoalStatusParams {
            workspace_path: workspace_str,
            goal_id: state.config.id,
            status: LongGoalStatus::Active,
            phase: Some(LongGoalPhase::Execution),
            next_run_at: None,
        })
        .unwrap();
        let after = Utc::now().timestamp();

        assert_eq!(active.config.status, LongGoalStatus::Active);
        let next_run_at = active.config.next_run_at.expect(
            "Active 状态不传 next_run_at 时必须基于 interval 重算 nextRunAt（LG-004 设计契约：恢复语义自动接力）",
        );
        // interval=10m=600s。next_run_at 必须落在 [before+600, after+600] 区间内，
        // 因为 update_next_run_at 用 Utc::now().timestamp() 作为基准时刻。
        assert!(
            next_run_at >= before + 600 && next_run_at <= after + 600,
            "nextRunAt 必须落在 [now+interval, now+interval+δ] 区间，实际 = {}, before+600={}, after+600={}",
            next_run_at,
            before + 600,
            after + 600
        );
    }
}
