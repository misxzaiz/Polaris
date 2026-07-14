/*! Simple AI 引擎
 *
 * 轻量级 AI 引擎，使用用户在「模型供应商」设置中配置的 OpenAI 兼容 API。
 * 内置 bash / 文件读写工具，可作为 Claude Code CLI 未安装时的备用方案。
 *
 * 核心流程：
 * 1. 从激活的 ModelProfile 获取 baseUrl / apiKey / model
 * 2. 调用 OpenAI Chat Completions API（流式）
 * 3. 如果 AI 请求工具调用 → 执行工具 → 将结果回传 API → 继续循环
 * 4. 通过 event_callback 将 AIEvent 推送给前端
 *
 * 模块拆分（Phase 0）：
 * - `prompt`    系统提示词构建
 * - `context`   environment_context + 项目指令（AGENTS.md/CLAUDE.md）注入
 * - `session`   会话状态（消息历史 / 中断 / 运行标记）
 * - `tools`     内置工具定义与执行
 * - `chat_loop` 请求 → 流式 → 工具调用循环
 */

mod chat_loop;
mod checkpoint_store;
mod compact;
mod compaction_plan;
mod context;
mod coordinator;
mod history;
mod mcp;
mod prompt;
mod retry;
mod session;
mod skill;
mod tools;

// Agent preset（Phase 4d）：需在 mod 声明后引用，单独放此。
mod agent;

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use crate::ai::traits::{
    AIEngine, EngineCapabilities, EngineDistribution, EngineId, EngineMetadata, EnvKeyMapping,
    SessionOptions,
};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    ContextCompactedEvent, ContextCompactionFailedEvent, ContextRestoredEvent, ErrorEvent,
    ProgressEvent, SessionEndEvent, SessionStartEvent, UserMessageEvent,
};
use crate::models::config::Config;
use crate::models::AIEvent;

use chat_loop::run_chat_loop;
use context::build_context_messages;
use prompt::build_system_prompt;
use session::SimpleAISession;

pub(crate) fn delete_context_checkpoints(stable_conversation_id: &str) -> Result<()> {
    coordinator::delete_checkpoints(stable_conversation_id)
}

async fn maybe_auto_compact_messages(
    runtime_session_id: &str,
    stable_conversation_id: &str,
    work_dir: &str,
    bootstrap_end: usize,
    profile_id: Option<String>,
    profile: crate::models::config::ModelProfile,
    messages: Vec<Value>,
    stats: &chat_loop::ChatLoopStats,
    callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
) -> (
    Vec<Value>,
    Option<coordinator::CompactionOutcome>,
    Option<String>,
) {
    let mut input = coordinator::CompactionInput {
        runtime_session_id: runtime_session_id.to_string(),
        stable_conversation_id: stable_conversation_id.to_string(),
        work_dir: work_dir.to_string(),
        messages,
        bootstrap_end,
        profile_id,
        profile,
        tool_specs: stats.tool_specs.clone(),
        latest_provider_input_tokens: stats.latest_provider_input_tokens,
        trigger: coordinator::CompactionTrigger::AutoSoft,
    };
    if !coordinator::should_auto_compact(&input) {
        return (input.messages, None, None);
    }
    if coordinator::should_force_compact(&input) {
        input.trigger = coordinator::CompactionTrigger::AutoHard;
    }
    let original = input.messages.clone();
    match coordinator::compact_snapshot(input, callback).await {
        Ok(outcome) => (outcome.messages.clone(), Some(outcome), None),
        Err(error) => {
            tracing::warn!(
                "[SimpleAI] 自动上下文压缩失败，保留原历史: session={}, error={}",
                runtime_session_id,
                error
            );
            (original, None, Some(error.to_message()))
        }
    }
}

fn emit_compaction_event(
    callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    runtime_session_id: &str,
    trigger: &str,
    outcome: &coordinator::CompactionOutcome,
) {
    let mut event = ContextCompactedEvent::new(
        runtime_session_id,
        trigger,
        Some(outcome.tokens_before as u64),
        Some(outcome.tokens_after as u64),
    );
    event.generation = Some(outcome.checkpoint_generation);
    event.archived_turns = Some(outcome.archived_turns);
    event.retained_turns = Some(outcome.retained_turns);
    let _ = callback(AIEvent::ContextCompacted(event));
}

#[allow(clippy::too_many_arguments)]
async fn run_chat_loop_with_context_recovery(
    runtime_session_id: &str,
    stable_conversation_id: &str,
    work_dir: &str,
    bootstrap_end: usize,
    profile_id: Option<String>,
    profile: &crate::models::config::ModelProfile,
    messages: &mut Vec<Value>,
    callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    abort_rx: &mut watch::Receiver<bool>,
    mcp_servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer],
    skills: &std::collections::HashMap<String, skill::SkillEntry>,
) -> (
    Result<chat_loop::ChatLoopStats>,
    Option<coordinator::CompactionOutcome>,
    Option<String>,
) {
    // Any failed provider/recovery path restores this exact pre-request snapshot. The current
    // user message is already present, but no partial assistant/tool mutation is retained.
    let turn_snapshot = messages.clone();
    let mut stats = chat_loop::ChatLoopStats::default();
    let first = run_chat_loop(
        runtime_session_id,
        messages,
        profile,
        work_dir,
        callback,
        abort_rx,
        mcp_servers,
        skills,
        &mut stats,
        0,
    )
    .await;

    match first {
        Ok(()) => {
            if stats.aborted {
                *messages = turn_snapshot;
            }
            (Ok(stats), None, None)
        }
        Err(error) if error.is_context_limit() => {
            let pre_compaction_messages = messages.clone();
            let _ = callback(AIEvent::Progress(ProgressEvent::new(
                runtime_session_id,
                "上下文窗口已超限，正在创建 checkpoint 并压缩后重试…",
            )));
            let input = coordinator::CompactionInput {
                runtime_session_id: runtime_session_id.to_string(),
                stable_conversation_id: stable_conversation_id.to_string(),
                work_dir: work_dir.to_string(),
                messages: pre_compaction_messages.clone(),
                bootstrap_end,
                profile_id,
                profile: profile.clone(),
                tool_specs: stats.tool_specs.clone(),
                latest_provider_input_tokens: stats.latest_provider_input_tokens,
                trigger: coordinator::CompactionTrigger::ContextLimitRecovery,
            };
            let outcome = match coordinator::compact_snapshot(input, callback).await {
                Ok(outcome) => outcome,
                Err(compaction_error) => {
                    *messages = turn_snapshot;
                    let reason = format!(
                        "上下文超限恢复压缩失败：{}；原请求未重试，历史保持不变",
                        compaction_error.to_message()
                    );
                    return (
                        Err(AppError::ProcessError(format!(
                            "{}；原始供应商错误：{}",
                            reason,
                            error.to_message()
                        ))),
                        None,
                        Some(reason),
                    );
                }
            };

            *messages = outcome.messages.clone();
            let compacted_base_len = messages.len();
            let _ = callback(AIEvent::Progress(ProgressEvent::new(
                runtime_session_id,
                "checkpoint 已完成，正在单次重试原请求…",
            )));
            let mut retry_stats = chat_loop::ChatLoopStats::default();
            let retry = run_chat_loop(
                runtime_session_id,
                messages,
                profile,
                work_dir,
                callback,
                abort_rx,
                mcp_servers,
                skills,
                &mut retry_stats,
                0,
            )
            .await;

            match retry {
                Ok(()) => {
                    if retry_stats.aborted {
                        *messages = turn_snapshot;
                        return (Ok(retry_stats), None, None);
                    }
                    let mut archived_messages = pre_compaction_messages;
                    archived_messages.extend_from_slice(&messages[compacted_base_len..]);
                    if let Err(checkpoint_error) = coordinator::finalize_recovery_checkpoint(
                        stable_conversation_id,
                        outcome.checkpoint_generation,
                        archived_messages,
                    ) {
                        *messages = turn_snapshot;
                        let reason = format!(
                            "上下文恢复 checkpoint 最终写入失败：{}；历史保持不变",
                            checkpoint_error.to_message()
                        );
                        return (
                            Err(AppError::ProcessError(reason.clone())),
                            None,
                            Some(reason),
                        );
                    }
                    (Ok(retry_stats), Some(outcome), None)
                }
                Err(retry_error) => {
                    *messages = turn_snapshot;
                    let reason = format!(
                        "上下文压缩后单次重试失败：{}；历史保持不变",
                        retry_error.to_message()
                    );
                    (Err(retry_error), None, Some(reason))
                }
            }
        }
        Err(error) => {
            *messages = turn_snapshot;
            (Err(error), None, None)
        }
    }
}

// ============================================================================
// 引擎
// ============================================================================

/// SimpleAI 引擎
pub struct SimpleAIEngine {
    config: Config,
    sessions: Arc<Mutex<HashMap<String, SimpleAISession>>>,
    session_counter: std::sync::atomic::AtomicU64,
}

impl SimpleAIEngine {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_counter: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn next_session_id(&self) -> String {
        let count = self
            .session_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!(
            "simple-ai-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            count
        )
    }

    fn find_active_profile(
        &self,
        profile_id: Option<&str>,
    ) -> Option<&crate::models::config::ModelProfile> {
        let profiles = &self.config.model_profiles;

        if let Some(pid) = profile_id {
            if let Some(p) = profiles.iter().find(|p| p.id == pid) {
                return Some(p);
            }
        }

        if let Some(pid) = &self.config.active_model_profile_id {
            if let Some(p) = profiles.iter().find(|p| &p.id == pid) {
                return Some(p);
            }
        }

        profiles.iter().find(|p| p.active)
    }
}

// ============================================================================
// AIEngine trait
// ============================================================================

impl AIEngine for SimpleAIEngine {
    fn id(&self) -> EngineId {
        EngineId::SimpleAI
    }

    fn name(&self) -> &'static str {
        "Simple AI"
    }

    fn description(&self) -> &'static str {
        "Lightweight AI assistant using model provider configuration with built-in tools"
    }

    fn metadata(&self) -> EngineMetadata {
        EngineMetadata {
            id: EngineId::SimpleAI,
            name: "Simple AI".into(),
            description: Some(
                "内置轻量 AI 引擎 — 直连模型供应商 API，无需外部 CLI，支持工具调用与流式输出"
                    .into(),
            ),
            distribution: EngineDistribution::Builtin,
            capabilities: EngineCapabilities {
                tools: true,
                image_input: false,
                streaming: true,
                interrupt: true,
                resume: true,
                stdin_input: false,
                fork_session: false,
            },
            env_keys: EnvKeyMapping::default(), // OpenAI 兼容（默认值）
            supports_model_provider: true,
        }
    }

    fn is_available(&self) -> bool {
        self.config
            .model_profiles
            .iter()
            .any(|p| !p.base_url.is_empty() && !p.api_key.is_empty() && !p.model.is_empty())
    }

    fn unavailable_reason(&self) -> Option<String> {
        if self.config.model_profiles.is_empty() {
            Some(
                "No model profiles configured. Please add one in Settings > Model Provider."
                    .to_string(),
            )
        } else {
            let has_valid =
                self.config.model_profiles.iter().any(|p| {
                    !p.base_url.is_empty() && !p.api_key.is_empty() && !p.model.is_empty()
                });
            if !has_valid {
                Some(
                    "Model profiles exist but none have complete baseUrl/apiKey/model. \
                     Please check Settings > Model Provider."
                        .to_string(),
                )
            } else {
                None
            }
        }
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        // 优先从 env_overrides 获取精确的 profile ID（由 apply_model_profile_options 设置）
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").cloned();
        let requested_stable_id = options.stable_conversation_id.clone();
        let mut profile = self
            .find_active_profile(profile_id.as_deref())
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError(
                    "No suitable model profile found. Please configure one in Settings > Model Provider."
                        .to_string(),
                )
            })?;

        // 如果前端显式传入了模型（通过 SessionOptions.model），覆盖 Profile 默认模型。
        // apply_model_profile_options 已在前置步骤完成「前端优先、Profile 兜底」的选择，
        // 此处需尊重该结果，否则前端选中的模型会被 profile.model 静默覆盖。
        if let Some(frontend_model) = options.model {
            if frontend_model != profile.model {
                tracing::info!(
                    "[SimpleAI] 使用前端选择的模型: {}（Profile 默认: {}）",
                    frontend_model,
                    profile.model
                );
                profile.model = frontend_model;
            }
        }

        let session_id = self.next_session_id();
        let stable_conversation_id = requested_stable_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| session_id.clone());
        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        // Skill 索引（Phase 4c）：扫描 .polaris/skills/*/SKILL.md，注入索引消息 + 供 read_skill 工具按需读全文。
        let skills_list = skill::discover_skills(&work_dir);
        let skills_map: std::collections::HashMap<String, skill::SkillEntry> = skills_list
            .iter()
            .map(|s| (s.name.clone(), s.clone()))
            .collect();
        if !skills_list.is_empty() {
            tracing::info!(
                "[SimpleAI] 发现 {} 个 skill：{}",
                skills_list.len(),
                skills_list
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }

        // 系统提示词（Phase 4d：options.agent 指定时读 .polaris/agents/<name>.md 覆盖 persona；
        // 用户显式传 system_prompt 时完全覆盖，agent 不生效——决策 §12-3）。
        let system_prompt = if let Some(custom) = &options.system_prompt {
            custom.clone()
        } else if let Some(agent_name) = &options.agent {
            match agent::load_agent(&work_dir, agent_name) {
                Some(agent) => {
                    tracing::info!("[SimpleAI] 使用 agent '{}' 的 system prompt", agent_name);
                    agent.system_prompt
                }
                None => {
                    tracing::warn!("[SimpleAI] 未找到 agent '{}'，回退默认 persona", agent_name);
                    let mut prompt = build_system_prompt();
                    if let Some(append) = &options.append_system_prompt {
                        prompt.push('\n');
                        prompt.push_str(append);
                    }
                    prompt
                }
            }
        } else {
            let mut prompt = build_system_prompt();
            if let Some(append) = &options.append_system_prompt {
                prompt.push('\n');
                prompt.push_str(append);
            }
            prompt
        };

        // 构建初始消息：system → 上下文消息（environment_context + 项目指令）→ skill 索引 → 历史 → 首轮 user。
        // 上下文消息仅首轮注入；continue_session 不重复注入（已在历史中）。
        let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system_prompt })];
        for ctx_msg in build_context_messages(&work_dir) {
            messages.push(ctx_msg);
        }
        if let Some(skill_index) = skill::build_skill_index_message(&skills_list) {
            messages.push(skill_index);
        }
        let bootstrap_end = messages.len();
        for entry in &options.message_history {
            messages.push(json!({ "role": entry.role, "content": entry.content }));
        }
        messages.push(json!({ "role": "user", "content": message }));

        // 发送事件
        let _ =
            (options.event_callback)(AIEvent::SessionStart(SessionStartEvent::new(&session_id)));
        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            &session_id,
            message.to_string(),
        )));

        // 创建会话：初始即带上 system + 历史 + 首轮 user 消息，并标记运行中。
        // 这样即便运行期间用户触发 continue_session，也能读到完整初始上下文而非空历史。
        let mut session = SimpleAISession::new(work_dir.clone());
        session.messages = messages.clone();
        session.stable_conversation_id = stable_conversation_id.clone();
        session.bootstrap_end = bootstrap_end;
        session.latest_profile = Some(profile.clone());
        session.latest_profile_id = profile_id.clone();
        let (task_generation, mut abort_rx) = session.claim_turn()?;

        // 在返回 runtime session ID 前同步插入，消除 start/continue 两个 spawn 的调度竞态。
        self.sessions
            .try_lock()
            .map_err(|_| AppError::StateError("SimpleAI 会话表正忙，请重试".to_string()))?
            .insert(session_id.clone(), session);

        // 启动后台任务：先插入会话，再跑对话循环，结束后回写完整历史。
        //
        // 合并为单个 spawn 的关键原因：
        // 1. 保证「插入会话」先于「run_chat_loop」执行，消除 continue_session 读不到会话的竞态；
        // 2. 循环结束后必须把累积的 messages 回写 session.messages，否则后续 continue_session
        //    读到空历史 → 模型丢失系统提示词与首轮上下文（即「会话失忆」根因）。
        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();
        let mcp_servers = options.mcp_servers.clone();
        let skills_map = skills_map.clone();
        tokio::spawn(async move {
            tracing::info!("[SimpleAI] 后台任务启动, session={}", sid);

            // messages 为 spawn 局部独占，避免模型请求和压缩期间长时间持锁阻塞 interrupt。
            let (result, recovery_outcome, recovery_failure) = run_chat_loop_with_context_recovery(
                &sid,
                &stable_conversation_id,
                &work_dir,
                bootstrap_end,
                profile_id.clone(),
                &profile,
                &mut messages,
                &cb,
                &mut abort_rx,
                &mcp_servers,
                &skills_map,
            )
            .await;

            let mut auto_outcome = None;
            let mut auto_failure = None;
            if recovery_outcome.is_none() {
                if let Ok(stats) = &result {
                    let (next_messages, outcome, failure) = maybe_auto_compact_messages(
                        &sid,
                        &stable_conversation_id,
                        &work_dir,
                        bootstrap_end,
                        profile_id.clone(),
                        profile.clone(),
                        messages.clone(),
                        stats,
                        &cb,
                    )
                    .await;
                    messages = next_messages;
                    auto_outcome = outcome;
                    auto_failure = failure;
                }
            }

            // 回写完整历史并清除运行标记，供后续 continue_session 续接上下文。
            let committed = {
                let mut guard = sessions.lock().await;
                if let Some(s) = guard.get_mut(&sid) {
                    if s.turn_generation == task_generation {
                        s.messages = messages;
                        s.is_running = false;
                        if let Ok(stats) = &result {
                            s.latest_provider_input_tokens = stats.latest_provider_input_tokens;
                            s.latest_tool_specs = stats.tool_specs.clone();
                        }
                        let committed_outcome = recovery_outcome.as_ref().or(auto_outcome.as_ref());
                        if let Some(outcome) = committed_outcome {
                            s.latest_request_tokens = Some(outcome.tokens_after);
                            s.compaction_state.generation = outcome.checkpoint_generation;
                            s.compaction_state.active_checkpoint =
                                Some(outcome.checkpoint_generation);
                            s.compaction_state.undo_checkpoint =
                                Some(outcome.checkpoint_generation);
                            s.compaction_state.last_compacted_at_ms =
                                Some(chrono::Utc::now().timestamp_millis());
                            s.compaction_state.consecutive_failures = 0;
                            s.compaction_state.status = session::CompactionStatus::Cooldown;
                        } else if auto_failure.is_some() || recovery_failure.is_some() {
                            s.compaction_state.consecutive_failures =
                                s.compaction_state.consecutive_failures.saturating_add(1);
                            s.compaction_state.status = session::CompactionStatus::Idle;
                        }
                        true
                    } else {
                        tracing::warn!(
                            "[SimpleAI] 忽略过期首轮回写, session={}, task_generation={}, current_generation={}",
                            sid,
                            task_generation,
                            s.turn_generation
                        );
                        false
                    }
                } else {
                    false
                }
            };

            if committed {
                if let Some(outcome) = &recovery_outcome {
                    emit_compaction_event(&cb, &sid, "recovery", outcome);
                } else if let Some(outcome) = &auto_outcome {
                    emit_compaction_event(&cb, &sid, "auto", outcome);
                }
                if let Some(reason) = recovery_failure.as_ref().or(auto_failure.as_ref()) {
                    let trigger = if recovery_failure.is_some() {
                        "recovery"
                    } else {
                        "auto"
                    };
                    let _ = cb(AIEvent::ContextCompactionFailed(
                        ContextCompactionFailedEvent::new(&sid, trigger, reason),
                    ));
                }
            }

            match result {
                Ok(_) => {
                    tracing::info!("[SimpleAI] 对话循环完成, session={}", sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
                Err(e) => {
                    tracing::error!("[SimpleAI] 对话循环失败, session={}, error={}", sid, e);
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, e.to_string())));
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
            }
        });

        Ok(session_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> std::result::Result<(), AppError> {
        // 优先从 env_overrides 获取精确的 profile ID
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").cloned();
        let requested_stable_id = options.stable_conversation_id.clone();
        let mut profile = self
            .find_active_profile(profile_id.as_deref())
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError("No suitable model profile found.".to_string())
            })?;

        // 如果前端显式传入了模型，覆盖 Profile 默认模型（同 start_session 逻辑）。
        if let Some(frontend_model) = options.model {
            if frontend_model != profile.model {
                tracing::info!(
                    "[SimpleAI] continue_session 使用前端选择的模型: {}（Profile 默认: {}）",
                    frontend_model,
                    profile.model
                );
                profile.model = frontend_model;
            }
        }

        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();
        let msg = message.to_string();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();
        let mcp_servers = options.mcp_servers.clone();

        // 同步领取 turn 所有权。第二个重叠 continue 会立即失败，不再从旧快照分叉。
        let (
            mut existing_messages,
            mut abort_rx,
            task_generation,
            stable_conversation_id,
            bootstrap_end,
            restored_generation,
            work_dir,
        ) = {
            let mut guard = self
                .sessions
                .try_lock()
                .map_err(|_| AppError::StateError("SimpleAI 会话表正忙，请重试".to_string()))?;
            let mut restored_generation = None;
            if !guard.contains_key(session_id) {
                let stable_id = requested_stable_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
                let checkpoint = coordinator::load_latest_checkpoint(stable_id)?;
                let checkpoint_is_compacted = checkpoint
                    .briefing
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                    && checkpoint.recent_tail_start.is_some();
                let restored_messages = coordinator::restore_messages(&checkpoint)?;
                let mut restored = SimpleAISession::new(checkpoint.work_dir.clone());
                restored.messages = restored_messages;
                restored.stable_conversation_id = stable_id.to_string();
                restored.bootstrap_end = checkpoint.bootstrap_end;
                restored.latest_profile = Some(profile.clone());
                restored.latest_profile_id = profile_id.clone();
                restored.compaction_state.generation = checkpoint.generation;
                restored.compaction_state.active_checkpoint = checkpoint_is_compacted
                    .then_some(checkpoint.generation);
                restored.compaction_state.last_compacted_at_ms = Some(checkpoint.created_at_ms);
                restored_generation = Some(checkpoint.generation);
                guard.insert(session_id.to_string(), restored);
            }
            let session = guard
                .get_mut(session_id)
                .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
            if let Some(requested) = requested_stable_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                if requested != session.stable_conversation_id {
                    return Err(AppError::ValidationError(
                        "SimpleAI runtime 与稳定对话 ID 不匹配".to_string(),
                    ));
                }
            }
            let (generation, task_rx) = session.claim_turn()?;
            session.latest_profile = Some(profile.clone());
            session.latest_profile_id = profile_id.clone();
            (
                session.messages.clone(),
                task_rx,
                generation,
                session.stable_conversation_id.clone(),
                session.bootstrap_end,
                restored_generation,
                session.work_dir.clone(),
            )
        };

        // 恢复 runtime 时必须继续使用 checkpoint 记录的原工作目录，而不是前端缺省值
        // “.”；否则工具、AGENTS.md 和 skills 会在错误目录执行。
        let skills_map: std::collections::HashMap<String, skill::SkillEntry> = {
            let list = skill::discover_skills(&work_dir);
            list.into_iter().map(|s| (s.name.clone(), s)).collect()
        };

        if let Some(generation) = restored_generation {
            let _ = (options.event_callback)(AIEvent::ContextRestored(ContextRestoredEvent::new(
                session_id,
                generation,
                "runtime_recovery",
            )));
        }

        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            session_id,
            message.to_string(),
        )));

        tokio::spawn(async move {
            tracing::info!("[SimpleAI] continue_session 后台任务启动, session={}", sid);

            existing_messages.push(json!({ "role": "user", "content": msg }));

            let (result, recovery_outcome, recovery_failure) = run_chat_loop_with_context_recovery(
                &sid,
                &stable_conversation_id,
                &work_dir,
                bootstrap_end,
                profile_id.clone(),
                &profile,
                &mut existing_messages,
                &cb,
                &mut abort_rx,
                &mcp_servers,
                &skills_map,
            )
            .await;

            let mut auto_outcome = None;
            let mut auto_failure = None;
            if recovery_outcome.is_none() {
                if let Ok(stats) = &result {
                    let (next_messages, outcome, failure) = maybe_auto_compact_messages(
                        &sid,
                        &stable_conversation_id,
                        &work_dir,
                        bootstrap_end,
                        profile_id.clone(),
                        profile.clone(),
                        existing_messages.clone(),
                        stats,
                        &cb,
                    )
                    .await;
                    existing_messages = next_messages;
                    auto_outcome = outcome;
                    auto_failure = failure;
                }
            }

            // 更新会话历史
            let committed = {
                let mut guard = sessions.lock().await;
                if let Some(session) = guard.get_mut(&sid) {
                    if session.turn_generation == task_generation {
                        session.messages = existing_messages;
                        session.is_running = false;
                        if let Ok(stats) = &result {
                            session.latest_provider_input_tokens =
                                stats.latest_provider_input_tokens;
                            session.latest_tool_specs = stats.tool_specs.clone();
                        }
                        let committed_outcome = recovery_outcome.as_ref().or(auto_outcome.as_ref());
                        if let Some(outcome) = committed_outcome {
                            session.latest_request_tokens = Some(outcome.tokens_after);
                            session.compaction_state.generation = outcome.checkpoint_generation;
                            session.compaction_state.active_checkpoint =
                                Some(outcome.checkpoint_generation);
                            session.compaction_state.undo_checkpoint =
                                Some(outcome.checkpoint_generation);
                            session.compaction_state.last_compacted_at_ms =
                                Some(chrono::Utc::now().timestamp_millis());
                            session.compaction_state.consecutive_failures = 0;
                            session.compaction_state.status = session::CompactionStatus::Cooldown;
                        } else if auto_failure.is_some() || recovery_failure.is_some() {
                            session.compaction_state.consecutive_failures = session
                                .compaction_state
                                .consecutive_failures
                                .saturating_add(1);
                            session.compaction_state.status = session::CompactionStatus::Idle;
                        }
                        true
                    } else {
                        tracing::warn!(
                            "[SimpleAI] 忽略过期 continue 回写, session={}, task_generation={}, current_generation={}",
                            sid,
                            task_generation,
                            session.turn_generation
                        );
                        false
                    }
                } else {
                    false
                }
            };

            if committed {
                if let Some(outcome) = &recovery_outcome {
                    emit_compaction_event(&cb, &sid, "recovery", outcome);
                } else if let Some(outcome) = &auto_outcome {
                    emit_compaction_event(&cb, &sid, "auto", outcome);
                }
                if let Some(reason) = recovery_failure.as_ref().or(auto_failure.as_ref()) {
                    let trigger = if recovery_failure.is_some() {
                        "recovery"
                    } else {
                        "auto"
                    };
                    let _ = cb(AIEvent::ContextCompactionFailed(
                        ContextCompactionFailedEvent::new(&sid, trigger, reason),
                    ));
                }
            }

            match result {
                Ok(_) => {
                    tracing::info!("[SimpleAI] continue 完成, session={}", sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
                Err(e) => {
                    tracing::error!("[SimpleAI] continue 失败, session={}, error={}", sid, e);
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, e.to_string())));
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
            }
        });

        Ok(())
    }

    fn compact_session(&mut self, session_id: &str, options: SessionOptions) -> Result<()> {
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").cloned();
        let requested_stable_id = options.stable_conversation_id.clone();
        let mut profile = self
            .find_active_profile(profile_id.as_deref())
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError("No suitable model profile found.".to_string())
            })?;
        if let Some(model) = options.model {
            profile.model = model;
        }

        let callback: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();
        let sid = session_id.to_string();
        let sessions = Arc::clone(&self.sessions);
        let (input, operation_generation) = {
            let mut guard = self
                .sessions
                .try_lock()
                .map_err(|_| AppError::StateError("SimpleAI 会话表正忙，请重试".to_string()))?;
            let session = guard
                .get_mut(session_id)
                .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
            if requested_stable_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .is_some_and(|value| value != session.stable_conversation_id)
            {
                return Err(AppError::ValidationError(
                    "SimpleAI runtime 与稳定对话 ID 不匹配".to_string(),
                ));
            }
            if session.is_running {
                return Err(AppError::StateError(
                    "会话运行中，需等待当前 turn 完成后再压缩".to_string(),
                ));
            }
            if matches!(
                session.compaction_state.status,
                session::CompactionStatus::Planning
            ) {
                return Err(AppError::StateError("会话正在压缩上下文".to_string()));
            }
            session.is_running = true;
            session.compaction_state.status = session::CompactionStatus::Planning;
            let generation = session.next_turn_generation();
            (
                coordinator::CompactionInput {
                    runtime_session_id: session_id.to_string(),
                    stable_conversation_id: session.stable_conversation_id.clone(),
                    work_dir: session.work_dir.clone(),
                    messages: session.messages.clone(),
                    bootstrap_end: session.bootstrap_end,
                    profile_id: profile_id
                        .clone()
                        .or_else(|| session.latest_profile_id.clone()),
                    profile: profile.clone(),
                    tool_specs: session.latest_tool_specs.clone(),
                    latest_provider_input_tokens: session.latest_provider_input_tokens,
                    trigger: coordinator::CompactionTrigger::Manual,
                },
                generation,
            )
        };

        let _ = callback(AIEvent::Progress(ProgressEvent::new(
            session_id,
            "正在准备上下文压缩…",
        )));
        tokio::spawn(async move {
            let result = coordinator::compact_snapshot(input, &callback).await;
            match result {
                Ok(outcome) => {
                    let committed = {
                        let mut guard = sessions.lock().await;
                        if let Some(session) = guard.get_mut(&sid) {
                            if session.turn_generation == operation_generation {
                                session.messages = outcome.messages.clone();
                                session.is_running = false;
                                session.latest_request_tokens = Some(outcome.tokens_after);
                                session.compaction_state.generation = outcome.checkpoint_generation;
                                session.compaction_state.active_checkpoint =
                                    Some(outcome.checkpoint_generation);
                                session.compaction_state.undo_checkpoint =
                                    Some(outcome.checkpoint_generation);
                                session.compaction_state.last_compacted_at_ms =
                                    Some(chrono::Utc::now().timestamp_millis());
                                session.compaction_state.consecutive_failures = 0;
                                session.compaction_state.status =
                                    session::CompactionStatus::Cooldown;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if committed {
                        let mut event = ContextCompactedEvent::new(
                            &sid,
                            "manual",
                            Some(outcome.tokens_before as u64),
                            Some(outcome.tokens_after as u64),
                        );
                        event.generation = Some(outcome.checkpoint_generation);
                        event.archived_turns = Some(outcome.archived_turns);
                        event.retained_turns = Some(outcome.retained_turns);
                        let _ = callback(AIEvent::ContextCompacted(event));
                    } else {
                        let _ = callback(AIEvent::ContextCompactionFailed(
                            ContextCompactionFailedEvent::new(
                                &sid,
                                "manual",
                                "会话状态在压缩期间发生变化，原历史保持不变",
                            ),
                        ));
                    }
                }
                Err(error) => {
                    {
                        let mut guard = sessions.lock().await;
                        if let Some(session) = guard.get_mut(&sid) {
                            if session.turn_generation == operation_generation {
                                session.is_running = false;
                                session.compaction_state.consecutive_failures = session
                                    .compaction_state
                                    .consecutive_failures
                                    .saturating_add(1);
                                session.compaction_state.status =
                                    if session.compaction_state.consecutive_failures >= 3 {
                                        session::CompactionStatus::Disabled
                                    } else {
                                        session::CompactionStatus::Idle
                                    };
                            }
                        }
                    }
                    let _ = callback(AIEvent::ContextCompactionFailed(
                        ContextCompactionFailedEvent::new(&sid, "manual", error.to_message()),
                    ));
                }
            }
        });
        Ok(())
    }

    fn restore_compaction(&mut self, session_id: &str, options: SessionOptions) -> Result<()> {
        let requested_stable_id = options.stable_conversation_id.clone();
        let callback = options.event_callback;
        let (stable_id, checkpoint_generation) = {
            let guard = self
                .sessions
                .try_lock()
                .map_err(|_| AppError::StateError("SimpleAI 会话表正忙，请重试".to_string()))?;
            let session = guard
                .get(session_id)
                .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
            if requested_stable_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .is_some_and(|value| value != session.stable_conversation_id)
            {
                return Err(AppError::ValidationError(
                    "SimpleAI runtime 与稳定对话 ID 不匹配".to_string(),
                ));
            }
            if session.is_running {
                return Err(AppError::StateError(
                    "会话运行中，无法恢复压缩前上下文".to_string(),
                ));
            }
            let generation = session.compaction_state.undo_checkpoint.ok_or_else(|| {
                AppError::StateError("当前没有可恢复的压缩 checkpoint".to_string())
            })?;
            (session.stable_conversation_id.clone(), generation)
        };
        let checkpoint = coordinator::load_checkpoint(&stable_id, checkpoint_generation)?;
        let mut guard = self
            .sessions
            .try_lock()
            .map_err(|_| AppError::StateError("SimpleAI 会话表正忙，请重试".to_string()))?;
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        if session.is_running
            || session.compaction_state.undo_checkpoint != Some(checkpoint_generation)
        {
            return Err(AppError::StateError(
                "会话状态已变化，无法恢复该 checkpoint".to_string(),
            ));
        }
        // durable undo marker 必须先于内存提交；否则 runtime 丢失后会从最新 checkpoint
        // 再次应用已经撤销的 briefing。
        coordinator::mark_checkpoint_restored(&stable_id, checkpoint_generation)?;
        session.messages = checkpoint.archived_messages;
        session.compaction_state.undo_checkpoint = None;
        session.compaction_state.status = session::CompactionStatus::Idle;
        session.compaction_state.active_checkpoint = None;
        session.next_turn_generation();
        drop(guard);
        let _ = callback(AIEvent::ContextRestored(ContextRestoredEvent::new(
            session_id,
            checkpoint_generation,
            "undo_compaction",
        )));
        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();

        tokio::spawn(async move {
            let guard = sessions.lock().await;
            if let Some(session) = guard.get(&sid) {
                let _ = session.abort_tx.send(true);
                tracing::info!("[SimpleAI] Interrupt signal sent for session {}", sid);
            } else {
                tracing::warn!("[SimpleAI] Session {} not found for interrupt", sid);
            }
        });

        Ok(())
    }

    fn active_session_count(&self) -> usize {
        self.sessions
            .try_lock()
            .map(|s| s.values().filter(|sess| sess.is_running).count())
            .unwrap_or(0)
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions
            .try_lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|session| session.is_running))
            .unwrap_or(false)
    }

    fn update_config(&mut self, new_config: Config) {
        self.config = new_config;
    }
}
