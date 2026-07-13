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
mod compaction_plan;
mod coordinator;
mod compact;
mod context;
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
    AIEngine, EngineId, SessionOptions,
    EngineMetadata, EngineDistribution, EngineCapabilities, EnvKeyMapping,
};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    CompactionFailedEvent, ErrorEvent, SessionEndEvent, SessionStartEvent, UserMessageEvent,
};
use crate::models::config::Config;
use crate::models::AIEvent;

use chat_loop::run_chat_loop;
use context::build_context_messages;
use prompt::build_system_prompt;
use session::SimpleAISession;

pub(crate) fn delete_context_checkpoints(stable_conversation_id: &str) -> Result<()> {
    checkpoint_store::ContextCheckpointStore::from_data_root()
        .delete_all(stable_conversation_id)
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

async fn claim_runtime_turn(
    sessions: &Arc<Mutex<HashMap<String, SimpleAISession>>>,
    session_id: &str,
) -> Result<(Vec<Value>, watch::Receiver<bool>, u64, String)> {
    let mut guard = sessions.lock().await;
    let session = guard
        .get_mut(session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if session.is_archived {
        return Err(AppError::SessionArchived(session_id.to_string()));
    }
    if session.is_running {
        return Err(AppError::SessionAlreadyRunning(session_id.to_string()));
    }
    let (new_tx, new_rx) = watch::channel(false);
    session.abort_tx = new_tx;
    session.abort_rx = new_rx.clone();
    session.is_running = true;
    let generation = session.next_turn_generation();
    Ok((
        session.messages.clone(),
        new_rx,
        generation,
        session.stable_conversation_id.clone(),
    ))
}

async fn recover_context_limit_once(
    sessions: Arc<Mutex<HashMap<String, SimpleAISession>>>,
    old_session_id: String,
    profile: crate::models::config::ModelProfile,
    work_dir: String,
    event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer>,
    skills: std::collections::HashMap<String, skill::SkillEntry>,
) -> Result<()> {
    let new_session_id = format!("simple-ai-{}", uuid::Uuid::new_v4());
    let input = coordinator::begin_compaction(
        &sessions,
        &old_session_id,
        new_session_id,
        None,
    )
    .await?;
    let handoff = coordinator::compact_and_handoff(
        Arc::clone(&sessions),
        input,
        profile.clone(),
        Arc::clone(&event_callback),
        coordinator::CompactionTrigger::Recovery,
    )
    .await?;

    let (mut messages, mut abort_rx, turn_generation, stable_conversation_id) = {
        let mut guard = sessions.lock().await;
        let session = guard
            .get_mut(&handoff.new_session_id)
            .ok_or_else(|| AppError::SessionNotFound(handoff.new_session_id.clone()))?;
        session.is_running = true;
        let generation = session.next_turn_generation();
        (
            session.messages.clone(),
            session.abort_rx.clone(),
            generation,
            session.stable_conversation_id.clone(),
        )
    };

    let retry_result = run_chat_loop(
        &handoff.new_session_id,
        &stable_conversation_id,
        &mut messages,
        &profile,
        &work_dir,
        &event_callback,
        &mut abort_rx,
        &mcp_servers,
        &skills,
        0,
    )
    .await;

    {
        let mut guard = sessions.lock().await;
        if let Some(session) = guard.get_mut(&handoff.new_session_id) {
            if session.turn_generation == turn_generation && !session.is_archived {
                session.messages = messages;
                session.is_running = false;
            }
        }
    }

    match retry_result {
        Ok(()) => {
            let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(
                &handoff.new_session_id,
            )));
            Ok(())
        }
        Err(error) => Err(error),
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
            description: Some("内置轻量 AI 引擎 — 直连模型供应商 API，无需外部 CLI，支持工具调用与流式输出".into()),
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
        self.config.model_profiles.iter().any(|p| {
            !p.base_url.is_empty() && !p.api_key.is_empty() && !p.model.is_empty()
        })
    }

    fn unavailable_reason(&self) -> Option<String> {
        if self.config.model_profiles.is_empty() {
            Some(
                "No model profiles configured. Please add one in Settings > Model Provider."
                    .to_string(),
            )
        } else {
            let has_valid = self.config.model_profiles.iter().any(|p| {
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
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").map(|s| s.as_str());
        let mut profile = self
            .find_active_profile(profile_id)
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
                skills_list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
            );
        }

        // 系统提示词（Phase 4d：options.agent 指定时读 .polaris/agents/<name>.md 覆盖 persona；
        // 用户显式传 system_prompt 时完全覆盖，agent 不生效——决策 §12-3）。
        let system_prompt = if let Some(custom) = &options.system_prompt {
            custom.clone()
        } else if let Some(agent_name) = &options.agent {
            match agent::load_agent(&work_dir, agent_name) {
                Some(agent) => {
                    tracing::info!(
                        "[SimpleAI] 使用 agent '{}' 的 system prompt",
                        agent_name
                    );
                    agent.system_prompt
                }
                None => {
                    tracing::warn!(
                        "[SimpleAI] 未找到 agent '{}'，回退默认 persona",
                        agent_name
                    );
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
        // bootstrap 固定上下文到这里结束；导入历史和用户消息可以被未来的压缩计划分组。
        let bootstrap_end = messages.len();
        for entry in &options.message_history {
            messages.push(json!({ "role": entry.role, "content": entry.content }));
        }
        messages.push(json!({ "role": "user", "content": message }));

        // 发送事件
        let _ = (options.event_callback)(AIEvent::SessionStart(SessionStartEvent::new(
            &session_id,
        )));
        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            &session_id,
            message.to_string(),
        )));

        // 创建会话：初始即带上 system + 历史 + 首轮 user 消息，并标记运行中。
        let mut session = SimpleAISession::new(work_dir.clone());
        session.messages = messages.clone();
        session.is_running = true;
        session.bootstrap_end = bootstrap_end;
        session.stable_conversation_id = options
            .env_overrides
            .get("__stable_conversation_id")
            .map(|s| s.clone())
            .unwrap_or_else(|| session_id.clone());
        let turn_generation = session.next_turn_generation();
        let stable_conversation_id = session.stable_conversation_id.clone();
        let mut abort_rx = session.abort_rx.clone();

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
            sessions.lock().await.insert(sid.clone(), session);

            // messages 为 spawn 局部独占，避免 run_chat_loop 长时间持锁阻塞 interrupt。
            let result = run_chat_loop(
                &sid,
                &stable_conversation_id,
                &mut messages,
                &profile,
                &work_dir,
                &cb,
                &mut abort_rx,
                &mcp_servers,
                &skills_map,
                0,
            )
            .await;

            // 回写完整历史并清除运行标记，供后续 continue_session 续接上下文。
            {
                let mut guard = sessions.lock().await;
                if let Some(s) = guard.get_mut(&sid) {
                    // 仅当前 turn generation 可回写，防止过期任务覆盖新状态。
                    if s.turn_generation == turn_generation && !s.is_archived {
                        s.messages = messages;
                        s.is_running = false;
                    } else {
                        tracing::warn!(
                            "[SimpleAI] 忽略过期 turn 回写, session={}, task_generation={}, current_generation={}",
                            sid,
                            turn_generation,
                            s.turn_generation
                        );
                    }
                }
            }

            match result {
                Ok(()) => {
                    tracing::info!("[SimpleAI] 对话循环完成, session={}", sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                    coordinator::auto_compact_after_turn(
                        Arc::clone(&sessions),
                        sid.clone(),
                        profile.clone(),
                        Arc::clone(&cb),
                    )
                    .await;
                }
                Err(AppError::ContextLimit(detail)) => {
                    tracing::warn!(
                        "[SimpleAI] 首轮触发上下文上限，执行单次 handoff recovery: {}",
                        detail
                    );
                    if let Err(recovery_error) = recover_context_limit_once(
                        Arc::clone(&sessions),
                        sid.clone(),
                        profile.clone(),
                        work_dir.clone(),
                        Arc::clone(&cb),
                        mcp_servers.clone(),
                        skills_map.clone(),
                    )
                    .await
                    {
                        let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, recovery_error.to_message())));
                        let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                    }
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
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").map(|s| s.as_str());
        let mut profile = self
            .find_active_profile(profile_id)
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

        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        // Skill
        let skills_map: std::collections::HashMap<String, skill::SkillEntry> = {
            let list = skill::discover_skills(&work_dir);
            list.into_iter().map(|s| (s.name.clone(), s)).collect()
        };

        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            session_id,
            message.to_string(),
        )));

        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();
        let msg = message.to_string();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();
        let mcp_servers = options.mcp_servers.clone();
        let skills_map = skills_map.clone();
        let stable_id = options
            .env_overrides
            .get("__stable_conversation_id")
            .cloned();
        let restored_session_id = self.next_session_id();

        tokio::spawn(async move {
            tracing::info!("[SimpleAI] continue_session 后台任务启动, session={}", sid);

            // 优先续接现有 runtime；应用重启后 runtime 缺失时，从最新完整 checkpoint 恢复。
            let (runtime_sid, payload) = match claim_runtime_turn(&sessions, &sid).await {
                Ok(payload) => (sid.clone(), payload),
                Err(AppError::SessionNotFound(_)) => {
                    let Some(stable_id) = stable_id.as_deref() else {
                        let error = AppError::SessionNotFound(sid.clone());
                        let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, error.to_message())));
                        return;
                    };
                    let recovered = coordinator::restore_runtime_from_checkpoint(
                        &sessions,
                        &sid,
                        restored_session_id,
                        stable_id,
                        &cb,
                    )
                    .await;
                    let runtime_sid = match recovered {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, error.to_message())));
                            return;
                        }
                    };
                    match claim_runtime_turn(&sessions, &runtime_sid).await {
                        Ok(payload) => (runtime_sid, payload),
                        Err(error) => {
                            let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, error.to_message())));
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, error.to_message())));
                    return;
                }
            };
            let (mut existing_messages, mut abort_rx, turn_generation, stable_conversation_id) = payload;

            existing_messages.push(json!({ "role": "user", "content": msg }));

            let result = run_chat_loop(
                &runtime_sid,
                &stable_conversation_id,
                &mut existing_messages,
                &profile,
                &work_dir,
                &cb,
                &mut abort_rx,
                &mcp_servers,
                &skills_map,
                0,
            )
            .await;

            // 更新实际 runtime session 的历史。
            {
                let mut guard = sessions.lock().await;
                if let Some(session) = guard.get_mut(&runtime_sid) {
                    if session.turn_generation == turn_generation && !session.is_archived {
                        session.messages = existing_messages;
                        session.is_running = false;
                    } else {
                        tracing::warn!(
                            "[SimpleAI] 忽略过期 continue 回写, session={}, task_generation={}, current_generation={}",
                            runtime_sid,
                            turn_generation,
                            session.turn_generation
                        );
                    }
                }
            }

            match result {
                Ok(()) => {
                    tracing::info!("[SimpleAI] continue 完成, session={}", runtime_sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&runtime_sid)));
                    coordinator::auto_compact_after_turn(
                        Arc::clone(&sessions),
                        runtime_sid.clone(),
                        profile.clone(),
                        Arc::clone(&cb),
                    )
                    .await;
                }
                Err(AppError::ContextLimit(detail)) => {
                    tracing::warn!(
                        "[SimpleAI] continue 触发上下文上限，执行单次 handoff recovery: {}",
                        detail
                    );
                    if let Err(recovery_error) = recover_context_limit_once(
                        Arc::clone(&sessions),
                        runtime_sid.clone(),
                        profile.clone(),
                        work_dir.clone(),
                        Arc::clone(&cb),
                        mcp_servers.clone(),
                        skills_map.clone(),
                    )
                    .await
                    {
                        let _ = cb(AIEvent::Error(ErrorEvent::new(&runtime_sid, recovery_error.to_message())));
                        let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&runtime_sid)));
                    }
                }
                Err(e) => {
                    tracing::error!("[SimpleAI] continue 失败, session={}, error={}", runtime_sid, e);
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&runtime_sid, e.to_string())));
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&runtime_sid)));
                }
            }
        });

        Ok(())
    }

    fn compact_session(&mut self, session_id: &str, options: SessionOptions) -> Result<()> {
        let profile_id = options
            .env_overrides
            .get("__simple_ai_profile_id")
            .map(|value| value.as_str());
        let profile = self
            .find_active_profile(profile_id)
            .cloned()
            .ok_or_else(|| AppError::ProcessError("No suitable model profile found.".to_string()))?;
        let new_session_id = self.next_session_id();
        let stable_id = options
            .env_overrides
            .get("__stable_conversation_id")
            .cloned();
        let old_session_id = session_id.to_string();
        let sessions = Arc::clone(&self.sessions);
        let callback = options.event_callback.clone();

        tokio::spawn(async move {
            let begin = coordinator::begin_compaction(
                &sessions,
                &old_session_id,
                new_session_id,
                stable_id.as_deref(),
            )
            .await;
            let input = match begin {
                Ok(input) => input,
                Err(error) => {
                    let _ = callback(AIEvent::CompactionFailed(CompactionFailedEvent::new(
                        &old_session_id,
                        error.to_message(),
                    )));
                    return;
                }
            };

            if let Err(error) = coordinator::compact_and_handoff(
                Arc::clone(&sessions),
                input,
                profile,
                Arc::clone(&callback),
                coordinator::CompactionTrigger::Manual,
            )
            .await
            {
                coordinator::fail_compaction(&sessions, &old_session_id, &error, &callback).await;
            }
        });

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

    fn update_config(&mut self, new_config: Config) {
        self.config = new_config;
    }
}
