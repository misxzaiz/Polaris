/**
 * 集成管理器
 *
 * 统一管理所有平台集成，提供消息路由和状态管理。
 * 集成 EngineRegistry 实现 AI 自动回复。
 */

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, oneshot};
use tauri::{AppHandle, Emitter};

use super::common::SessionManager;
use super::qqbot::QQBotAdapter;
use super::traits::PlatformIntegration;
use super::types::*;
use crate::ai::EngineRegistry;
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
    /// App Handle (用于发送事件到前端)
    app_handle: Option<AppHandle>,
    /// 运行状态
    running: bool,
    /// 消息处理任务句柄
    message_task: Option<tokio::task::JoinHandle<()>>,
    /// AI 引擎注册表引用
    engine_registry: Option<Arc<Mutex<EngineRegistry>>>,
    /// 会话 ID 映射 (conversation_id -> ai_session_id)
    session_map: HashMap<String, String>,
}

impl IntegrationManager {
    /// 创建新的集成管理器
    pub fn new() -> Self {
        Self {
            message_rx: None,
            message_tx: None,
            adapters: Arc::new(Mutex::new(HashMap::new())),
            sessions: SessionManager::new(),
            app_handle: None,
            running: false,
            message_task: None,
            engine_registry: None,
            session_map: HashMap::new(),
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
        self.app_handle = Some(app_handle);

        // 创建消息通道
        let (tx, rx) = mpsc::channel(100);
        self.message_tx = Some(tx);
        self.message_rx = Some(rx);

        // 初始化 QQ Bot
        if let Some(config) = qqbot_config {
            if config.enabled && !config.app_id.is_empty() && !config.client_secret.is_empty() {
                let adapter = QQBotAdapter::new(config);
                let mut adapters = self.adapters.lock().await;
                adapters.insert(Platform::QQBot, Box::new(adapter));
                tracing::info!("[IntegrationManager] QQBot adapter registered");
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
        if self.message_task.is_none() {
            let rx = self.message_rx.take();
            let app_handle = self.app_handle.clone();
            let engine_registry = self.engine_registry.clone();
            let adapters = self.adapters.clone();

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

                        // 1. 发送到前端
                        if let Err(e) = app_handle.emit("integration:message", &msg) {
                            tracing::error!("[IntegrationManager] ❌ 发送消息到前端失败: {}", e);
                        } else {
                            tracing::info!("[IntegrationManager] ✅ 消息已发送到前端");
                        }

                        // 2. 调用 AI 生成回复
                        if let Some(ref registry) = engine_registry {
                            tracing::info!("[IntegrationManager] 🔧 engine_registry 存在，准备调用 AI");
                            if let Some(text) = msg.content.as_text() {
                                tracing::info!("[IntegrationManager] 📝 消息文本: {}", if text.len() > 50 { &text[..50] } else { text });
                                if !text.is_empty() {
                                    let conversation_id = msg.conversation_id.clone();
                                    let adapters_clone = adapters.clone();
                                    let app_handle_clone = app_handle.clone();

                                    Self::process_ai_message(
                                        registry.clone(),
                                        conversation_id,
                                        text.to_string(),
                                        app_handle_clone,
                                        platform,
                                        adapters_clone,
                                    ).await;
                                } else {
                                    tracing::warn!("[IntegrationManager] ⚠️ 消息文本为空，跳过 AI 调用");
                                }
                            } else {
                                tracing::warn!("[IntegrationManager] ⚠️ 消息不是文本类型，跳过 AI 调用");
                            }
                        } else {
                            tracing::warn!("[IntegrationManager] ⚠️ engine_registry 未设置，无法调用 AI");
                        }
                    }

                    tracing::warn!("[IntegrationManager] ⚠️ 消息处理任务结束");
                });

                self.message_task = Some(task);
            } else {
                tracing::error!("[IntegrationManager] ❌ 无法启动消息处理任务: message_rx 或 app_handle 为空");
            }
        }

        Ok(())
    }

    /// 处理 AI 消息
    async fn process_ai_message(
        engine_registry: Arc<Mutex<EngineRegistry>>,
        conversation_id: String,
        message: String,
        app_handle: AppHandle,
        platform: Platform,
        adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
    ) {
        tracing::info!("[IntegrationManager] 🤖 开始 AI 回复: conversation={}, message_len={}", conversation_id, message.len());

        // 记录开始时间
        let start_time = std::time::Instant::now();

        // 检查引擎可用性
        {
            let registry = engine_registry.lock().await;
            let available_engines = registry.list_available();
            tracing::info!("[IntegrationManager] 🔧 可用引擎: {:?}", available_engines);
            if available_engines.is_empty() {
                tracing::error!("[IntegrationManager] ❌ 没有可用的 AI 引擎");
                let _ = app_handle.emit("integration:ai:error", serde_json::json!({
                    "conversationId": conversation_id,
                    "error": "没有可用的 AI 引擎"
                }));
                return;
            }
        }

        // 用于累积回复文本
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let conversation_id_clone = conversation_id.clone();
        let accumulated_text_clone = accumulated_text.clone();
        let app_handle_for_callback = app_handle.clone();

        // 创建 oneshot 通道等待进程完成
        let (complete_tx, complete_rx) = oneshot::channel();
        let complete_tx = Arc::new(std::sync::Mutex::new(Some(complete_tx)));

        // 创建事件回调
        let callback = move |event: crate::models::AIEvent| {
            // 提取文本
            if let Some(text) = event.extract_text() {
                tracing::debug!("[IntegrationManager] AI 文本: {}", text);

                // 累积文本 (使用 try_lock 避免阻塞)
                if let Ok(mut accumulated) = accumulated_text_clone.try_lock() {
                    accumulated.push_str(&text);
                }

                // 发送增量更新到前端
                let _ = app_handle_for_callback.emit("integration:ai:delta", serde_json::json!({
                    "conversationId": conversation_id_clone,
                    "text": text,
                    "isDelta": true
                }));
            }

            // 检查会话结束
            if event.is_session_end() {
                tracing::info!("[IntegrationManager] AI 会话结束");
            }

            // 检查错误
            if event.is_error() {
                tracing::error!("[IntegrationManager] AI 会话出错");
            }
        };

        // 创建完成回调
        let complete_callback = {
            let complete_tx = complete_tx.clone();
            move |_exit_code: i32| {
                tracing::debug!("[IntegrationManager] 进程完成回调触发");
                if let Ok(mut tx) = complete_tx.lock() {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        };

        // 调用 AI 引擎
        let result = {
            let mut registry = engine_registry.lock().await;
            let options = crate::ai::SessionOptions::new(callback)
                .with_system_prompt("你是一个友好的助手，通过 QQ 回复用户消息。回复简洁、有帮助。")
                .with_on_complete(complete_callback);

            registry.start_session(None, &message, options)
        };

        match result {
            Ok(session_id) => {
                tracing::info!("[IntegrationManager] AI 会话创建: session_id={}", session_id);

                // 等待进程完成
                tracing::info!("[IntegrationManager] ⏳ 等待 AI 进程完成...");
                match complete_rx.await {
                    Ok(()) => {
                        tracing::info!("[IntegrationManager] ✅ AI 进程已完成");
                    }
                    Err(_) => {
                        tracing::warn!("[IntegrationManager] ⚠️ 完成通道已关闭");
                    }
                }

                // 获取完整回复文本
                let final_text = accumulated_text.lock().await.clone();
                tracing::info!("[IntegrationManager] 📝 回复文本长度: {}", final_text.len());

                // 发送完整回复事件到前端
                let _ = app_handle.emit("integration:ai:complete", serde_json::json!({
                    "conversationId": conversation_id,
                    "sessionId": session_id,
                    "text": final_text
                }));

                // 发送回复到 QQ
                if !final_text.is_empty() {
                    tracing::info!("[IntegrationManager] 📤 发送回复到 {}: {}", platform, conversation_id);

                    let mut adapters_guard = adapters.lock().await;
                    if let Some(adapter) = adapters_guard.get_mut(&platform) {
                        let target = SendTarget::Conversation(conversation_id.clone());
                        let content = MessageContent::text(&final_text);

                        match adapter.send(target, content).await {
                            Ok(_) => {
                                tracing::info!("[IntegrationManager] ✅ 回复已发送到 QQ");

                                // 发送完成消息（包含处理时间）
                                let elapsed = start_time.elapsed();
                                let elapsed_secs = elapsed.as_secs_f32();
                                let complete_msg = format!("✅ 处理完成，耗时 {:.1}s", elapsed_secs);

                                let target = SendTarget::Conversation(conversation_id.clone());
                                let complete_content = MessageContent::text(&complete_msg);

                                if let Err(e) = adapter.send(target, complete_content).await {
                                    tracing::error!("[IntegrationManager] ❌ 发送完成消息失败: {:?}", e);
                                }
                            }
                            Err(e) => {
                                tracing::error!("[IntegrationManager] ❌ 发送回复失败: {:?}", e);
                            }
                        }
                    } else {
                        tracing::warn!("[IntegrationManager] ⚠️ 未找到 {} 适配器", platform);
                    }
                } else {
                    tracing::warn!("[IntegrationManager] ⚠️ AI 返回空文本，不发送回复");
                }
            }
            Err(e) => {
                tracing::error!("[IntegrationManager] AI 会话创建失败: {:?}", e);
                let _ = app_handle.emit("integration:ai:error", serde_json::json!({
                    "conversationId": conversation_id,
                    "error": e.to_string()
                }));
            }
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
}

impl Default for IntegrationManager {
    fn default() -> Self {
        Self::new()
    }
}