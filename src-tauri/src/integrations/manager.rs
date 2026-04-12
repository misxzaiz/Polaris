/*! 集成管理器
 *
 * 统一管理所有平台集成，提供消息路由和状态管理。
 * 集成 EngineRegistry 实现 AI 自动回复。
 * 支持命令解析和处理。
 */

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, oneshot};
use tauri::{AppHandle, Emitter};

use super::common::{SessionManager, ConversationStore};
use super::qqbot::QQBotAdapter;
use super::feishu::FeishuAdapter;
use super::traits::PlatformIntegration;
use super::types::*;
use super::commands::{BotCommand, CommandParser, get_help_text, PromptMode};
use super::instance_registry::{InstanceRegistry, PlatformInstance, InstanceConfig, InstanceId};
use crate::ai::{EngineRegistry, SessionOptions};
use crate::error::Result;
use crate::models::config::{QQBotConfig, QQBotRuntimeConfig, FeishuConfig, FeishuRuntimeConfig};
use crate::services::prompt_store::PromptStore;

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
    /// 每个会话的消息处理串行锁（确保同一会话消息按序处理，不同会话并行）
    conversation_queues: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

/// AI 消息处理上下文
struct ProcessAiMessageContext {
    engine_registry: Arc<Mutex<EngineRegistry>>,
    conversation_id: String,
    message: String,
    app_handle: AppHandle,
    platform: Platform,
    adapters: Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
    conversation_states: Arc<Mutex<ConversationStore>>,
    active_sessions: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
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
            conversation_queues: Arc::new(Mutex::new(HashMap::new())),
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
    pub async fn init(&mut self, qqbot_config: Option<QQBotConfig>, feishu_config: Option<FeishuConfig>, app_handle: AppHandle) {
        self.app_handle = Some(app_handle.clone());

        // 创建消息通道（仅在未创建时，避免重复 init 时覆盖）
        if self.message_tx.is_none() {
            let (tx, rx) = mpsc::channel(100);
            self.message_tx = Some(tx);
            self.message_rx = Some(rx);
        }

        // 从传入的配置中加载 QQBot 实例
        if let Some(config) = qqbot_config {
            let mut registry = self.instance_registry.lock().await;
            for instance_config in &config.instances {
                // 跳过已存在的实例（避免重复调用 init 时重复添加）
                if registry.get(&instance_config.id).is_some() {
                    continue;
                }
                let runtime_config = QQBotRuntimeConfig::from(instance_config);
                let platform_instance = PlatformInstance {
                    id: instance_config.id.clone(),
                    name: instance_config.name.clone(),
                    platform: Platform::QQBot,
                    config: InstanceConfig::QQBot(runtime_config),
                    created_at: instance_config.created_at.as_ref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(chrono::Utc::now),
                    last_active: instance_config.last_active.as_ref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Utc)),
                    enabled: instance_config.enabled,
                };
                registry.add(platform_instance);
            }

            if let Some(ref active_id) = config.active_instance_id {
                registry.activate(active_id);
            }

            tracing::info!("[IntegrationManager] ✅ QQ Bot 实例已加载 (共 {} 个)", config.instances.len());

            if let Some(active_instance) = registry.get_active(Platform::QQBot) {
                if let InstanceConfig::QQBot(qqbot_cfg) = &active_instance.config {
                    if qqbot_cfg.enabled && !qqbot_cfg.app_id.is_empty() && !qqbot_cfg.client_secret.is_empty() {
                        // 只在 adapters 中不存在时才创建，避免覆盖已有连接
                        let mut adapters = self.adapters.lock().await;
                        if !adapters.contains_key(&Platform::QQBot) {
                            let adapter = QQBotAdapter::new(qqbot_cfg.clone());
                            adapters.insert(Platform::QQBot, Box::new(adapter));
                            tracing::info!("[IntegrationManager] ✅ 创建 QQBot 适配器: {}", active_instance.name);
                        } else {
                            tracing::info!("[IntegrationManager] ✅ QQBot 适配器已存在，跳过重建");
                        }
                    }
                }
            }
        }

        // 从传入的配置中加载 Feishu 实例
        if let Some(config) = feishu_config {
            let mut registry = self.instance_registry.lock().await;
            for instance_config in &config.instances {
                // 跳过已存在的实例（避免重复调用 init 时重复添加）
                if registry.get(&instance_config.id).is_some() {
                    continue;
                }
                let runtime_config = FeishuRuntimeConfig::from(instance_config);
                let platform_instance = PlatformInstance {
                    id: instance_config.id.clone(),
                    name: instance_config.name.clone(),
                    platform: Platform::Feishu,
                    config: InstanceConfig::Feishu(runtime_config),
                    created_at: instance_config.created_at.as_ref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(chrono::Utc::now),
                    last_active: instance_config.last_active.as_ref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Utc)),
                    enabled: instance_config.enabled,
                };
                registry.add(platform_instance);
            }

            if let Some(ref active_id) = config.active_instance_id {
                registry.activate(active_id);
            }

            tracing::info!("[IntegrationManager] ✅ Feishu 实例已加载 (共 {} 个)", config.instances.len());

            if let Some(active_instance) = registry.get_active(Platform::Feishu) {
                if let InstanceConfig::Feishu(feishu_cfg) = &active_instance.config {
                    if feishu_cfg.enabled && !feishu_cfg.app_id.is_empty() && !feishu_cfg.app_secret.is_empty() {
                        // 只在 adapters 中不存在时才创建，避免覆盖已有连接
                        let mut adapters = self.adapters.lock().await;
                        if !adapters.contains_key(&Platform::Feishu) {
                            let adapter = FeishuAdapter::new(feishu_cfg.clone());
                            adapters.insert(Platform::Feishu, Box::new(adapter));
                            tracing::info!("[IntegrationManager] ✅ 创建 Feishu 适配器: {}", active_instance.name);
                        } else {
                            tracing::info!("[IntegrationManager] ✅ Feishu 适配器已存在，跳过重建");
                        }
                    }
                }
            }
        }
    }


    /// 启动指定平台
    pub async fn start(&mut self, platform: Platform) -> Result<()> {
        tracing::info!("[IntegrationManager] 🚀 start() 被调用，platform: {}", platform);

        let tx = self.message_tx.as_ref()
            .ok_or_else(|| crate::error::AppError::StateError("消息通道未初始化".to_string()))?
            .clone();

        // 连接适配器
        {
            let mut adapters = self.adapters.lock().await;
            if let Some(adapter) = adapters.get_mut(&platform) {
                // 避免重复连接：如果已连接则跳过
                if adapter.is_connected() {
                    tracing::info!("[IntegrationManager] {} 已连接，跳过重复 connect()", platform);
                    return Ok(());
                }
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
        instance_registry: Arc<Mutex<InstanceRegistry>>,
    ) {
        let conversation_id = msg.conversation_id.clone();

        // 注入默认工作区（从当前激活实例配置中读取）
        let work_dir = {
            let mut states = conversation_states.lock().await;
            let state = states.get_or_create(&conversation_id);
            if state.work_dir.is_none() {
                if let Some(wd) = Self::get_instance_work_dir(&instance_registry, platform).await {
                    tracing::info!("[IntegrationManager] 📂 注入默认工作区: conversation={}, work_dir={}", conversation_id, wd);
                    state.work_dir = Some(wd);
                }
            }
            state.work_dir.clone()
        };

        // 处理媒体内容：下载文件并构造文本描述
        let text = if msg.content.has_media() {
            Self::handle_media_content(&msg, &adapters, &work_dir).await
        } else {
            match msg.content.as_text() {
                Some(t) => t.to_string(),
                None => {
                    tracing::debug!("[IntegrationManager] 非文本消息，跳过处理");
                    return;
                }
            }
        };

        if text.is_empty() {
            tracing::debug!("[IntegrationManager] 消息内容为空，跳过处理");
            return;
        }

        // 1. 解析命令
        if let Some(cmd) = CommandParser::parse(&text) {
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
            let ctx = ProcessAiMessageContext {
                engine_registry: registry.clone(),
                conversation_id,
                message: text,
                app_handle,
                platform,
                adapters,
                conversation_states,
                active_sessions,
            };
            Self::process_ai_message(ctx).await;
        } else {
            tracing::warn!("[IntegrationManager] ⚠️ engine_registry 未设置，无法调用 AI");
            Self::send_reply(&adapters, platform, &conversation_id, "⚠️ AI 服务未初始化").await;
        }
    }

    /// 处理消息中的媒体内容：下载文件并构造文本描述
    async fn handle_media_content(
        msg: &IntegrationMessage,
        adapters: &Arc<Mutex<HashMap<Platform, Box<dyn PlatformIntegration>>>>,
        work_dir: &Option<String>,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        // 提取原始文本（Mixed 内容可能包含文字）
        if let Some(text) = msg.content.as_text() {
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }

        // 确定保存目录
        let media_dir = match work_dir {
            Some(dir) => std::path::PathBuf::from(dir).join(".media"),
            None => dirs::data_local_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("claude-code-pro")
                .join("media"),
        };

        // 创建目录（如不存在）
        if let Err(e) = tokio::fs::create_dir_all(&media_dir).await {
            tracing::error!("[IntegrationManager] ❌ 创建媒体目录失败: {}", e);
            parts.push("⚠️ 媒体文件保存失败：无法创建目录".to_string());
            return parts.join("\n");
        }

        // 调用适配器下载媒体
        let downloads = {
            let mut adapters_lock = adapters.lock().await;
            if let Some(adapter) = adapters_lock.get_mut(&msg.platform) {
                adapter.download_media(msg, &media_dir).await
            } else {
                vec![]
            }
        };
        // 适配器锁已释放

        // 构造文本描述
        for dl in downloads {
            match &dl.local_path {
                Some(path) => {
                    parts.push(format!("[{}] 已保存到: {}", dl.label, path));
                }
                None => {
                    parts.push(format!("[{}] 下载失败", dl.label));
                }
            }
        }

        let result = parts.join("\n");
        tracing::info!("[IntegrationManager] 📎 媒体处理结果: {} chars", result.len());
        result
    }

    /// 获取当前平台激活实例的默认工作目录
    async fn get_instance_work_dir(
        instance_registry: &Arc<Mutex<InstanceRegistry>>,
        platform: Platform,
    ) -> Option<String> {
        let registry = instance_registry.lock().await;
        registry.get_active(platform)
            .and_then(|inst| match &inst.config {
                InstanceConfig::QQBot(cfg) => cfg.work_dir.clone(),
                InstanceConfig::Feishu(cfg) => cfg.work_dir.clone(),
            })
            .filter(|dir| !dir.is_empty())
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

            BotCommand::EngineInfo => {
                let mut lines = vec!["🤖 **引擎信息**\n".to_string()];

                if let Some(registry) = engine_registry {
                    let reg = registry.lock().await;
                    for engine_id in reg.list_available() {
                        let status = if reg.is_available(&engine_id) { "✅ 可用" } else { "❌ 不可用" };
                        lines.push(format!("• {} — {} ({})", engine_id.display_name(), engine_id, status));
                    }
                    if reg.list_available().is_empty() {
                        lines.push("⚠️ 没有已注册的引擎".to_string());
                    }
                } else {
                    lines.push("⚠️ 引擎注册表未初始化".to_string());
                }

                lines.push("\n💡 使用 `/claude [提示词]` 切换引擎".to_string());
                Some(lines.join("\n"))
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

                    // 工作区详情
                    if let Some(ref work_dir) = state.work_dir {
                        let path_buf = std::path::PathBuf::from(work_dir);
                        if let Some(name) = path_buf.file_name().and_then(|n| n.to_str()) {
                            lines.push(format!("📂 工作区名称: {}", name));
                        }
                        if path_buf.join(".git").exists() {
                            lines.push("🔀 Git 仓库: 是".to_string());
                        }
                    }

                    lines.push(format!("💬 消息数: {}", state.message_count));

                    // 显示预设信息
                    if let Some(ref preset_id) = state.prompt_preset_id {
                        // 尝试解析预设名称
                        let preset_display = Self::resolve_preset_display_name(preset_id, state.work_dir.as_deref());
                        lines.push(format!("🎯 预设: {}", preset_display));
                    }

                    if let Some(ref prompt) = state.custom_prompt {
                        let preview: String = prompt.chars().take(30).collect();
                        let truncated = if preview.len() < prompt.len() { format!("{}...", preview) } else { preview };
                        lines.push(format!("📝 提示词: {}", truncated));
                    }

                    if state.pending_resume {
                        lines.push("🔄 待恢复: 是（下一条消息将自动继续上次会话）".to_string());
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
                        lines.push(format!("  {} {} ({})", status, engine_id.display_name(), engine_id));
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
                let name = path_buf.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");
                Some(format!("✅ 工作目录已设置为: {}{}\n📂 工作区: {}", path, git_hint, name))
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

            BotCommand::Workspace => {
                let states = conversation_states.lock().await;
                let mut lines = vec!["📂 **工作区信息**\n".to_string()];

                if let Some(state) = states.get(conversation_id) {
                    match &state.work_dir {
                        Some(path) => {
                            let path_buf = std::path::PathBuf::from(path);
                            lines.push(format!("📁 路径: {}", path));

                            if let Some(name) = path_buf.file_name().and_then(|n| n.to_str()) {
                                lines.push(format!("🏷️ 名称: {}", name));
                            }

                            // Git 信息
                            if path_buf.join(".git").exists() {
                                lines.push("🔀 Git 仓库: 是".to_string());
                                // 尝试获取分支名
                                let git_head = path_buf.join(".git/HEAD");
                                if let Ok(head_content) = std::fs::read_to_string(&git_head) {
                                    if let Some(branch) = head_content.strip_prefix("ref: refs/heads/") {
                                        lines.push(format!("🌿 当前分支: {}", branch.trim()));
                                    }
                                }
                            } else {
                                lines.push("🔀 Git 仓库: 否".to_string());
                            }

                            // Polaris 工作区检测
                            let polaris_dir = path_buf.join(".polaris");
                            if polaris_dir.exists() {
                                lines.push("⚙️ Polaris 工作区: 是".to_string());
                                // 检测各配置文件
                                let configs = [
                                    ("prompt_config.json", "提示词配置"),
                                    ("todos.json", "待办列表"),
                                    ("requirements", "需求库"),
                                    ("scheduler", "定时任务"),
                                ];
                                for (file, label) in &configs {
                                    if polaris_dir.join(file).exists() {
                                        lines.push(format!("  • {}", label));
                                    }
                                }
                            } else {
                                lines.push("⚙️ Polaris 工作区: 否（使用 /path 设置包含 .polaris 的目录）".to_string());
                            }
                        }
                        None => {
                            lines.push("⚠️ 未设置工作目录".to_string());
                            lines.push("💡 使用 `/path <目录>` 设置工作目录".to_string());
                        }
                    }
                } else {
                    lines.push("⚠️ 未设置工作目录".to_string());
                    lines.push("💡 使用 `/path <目录>` 设置工作目录".to_string());
                }

                Some(lines.join("\n"))
            }

            BotCommand::Resume => {
                let mut states = conversation_states.lock().await;
                let state = states.get_or_create(conversation_id);

                if let Some(ref session_id) = state.ai_session_id {
                    let short_id: String = session_id.chars().take(8).collect();
                    state.pending_resume = true;
                    Some(format!("✅ 已标记恢复会话 {}\n💡 下一条消息将自动继续该会话", short_id))
                } else {
                    Some("⚠️ 没有历史 AI 会话可恢复".to_string())
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

                Some("✅ 会话已完全重置（工作目录、预设、提示词均已清除）".to_string())
            }

            BotCommand::Clear => {
                // 中断活跃会话
                {
                    let mut sessions = active_sessions.lock().await;
                    if let Some(handle) = sessions.remove(conversation_id) {
                        handle.abort();
                    }
                }

                // 仅清除 AI 上下文，保留工作目录和预设
                let mut states = conversation_states.lock().await;
                if let Some(state) = states.get_mut(conversation_id) {
                    let work_dir = state.work_dir.clone();
                    let preset_id = state.prompt_preset_id.clone();
                    state.clear_context();
                    // clear_context 已经保留了 work_dir 和 preset_id，无需再设置
                    let _ = (work_dir, preset_id); // 显式表明这些值在 clear_context 中已被保留
                }

                Some("✅ AI 上下文已清除（工作目录和预设已保留）".to_string())
            }

            BotCommand::SwitchPreset { preset_id } => {
                match preset_id {
                    Some(raw_id) => {
                        // 解析预设 ID：尝试精确匹配，再尝试前缀匹配
                        let resolved_id = Self::resolve_preset_id(&raw_id);

                        // 验证预设是否存在
                        let mut states = conversation_states.lock().await;
                        let state = states.get_or_create(conversation_id);
                        let work_dir = state.work_dir.clone();
                        let work_dir_path = work_dir.as_deref().unwrap_or(".");

                        let display_name = if Self::validate_preset_exists(&resolved_id, work_dir_path) {
                            state.prompt_preset_id = Some(resolved_id.clone());
                            Self::resolve_preset_display_name(&resolved_id, Some(work_dir_path))
                        } else {
                            // 预设不存在，列出可用的
                            drop(states);
                            let available = Self::get_available_presets(work_dir_path);
                            return Some(format!(
                                "❌ 预设 '{}' 不存在\n\n📋 **可用预设:**\n{}\n\n💡 使用 `/preset list` 查看详情",
                                raw_id,
                                available.iter()
                                    .map(|(id, name)| format!("• `{}` — {}", id, name))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            ));
                        };

                        Some(format!("✅ 已切换到预设: {}", display_name))
                    }
                    None => {
                        // 恢复默认预设
                        let mut states = conversation_states.lock().await;
                        let state = states.get_or_create(conversation_id);
                        state.prompt_preset_id = None;
                        Some("✅ 已恢复默认提示词".to_string())
                    }
                }
            }

            BotCommand::ListPresets => {
                let work_dir = {
                    let states = conversation_states.lock().await;
                    states.get(conversation_id)
                        .and_then(|s| s.work_dir.clone())
                };
                let work_dir_path = work_dir.as_deref().unwrap_or(".");
                let presets = Self::get_available_presets(work_dir_path);

                let mut lines = vec!["📋 **可用提示词预设**\n".to_string()];

                if presets.is_empty() {
                    lines.push("⚠️ 未找到可用预设".to_string());
                } else {
                    for (id, name) in &presets {
                        lines.push(format!("• `{}` — {}", id, name));
                    }
                }

                lines.push("\n💡 使用 `/preset <预设名>` 切换预设".to_string());
                lines.push("💡 使用 `/preset default` 恢复默认".to_string());

                Some(lines.join("\n"))
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

    /// 从工具参数中提取文件名（仅 basename）
    fn extract_file_basename(args: &std::collections::HashMap<String, serde_json::Value>) -> Option<String> {
        for key in &["path", "file_path", "filePath", "filename", "file"] {
            if let Some(val) = args.get(*key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    let name = val.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(val);
                    return Some(name.to_string());
                }
            }
        }
        None
    }

    /// 从工具参数中提取命令
    fn extract_command(args: &std::collections::HashMap<String, serde_json::Value>, max_len: usize) -> Option<String> {
        for key in &["command", "cmd", "command_string"] {
            if let Some(val) = args.get(*key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    return Some(Self::truncate_str(val, max_len));
                }
            }
        }
        None
    }

    /// 从工具参数中提取搜索词
    fn extract_search_query(args: &std::collections::HashMap<String, serde_json::Value>, max_len: usize) -> Option<String> {
        for key in &["query", "q", "search", "keyword", "pattern", "regex"] {
            if let Some(val) = args.get(*key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    return Some(Self::truncate_str(val, max_len));
                }
            }
        }
        None
    }

    /// 从工具参数中提取 URL 简称
    fn extract_url_brief(args: &std::collections::HashMap<String, serde_json::Value>, max_len: usize) -> Option<String> {
        for key in &["url", "uri", "href"] {
            if let Some(val) = args.get(*key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    // 简化显示：取 hostname + 路径前段
                    let simplified = if val.starts_with("http://") || val.starts_with("https://") {
                        let stripped = val.trim_start_matches("https://").trim_start_matches("http://");
                        let path_end = stripped.find('?').unwrap_or(stripped.len());
                        &stripped[..path_end]
                    } else {
                        val
                    };
                    return Some(Self::truncate_str(simplified, max_len));
                }
            }
        }
        None
    }

    /// 安全截断字符串（按字符边界）
    fn truncate_str(s: &str, max_len: usize) -> String {
        if s.chars().count() <= max_len {
            s.to_string()
        } else {
            let truncated: String = s.chars().take(max_len - 3).collect();
            format!("{}...", truncated)
        }
    }

    /// 根据工具名和参数生成简短描述
    ///
    /// 等价于前端 `extractToolKeyInfo()`，根据工具类型从 args 中提取关键信息
    fn format_tool_brief(tool_name: &str, args: &std::collections::HashMap<String, serde_json::Value>) -> String {
        let name_lower = tool_name.to_lowercase();

        // Skill 工具：提取 skill 参数
        if name_lower == "skill" {
            if let Some(val) = args.get("skill").and_then(|v| v.as_str()) {
                let name = val.rsplit(':').next().unwrap_or(val);
                return name.to_string();
            }
        }

        // Task / Agent 工具：提取 prompt 或 description
        if name_lower == "task" || name_lower == "agent" {
            if let Some(val) = args.get("prompt").and_then(|v| v.as_str()) {
                return Self::truncate_str(val, 50);
            }
            if let Some(val) = args.get("description").and_then(|v| v.as_str()) {
                return Self::truncate_str(val, 50);
            }
        }

        // AskUserQuestion：提取问题
        if name_lower == "askuserquestion" {
            if let Some(val) = args.get("header").and_then(|v| v.as_str()) {
                return val.to_string();
            }
            if let Some(questions) = args.get("questions").and_then(|v| v.as_array()) {
                if let Some(first) = questions.first() {
                    if let Some(q) = first.get("question").and_then(|v| v.as_str()) {
                        return Self::truncate_str(q, 50);
                    }
                }
            }
        }

        // Glob 特殊：优先取 pattern
        if tool_name == "Glob" {
            if let Some(val) = args.get("pattern").and_then(|v| v.as_str()) {
                return Self::truncate_str(val, 40);
            }
        }

        // 文件类工具（Read / Write / Edit / Delete）
        if matches!(name_lower.as_str(),
            "read" | "readfile" | "read_file" |
            "write" | "writefile" | "write_file" | "create_file" |
            "edit" | "edit3" | "str_replace_editor" |
            "delete" | "deletefile" | "remove"
        ) {
            if let Some(name) = Self::extract_file_basename(args) {
                return name;
            }
        }

        // Bash / 执行类
        if matches!(name_lower.as_str(), "bash" | "bashcommand" | "run_command" | "execute") {
            if let Some(cmd) = Self::extract_command(args, 40) {
                return cmd;
            }
        }

        // Grep / 搜索类
        if matches!(name_lower.as_str(), "grep" | "search" | "searchfiles" | "websearch" | "web_search") {
            if let Some(q) = Self::extract_search_query(args, 30) {
                return q;
            }
        }

        // 网络请求类
        if matches!(name_lower.as_str(), "webfetch" | "web_fetch" | "httprequest" | "http_request") {
            if let Some(url) = Self::extract_url_brief(args, 30) {
                return url;
            }
        }

        // TodoWrite：提取统计
        if name_lower == "todowrite" {
            if let Some(todos) = args.get("todos").and_then(|v| v.as_array()) {
                let total = todos.len();
                let completed = todos.iter()
                    .filter(|t| t.get("status").and_then(|s| s.as_str()) == Some("completed"))
                    .count();
                return if completed == total && total > 0 {
                    format!("{}个已完成", total)
                } else if completed > 0 {
                    format!("{}/{} ({}%)", completed, total, completed * 100 / total)
                } else {
                    format!("{}个任务", total)
                };
            }
        }

        // 兜底：尝试文件名 → 命令 → 搜索词
        Self::extract_file_basename(args)
            .or_else(|| Self::extract_command(args, 40))
            .or_else(|| Self::extract_search_query(args, 30))
            .unwrap_or_default()
    }

    /// 处理 AI 消息
    async fn process_ai_message(ctx: ProcessAiMessageContext) {
        let ProcessAiMessageContext {
            engine_registry,
            conversation_id,
            message,
            app_handle,
            platform,
            adapters,
            conversation_states,
            active_sessions,
        } = ctx;
        tracing::info!("[IntegrationManager] 🤖 开始 AI 回复: conversation={}, message_len={}", conversation_id, message.len());

        // 获取会话状态（包括已有的 ai_session_id）
        let (engine_id, work_dir, system_prompt, existing_session_id, is_resuming) = {
            let mut states = conversation_states.lock().await;
            let state = states.get_or_create(&conversation_id);

            // 检查是否在 /resume 后自动恢复
            let is_resuming = state.pending_resume && state.ai_session_id.is_some();
            if is_resuming {
                state.pending_resume = false;
            }

            // 构建系统提示词（根据平台名称动态生成）
            let platform_name = match platform {
                Platform::QQBot => "QQ",
                Platform::Feishu => "飞书",
            };
            let default_prompt = format!("你是一个友好的助手，通过 {} 回复用户消息。回复简洁、有帮助。", platform_name);

            // 优先使用预设提示词，其次使用自定义提示词
            let system_prompt = if let Some(ref preset_id) = state.prompt_preset_id {
                let work_dir_path = state.work_dir.clone().unwrap_or_else(|| ".".to_string());
                match Self::build_prompt_from_preset(preset_id, &work_dir_path) {
                    Some(preset_prompt) => {
                        match &state.custom_prompt {
                            Some(custom) => {
                                match state.prompt_mode {
                                    PromptMode::Append => format!("{}\n\n{}", preset_prompt, custom),
                                    PromptMode::Replace => custom.clone(),
                                }
                            }
                            None => preset_prompt,
                        }
                    }
                    None => {
                        match &state.custom_prompt {
                            Some(custom) => {
                                match state.prompt_mode {
                                    PromptMode::Append => format!("{}\n\n{}", default_prompt, custom),
                                    PromptMode::Replace => custom.clone(),
                                }
                            }
                            None => default_prompt,
                        }
                    }
                }
            } else {
                match &state.custom_prompt {
                    Some(custom) => {
                        match state.prompt_mode {
                            PromptMode::Append => format!("{}\n\n{}", default_prompt, custom),
                            PromptMode::Replace => custom.clone(),
                        }
                    }
                    None => default_prompt,
                }
            };

            let session_id = state.ai_session_id.clone();
            let engine_id = state.get_engine_id();

            (
                engine_id,
                state.work_dir.clone(),
                system_prompt,
                session_id,
                is_resuming,
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

        // 发送即时确认消息
        if is_resuming {
            if let Some(ref sid) = existing_session_id {
                let short_id: String = sid.chars().take(8).collect();
                Self::send_reply(&adapters, platform, &conversation_id, &format!("🔄 正在恢复会话 {}...", short_id)).await;
            } else {
                Self::send_reply(&adapters, platform, &conversation_id, "✅ 已接收到消息，正在处理中").await;
            }
        } else {
            Self::send_reply(&adapters, platform, &conversation_id, "✅ 已接收到消息，正在处理中").await;
        }

        // 用于累积最终回复文本（仅 AssistantMessage / Token / Result）
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let accumulated_text_clone = accumulated_text.clone();

        // 进度消息节流：记录上次发送进度消息的时间
        let last_progress_time = Arc::new(std::sync::Mutex::new(
            std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(10))
                .unwrap_or_else(std::time::Instant::now)
        ));
        let last_progress_time_clone = last_progress_time.clone();

        // 创建 oneshot 通道等待进程完成
        let (complete_tx, complete_rx) = oneshot::channel();
        let complete_tx = Arc::new(std::sync::Mutex::new(Some(complete_tx)));

        let conversation_id_for_callback = conversation_id.clone();
        let app_handle_for_callback = app_handle.clone();

        // 进度消息节流间隔（毫秒）
        const PROGRESS_THROTTLE_MS: u64 = 1500;

        // 工具描述缓存：ToolCallStart 时存入，ToolCallEnd 时取出
        let tool_brief_cache: Arc<std::sync::Mutex<std::collections::HashMap<String, String>>> =
            Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let tool_brief_cache_clone = tool_brief_cache.clone();

        // 捕获当前 Tokio runtime handle，因为 callback 可能从非 Tokio 线程调用
        let rt_handle = tokio::runtime::Handle::current();

        // 创建事件回调 —— 按事件类型分条发送
        // 提前 clone adapters 给闭包使用，避免 move 后无法再访问
        let adapters_for_callback = adapters.clone();
        let callback = move |event: crate::models::AIEvent| {
            tracing::debug!("[IntegrationManager] 收到事件: {:?}", std::mem::discriminant(&event));

            match &event {
                // 思考事件：发送思考摘要
                crate::models::AIEvent::Thinking(thinking) => {
                    let text = &thinking.content;
                    if !text.is_empty() {
                        let preview: String = text.chars().take(150).collect();
                        let preview = if preview.len() < text.len() {
                            format!("{}...", preview)
                        } else {
                            preview
                        };
                        let msg = format!("[思考中] {}", preview);
                        let adapters = adapters_for_callback.clone();
                        let conv_id = conversation_id_for_callback.clone();
                        rt_handle.spawn(async move {
                            Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                        });
                    }
                }

                // 工具调用开始：带节流
                crate::models::AIEvent::ToolCallStart(tc) => {
                    let brief = Self::format_tool_brief(&tc.tool, &tc.args);
                    // 缓存描述供 ToolCallEnd 使用
                    if let Some(ref call_id) = tc.call_id {
                        if let Ok(mut cache) = tool_brief_cache_clone.try_lock() {
                            cache.insert(call_id.clone(), brief.clone());
                        }
                    }
                    let msg = if brief.is_empty() {
                        format!("[{}]", tc.tool)
                    } else {
                        format!("[{}] {}", tc.tool, brief)
                    };
                    let should_send = {
                        if let Ok(mut last) = last_progress_time_clone.try_lock() {
                            let now = std::time::Instant::now();
                            if now.duration_since(*last) >= std::time::Duration::from_millis(PROGRESS_THROTTLE_MS) {
                                *last = now;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if should_send {
                        let adapters = adapters_for_callback.clone();
                        let conv_id = conversation_id_for_callback.clone();
                        rt_handle.spawn(async move {
                            Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                        });
                    }
                }

                // 工具调用结束：不受节流限制
                crate::models::AIEvent::ToolCallEnd(tc) => {
                    let status = if tc.success { "完成 ✅" } else { "失败 ❌" };
                    // 从缓存取出描述
                    let brief = tc.call_id.as_ref()
                        .and_then(|id| {
                            tool_brief_cache_clone.try_lock().ok()
                                .and_then(|mut cache| cache.remove(id))
                        })
                        .unwrap_or_default();
                    let msg = if brief.is_empty() {
                        format!("[{}] {}", tc.tool, status)
                    } else {
                        format!("[{}] {} {}", tc.tool, brief, status)
                    };
                    let adapters = adapters_for_callback.clone();
                    let conv_id = conversation_id_for_callback.clone();
                    rt_handle.spawn(async move {
                        Self::send_reply(&adapters, platform, &conv_id, &msg).await;
                    });
                }

                // Progress 事件：忽略（已由 Thinking/ToolCall 覆盖）
                crate::models::AIEvent::Progress(_) => {}

                // 文本类事件：直接发送到平台，不累积
                _ => {
                    if let Some(text) = event.extract_text() {
                        if !text.is_empty() {
                            let preview: String = text.chars().take(100).collect();
                            let preview = if preview.len() < text.len() { format!("{}...", preview) } else { preview };
                            tracing::info!("[IntegrationManager] AI 文本 (len={}): {}", text.len(), preview);

                            // 直接送文本到平台
                            let adapters = adapters_for_callback.clone();
                            let conv_id = conversation_id_for_callback.clone();
                            let text_for_send = text.clone();
                            rt_handle.spawn(async move {
                                Self::send_reply(&adapters, platform, &conv_id, &text_for_send).await;
                            });

                            // 仍然累积文本（用于前端 integration:ai:complete 事件）
                            if let Ok(mut accumulated) = accumulated_text_clone.try_lock() {
                                accumulated.push_str(&text);
                            }

                            // 发送增量更新到前端
                            let _ = app_handle_for_callback.emit("integration:ai:delta", serde_json::json!({
                                "conversationId": conversation_id_for_callback,
                                "text": text,
                                "isDelta": true
                            }));
                        }
                    }
                }
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
            if let Ok(mut states) = conversation_states_for_update.try_lock() {
                states.set_ai_session(&task_conversation_id_for_update, new_session_id);
            }
        });

        // 创建内部任务完成信号，确保 per-conversation 锁覆盖完整 AI 处理周期
        let (inner_done_tx, inner_done_rx) = tokio::sync::oneshot::channel();

        let task = tokio::spawn(async move {
            // 调用 AI 引擎（根据是否已有会话决定创建新会话还是继续会话）
            let session_id_for_response: String;

            if let Some(ref existing_id) = existing_session_id {
                tracing::info!("[IntegrationManager] 🔄 继续已有会话: {}", &existing_id[..8.min(existing_id.len())]);

                let result = {
                    let mut registry = task_engine_registry.lock().await;
                    let mut options = SessionOptions::new(callback)
                        .with_system_prompt(&system_prompt)
                        .with_on_complete(complete_callback);
                    options.on_session_id_update = Some(session_id_update_callback.clone());

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

                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            } else {
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

                        let mut sessions = task_active_sessions.lock().await;
                        sessions.remove(&task_conversation_id);
                        return;
                    }
                }
            }

            // 等待进程完成
            tracing::info!("[IntegrationManager] ⏳ 等待 AI 进程完成...");
            let _ = complete_rx.await;

            // 获取最终回复文本（仅用于前端事件）
            let final_text = accumulated_text.lock().await.clone();
            tracing::info!("[IntegrationManager] 📝 回复文本长度: {}", final_text.len());

            // 发送完整回复事件到前端
            let _ = task_app_handle.emit("integration:ai:complete", serde_json::json!({
                "conversationId": task_conversation_id,
                "sessionId": session_id_for_response,
                "text": final_text
            }));

            // 文本已在回调中实时发送到平台，此处只发送完成通知
            if !final_text.is_empty() {
                let elapsed = start_time.elapsed();
                let complete_msg = format!("✅ 处理完成（⏰ {:.1}s）", elapsed.as_secs_f32());
                Self::send_reply(&task_adapters, platform, &task_conversation_id, &complete_msg).await;
            } else {
                tracing::warn!("[IntegrationManager] ⚠️ AI 返回空文本，不发送回复");
            }

            // 从活跃会话中移除
            let mut sessions = task_active_sessions.lock().await;
            sessions.remove(&task_conversation_id);

            // 通知外部任务已完成
            let _ = inner_done_tx.send(());
        });

        // 记录活跃会话
        {
            let mut sessions = active_sessions.lock().await;
            sessions.insert(conversation_id.clone(), task);
        }

        // 等待内部 AI 处理任务完成，确保 per-conversation 锁覆盖完整 AI 处理周期
        // 这样第二条消息必须等第一条消息的 AI 处理完全结束后才能获取锁
        // 当 /interrupt 中断任务时，inner_done_tx 被 drop，inner_done_rx.await 返回 Err，函数正常退出
        let _ = inner_done_rx.await;
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
        drop(registry);
        tracing::info!("[IntegrationManager] ✅ 实例已添加: {}", id);
        id
    }

    /// 移除实例配置
    pub async fn remove_instance(&self, instance_id: &str) -> Option<PlatformInstance> {
        let mut registry = self.instance_registry.lock().await;
        let removed = registry.remove(instance_id);
        drop(registry);
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
            InstanceConfig::Feishu(config) => {
                tracing::info!("[IntegrationManager] 创建新的 Feishu Adapter: {}", instance.name);
                Box::new(FeishuAdapter::new(config.clone()))
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
        tracing::info!("[IntegrationManager] switch_instance 步骤 7: 建立连接");
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
        tracing::info!("[IntegrationManager] switch_instance 步骤 8: 启动消息处理任务");
        self.start_message_processing_task(platform);

        // 实例切换完成

        tracing::info!("[IntegrationManager] ✅ 实例切换成功: {}", instance.name);
        Ok(())
    }

    /// 启动消息处理任务
    fn start_message_processing_task(&mut self, _platform: Platform) {
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
        let conversation_queues = self.conversation_queues.clone();
        let instance_registry = self.instance_registry.clone();

        if let (Some(rx), Some(app_handle)) = (rx, app_handle) {
            tracing::info!("[IntegrationManager] 🚀 启动消息处理任务");

            let task = tokio::spawn(async move {
                tracing::info!("[IntegrationManager] 📨 消息处理任务已启动，等待消息...");
                let mut rx = rx;

                while let Some(msg) = rx.recv().await {
                    // 使用消息自身携带的 platform，而不是启动时的 platform
                    let msg_platform = msg.platform;
                    let conv_id = msg.conversation_id.clone();

                    tracing::info!(
                        "[IntegrationManager] 📩 收到消息: id={}, platform={}, conversation={}",
                        msg.id,
                        msg_platform,
                        conv_id
                    );

                    // 发送到前端（同步 emit，不阻塞）
                    if let Err(e) = app_handle.emit("integration:message", &msg) {
                        tracing::error!("[IntegrationManager] ❌ 发送消息到前端失败: {}", e);
                    } else {
                        tracing::info!("[IntegrationManager] ✅ 消息已发送到前端");
                    }

                    // 获取或创建 per-conversation 串行锁
                    let conv_lock = {
                        let mut queues = conversation_queues.lock().await;
                        queues.entry(conv_id.clone()).or_default().clone()
                    };

                    // clone 所有 Arc 引用给 spawned 任务使用
                    let task_app_handle = app_handle.clone();
                    let task_adapters = adapters.clone();
                    let task_engine_registry = engine_registry.clone();
                    let task_conversation_states = conversation_states.clone();
                    let task_active_sessions = active_sessions.clone();
                    let task_conversation_queues = conversation_queues.clone();
                    let task_instance_registry = instance_registry.clone();

                    // spawn 处理任务：同一会话串行，不同会话并行
                    tokio::spawn(async move {
                        // 等待同一会话的前一条消息处理完成
                        let _guard = conv_lock.lock().await;

                        Self::handle_message(
                            msg,
                            task_app_handle,
                            msg_platform,
                            task_adapters,
                            task_engine_registry,
                            task_conversation_states,
                            task_active_sessions,
                            task_instance_registry,
                        ).await;

                        // 尝试清理空闲的队列条目，避免内存泄漏
                        {
                            let mut queues = task_conversation_queues.lock().await;
                            if let Some(lock) = queues.get(&conv_id) {
                                // strong_count == 2 表示只有 queues map 和当前引用持有
                                // （没有其他任务在等锁）
                                if Arc::strong_count(lock) <= 2 {
                                    queues.remove(&conv_id);
                                }
                            }
                        }
                    });
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

    /// 解析用户输入的预设 ID
    /// 支持 "minimal" → "preset-minimal" 的简写映射
    fn resolve_preset_id(raw_id: &str) -> String {
        let lower = raw_id.to_lowercase();

        // 常见简写映射
        let shorthand_map = [
            ("default", "preset-default"),
            ("minimal", "preset-minimal"),
            ("full", "preset-full"),
        ];
        for (shorthand, full_id) in &shorthand_map {
            if lower == *shorthand {
                return full_id.to_string();
            }
        }

        // 如果已经以 "preset-" 开头，直接使用
        if lower.starts_with("preset-") {
            return lower;
        }

        // 最后尝试加 "preset-" 前缀
        format!("preset-{}", lower)
    }

    /// 验证预设是否存在
    fn validate_preset_exists(preset_id: &str, work_dir: &str) -> bool {
        use std::path::Path;
        let work_path = Path::new(work_dir);

        match PromptStore::from_work_dir(work_path) {
            Ok(store) => store.get_preset(preset_id).is_some(),
            Err(_) => {
                // PromptStore 不可用时，接受系统预设
                matches!(preset_id, "preset-default" | "preset-minimal" | "preset-full")
            }
        }
    }

    /// 获取可用的预设列表 (id, name)
    fn get_available_presets(work_dir: &str) -> Vec<(String, String)> {
        use std::path::Path;
        let work_path = Path::new(work_dir);

        match PromptStore::from_work_dir(work_path) {
            Ok(store) => {
                store.get_presets()
                    .iter()
                    .map(|p| (p.id.clone(), p.name.clone()))
                    .collect()
            }
            Err(_) => {
                // PromptStore 不可用时，返回默认预设列表
                vec![
                    ("preset-default".to_string(), "默认预设".to_string()),
                    ("preset-minimal".to_string(), "精简预设".to_string()),
                    ("preset-full".to_string(), "完整预设".to_string()),
                ]
            }
        }
    }

    /// 获取预设的显示名称
    fn resolve_preset_display_name(preset_id: &str, work_dir: Option<&str>) -> String {
        let work_dir_str = work_dir.unwrap_or(".");
        use std::path::Path;
        let work_path = Path::new(work_dir_str);

        if let Ok(store) = PromptStore::from_work_dir(work_path) {
            if let Some(preset) = store.get_preset(preset_id) {
                return format!("{} ({})", preset.name, preset_id);
            }
        }

        // 降级：使用 ID 映射
        match preset_id {
            "preset-default" => "默认预设 (preset-default)".to_string(),
            "preset-minimal" => "精简预设 (preset-minimal)".to_string(),
            "preset-full" => "完整预设 (preset-full)".to_string(),
            other => other.to_string(),
        }
    }

    /// 从预设构建提示词（内部已做 ID 解析）
    fn build_prompt_from_preset(preset_id: &str, work_dir: &str) -> Option<String> {
        use std::path::Path;

        // 先尝试解析 ID（兼容简写）
        let resolved_id = Self::resolve_preset_id(preset_id);

        let work_path = Path::new(work_dir);
        match PromptStore::from_work_dir(work_path) {
            Ok(store) => {
                // 用解析后的 ID 查找预设，降级用原始 ID
                let lookup_id = if store.get_preset(&resolved_id).is_some() {
                    &resolved_id
                } else if store.get_preset(preset_id).is_some() {
                    preset_id
                } else {
                    tracing::warn!("[IntegrationManager] 预设不存在: {} (尝试 {})", preset_id, resolved_id);
                    return None;
                };

                // 构建变量表
                let mut variables = std::collections::HashMap::new();
                variables.insert("workspace_path".to_string(), work_dir.to_string());
                variables.insert("workspace_name".to_string(),
                    work_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("workspace")
                        .to_string()
                );

                // 构建提示词
                let prompt = store.build_prompt(lookup_id, &variables);
                tracing::info!("[IntegrationManager] 📝 从预设 '{}' 构建提示词, 长度: {}", lookup_id, prompt.len());
                Some(prompt)
            }
            Err(e) => {
                tracing::warn!("[IntegrationManager] 无法加载提示词配置: {:?}", e);
                None
            }
        }
    }
}

impl Default for IntegrationManager {
    fn default() -> Self {
        Self::new()
    }
}
