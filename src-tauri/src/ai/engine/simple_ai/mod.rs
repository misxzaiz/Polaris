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
mod context;
mod history;
mod prompt;
mod session;
mod tools;

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
    ErrorEvent, SessionEndEvent, SessionStartEvent, UserMessageEvent,
};
use crate::models::config::Config;
use crate::models::AIEvent;

use chat_loop::run_chat_loop;
use context::build_context_messages;
use prompt::build_system_prompt;
use session::SimpleAISession;

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
        let profile = self
            .find_active_profile(profile_id)
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError(
                    "No suitable model profile found. Please configure one in Settings > Model Provider."
                        .to_string(),
                )
            })?;

        let session_id = self.next_session_id();
        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        // 系统提示词
        let system_prompt = if let Some(custom) = &options.system_prompt {
            custom.clone()
        } else {
            let mut prompt = build_system_prompt();
            if let Some(append) = &options.append_system_prompt {
                prompt.push('\n');
                prompt.push_str(append);
            }
            prompt
        };

        // 构建初始消息：system → 上下文消息（environment_context + 项目指令）→ 历史 → 首轮 user。
        // 上下文消息仅首轮注入；continue_session 不重复注入（已在历史中）。
        let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system_prompt })];
        for ctx_msg in build_context_messages(&work_dir) {
            messages.push(ctx_msg);
        }
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
        // 这样即便运行期间用户触发 continue_session，也能读到完整初始上下文而非空历史。
        let mut session = SimpleAISession::new(work_dir.clone());
        session.messages = messages.clone();
        session.is_running = true;
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
        tokio::spawn(async move {
            tracing::info!("[SimpleAI] 后台任务启动, session={}", sid);
            sessions.lock().await.insert(sid.clone(), session);

            // messages 为 spawn 局部独占，避免 run_chat_loop 长时间持锁阻塞 interrupt。
            let result = run_chat_loop(
                &sid,
                &mut messages,
                &profile,
                &work_dir,
                &cb,
                &mut abort_rx,
            )
            .await;

            // 回写完整历史并清除运行标记，供后续 continue_session 续接上下文。
            {
                let mut guard = sessions.lock().await;
                if let Some(s) = guard.get_mut(&sid) {
                    s.messages = messages;
                    s.is_running = false;
                }
            }

            match result {
                Ok(()) => {
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
    ) -> Result<()> {
        // 优先从 env_overrides 获取精确的 profile ID
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").map(|s| s.as_str());
        let profile = self
            .find_active_profile(profile_id)
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError("No suitable model profile found.".to_string())
            })?;

        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            session_id,
            message.to_string(),
        )));

        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();
        let msg = message.to_string();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();

        tokio::spawn(async move {
            tracing::info!("[SimpleAI] continue_session 后台任务启动, session={}", sid);

            // 获取会话历史与中断接收端，并标记运行中（单次加锁完成）。
            let (mut existing_messages, mut abort_rx) = {
                let mut guard = sessions.lock().await;
                if let Some(session) = guard.get_mut(&sid) {
                    session.is_running = true;
                    (session.messages.clone(), session.abort_rx.clone())
                } else {
                    // 会话不存在（异常路径）：用仅含系统提示词的初始历史兜底。
                    let system_prompt = build_system_prompt();
                    let (_, rx) = watch::channel(false);
                    (
                        vec![json!({ "role": "system", "content": system_prompt })],
                        rx,
                    )
                }
            };

            existing_messages.push(json!({ "role": "user", "content": msg }));

            let result = run_chat_loop(
                &sid,
                &mut existing_messages,
                &profile,
                &work_dir,
                &cb,
                &mut abort_rx,
            )
            .await;

            // 更新会话历史
            {
                let mut guard = sessions.lock().await;
                if let Some(session) = guard.get_mut(&sid) {
                    session.messages = existing_messages;
                    session.is_running = false;
                }
            }

            match result {
                Ok(()) => {
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
