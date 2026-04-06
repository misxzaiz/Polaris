/*! ClawCode 引擎实现
 *
 * 使用 claw-code 适配层实现的 AI 引擎。
 * 基于 OpenAiCompatClient 和 convert.rs 转换层。
 * 支持工具调用和工具执行器集成。
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::ai::adapters::{
    history_entries_to_input_messages, InputContentBlock, InputMessage, MessageRequest,
    OpenAiCompatClient, OpenAiCompatConfig, OutputContentBlock, ToolChoice,
};
use crate::ai::session::SessionManager;
use crate::ai::tools::executor::PolarisToolExecutor;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::AIEvent;

/// 默认系统提示词（告知模型工具可用）
const DEFAULT_SYSTEM_PROMPT_WITH_TOOLS: &str = "你是一个 AI 助手，可以使用工具来完成任务。

你有以下工具可用：
- read_file: 读取文件内容
- write_file: 写入文件内容
- edit_file: 编辑文件内容（字符串替换）
- glob_search: 使用 Glob 模式搜索文件
- grep_search: 使用正则表达式搜索文件内容

当用户请求涉及文件操作时，请主动使用相应工具。调用工具时，确保参数正确且路径在工作目录范围内。";

/// 默认系统提示词（无工具）
const DEFAULT_SYSTEM_PROMPT_NO_TOOLS: &str = "你是一个 AI 助手，请根据用户请求提供帮助。";

/// 工具调用状态
///
/// 用于跟踪流式响应中的工具调用进度。
#[derive(Debug, Clone)]
pub enum ToolCallState {
    /// 空闲（无工具调用）
    Idle,
    /// 收集工具参数（正在接收 delta）
    CollectingInput {
        /// 工具调用 ID
        tool_id: String,
        /// 工具名称
        tool_name: String,
        /// 已收集的 JSON 输入
        input_json: String,
    },
    /// 参数收集完成，等待执行
    ReadyToExecute {
        /// 工具调用 ID
        tool_id: String,
        /// 工具名称
        tool_name: String,
        /// 解析后的输入参数
        input: serde_json::Value,
    },
    /// 执行中
    Executing {
        /// 工具调用 ID
        tool_id: String,
        /// 工具名称
        tool_name: String,
    },
}

/// ClawCode 引擎配置
#[derive(Clone)]
pub struct ClawCodeConfig {
    /// Provider 名称（用于日志）
    pub provider_name: String,
    /// API Key
    pub api_key: String,
    /// API Base URL
    pub base_url: String,
    /// 模型名称
    pub model: String,
    /// 最大输出 token 数
    pub max_tokens: u32,
    /// 温度参数
    pub temperature: f32,
    /// 工具执行器（可选）
    pub tool_executor: Option<Arc<dyn PolarisToolExecutor>>,
    /// 启用工具调用（默认 false）
    pub enable_tools: bool,
    /// 工具选择策略（默认 Auto）
    pub tool_choice: Option<ToolChoice>,
}

impl std::fmt::Debug for ClawCodeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClawCodeConfig")
            .field("provider_name", &self.provider_name)
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("temperature", &self.temperature)
            .field("tool_executor", &self.tool_executor.as_ref().map(|_| "PolarisToolExecutor"))
            .field("enable_tools", &self.enable_tools)
            .field("tool_choice", &self.tool_choice)
            .finish()
    }
}

impl Default for ClawCodeConfig {
    fn default() -> Self {
        Self {
            provider_name: "ClawCode".to_string(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            max_tokens: 4096,
            temperature: 0.7,
            tool_executor: None,
            enable_tools: false,
            tool_choice: None,
        }
    }
}

impl ClawCodeConfig {
    /// 创建配置
    pub fn new(
        provider_name: impl Into<String>,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            provider_name: provider_name.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            model: model.into(),
            ..Default::default()
        }
    }

    /// 设置最大 token 数
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    /// 设置温度
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = temperature;
        self
    }

    /// 配置工具执行器
    ///
    /// 设置工具执行器后，自动启用工具调用。
    pub fn with_tool_executor(mut self, executor: Arc<dyn PolarisToolExecutor>) -> Self {
        self.tool_executor = Some(executor);
        self.enable_tools = true;
        self
    }

    /// 设置工具选择策略
    pub fn with_tool_choice(mut self, choice: ToolChoice) -> Self {
        self.tool_choice = Some(choice);
        self
    }

    /// 启用工具调用
    pub fn enable_tools(mut self, enable: bool) -> Self {
        self.enable_tools = enable;
        self
    }

    /// 转换为 OpenAiCompatConfig
    fn to_compat_config(&self) -> OpenAiCompatConfig {
        OpenAiCompatConfig::custom(
            &self.provider_name,
            &self.api_key,
            &self.base_url,
            &self.model,
        )
        .with_max_tokens(self.max_tokens)
        .with_temperature(self.temperature)
    }
}

/// ClawCode 引擎
///
/// 使用 claw-code 适配层实现的 AI 引擎，
/// 支持 OpenAI 兼容 API 和流式响应。
pub struct ClawCodeEngine {
    /// 引擎配置
    config: Option<ClawCodeConfig>,
    /// OpenAI 兼容客户端
    client: Option<OpenAiCompatClient>,
    /// 会话管理器
    sessions: SessionManager,
    /// 取消令牌映射（使用 Arc<Mutex> 实现跨异步任务共享）
    cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

/// 收集的助手消息内容
///
/// 用于构建包含工具调用的 assistant 消息。
#[derive(Debug, Clone, Default)]
struct AssistantContent {
    /// 文本内容
    text: String,
    /// 工具调用列表
    tool_calls: Vec<ToolCallInfo>,
    /// 思考内容
    thinking: String,
}

/// 工具调用信息
#[derive(Debug, Clone)]
struct ToolCallInfo {
    /// 工具调用 ID
    id: String,
    /// 工具名称
    name: String,
    /// 输入参数
    input: serde_json::Value,
}

/// 工具执行结果
#[derive(Debug, Clone)]
struct ToolResult {
    /// 工具调用 ID
    tool_id: String,
    /// 工具名称
    tool_name: String,
    /// 执行结果
    result: String,
    /// 是否错误
    is_error: bool,
}

impl ClawCodeEngine {
    /// 创建新的 ClawCode 引擎
    pub fn new() -> Self {
        Self {
            config: None,
            client: None,
            sessions: SessionManager::new(),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 使用配置创建引擎
    pub fn with_config(config: ClawCodeConfig) -> Self {
        let compat_config = config.to_compat_config();
        let client = OpenAiCompatClient::new(compat_config);

        Self {
            config: Some(config),
            client: Some(client),
            sessions: SessionManager::new(),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 设置配置
    pub fn set_config(&mut self, config: ClawCodeConfig) {
        let compat_config = config.to_compat_config();
        self.client = Some(OpenAiCompatClient::new(compat_config));
        self.config = Some(config);
    }

    /// 处理流事件，更新工具调用状态
    ///
    /// 返回：
    /// - ai_event: 发送给用户的事件（如果有）
    /// - new_state: 新的工具调用状态（如果有变化）
    #[allow(dead_code)]
    fn handle_stream_event(
        &self,
        event: &crate::ai::adapters::StreamEvent,
        session_id: &str,
        current_state: &ToolCallState,
    ) -> (Option<AIEvent>, Option<ToolCallState>) {
        use crate::ai::adapters::{ContentBlockDelta, OutputContentBlock, StreamEvent};

        match event {
            // 内容块开始 - 可能是工具调用开始
            StreamEvent::ContentBlockStart(e) => {
                match &e.content_block {
                    OutputContentBlock::ToolUse { id, name, input } => {
                        // 工具调用开始：初始化收集状态
                        let initial_json = if input.is_object() {
                            serde_json::to_string(input).unwrap_or_default()
                        } else {
                            String::new()
                        };

                        let new_state = ToolCallState::CollectingInput {
                            tool_id: id.clone(),
                            tool_name: name.clone(),
                            input_json: initial_json,
                        };

                        // 发送 ToolCallStart 事件给用户
                        let args = input.as_object()
                            .map(|obj| obj.iter()
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect())
                            .unwrap_or_default();

                        let ai_event = AIEvent::ToolCallStart(
                            crate::models::ToolCallStartEvent::new(session_id, name.clone(), args)
                                .with_call_id(id.clone())
                        );

                        (Some(ai_event), Some(new_state))
                    }
                    OutputContentBlock::Text { .. } => (None, None),
                    OutputContentBlock::Thinking { .. } => (None, None),
                    OutputContentBlock::RedactedThinking { .. } => (None, None),
                }
            }

            // 内容块增量 - 文本、工具输入 JSON、思考内容
            StreamEvent::ContentBlockDelta(e) => {
                match &e.delta {
                    ContentBlockDelta::TextDelta { text } => {
                        (Some(AIEvent::token(session_id, text.clone())), None)
                    }
                    ContentBlockDelta::InputJsonDelta { partial_json } => {
                        match current_state {
                            ToolCallState::CollectingInput { tool_id, tool_name, input_json } => {
                                let new_json = format!("{}{}", input_json, partial_json);
                                let new_state = ToolCallState::CollectingInput {
                                    tool_id: tool_id.clone(),
                                    tool_name: tool_name.clone(),
                                    input_json: new_json,
                                };
                                (None, Some(new_state))
                            }
                            _ => (None, None)
                        }
                    }
                    ContentBlockDelta::ThinkingDelta { thinking } => {
                        (Some(AIEvent::Thinking(crate::models::ThinkingEvent::new(session_id, thinking.clone()))), None)
                    }
                    ContentBlockDelta::SignatureDelta { .. } => (None, None),
                }
            }

            // 内容块结束 - 工具调用参数收集完成
            StreamEvent::ContentBlockStop(_) => {
                match current_state {
                    ToolCallState::CollectingInput { tool_id, tool_name, input_json } => {
                        let input: serde_json::Value = serde_json::from_str(input_json)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

                        let new_state = ToolCallState::ReadyToExecute {
                            tool_id: tool_id.clone(),
                            tool_name: tool_name.clone(),
                            input,
                        };

                        (None, Some(new_state))
                    }
                    _ => (None, None)
                }
            }

            StreamEvent::MessageStart(_) => (None, None),
            StreamEvent::MessageDelta(_) => (None, None),
            StreamEvent::MessageStop(_) => {
                (Some(AIEvent::session_end(session_id)), Some(ToolCallState::Idle))
            }
        }
    }

    /// 执行工具调用
    ///
    /// 从 ReadyToExecute 状态获取工具信息，执行工具，返回结果。
    /// 同时发送 ToolCallEnd 事件给用户。
    async fn execute_tool(
        config: &ClawCodeConfig,
        state: &ToolCallState,
        session_id: &str,
        event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) -> Option<(String, String, String, bool)> {
        // 检查状态是否为 ReadyToExecute
        let (tool_id, tool_name, input) = match state {
            ToolCallState::ReadyToExecute { tool_id, tool_name, input } => {
                (tool_id.clone(), tool_name.clone(), input.clone())
            }
            _ => return None,
        };

        // 获取工具执行器
        let executor = config.tool_executor.as_ref()?;

        tracing::info!(
            "[ClawCodeEngine] 执行工具: {} (id: {}, session: {})",
            tool_name, tool_id, session_id
        );

        // 执行工具
        let result = executor.execute(&tool_name, &input).await;

        // 处理执行结果
        let (result_str, is_error) = match result {
            Ok(output) => {
                tracing::info!("[ClawCodeEngine] 工具执行成功: {} -> {}", tool_name, output);
                (output, false)
            }
            Err(e) => {
                tracing::error!("[ClawCodeEngine] 工具执行失败: {} -> {}", tool_name, e);
                (e.to_string(), true)
            }
        };

        // 发送 ToolCallEnd 事件
        let result_value = serde_json::Value::String(result_str.clone());
        event_callback(AIEvent::ToolCallEnd(
            crate::models::ToolCallEndEvent::new(session_id, tool_name.clone(), !is_error)
                .with_result(result_value)
                .with_call_id(tool_id.clone())
        ));

        Some((tool_id, tool_name, result_str, is_error))
    }


    /// 构建消息请求
    fn build_request(
        &self,
        messages: Vec<InputMessage>,
        system_prompt: Option<&str>,
    ) -> MessageRequest {
        let config = match &self.config {
            Some(c) => c,
            None => {
                return MessageRequest {
                    model: String::new(),
                    max_tokens: 4096,
                    messages,
                    system: system_prompt.map(|s| s.to_string()),
                    tools: None,
                    tool_choice: None,
                    stream: true,
                };
            }
        };

        // 获取工具定义（如果启用）
        tracing::debug!(
            "[ClawCodeEngine] build_request: enable_tools={}, tool_executor={:?}",
            config.enable_tools,
            config.tool_executor.as_ref().map(|_| "Some(executor)")
        );
        let tools = if config.enable_tools {
            config.tool_executor.as_ref()
                .map(|e| e.available_tools())
        } else {
            None
        };

        tracing::debug!(
            "[ClawCodeEngine] build_request: tools_count={:?}",
            tools.as_ref().map(|t| t.len())
        );

        // 设置工具选择策略
        let tool_choice = if config.enable_tools {
            config.tool_choice.clone()
                .or(Some(ToolChoice::Auto))
        } else {
            None
        };

        // 构建系统提示词（如果启用工具，添加默认提示）
        let final_system_prompt = if tools.is_some() {
            match system_prompt {
                Some(prompt) if !prompt.is_empty() => {
                    Some(format!("{}\n\n{}", DEFAULT_SYSTEM_PROMPT_WITH_TOOLS, prompt))
                }
                _ => Some(DEFAULT_SYSTEM_PROMPT_WITH_TOOLS.to_string()),
            }
        } else {
            match system_prompt {
                Some(prompt) if !prompt.is_empty() => Some(prompt.to_string()),
                _ => Some(DEFAULT_SYSTEM_PROMPT_NO_TOOLS.to_string()),
            }
        };

        MessageRequest {
            model: config.model.clone(),
            max_tokens: config.max_tokens,
            messages,
            system: final_system_prompt,
            tools,
            tool_choice,
            stream: true,
        }
    }

    /// 执行流式聊天请求
    ///
    /// 支持工具调用循环：
    /// 1. 接收流式响应
    /// 2. 检测工具调用并执行
    /// 3. 发送工具结果继续对话
    /// 4. 循环直到没有更多工具调用
    async fn execute_stream_chat(
        &mut self,
        messages: Vec<InputMessage>,
        options: SessionOptions,
        session_id: String,
    ) -> Result<()> {
        let client = self.client.as_ref()
            .ok_or_else(|| AppError::ValidationError("ClawCode 配置未设置".to_string()))?;

        let cancel_token = CancellationToken::new();
        {
            let mut tokens = self.cancel_tokens.lock()
                .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
            tokens.insert(session_id.clone(), cancel_token.clone());
        }

        let event_callback = options.event_callback.clone();

        // 发送 session_start 事件，让前端知道会话已开始
        // 这是中断功能正常工作的关键：前端需要这个事件来更新 conversationId
        event_callback(AIEvent::session_start(&session_id));
        tracing::info!("[ClawCodeEngine] 已发送 session_start 事件: {}", session_id);

        // 同时调用 on_session_id_update 回调（如果存在）
        if let Some(ref cb) = options.on_session_id_update {
            cb(session_id.clone());
        }

        // 当前消息列表（会在循环中更新）
        let mut current_messages = messages;

        // 工具调用循环
        loop {
            if cancel_token.is_cancelled() {
                tracing::info!("[ClawCodeEngine] 会话已取消: {}", session_id);
                break;
            }

            // 构建请求
            let request = self.build_request(current_messages.clone(), options.system_prompt.as_deref());

            tracing::info!("[ClawCodeEngine] 开始流式请求 (session: {}, msg_count: {})", session_id, current_messages.len());

            // 发送流式请求
            let mut stream = client.stream_message(&request).await?;

            // 当前工具调用状态
            let mut tool_state = ToolCallState::Idle;
            // 收集的助手内容
            let mut assistant_content = AssistantContent::default();
            // 收集的工具执行结果
            let mut tool_results: Vec<ToolResult> = Vec::new();

            // 处理流事件
            while !cancel_token.is_cancelled() {
                match stream.next_event().await {
                    Ok(Some(event)) => {
                        // 处理事件并更新状态
                        let (ai_event, new_state) = self.handle_stream_event(&event, &session_id, &tool_state);

                        // 发送事件给用户
                        if let Some(evt) = ai_event {
                            // 收集文本内容
                            if let AIEvent::Token(token) = &evt {
                                assistant_content.text.push_str(&token.value);
                            }
                            // 收集思考内容
                            if let AIEvent::Thinking(thinking) = &evt {
                                assistant_content.thinking.push_str(&thinking.content);
                            }
                            event_callback(evt);
                        }

                        // 更新状态
                        if let Some(state) = new_state {
                            // 检测到工具调用参数收集完成
                            if matches!(state, ToolCallState::ReadyToExecute { .. }) {
                                // 收集工具调用信息
                                if let ToolCallState::ReadyToExecute { tool_id, tool_name, input } = &state {
                                    assistant_content.tool_calls.push(ToolCallInfo {
                                        id: tool_id.clone(),
                                        name: tool_name.clone(),
                                        input: input.clone(),
                                    });
                                }

                                // 执行工具
                                let config = self.config.as_ref().unwrap();
                                let result = Self::execute_tool(config, &state, &session_id, event_callback.clone()).await;

                                if let Some((tool_id, tool_name, result_str, is_error)) = result {
                                    tool_results.push(ToolResult {
                                        tool_id,
                                        tool_name,
                                        result: result_str,
                                        is_error,
                                    });
                                }

                                // 执行完成后回到空闲状态
                                tool_state = ToolCallState::Idle;
                            } else {
                                tool_state = state;
                            }
                        }
                    }
                    Ok(None) => {
                        // 流结束
                        tracing::info!("[ClawCodeEngine] 流结束 (session: {})", session_id);
                        break;
                    }
                    Err(e) => {
                        tracing::error!("[ClawCodeEngine] 流错误: {}", e);
                        event_callback(AIEvent::Error(crate::models::ErrorEvent::new(
                            &session_id,
                            e.to_string(),
                        )));
                        // 清理
                        {
                            let mut tokens = self.cancel_tokens.lock()
                                .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
                            tokens.remove(&session_id);
                        }
                        return Err(e);
                    }
                }
            }

            // 检查是否有工具调用结果需要处理
            if tool_results.is_empty() || cancel_token.is_cancelled() {
                // 没有工具调用或已取消，结束循环
                break;
            }

            // 构建下一轮请求的消息
            tracing::info!("[ClawCodeEngine] 工具调用完成，准备发送结果 (tool_count: {})", tool_results.len());

            // 1. 添加助手消息（包含工具调用）
            let assistant_msg = Self::build_assistant_message(&assistant_content);
            current_messages.push(assistant_msg);

            // 2. 添加工具结果消息
            for result in &tool_results {
                let tool_msg = InputMessage::tool_result(&result.tool_id, &result.result);
                current_messages.push(tool_msg);
            }

            // 继续循环，发送新请求
        }

        // 清理
        {
            let mut tokens = self.cancel_tokens.lock()
                .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
            tokens.remove(&session_id);
        }

        if cancel_token.is_cancelled() {
            tracing::info!("[ClawCodeEngine] 会话已取消: {}", session_id);
        }

        Ok(())
    }

    /// 构建助手消息
    ///
    /// 根据收集的内容构建包含文本和工具调用的 assistant 消息。
    fn build_assistant_message(content: &AssistantContent) -> InputMessage {
        use crate::ai::adapters::InputContentBlock;

        // 构建内容块列表
        let mut blocks: Vec<InputContentBlock> = Vec::new();

        // 添加思考内容（如果有）- 作为文本块
        if !content.thinking.is_empty() {
            blocks.push(InputContentBlock::Text {
                text: format!("[Thinking] {}", content.thinking),
            });
        }

        // 添加文本内容（如果有）
        if !content.text.is_empty() {
            blocks.push(InputContentBlock::Text {
                text: content.text.clone(),
            });
        }

        // 添加工具调用
        for tc in &content.tool_calls {
            blocks.push(InputContentBlock::ToolUse {
                id: tc.id.clone(),
                name: tc.name.clone(),
                input: tc.input.clone(),
            });
        }

        InputMessage::assistant_with_blocks(blocks)
    }
}

impl AIEngine for ClawCodeEngine {
    fn id(&self) -> EngineId {
        EngineId::OpenAI {
            provider_id: Some("claw-code".to_string()),
        }
    }

    fn name(&self) -> &'static str {
        "ClawCode"
    }

    fn description(&self) -> &'static str {
        "使用 claw-code 适配层的 AI 引擎"
    }

    fn is_available(&self) -> bool {
        self.config.is_some() && self.client.is_some()
    }

    fn unavailable_reason(&self) -> Option<String> {
        if self.config.is_none() {
            Some("未配置 ClawCode Provider".to_string())
        } else {
            None
        }
    }

    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        tracing::info!("[ClawCodeEngine] 启动会话");

        if !self.is_available() {
            return Err(AppError::ValidationError(
                self.unavailable_reason().unwrap_or_else(|| "引擎不可用".to_string()),
            ));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        // 注册会话
        self.sessions.register(
            session_id.clone(),
            0, // 无 PID
            "claw-code".to_string(),
        )?;

        // 构建消息
        let messages = vec![InputMessage::user_text(message)];

        // 克隆 cancel_tokens 用于异步任务（Arc 共享）
        let cancel_tokens_clone = self.cancel_tokens.clone();
        // 克隆 client 用于异步任务
        let client_clone = self.client.clone();
        // 克隆 config 用于异步任务
        let config_clone = self.config.clone();

        let sid = session_id.clone();

        // 异步执行
        tokio::spawn(async move {
            // 创建临时引擎实例，共享 cancel_tokens
            let mut engine_clone = ClawCodeEngine {
                config: config_clone,
                client: client_clone,
                sessions: SessionManager::new(),
                cancel_tokens: cancel_tokens_clone,
            };

            if let Err(e) = engine_clone.execute_stream_chat(messages, options, sid.clone()).await {
                tracing::error!("[ClawCodeEngine] 执行失败: {}", e);
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
        tracing::info!("[ClawCodeEngine] 继续会话 (history_len: {})", options.message_history.len());

        if !self.is_available() {
            return Err(AppError::ValidationError(
                self.unavailable_reason().unwrap_or_else(|| "引擎不可用".to_string()),
            ));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        // 注册会话
        self.sessions.register(
            session_id.clone(),
            0,
            "claw-code".to_string(),
        )?;

        // 转换历史消息
        let mut messages = history_entries_to_input_messages(&options.message_history);

        // 添加新消息
        messages.push(InputMessage::user_text(message));

        // 克隆 cancel_tokens 用于异步任务（Arc 共享）
        let cancel_tokens_clone = self.cancel_tokens.clone();
        // 克隆 client 用于异步任务
        let client_clone = self.client.clone();
        // 克隆 config 用于异步任务
        let config_clone = self.config.clone();

        let sid = session_id.clone();

        // 异步执行
        tokio::spawn(async move {
            // 创建临时引擎实例，共享 cancel_tokens
            let mut engine_clone = ClawCodeEngine {
                config: config_clone,
                client: client_clone,
                sessions: SessionManager::new(),
                cancel_tokens: cancel_tokens_clone,
            };

            if let Err(e) = engine_clone.execute_stream_chat(messages, options, sid.clone()).await {
                tracing::error!("[ClawCodeEngine] 继续会话执行失败: {}", e);
            }
        });

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[ClawCodeEngine] 中断会话: {}", session_id);

        {
            let mut tokens = self.cancel_tokens.lock()
                .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
            if let Some(token) = tokens.remove(session_id) {
                token.cancel();
                tracing::info!("[ClawCodeEngine] 会话已取消: {}", session_id);
            }
        }

        self.sessions.remove(session_id);
        Ok(())
    }

    fn active_session_count(&self) -> usize {
        self.cancel_tokens.lock()
            .map(|tokens| tokens.len())
            .unwrap_or(0)
    }
}

impl Default for ClawCodeEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::adapters::{
        ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent,
        ContentBlockStopEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
        ToolDefinition,
    };
    use crate::ai::tools::executor::PolarisToolExecutor;
    use crate::ai::tools::types::{ToolError, PermissionPolicy, PermissionMode, ToolSpec};
    use async_trait::async_trait;
    use std::sync::Arc;

    #[test]
    fn test_config_default() {
        let config = ClawCodeConfig::default();
        assert_eq!(config.provider_name, "ClawCode");
        assert_eq!(config.max_tokens, 4096);
        assert_eq!(config.temperature, 0.7);
        assert!(!config.enable_tools);
        assert!(config.tool_executor.is_none());
    }

    #[test]
    fn test_config_new() {
        let config = ClawCodeConfig::new(
            "TestProvider",
            "test-key",
            "https://api.test.com/v1",
            "test-model",
        );
        assert_eq!(config.provider_name, "TestProvider");
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.base_url, "https://api.test.com/v1");
        assert_eq!(config.model, "test-model");
    }

    #[test]
    fn test_config_with_options() {
        let config = ClawCodeConfig::new("Test", "key", "url", "model")
            .with_max_tokens(8192)
            .with_temperature(0.5);
        assert_eq!(config.max_tokens, 8192);
        assert_eq!(config.temperature, 0.5);
    }

    #[test]
    fn test_engine_new() {
        let engine = ClawCodeEngine::new();
        assert!(!engine.is_available());
        assert_eq!(engine.name(), "ClawCode");
    }

    #[test]
    fn test_engine_with_config() {
        let config = ClawCodeConfig::new("Test", "key", "url", "model");
        let engine = ClawCodeEngine::with_config(config);
        assert!(engine.is_available());
        assert_eq!(engine.name(), "ClawCode");
    }

    #[test]
    fn test_engine_set_config() {
        let mut engine = ClawCodeEngine::new();
        assert!(!engine.is_available());

        let config = ClawCodeConfig::new("Test", "key", "url", "model");
        engine.set_config(config);
        assert!(engine.is_available());
    }

    #[test]
    fn test_engine_id() {
        let engine = ClawCodeEngine::new();
        let id = engine.id();
        assert!(matches!(id, EngineId::OpenAI { provider_id: Some(p) } if p == "claw-code"));
    }

    #[test]
    fn test_build_request() {
        let config = ClawCodeConfig::new("Test", "key", "url", "gpt-4")
            .with_max_tokens(1000);
        let engine = ClawCodeEngine::with_config(config);

        let messages = vec![InputMessage::user_text("Hello")];
        let request = engine.build_request(messages, Some("Be helpful"));

        assert_eq!(request.model, "gpt-4");
        assert_eq!(request.max_tokens, 1000);
        assert_eq!(request.messages.len(), 1);
        assert_eq!(request.system, Some("Be helpful".to_string()));
        assert!(request.stream);
        assert!(request.tools.is_none());
    }

    // === ToolCallState 状态测试 ===

    #[test]
    fn test_tool_call_state_idle() {
        let state = ToolCallState::Idle;
        assert!(matches!(state, ToolCallState::Idle));
    }

    #[test]
    fn test_tool_call_state_collecting_input() {
        let state = ToolCallState::CollectingInput {
            tool_id: "call_123".to_string(),
            tool_name: "read_file".to_string(),
            input_json: "{\"path\": \"/test\"}".to_string(),
        };

        match state {
            ToolCallState::CollectingInput { tool_id, tool_name, input_json } => {
                assert_eq!(tool_id, "call_123");
                assert_eq!(tool_name, "read_file");
                assert_eq!(input_json, "{\"path\": \"/test\"}");
            }
            _ => panic!("Expected CollectingInput state"),
        }
    }

    #[test]
    fn test_tool_call_state_ready_to_execute() {
        let input = serde_json::json!({"path": "/test"});
        let state = ToolCallState::ReadyToExecute {
            tool_id: "call_123".to_string(),
            tool_name: "read_file".to_string(),
            input,
        };

        match state {
            ToolCallState::ReadyToExecute { tool_id, tool_name, input } => {
                assert_eq!(tool_id, "call_123");
                assert_eq!(tool_name, "read_file");
                assert_eq!(input["path"], "/test");
            }
            _ => panic!("Expected ReadyToExecute state"),
        }
    }

    #[test]
    fn test_tool_call_state_executing() {
        let state = ToolCallState::Executing {
            tool_id: "call_123".to_string(),
            tool_name: "read_file".to_string(),
        };

        match state {
            ToolCallState::Executing { tool_id, tool_name } => {
                assert_eq!(tool_id, "call_123");
                assert_eq!(tool_name, "read_file");
            }
            _ => panic!("Expected Executing state"),
        }
    }

    // === handle_stream_event 测试 ===

    #[test]
    fn test_handle_stream_event_tool_use_start() {
        let engine = ClawCodeEngine::new();
        let state = ToolCallState::Idle;

        // 创建 ToolUse 开始事件
        let event = StreamEvent::ContentBlockStart(ContentBlockStartEvent {
            index: 0,
            content_block: OutputContentBlock::ToolUse {
                id: "call_123".to_string(),
                name: "read_file".to_string(),
                input: serde_json::json!({"path": "/test"}),
            },
        });

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 验证返回了 ToolCallStart 事件
        assert!(ai_event.is_some());
        match ai_event.unwrap() {
            AIEvent::ToolCallStart(evt) => {
                assert_eq!(evt.session_id, "session_1");
                assert_eq!(evt.tool, "read_file");
                assert_eq!(evt.call_id, Some("call_123".to_string()));
            }
            _ => panic!("Expected ToolCallStart event"),
        }

        // 验证状态转换到 CollectingInput
        assert!(new_state.is_some());
        match new_state.unwrap() {
            ToolCallState::CollectingInput { tool_id, tool_name, .. } => {
                assert_eq!(tool_id, "call_123");
                assert_eq!(tool_name, "read_file");
            }
            _ => panic!("Expected CollectingInput state"),
        }
    }

    #[test]
    fn test_handle_stream_event_text_delta() {
        let engine = ClawCodeEngine::new();
        let state = ToolCallState::Idle;

        // 创建文本增量事件
        let event = StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
            index: 0,
            delta: ContentBlockDelta::TextDelta {
                text: "Hello".to_string(),
            },
        });

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 验证返回了 Token 事件
        assert!(ai_event.is_some());
        match ai_event.unwrap() {
            AIEvent::Token(evt) => {
                assert_eq!(evt.session_id, "session_1");
                assert_eq!(evt.value, "Hello");
            }
            _ => panic!("Expected Token event"),
        }

        // 状态应保持不变
        assert!(new_state.is_none());
    }

    #[test]
    fn test_handle_stream_event_thinking_delta() {
        let engine = ClawCodeEngine::new();
        let state = ToolCallState::Idle;

        // 创建思考增量事件
        let event = StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
            index: 0,
            delta: ContentBlockDelta::ThinkingDelta {
                thinking: "Let me think...".to_string(),
            },
        });

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 验证返回了 Thinking 事件
        assert!(ai_event.is_some());
        match ai_event.unwrap() {
            AIEvent::Thinking(evt) => {
                assert_eq!(evt.session_id, "session_1");
                assert_eq!(evt.content, "Let me think...");
            }
            _ => panic!("Expected Thinking event"),
        }

        // 状态应保持不变
        assert!(new_state.is_none());
    }

    #[test]
    fn test_handle_stream_event_input_json_delta() {
        let engine = ClawCodeEngine::new();

        // 从 CollectingInput 状态开始
        let state = ToolCallState::CollectingInput {
            tool_id: "call_123".to_string(),
            tool_name: "read_file".to_string(),
            input_json: "{\"path\": \"/te".to_string(),
        };

        // 创建 JSON 增量事件
        let event = StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
            index: 0,
            delta: ContentBlockDelta::InputJsonDelta {
                partial_json: "st\"}".to_string(),
            },
        });

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 不应返回事件
        assert!(ai_event.is_none());

        // 状态应更新，input_json 应追加
        assert!(new_state.is_some());
        match new_state.unwrap() {
            ToolCallState::CollectingInput { input_json, .. } => {
                assert_eq!(input_json, "{\"path\": \"/test\"}");
            }
            _ => panic!("Expected CollectingInput state"),
        }
    }

    #[test]
    fn test_handle_stream_event_content_block_stop() {
        let engine = ClawCodeEngine::new();

        // 从 CollectingInput 状态开始（已收集完整 JSON）
        let state = ToolCallState::CollectingInput {
            tool_id: "call_123".to_string(),
            tool_name: "read_file".to_string(),
            input_json: "{\"path\": \"/test\"}".to_string(),
        };

        // 创建内容块结束事件
        let event = StreamEvent::ContentBlockStop(ContentBlockStopEvent { index: 0 });

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 不应返回事件
        assert!(ai_event.is_none());

        // 状态应转换到 ReadyToExecute
        assert!(new_state.is_some());
        match new_state.unwrap() {
            ToolCallState::ReadyToExecute { tool_id, tool_name, input } => {
                assert_eq!(tool_id, "call_123");
                assert_eq!(tool_name, "read_file");
                assert_eq!(input["path"], "/test");
            }
            _ => panic!("Expected ReadyToExecute state"),
        }
    }

    #[test]
    fn test_handle_stream_event_message_stop() {
        let engine = ClawCodeEngine::new();
        let state = ToolCallState::Idle;

        // 创建消息结束事件
        let event = StreamEvent::MessageStop(MessageStopEvent {});

        let (ai_event, new_state) = engine.handle_stream_event(&event, "session_1", &state);

        // 验证返回了 SessionEnd 事件
        assert!(ai_event.is_some());
        match ai_event.unwrap() {
            AIEvent::SessionEnd(evt) => {
                assert_eq!(evt.session_id, "session_1");
            }
            _ => panic!("Expected SessionEnd event"),
        }

        // 状态应重置为 Idle
        assert!(new_state.is_some());
        assert!(matches!(new_state.unwrap(), ToolCallState::Idle));
    }

    // === build_assistant_message 测试 ===

    #[test]
    fn test_build_assistant_message_text_only() {
        let content = AssistantContent {
            text: "Hello, I can help you.".to_string(),
            tool_calls: vec![],
            thinking: String::new(),
        };

        let message = ClawCodeEngine::build_assistant_message(&content);

        assert_eq!(message.role, "assistant");
        assert_eq!(message.content.len(), 1);
        match &message.content[0] {
            InputContentBlock::Text { text } => {
                assert_eq!(text, "Hello, I can help you.");
            }
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_build_assistant_message_with_thinking() {
        let content = AssistantContent {
            text: "The answer is 42.".to_string(),
            tool_calls: vec![],
            thinking: "Let me calculate...".to_string(),
        };

        let message = ClawCodeEngine::build_assistant_message(&content);

        assert_eq!(message.role, "assistant");
        assert_eq!(message.content.len(), 2);

        // 第一个块应该是思考（作为文本）
        match &message.content[0] {
            InputContentBlock::Text { text } => {
                assert!(text.contains("[Thinking]"));
                assert!(text.contains("Let me calculate..."));
            }
            _ => panic!("Expected Text block for thinking"),
        }

        // 第二个块应该是文本
        match &message.content[1] {
            InputContentBlock::Text { text } => {
                assert_eq!(text, "The answer is 42.");
            }
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_build_assistant_message_with_tool_call() {
        let content = AssistantContent {
            text: "I'll read the file.".to_string(),
            tool_calls: vec![ToolCallInfo {
                id: "call_123".to_string(),
                name: "read_file".to_string(),
                input: serde_json::json!({"path": "/test"}),
            }],
            thinking: String::new(),
        };

        let message = ClawCodeEngine::build_assistant_message(&content);

        assert_eq!(message.role, "assistant");
        assert_eq!(message.content.len(), 2);

        // 第一个块应该是文本
        match &message.content[0] {
            InputContentBlock::Text { text } => {
                assert_eq!(text, "I'll read the file.");
            }
            _ => panic!("Expected Text block"),
        }

        // 第二个块应该是工具调用
        match &message.content[1] {
            InputContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_123");
                assert_eq!(name, "read_file");
                assert_eq!(input["path"], "/test");
            }
            _ => panic!("Expected ToolUse block"),
        }
    }

    #[test]
    fn test_build_assistant_message_full() {
        let content = AssistantContent {
            text: "Done!".to_string(),
            tool_calls: vec![ToolCallInfo {
                id: "call_123".to_string(),
                name: "read_file".to_string(),
                input: serde_json::json!({"path": "/test"}),
            }],
            thinking: "Processing...".to_string(),
        };

        let message = ClawCodeEngine::build_assistant_message(&content);

        assert_eq!(message.role, "assistant");
        assert_eq!(message.content.len(), 3);

        // 验证顺序：thinking -> text -> tool_use
        match &message.content[0] {
            InputContentBlock::Text { text } => assert!(text.contains("Processing...")),
            _ => panic!("Expected thinking text block"),
        }
        match &message.content[1] {
            InputContentBlock::Text { text } => assert_eq!(text, "Done!"),
            _ => panic!("Expected text block"),
        }
        match &message.content[2] {
            InputContentBlock::ToolUse { name, .. } => assert_eq!(name, "read_file"),
            _ => panic!("Expected ToolUse block"),
        }
    }

    // === 工具配置测试 ===

    /// Mock 工具执行器用于测试
    struct MockToolExecutor {
        policy: PermissionPolicy,
        work_dir: std::path::PathBuf,
    }

    impl MockToolExecutor {
        fn new() -> Self {
            Self {
                policy: PermissionPolicy::new(PermissionMode::DangerFullAccess),
                work_dir: std::path::PathBuf::from("/"),
            }
        }
    }

    #[async_trait]
    impl PolarisToolExecutor for MockToolExecutor {
        async fn execute(&self, _tool_name: &str, _input: &serde_json::Value) -> std::result::Result<String, ToolError> {
            Ok("mock result".to_string())
        }

        fn available_tools(&self) -> Vec<ToolDefinition> {
            vec![ToolDefinition {
                name: "mock_tool".to_string(),
                description: Some("A mock tool".to_string()),
                input_schema: serde_json::json!({"type": "object"}),
            }]
        }

        fn tool_specs(&self) -> Vec<ToolSpec> {
            vec![]
        }

        fn has_tool(&self, name: &str) -> bool {
            name == "mock_tool"
        }

        fn permission_policy(&self) -> &PermissionPolicy {
            &self.policy
        }

        fn set_permission_policy(&mut self, policy: PermissionPolicy) {
            self.policy = policy;
        }

        fn work_dir(&self) -> Option<&std::path::Path> {
            Some(&self.work_dir)
        }

        fn set_work_dir(&mut self, work_dir: std::path::PathBuf) {
            self.work_dir = work_dir;
        }
    }

    #[test]
    fn test_config_with_tool_executor() {
        let executor = Arc::new(MockToolExecutor::new());
        let config = ClawCodeConfig::new("Test", "key", "url", "model")
            .with_tool_executor(executor);

        // 设置 tool_executor 后应自动启用工具
        assert!(config.enable_tools);
        assert!(config.tool_executor.is_some());
    }

    #[test]
    fn test_config_enable_tools() {
        let config = ClawCodeConfig::new("Test", "key", "url", "model")
            .enable_tools(true);

        assert!(config.enable_tools);

        // 未设置 tool_executor 时，工具列表为空
        assert!(config.tool_executor.is_none());
    }

    #[test]
    fn test_config_with_tool_choice() {
        let config = ClawCodeConfig::new("Test", "key", "url", "model")
            .with_tool_choice(ToolChoice::Auto);

        assert_eq!(config.tool_choice, Some(ToolChoice::Auto));

        // 工具调用未启用（需要显式启用或设置 tool_executor）
        assert!(!config.enable_tools);
    }

    #[test]
    fn test_build_request_with_tools() {
        let executor = Arc::new(MockToolExecutor::new());
        let config = ClawCodeConfig::new("Test", "key", "url", "gpt-4")
            .with_tool_executor(executor);

        let engine = ClawCodeEngine::with_config(config);
        let messages = vec![InputMessage::user_text("Hello")];
        let request = engine.build_request(messages, None);

        // 应包含工具定义
        assert!(request.tools.is_some());
        let tools = request.tools.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "mock_tool");

        // 应设置工具选择策略（默认 Auto）
        assert!(request.tool_choice.is_some());
        assert_eq!(request.tool_choice, Some(ToolChoice::Auto));
    }

    #[test]
    fn test_build_request_with_explicit_tool_choice() {
        let executor = Arc::new(MockToolExecutor::new());
        let config = ClawCodeConfig::new("Test", "key", "url", "gpt-4")
            .with_tool_executor(executor)
            .with_tool_choice(ToolChoice::Any);

        let engine = ClawCodeEngine::with_config(config);
        let messages = vec![InputMessage::user_text("Hello")];
        let request = engine.build_request(messages, None);

        // 应使用配置的 tool_choice
        assert_eq!(request.tool_choice, Some(ToolChoice::Any));
    }
}