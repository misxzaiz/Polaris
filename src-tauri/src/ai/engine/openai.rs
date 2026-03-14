/**
 * OpenAI 兼容 API 引擎实现
 *
 * 支持 OpenAI 兼容的 API（如 DeepSeek、Moonshot 等）
 * 支持多 Provider 配置
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use crate::models::config::OpenAIProvider;

/// OpenAI Provider 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIProviderConfig {
    pub provider_id: String,
    pub provider_name: String,
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub supports_tools: bool,
}

fn default_max_tokens() -> u32 {
    4096
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionCall,
}

/// 函数调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// OpenAI Chat 请求
#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

/// OpenAI 流式响应
#[derive(Debug, Clone, Deserialize)]
pub struct StreamResponse {
    pub id: Option<String>,
    pub choices: Vec<StreamChoice>,
}

/// 流式选择项
#[derive(Debug, Clone, Deserialize)]
pub struct StreamChoice {
    pub index: u32,
    pub delta: Delta,
    pub finish_reason: Option<String>,
}

/// 增量内容
#[derive(Debug, Clone, Deserialize)]
pub struct Delta {
    pub role: Option<String>,
    pub content: Option<String>,
}

/// OpenAI 兼容引擎
///
/// 支持多 Provider 配置，通过 provider_id 区分不同配置
pub struct OpenAIEngine {
    /// Provider ID（标识这是哪个 Provider 的引擎）
    provider_id: Option<String>,
    /// 配置（单个 Provider 配置）
    config: Option<OpenAIProviderConfig>,
    /// 多 Provider 配置映射（provider_id -> config）
    providers: Arc<Mutex<HashMap<String, OpenAIProviderConfig>>>,
    /// 激活的 Provider ID
    active_provider_id: Arc<Mutex<Option<String>>>,
    /// HTTP 客户端
    client: Client,
    /// 会话管理器
    sessions: SessionManager,
    /// 取消令牌映射
    cancel_tokens: HashMap<String, CancellationToken>,
}

impl OpenAIEngine {
    /// 创建新的 OpenAI 引擎（使用共享配置）
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            provider_id: None,
            config: None,
            providers: Arc::new(Mutex::new(HashMap::new())),
            active_provider_id: Arc::new(Mutex::new(None)),
            client,
            sessions: SessionManager::new(),
            cancel_tokens: HashMap::new(),
        }
    }

    /// 创建指定 Provider ID 的引擎实例
    pub fn with_provider_id(provider_id: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            provider_id: Some(provider_id),
            config: None,
            providers: Arc::new(Mutex::new(HashMap::new())),
            active_provider_id: Arc::new(Mutex::new(None)),
            client,
            sessions: SessionManager::new(),
            cancel_tokens: HashMap::new(),
        }
    }

    /// 使用配置创建引擎
    pub fn with_config(config: OpenAIProviderConfig) -> Self {
        let provider_id = config.provider_id.clone();
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            provider_id: Some(provider_id.clone()),
            config: Some(config),
            providers: Arc::new(Mutex::new(HashMap::new())),
            active_provider_id: Arc::new(Mutex::new(Some(provider_id))),
            client,
            sessions: SessionManager::new(),
            cancel_tokens: HashMap::new(),
        }
    }

    /// 设置多个 Provider 配置
    pub fn set_providers(&mut self, providers: Vec<OpenAIProvider>, active_id: Option<String>) {
        let mut map = self.providers.lock().unwrap();
        map.clear();
        for p in providers {
            map.insert(p.id.clone(), Self::provider_to_config(p));
        }
        *self.active_provider_id.lock().unwrap() = active_id;
    }

    /// 更新单个配置
    pub fn set_config(&mut self, config: OpenAIProviderConfig) {
        self.provider_id = Some(config.provider_id.clone());
        self.config = Some(config);
    }

    /// 设置激活的 Provider ID
    pub fn set_active_provider(&mut self, provider_id: Option<String>) {
        *self.active_provider_id.lock().unwrap() = provider_id;
    }

    /// 将 OpenAIProvider 转换为 OpenAIProviderConfig
    fn provider_to_config(p: OpenAIProvider) -> OpenAIProviderConfig {
        OpenAIProviderConfig {
            provider_id: p.id,
            provider_name: p.name,
            api_key: p.api_key,
            api_base: p.api_base,
            model: p.model,
            temperature: p.temperature as f32,
            max_tokens: p.max_tokens as u32,
            supports_tools: p.supports_tools,
        }
    }

    /// 根据 provider_id 或 name 获取配置
    ///
    /// 匹配规则（不区分大小写）：
    /// 1. 精确匹配 id 字段
    /// 2. 精确匹配 name 字段
    /// 3. 模糊匹配：id 或 name 包含用户输入
    fn get_config_for_provider(&self, provider_id: Option<&str>) -> Option<OpenAIProviderConfig> {
        // 1. 如果有指定的 provider_id
        if let Some(id) = provider_id {
            let id_lower = id.to_lowercase();

            // 先检查本地配置
            if let Some(ref config) = self.config {
                // 精确匹配 id
                if config.provider_id.to_lowercase() == id_lower {
                    return Some(config.clone());
                }
                // 精确匹配 name
                if config.provider_name.to_lowercase() == id_lower {
                    return Some(config.clone());
                }
                // 模糊匹配 id
                if config.provider_id.to_lowercase().contains(&id_lower) {
                    return Some(config.clone());
                }
                // 模糊匹配 name
                if config.provider_name.to_lowercase().contains(&id_lower) {
                    return Some(config.clone());
                }
            }

            // 检查共享配置
            let providers = self.providers.lock().unwrap();

            // 精确匹配 id
            if let Some(config) = providers.get(id) {
                return Some(config.clone());
            }

            // 遍历所有 provider，匹配 id 或 name
            for (pid, config) in providers.iter() {
                // 精确匹配 name
                if config.provider_name.to_lowercase() == id_lower {
                    return Some(config.clone());
                }
                // 模糊匹配 id
                if pid.to_lowercase().contains(&id_lower) {
                    return Some(config.clone());
                }
                // 模糊匹配 name
                if config.provider_name.to_lowercase().contains(&id_lower) {
                    return Some(config.clone());
                }
            }

            return None;
        }

        // 2. 使用本地配置
        if let Some(ref config) = self.config {
            return Some(config.clone());
        }

        // 3. 使用激活的 Provider
        let active_id = self.active_provider_id.lock().unwrap();
        if let Some(ref id) = *active_id {
            let providers = self.providers.lock().unwrap();
            return providers.get(id).cloned();
        }

        None
    }

    /// 解析 SSE 行
    fn parse_sse_line(&self, line: &str) -> Option<StreamResponse> {
        let line = line.trim();
        if line.is_empty() || !line.starts_with("data:") {
            return None;
        }

        let data = line.strip_prefix("data:")?.trim();
        if data == "[DONE]" {
            return None;
        }

        serde_json::from_str(data).ok()
    }

    /// 执行聊天请求（异步）
    async fn execute_chat(
        &mut self,
        messages: Vec<ChatMessage>,
        options: SessionOptions,
        session_id: String,
        provider_id: Option<String>,
    ) -> Result<()> {
        let config = self.get_config_for_provider(provider_id.as_deref())
            .ok_or_else(|| AppError::ValidationError("OpenAI 配置未设置".to_string()))?;

        let cancel_token = CancellationToken::new();
        self.cancel_tokens.insert(session_id.clone(), cancel_token.clone());

        let client = self.client.clone();
        let event_callback = options.event_callback.clone();

        // 构建请求
        let request = ChatRequest {
            model: config.model.clone(),
            messages,
            temperature: Some(config.temperature),
            max_tokens: Some(config.max_tokens),
            stream: Some(true),
        };

        tracing::info!("[OpenAIEngine] 发送请求到 {} (provider: {})", config.api_base, config.provider_id);

        // 发送请求
        let response = client
            .post(format!("{}/chat/completions", config.api_base.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| AppError::NetworkError(format!("API 请求失败: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::NetworkError(format!("API 错误 ({}): {}", status, body)));
        }

        // 使用字节流处理 SSE
        use futures_util::StreamExt;

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            // 检查取消
            if cancel_token.is_cancelled() {
                tracing::info!("[OpenAIEngine] 会话已取消: {}", session_id);
                break;
            }

            let chunk = chunk.map_err(|e| AppError::NetworkError(format!("读取流失败: {}", e)))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // 处理完整的行
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if let Some(response) = self.parse_sse_line(&line) {
                    for choice in response.choices {
                        if let Some(content) = &choice.delta.content {
                            event_callback(AIEvent::assistant_message(content, true));
                        }

                        // 检查完成
                        if choice.finish_reason.is_some() {
                            event_callback(AIEvent::session_end(&session_id));
                        }
                    }
                }
            }
        }

        // 清理
        self.cancel_tokens.remove(&session_id);

        Ok(())
    }
}

impl AIEngine for OpenAIEngine {
    fn id(&self) -> EngineId {
        EngineId::OpenAI {
            provider_id: self.provider_id.clone(),
        }
    }

    fn name(&self) -> &'static str {
        "OpenAI"
    }

    fn description(&self) -> &'static str {
        "OpenAI 兼容 API 引擎"
    }

    fn is_available(&self) -> bool {
        // 检查是否有可用的配置
        self.config.is_some() || !self.providers.lock().unwrap().is_empty()
    }

    fn unavailable_reason(&self) -> Option<String> {
        if self.config.is_none() && self.providers.lock().unwrap().is_empty() {
            Some("未配置 OpenAI Provider".to_string())
        } else {
            None
        }
    }

    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        // 优先使用传入的 provider_id，否则使用引擎默认的
        let provider_id = options.openai_provider_id.clone()
            .or_else(|| self.provider_id.clone());

        tracing::info!("[OpenAIEngine] 启动会话 (provider: {:?})", provider_id);

        // 检查配置
        if self.get_config_for_provider(provider_id.as_deref()).is_none() {
            return Err(AppError::ValidationError("OpenAI 配置未设置".to_string()));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        // 注册会话
        self.sessions.register(
            session_id.clone(),
            0, // OpenAI 没有 PID
            "openai".to_string(),
        )?;

        // 构建消息
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: Some(message.to_string()),
            tool_calls: None,
            tool_call_id: None,
        }];

        // 克隆必要的数据用于异步任务
        let mut engine_clone = OpenAIEngine {
            provider_id: provider_id.clone(),
            config: self.config.clone(),
            providers: self.providers.clone(),
            active_provider_id: self.active_provider_id.clone(),
            client: self.client.clone(),
            sessions: SessionManager::new(),
            cancel_tokens: HashMap::new(),
        };

        let sid = session_id.clone();

        // 在异步运行时中执行
        tokio::spawn(async move {
            if let Err(e) = engine_clone.execute_chat(messages, options, sid.clone(), provider_id).await {
                tracing::error!("[OpenAIEngine] 执行失败: {}", e);
            }
        });

        Ok(session_id)
    }

    fn continue_session(
        &mut self,
        _session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        // 优先使用传入的 provider_id，否则使用引擎默认的
        let provider_id = options.openai_provider_id.clone()
            .or_else(|| self.provider_id.clone());

        tracing::info!("[OpenAIEngine] 继续会话 (provider: {:?}, history_len: {})",
            provider_id, options.message_history.len());

        // 检查配置
        if self.get_config_for_provider(provider_id.as_deref()).is_none() {
            return Err(AppError::ValidationError("OpenAI 配置未设置".to_string()));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        // 注册会话
        self.sessions.register(
            session_id.clone(),
            0,
            "openai".to_string(),
        )?;

        // 构建消息：历史 + 新消息
        let mut messages: Vec<ChatMessage> = options.message_history
            .iter()
            .map(|h| ChatMessage {
                role: h.role.clone(),
                content: Some(h.content.clone()),
                tool_calls: None,
                tool_call_id: None,
            })
            .collect();

        // 添加新消息
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: Some(message.to_string()),
            tool_calls: None,
            tool_call_id: None,
        });

        // 克隆必要的数据用于异步任务
        let mut engine_clone = OpenAIEngine {
            provider_id: provider_id.clone(),
            config: self.config.clone(),
            providers: self.providers.clone(),
            active_provider_id: self.active_provider_id.clone(),
            client: self.client.clone(),
            sessions: SessionManager::new(),
            cancel_tokens: HashMap::new(),
        };

        let sid = session_id.clone();

        // 在异步运行时中执行
        tokio::spawn(async move {
            if let Err(e) = engine_clone.execute_chat(messages, options, sid.clone(), provider_id).await {
                tracing::error!("[OpenAIEngine] 继续会话执行失败: {}", e);
            }
        });

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[OpenAIEngine] 中断会话: {}", session_id);

        if let Some(token) = self.cancel_tokens.remove(session_id) {
            token.cancel();
            tracing::info!("[OpenAIEngine] 会话已取消: {}", session_id);
        }

        self.sessions.remove(session_id);
        Ok(())
    }

    fn active_session_count(&self) -> usize {
        self.cancel_tokens.len()
    }
}

impl Default for OpenAIEngine {
    fn default() -> Self {
        Self::new()
    }
}
