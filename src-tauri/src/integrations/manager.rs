/*! 集成管理器
 *
 * 统一管理所有平台集成，提供消息路由和状态管理。
 * 集成 EngineRegistry 实现 AI 自动回复。
 * 支持命令解析和处理。
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, oneshot};
use tauri::{AppHandle, Emitter};

use super::common::{SessionManager, ConversationStore};
use super::qqbot::QQBotAdapter;
use super::traits::PlatformIntegration;
use super::types::*;
use super::commands::{BotCommand, CommandParser, get_help_text, PromptMode};
use super::instance_registry::{InstanceRegistry, PlatformInstance, InstanceConfig, InstanceId};
use crate::ai::{EngineRegistry, SessionOptions};
use crate::error::Result;
use crate::models::config::QQBotConfig;

/// 集成管理器
pub struct IntegrationManager {
    /// 消息接收通道
    message_rx: Option<mpsc::Receiver<IntegrationMessage>>,
    /// 消息发送通道
    message_tx: Option<mpsc::Sender<IntegrationMessage>>,
    /// 平台适配器 (共享，用于消息处理任务发送回复)
    adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
    /// 会话管理
    sessions: SessionManager,
    /// 会话状态存储
    conversation_states: Arc<Mutex<ConversationStore>>,
    /// App Handle (用于发送事件到前端)
    app_handle: Option<AppHandle>,
    /// 运行状态
    running: bool,
    /// 消息处理任务句柄
    message_task: Option<tokio::task::JoinHandle<()>>,
    /// AI 引擎注册表引用
    engine_registry: Option<Arc<Mutex<EngineRegistry>>>,
    /// 会话 ID 映射 (conversation_id -> ai_session_id)（预留）
    #[allow(dead_code)]
    session_map: HashMap<String, String>,
    /// 活跃的 AI 会话句柄（用于中断）
    active_sessions: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    /// 实例注册表（多配置管理）
    instance_registry: Arc<Mutex<InstanceRegistry>>,
    /// 实例数据存储路径
    instances_path: Option<PathBuf>,
}

impl IntegrationManager {
    /// 创建新的集成管理器
    pub fn new() -> Self {
        Self {
            message_rx: None,
            message_tx: None,
            adapters: Arc::new(Mutex::new(HashMap::new())),
            sessions: SessionManager::new(),
            conversation_states: Arc::new(Mutex::new(ConversationStore::new())),
            app_handle: None,
            running: false,
            message_task: None,
            engine_registry: None,
            session_map: HashMap::new(),
            active_sessions: Arc::new(Mutex::new(HashMap::new())),
            instance_registry: Arc::new(Mutex::new(InstanceRegistry::new())),
            instances_path: None,
        }
    }

    /// 设置 AI 引擎注册表
    pub fn with_engine_registry(mut self, registry: Arc<Mutex<EngineRegistry>>) -> Self {
        self.engine_registry = Some(registry);
        self
    }

    /// 设置 AI 引擎注册表（可变引用）
    pub fn set_engine_registry(&mut self, registry: Arc<Mutex<EngineRegistry>>) {
        self.engine_registry = Some(registry);
    }

    /// 初始化
    pub async fn init(&mut self, qqbot_config: Option<QQBotConfig>, app_handle: AppHandle) {
        self.app_handle = Some(app_handle.clone());

        // 初始化实例存储路径
        if let Some(config_dir) = dirs::config_dir() {
            let data_dir = config_dir.join("claude-code-pro");
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                tracing::warn!("[IntegrationManager] 无法创建数据目录: {}", e);
            }
            self.instances_path = Some(data_dir.join("instances.json"));
            tracing::info!("[IntegrationManager] 实例存储路径: {:?}", self.instances_path);
        }

        // 创建消息通道
        let (tx, rx) = mpsc::channel(100);
        self.message_tx = Some(tx);
        self.message_rx = Some(rx);

        // 加载已保存的实例
        self.load_instances_from_file();

        // 初始化 QQ Bot（仅当没有已保存的实例时使用传入的配置）
        if self.instance_registry.lock().await.count() == 0 {
            if let Some(config) = qqbot_config {
                if config.enabled && !config.app_id.is_empty() && !config.client_secret.is_empty() {
                    let adapter = QQBotAdapter::new(config);
                    let mut adapters = self.adapters.lock().await;
                    adapters.insert(Platform::QQBot, Box::new(adapter));
                    tracing::info!("[IntegrationManager] QQBot adapter registered");
                }
            }
        }
    }

    /// 从文件加载实例
    fn load_instances_from_file(&mut self) {
        if let Some(ref path) = self.instances_path {
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => {
                        match InstanceRegistry::from_json(&content) {
                            Ok(registry) => {
                                let count = registry.count();
                                // 同步更新实例注册表
                                if let Ok(mut instance_registry) = self.instance_registry.try_lock() {
                                    *instance_registry = registry;
                                    tracing::info!("[IntegrationManager] ✅ 已加载 {} 个实例", count);
                                }
                            }
                            Err(e) => {
                                tracing::warn!("[IntegrationManager] 解析实例文件失败: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[IntegrationManager] 读取实例文件失败: {}", e);
                    }
                }
            }
        }
    }

    /// 保存实例到文件
    fn save_instances_to_file(&self) {
        if let Some(ref path) = self.instances_path {
            if let Ok(registry) = self.instance_registry.try_lock() {
                match registry.to_json() {
                    Ok(json) => {
                        if let Err(e) = std::fs::write(path, json) {
                            tracing::warn!("[IntegrationManager] 保存实例文件失败: {}", e);
                        } else {
                            tracing::debug!("[IntegrationManager] ✅ 已保存 {} 个实例", registry.count());
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[IntegrationManager] 序列化实例失败: {}", e);
                    }
                }
            }
        }
    }

    /// 启动指定平台
    pub async fn start(&mut self, platform: Platform) -> Result<()> {
        let tx = self.message_tx.as_ref()
            .ok_or_else(|| crate::error::AppError::StateError("消息通道未初始化".to_string()))?
            .clone();

        // 连接适配器
        {
            let mut adapters = self.adapters.lock().await;
            if let Some(adapter) = adapters.get_mut(&platform) {
                adapter.connect(tx).await?;
                tracing::info!("[IntegrationManager] {} started", platform);
            } else {
                return Err(crate::error::AppError::ValidationError(format!(
                    "平台 {} 未注册",
                    platform
                )));
            }
        }

        // 启动消息处理任务（如果还没有启动）
        self.start_message_processing_task(platform);

        Ok(())
    }

    /// 处理消息（统一入口）
    async fn handle_message(
        msg: IntegrationMessage,
        app_handle: AppHandle,
        platform: Platform,
        adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
        engine_registry: Option<Arc<Mutex<EngineRegistry>>>,
        conversation_states: Arc<Mutex<ConversationStore>>,
        active_sessions: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    ) {
        let text = match msg.content.as_text() {
            Some(t) => t,
            None => {
                tracing::debug!("[IntegrationManager] 非文本消息，跳过处理");
                return;
            }
        };

        let conversation_id = msg.conversation_id.clone();

        // 1. 解析命令
        if let Some(cmd) = CommandParser::parse(text) {
            tracing::info!("[IntegrationManager] 📋 识别到命令: {:?}", cmd);

            let reply = Self::handle_command(
                cmd,
                &conversation_id,
                engine_registry.as_ref(),
                conversation_states.clone(),
                active_sessions.clone(),
            ).await;

            // 发送命令回复
            if let Some(reply_text) = reply {
                Self::send_reply(&adapters, platform, &conversation_id, &reply_text).await;
            }
            return;
        }

        // 2. 普通 AI 消息处理
        if let Some(ref registry) = engine_registry {
            Self::process_ai_message(
                registry.clone(),
                conversation_id,
                text.to_string(),
                app_handle,
                platform,
                adapters,
                conversation_states,
                active_sessions,
            ).await;
        } else {
            tracing::warn!("[IntegrationManager] ⚠️ engine_registry 未设置，无法调用 AI");
            Self::send_reply(&adapters, platform, &conversation_id, "⚠️ AI 服务未初始化").await;
        }
    }

    /// 处理命令
    async fn handle_command(
        cmd: BotCommand,
        conversation_id: &str,
        engine_registry: Option<&Arc<Mutex<EngineRegistry>>>,
        conversation_states: Arc<Mutex<ConversationStore>>,
        active_sessions: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    ) -> Option<String> {
        match cmd {
            BotCommand::SwitchProvider { provider, custom_prompt, replace_mode } => {
                // 检查引擎是否可用
                if let Some(registry) = engine_registry {
                    let registry = registry.lock().await;
                    if !registry.is_available(&provider) {
                        return Some(format!("❌ {} 引擎不可用", provider));
                    }
                }

                // 更新会话状态
                let mut states = conversation_states.lock().await;
                let state = states.get_or_create(conversation_id);
                state.set_engine(&provider);
                state.custom_prompt = custom_prompt.clone();
                state.prompt_mode = if replace_mode { PromptMode::Replace } else { PromptMode::Append };

                let prompt_info = match custom_prompt {
                    Some(p) => {
                        let preview: String = p.chars().take(20).collect();
                        let preview = if preview.len() < p.len() { format!("{}...", preview) } else { preview };
                        format!("（提示词: {}）", preview)
                    }
                    None => "".to_string(),
                };
                Some(format!("✅ 已切换到 {} 模型{}", provider, prompt_info))
            }

            BotCommand::Interrupt => {
                // 中断活跃的 AI 会话
                let mut sessions = active_sessions.lock().await;
                if let Some(handle) = sessions.remove(conversation_id) {
                    handle.abort();
                    Some("✅ 已中断当前对话".to_string())
                } else {
                    Some("⚠️ 当前没有进行中的对话".to_string())
                }
            }

            BotCommand::Status => {
                let states = conversation_states.lock().await;
                let mut lines = vec!["📊 **当前状态**\n".to_string()];

                if let Some(state) = states.get(conversation_id) {
                    lines.push(format!("🤖 模型: {}", state.engine_id));
                    lines.push(format!("📁 工作目录: {}", state.work_dir.as_deref().unwrap_or("默认")));
                    lines.push(format!("💬 消息数: {}", state.message_count));
                    if let Some(ref prompt) = state.custom_prompt {
                        lines.push(format!("📝 提示词: {}...", &prompt[..prompt.len().min(30)]));
                    }
                } else {
                    lines.push("🤖 模型: claude (默认)".to_string());
                }

                // 显示可用引擎
                if let Some(registry) = engine_registry {
                    lines.push("\n**可用引擎**:".to_string());
                    let registry = registry.lock().await;
                    for engine_id in registry.list_available() {
                        let status = if registry.is_available(&engine_id) { "✅" } else { "❌" };
                        lines.push(format!("  {} {}", status, engine_id));
                    }
                }

                Some(lines.join("\n"))
            }

            BotCommand::SetPath { path } => {
                // 验证路径
                let path_buf = std::path::PathBuf::from(&path);
                if !path_buf.exists() {
                    return Some(format!("❌ 路径不存在: {}", path));
                }
                if !path_buf.is_dir() {
                    return Some(format!("❌ 不是有效的目录: {}", path));
                }

                let mut states = conversation_states.lock().await;
                states.set_work_dir(conversation_id, path.clone());

                let is_git = path_buf.join(".git").exists();
                let git_hint = if is_git { " (Git 仓库)" } else { "" };
                Some(format!("✅ 工作目录已设置为: {}{}", path, git_hint))
            }

            BotCommand::GetPath => {
                let states = conversation_states.lock().await;
                if let Some(state) = states.get(conversation_id) {
                    match &state.work_dir {
                        Some(path) => Some(format!("📁 当前工作目录: {}", path)),
                        None => Some("📁 工作目录: 默认（应用目录）".to_string()),
                    }
                } else {
                    Some("📁 工作目录: 默认（应用目录）".to_string())
                }
            }

            BotCommand::Resume => {
                let states = conversation_states.lock().await;
                if let Some(state) = states.get(conversation_id) {
                    if let Some(ref session_id) = state.ai_session_id {
                        let short_id: String = session_id.chars().take(8).collect();
                        Some(format!("✅ 会话 {} 可继续\n请直接发送消息", short_id))
                    } else {
                        Some("⚠️ 没有历史 AI 会话".to_string())
                    }
                } else {
                    Some("⚠️ 没有历史会话".to_string())
                }
            }

            BotCommand::Restart => {
                // 中断活跃会话
                {
                    let mut sessions = active_sessions.lock().await;
                    if let Some(handle) = sessions.remove(conversation_id) {
                        handle.abort();
                    }
                }

                // 重置状态
                let mut states = conversation_states.lock().await;
                states.reset(conversation_id);

                Some("✅ 会话已重置".to_string())
            }

            BotCommand::Help => {
                Some(get_help_text())
            }

            BotCommand::Unknown => {
                None // 不应该到达这里
            }
        }
    }

    /// 发送回复
    async fn send_reply(
        adapters: &Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
        platform: Platform,
        conversation_id: &str,
        text: &str,
    ) {
        let mut adapters_guard = adapters.lock().await;
        if let Some(adapter) = adapters_guard.get_mut(&platform) {
            let target = SendTarget::Conversation(conversation_id.to_string());
            let content = MessageContent::text(text);

            if let Err(e) = adapter.send(target, content).await {
                tracing::error!("[IntegrationManager] ❌ 发送回复失败: {:?}", e);
            }
        }
    }

    /// 处理 AI 消息
    async fn process_ai_message(
        engine_registry: Arc<Mutex<EngineRegistry>>,
        conversation_id: String,
        message: String,
        app_handle: AppHandle,
        platform: Platform,
        adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
        conversation_states: Arc<Mutex<ConversationStore>>,
        active_sessions: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    ) {
        tracing::info!("[IntegrationManager] 🤖 开始 AI 回复: conversation={}, message_len={}", conversation_id, message.len());

        // 获取会话状态（包括已有的 ai_session_id 和消息历史）
        let (engine_id, work_dir, system_prompt, existing_session_id, message_history, is_openai) = {
            let mut states = conversation_states.lock().await;
            let state = states.get_or_create(&conversation_id);

            // 构建系统提示词
            let default_prompt = "你是一个友好的助手，通过 QQ 回复用户消息。回复简洁、有帮助。";
            let system_prompt = match &state.custom_prompt {
                Some(custom) => {
                    match state.prompt_mode {
                        PromptMode::Append => format!("{}\n\n{}", default_prompt, custom),
                        PromptMode::Replace => custom.clone(),
                    }
                }
                None => default_prompt.to_string(),
            };

            let session_id = state.ai_session_id.clone();
            let engine_id = state.get_engine_id();
            let is_openai = engine_id.is_openai();

            // 获取消息历史（仅 OpenAI 需要）
            let history: Vec<crate::ai::HistoryEntry> = if is_openai {
                state.message_history.iter()
                    .map(|h| crate::ai::HistoryEntry {
                        role: h.role.clone(),
                        content: h.content.clone(),
                    })
                    .collect()
            } else {
                Vec::new()
            };

            (
                engine_id,
                state.work_dir.clone(),
                system_prompt,
                session_id,
                history,
                is_openai,
            )
        };

        // 记录开始时间
        let start_time = std::time::Instant::now();

        // 检查引擎可用性
        {
            let registry = engine_registry.lock().await;
            if !registry.is_available(&engine_id) {
                tracing::error!("[IntegrationManager] ❌ {} 引擎不可用", engine_id);
                Self::send_reply(&adapters, platform, &conversation_id, &format!("❌ {} 引擎不可用", engine_id)).await;
                return;
            }
        }

        // 用于累积回复文本
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let accumulated_text_clone = accumulated_text.clone();
        let conversation_id_for_callback = conversation_id.clone();
        let app_handle_for_callback = app_handle.clone();

        // 创建 oneshot 通道等待进程完成
        let (complete_tx, complete_rx) = oneshot::channel();
        let complete_tx = Arc::new(std::sync::Mutex::new(Some(complete_tx)));

        // 创建事件回调
        let callback = move |event: crate::models::AIEvent| {
            // 记录事件类型
            tracing::debug!("[IntegrationManager] 收到事件: {:?}", std::mem::discriminant(&event));

            // 提取文本
            if let Some(text) = event.extract_text() {
                // 使用字符安全的截断方式，避免在多字节 UTF-8 字符中间切割
                let preview: String = text.chars().take(100).collect();
                let preview = if preview.len() < text.len() { format!("{}...", preview) } else { preview };
                tracing::info!("[IntegrationManager] AI 文本 (len={}): {}", text.len(), preview);

                // 累积文本
                if let Ok(mut accumulated) = accumulated_text_clone.try_lock() {
                    if matches!(event, crate::models::AIEvent::Progress(_)) {
                        if !accumulated.is_empty() && !accumulated.ends_with('\n') {
                            accumulated.push('\n');
                        }
                        accumulated.push_str(&text);
                        accumulated.push('\n');
                    } else {
                        accumulated.push_str(&text);
                    }
                }

                // 发送增量更新到前端
                let _ = app_handle_for_callback.emit("integration:ai:delta", serde_json::json!({
                    "conversationId": conversation_id_for_callback,
                    "text": text,
                    "isDelta": true
                }));
            }

            if event.is_session_end() {
                tracing::info!("[IntegrationManager] AI 会话结束");
            }

            if event.is_error() {
                tracing::error!("[IntegrationManager] AI 会话出错: {:?}", event);
            }
        };

        // 创建完成回调
        let complete_tx_clone = complete_tx.clone();
        let complete_callback = move |_exit_code: i32| {
            tracing::debug!("[IntegrationManager] 进程完成回调触发");
            if let Ok(mut tx) = complete_tx_clone.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(());
                }
            }
        };

        // 启动 AI 会话任务
        let task_conversation_id = conversation_id.clone();
        let task_adapters = adapters.clone();
        let task_app_handle = app_handle.clone();
        let task_engine_registry = engine_registry.clone();
        let task_conversation_states = conversation_states.clone();
        let task_active_sessions = active_sessions.clone();

        // 创建 session_id 更新回调
        let task_conversation_id_for_update = conversation_id.clone();
        let conversation_states_for_update = conversation_states.clone();
        let session_id_update_callback = Arc::new(move |new_session_id: String| {
            tracing::info!("[IntegrationManager] 📌 Session ID 更新回调: {}", &new_session_id[..8.min(new_session_id.len())]);
            // 注意：这里不能使用 async，需要使用 try_lock
            if let Ok(mut states) = conversation_states_for_update.try_lock() {
                states.set_ai_session(&task_conversation_id_for_update, new_session_id);
            }
        });

        let task = tokio::spawn(async move {
            // 调用 AI 引擎（根据是否已有会话决定创建新会话还是继续会话）
            let session_id_for_response: String;

            // 检查是否已有会话
            if let Some(ref existing_id) = existing_session_id {
                // 继续已有会话
                tracing::info!("[IntegrationManager] 🔄 继续已有会话: {}", &existing_id[..8.min(existing_id.len())]);

                let result = {
                    let mut registry = task_engine_registry.lock().await;
                    let mut options = SessionOptions::new(callback)
                        .with_system_prompt(&system_prompt)
                        .with_on_complete(complete_callback);
                    options.on_session_id_update = Some(session_id_update_callback.clone());

                    // OpenAI 引擎传递消息历史
                    if is_openai {
                        options = options.with_message_history(message_history.clone());
                    }

                    if let Some(ref dir) = work_dir {
                        options = options.with_work_dir(dir);
                    }

                    registry.continue_session(engine_id, existing_id, &message, options)
                };

                match result {
                    Ok(()) => {
                        session_id_for_response = existing_id.clone();
                    }
                    Err(e) => {
                        tracing::error!("[IntegrationManager] 继续会话失败: {:?}", e);
                        let _ = task_app_handle.emit("integration:ai:error", serde_json::json!({
                            "conversationId": task_conversation_id,
                            "error": e.to_string()
                        }));
                        Self::send_reply(&task_adapters, platform, &task_conversation_id, &format!("❌ AI 调用失败: {}", e)).await;

                        // 从活跃会话中移除
                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            } else {
                // 创建新会话
                tracing::info!("[IntegrationManager] 🆕 创建新会话");

                let result = {
                    let mut registry = task_engine_registry.lock().await;
                    let mut options = SessionOptions::new(callback)
                        .with_system_prompt(&system_prompt)
                        .with_on_complete(complete_callback);
                    options.on_session_id_update = Some(session_id_update_callback.clone());

                    if let Some(ref dir) = work_dir {
                        options = options.with_work_dir(dir);
                    }

                    registry.start_session(Some(engine_id), &message, options)
                };

                match result {
                    Ok(session_id) => {
                        tracing::info!("[IntegrationManager] AI 会话创建: session_id={}", session_id);
                        session_id_for_response = session_id.clone();

                        // 保存会话 ID
                        {
                            let mut states = task_conversation_states.lock().await;
                            states.set_ai_session(&task_conversation_id, session_id);
                        }
                    }
                    Err(e) => {
                        tracing::error!("[IntegrationManager] 创建会话失败: {:?}", e);
                        let _ = task_app_handle.emit("integration:ai:error", serde_json::json!({
                            "conversationId": task_conversation_id,
                            "error": e.to_string()
                        }));
                        Self::send_reply(&task_adapters, platform, &task_conversation_id, &format!("❌ AI 调用失败: {}", e)).await;

                        // 从活跃会话中移除
                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            }

            // 等待进程完成
            tracing::info!("[IntegrationManager] ⏳ 等待 AI 进程完成...");
            let _ = complete_rx.await;

            // 获取完整回复文本
            let final_text = accumulated_text.lock().await.clone();
            tracing::info!("[IntegrationManager] 📝 回复文本长度: {}", final_text.len());

            // 发送完整回复事件到前端
            let _ = task_app_handle.emit("integration:ai:complete", serde_json::json!({
                "conversationId": task_conversation_id,
                "sessionId": session_id_for_response,
                "text": final_text
            }));

            // 发送回复到平台
            if !final_text.is_empty() {
                Self::send_reply(&task_adapters, platform, &task_conversation_id, &final_text).await;
                tracing::info!("[IntegrationManager] ✅ 回复已发送");

                // OpenAI 引擎保存消息历史
                if is_openai {
                    let mut states = task_conversation_states.lock().await;
                    states.add_user_message(&task_conversation_id, &message);
                    states.add_assistant_message(&task_conversation_id, &final_text);
                    tracing::info!("[IntegrationManager] 📝 消息历史已更新");
                }

                // 发送完成消息
                let elapsed = start_time.elapsed();
                let complete_msg = format!("✅ 处理完成（⏰ {:.1}s）", elapsed.as_secs_f32());
                Self::send_reply(&task_adapters, platform, &task_conversation_id, &complete_msg).await;
            } else {
                tracing::warn!("[IntegrationManager] ⚠️ AI 返回空文本，不发送回复");
            }

            // 从活跃会话中移除
            let mut sessions = task_active_sessions.lock().await;
            sessions.remove(&task_conversation_id);
        });

        // 记录活跃会话
        {
            let mut sessions = active_sessions.lock().await;
            sessions.insert(conversation_id.clone(), task);
        }
    }

    /// 停止指定平台
    pub async fn stop(&mut self, platform: Platform) -> Result<()> {
        let mut adapters = self.adapters.lock().await;
        if let Some(adapter) = adapters.get_mut(&platform) {
            adapter.disconnect().await?;
            tracing::info!("[IntegrationManager] {} stopped", platform);
        }
        Ok(())
    }

    /// 启动所有平台
    pub async fn start_all(&mut self) -> Result<()> {
        let platforms: Vec<Platform> = {
            let adapters = self.adapters.lock().await;
            adapters.keys().copied().collect()
        };

        for platform in platforms {
            if let Err(e) = self.start(platform).await {
                tracing::error!("[IntegrationManager] Failed to start {}: {:?}", platform, e);
            }
        }

        self.running = true;
        Ok(())
    }

    /// 停止所有平台
    pub async fn stop_all(&mut self) -> Result<()> {
        let platforms: Vec<Platform> = {
            let adapters = self.adapters.lock().await;
            adapters.keys().copied().collect()
        };

        for platform in platforms {
            let _ = self.stop(platform).await;
        }

        self.running = false;
        Ok(())
    }

    /// 发送消息
    pub async fn send(
        &self,
        platform: Platform,
        target: SendTarget,
        content: MessageContent,
    ) -> Result<()> {
        let mut adapters = self.adapters.lock().await;
        if let Some(adapter) = adapters.get_mut(&platform) {
            adapter.send(target, content).await
        } else {
            Err(crate::error::AppError::ValidationError(format!(
                "平台 {} 未注册",
                platform
            )))
        }
    }

    /// 获取平台状态
    pub async fn status(&self, platform: Platform) -> Option<IntegrationStatus> {
        let adapters = self.adapters.lock().await;
        adapters.get(&platform).map(|a| a.status())
    }

    /// 获取所有状态
    pub async fn all_status(&self) -> HashMap<Platform, IntegrationStatus> {
        let adapters = self.adapters.lock().await;
        adapters
            .iter()
            .map(|(p, a)| (*p, a.status()))
            .collect()
    }

    /// 处理消息 (从通道读取并转发到前端)
    ///
    /// 此方法应该在单独的任务中运行
    pub async fn process_messages(&mut self) {
        if let Some(rx) = &mut self.message_rx {
            while let Some(msg) = rx.recv().await {
                // 更新会话
                self.sessions.update(&msg.conversation_id);

                // 发送到前端
                if let Some(ref app_handle) = self.app_handle {
                    if let Err(e) = app_handle.emit("integration:message", &msg) {
                        tracing::error!("[IntegrationManager] Failed to emit message: {}", e);
                    }
                }

                tracing::debug!(
                    "[IntegrationManager] Message received: {} from {}",
                    msg.id,
                    msg.platform
                );
            }
        }
    }

    /// 是否正在运行
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// 获取会话列表
    pub fn sessions(&self) -> Vec<&IntegrationSession> {
        self.sessions.all()
    }

    /// 注册平台
    pub async fn register(&mut self, platform: Platform, adapter: Box<dyn PlatformIntegration>) {
        let mut adapters = self.adapters.lock().await;
        adapters.insert(platform, adapter);
    }

    // ==================== 实例管理方法 ====================

    /// 添加实例配置
    pub async fn add_instance(&self, instance: PlatformInstance) -> InstanceId {
        let mut registry = self.instance_registry.lock().await;
        let id = registry.add(instance);
        drop(registry); // 释放锁后再保存
        self.save_instances_to_file();
        tracing::info!("[IntegrationManager] ✅ 实例已添加并保存: {}", id);
        id
    }

    /// 移除实例配置
    pub async fn remove_instance(&self, instance_id: &str) -> Option<PlatformInstance> {
        let mut registry = self.instance_registry.lock().await;
        let removed = registry.remove(instance_id);
        drop(registry); // 释放锁后再保存
        self.save_instances_to_file();
        if removed.is_some() {
            tracing::info!("[IntegrationManager] ✅ 实例已移除并保存: {}", instance_id);
        }
        removed
    }

    /// 获取所有实例
    pub async fn list_instances(&self) -> Vec<PlatformInstance> {
        let registry = self.instance_registry.lock().await;
        registry.all().to_vec()
    }

    /// 按平台获取实例列表
    pub async fn list_instances_by_platform(&self, platform: Platform) -> Vec<PlatformInstance> {
        let registry = self.instance_registry.lock().await;
        registry.get_by_platform(platform).into_iter().cloned().collect()
    }

    /// 获取当前激活的实例
    pub async fn get_active_instance(&self, platform: Platform) -> Option<PlatformInstance> {
        let registry = self.instance_registry.lock().await;
        registry.get_active(platform).cloned()
    }

    /// 检查实例是否激活
    pub async fn is_instance_active(&self, instance_id: &str) -> bool {
        let registry = self.instance_registry.lock().await;
        registry.is_active(instance_id)
    }

    /// 检查平台是否有激活实例
    pub async fn has_active_instance(&self, platform: Platform) -> bool {
        let registry = self.instance_registry.lock().await;
        registry.has_active(platform)
    }

    /// 切换实例（核心方法）
    ///
    /// 切换流程：
    /// 1. 检查目标实例是否存在
    /// 2. 断开当前连接
    /// 3. 创建新的 Adapter
    /// 4. 建立连接
    pub async fn switch_instance(&mut self, instance_id: &str) -> Result<()> {
        tracing::info!("[IntegrationManager] 🔄 切换实例: {}", instance_id);

        // 1. 获取实例配置
        let instance = {
            let registry = self.instance_registry.lock().await;
            registry.get(instance_id).cloned()
        };

        let instance = match instance {
            Some(i) => i,
            None => {
                return Err(crate::error::AppError::ValidationError(format!(
                    "实例不存在: {}",
                    instance_id
                )));
            }
        };

        let platform = instance.platform;

        // 2. 检查是否已有激活实例（同类型平台互斥）
        {
            let registry = self.instance_registry.lock().await;
            if registry.is_active(instance_id) {
                tracing::info!("[IntegrationManager] 实例已激活，无需切换");
                return Ok(());
            }
        }

        // 3. 断开当前连接（销毁旧 Adapter）
        {
            let mut adapters = self.adapters.lock().await;
            if let Some(mut adapter) = adapters.remove(&platform) {
                tracing::info!("[IntegrationManager] 断开当前连接...");
                adapter.disconnect().await?;
            }
        }

        // 4. 创建新的 Adapter
        let adapter: Box<dyn PlatformIntegration> = match &instance.config {
            InstanceConfig::QQBot(config) => {
                tracing::info!("[IntegrationManager] 创建新的 QQBot Adapter: {}", instance.name);
                Box::new(QQBotAdapter::new(config.clone()))
            }
        };

        // 5. 注册新 Adapter
        {
            let mut adapters = self.adapters.lock().await;
            adapters.insert(platform, adapter);
        }

        // 6. 激活实例
        {
            let mut registry = self.instance_registry.lock().await;
            registry.activate(instance_id);
        }

        // 7. 建立连接
        let tx = self.message_tx.as_ref()
            .ok_or_else(|| crate::error::AppError::StateError("消息通道未初始化".to_string()))?
            .clone();

        {
            let mut adapters = self.adapters.lock().await;
            if let Some(adapter) = adapters.get_mut(&platform) {
                adapter.connect(tx).await?;
            }
        }

        // 8. 启动消息处理任务（如果还没有启动）
        self.start_message_processing_task(platform);

        // 保存激活状态
        self.save_instances_to_file();

        tracing::info!("[IntegrationManager] ✅ 实例切换成功: {}", instance.name);
        Ok(())
    }

    /// 启动消息处理任务
    fn start_message_processing_task(&mut self, platform: Platform) {
        if self.message_task.is_some() {
            tracing::debug!("[IntegrationManager] 消息处理任务已在运行");
            return;
        }

        let rx = self.message_rx.take();
        let app_handle = self.app_handle.clone();
        let engine_registry = self.engine_registry.clone();
        let adapters = self.adapters.clone();
        let conversation_states = self.conversation_states.clone();
        let active_sessions = self.active_sessions.clone();

        if let (Some(rx), Some(app_handle)) = (rx, app_handle) {
            tracing::info!("[IntegrationManager] 🚀 启动消息处理任务");

            let task = tokio::spawn(async move {
                tracing::info!("[IntegrationManager] 📨 消息处理任务已启动，等待消息...");
                let mut rx = rx;

                while let Some(msg) = rx.recv().await {
                    tracing::info!(
                        "[IntegrationManager] 📩 收到消息: id={}, platform={}, conversation={}",
                        msg.id,
                        msg.platform,
                        msg.conversation_id
                    );

                    // 发送到前端
                    if let Err(e) = app_handle.emit("integration:message", &msg) {
                        tracing::error!("[IntegrationManager] ❌ 发送消息到前端失败: {}", e);
                    } else {
                        tracing::info!("[IntegrationManager] ✅ 消息已发送到前端");
                    }

                    // 处理消息
                    Self::handle_message(
                        msg,
                        app_handle.clone(),
                        platform,
                        adapters.clone(),
                        engine_registry.clone(),
                        conversation_states.clone(),
                        active_sessions.clone(),
                    ).await;
                }

                tracing::warn!("[IntegrationManager] ⚠️ 消息处理任务结束");
            });

            self.message_task = Some(task);
        } else {
            tracing::error!("[IntegrationManager] ❌ 无法启动消息处理任务: message_rx 或 app_handle 为空");
        }
    }

    /// 断开当前实例
    pub async fn disconnect_instance(&mut self, platform: Platform) -> Result<()> {
        tracing::info!("[IntegrationManager] 断开平台 {} 的连接", platform);

        // 1. 断开连接
        {
            let mut adapters = self.adapters.lock().await;
            if let Some(mut adapter) = adapters.remove(&platform) {
                adapter.disconnect().await?;
            }
        }

        // 2. 清除激活状态
        {
            let mut registry = self.instance_registry.lock().await;
            registry.deactivate(platform);
        }

        // 保存状态
        self.save_instances_to_file();

        tracing::info!("[IntegrationManager] ✅ 已断开平台 {}", platform);
        Ok(())
    }

    /// 获取实例注册表引用
    pub fn instance_registry(&self) -> Arc<Mutex<InstanceRegistry>> {
        self.instance_registry.clone()
    }

    /// 更新实例配置
    pub async fn update_instance(&mut self, instance: PlatformInstance) -> Result<()> {
        tracing::info!("[IntegrationManager] 更新实例: {}", instance.id);

        let instance_id = instance.id.clone();
        let platform = instance.platform;

        // 更新注册表中的实例
        {
            let mut registry = self.instance_registry.lock().await;
            if let Some(existing) = registry.get_mut(&instance_id) {
                *existing = instance;
                tracing::info!("[IntegrationManager] ✅ 实例配置已更新: {}", instance_id);
            } else {
                return Err(crate::error::AppError::ValidationError(format!(
                    "实例不存在: {}",
                    instance_id
                )));
            }
        }

        // 保存到文件
        self.save_instances_to_file();

        // 如果是当前激活的实例，需要重新创建 Adapter
        {
            let registry = self.instance_registry.lock().await;
            if registry.is_active(&instance_id) {
                tracing::info!("[IntegrationManager] 激活实例已更新，需要重建 Adapter");
                drop(registry); // 释放锁

                // 断开当前连接
                {
                    let mut adapters = self.adapters.lock().await;
                    if let Some(mut adapter) = adapters.remove(&platform) {
                        let _ = adapter.disconnect().await;
                    }
                }
            }
        }

        Ok(())
    }
}

impl Default for IntegrationManager {
    fn default() -> Self {
        Self::new()
    }
}
