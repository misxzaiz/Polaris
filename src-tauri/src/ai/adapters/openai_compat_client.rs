/*! OpenAI 兼容 API 客户端
 *
 * 使用 claw-code 类型定义实现的 OpenAI 兼容 API 客户端。
 * 支持 OpenAI、xAI、以及兼容 OpenAI API 的服务。
 *
 * 设计目标：
 * - 使用适配层类型（claw_code_types）
 * - 支持流式和非流式响应
 * - 与 Polaris AIEvent 系统集成
 */

use std::collections::VecDeque;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use super::claw_code_types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
use crate::error::{AppError, Result};

/// OpenAI 兼容客户端配置
#[derive(Debug, Clone)]
pub struct OpenAiCompatConfig {
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
    /// 是否支持工具调用
    pub supports_tools: bool,
    /// 最大重试次数
    pub max_retries: u32,
    /// 初始退避时间
    pub initial_backoff: Duration,
    /// 最大退避时间
    pub max_backoff: Duration,
}

impl Default for OpenAiCompatConfig {
    fn default() -> Self {
        Self {
            provider_name: "OpenAI".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4".to_string(),
            max_tokens: 4096,
            temperature: 0.7,
            supports_tools: true,
            max_retries: 2,
            initial_backoff: Duration::from_millis(200),
            max_backoff: Duration::from_secs(2),
        }
    }
}

impl OpenAiCompatConfig {
    /// 创建 OpenAI 配置
    pub fn openai(api_key: impl Into<String>) -> Self {
        Self {
            provider_name: "OpenAI".to_string(),
            api_key: api_key.into(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4".to_string(),
            ..Default::default()
        }
    }

    /// 创建 xAI 配置
    pub fn xai(api_key: impl Into<String>) -> Self {
        Self {
            provider_name: "xAI".to_string(),
            api_key: api_key.into(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "grok-3".to_string(),
            ..Default::default()
        }
    }

    /// 创建自定义配置
    pub fn custom(
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

    /// 设置模型
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
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
}

/// OpenAI 兼容 API 客户端
#[derive(Debug, Clone)]
pub struct OpenAiCompatClient {
    http: Client,
    config: OpenAiCompatConfig,
}

impl OpenAiCompatClient {
    /// 创建新客户端
    pub fn new(config: OpenAiCompatConfig) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        Self { http, config }
    }

    /// 发送非流式消息请求
    pub async fn send_message(&self, request: &MessageRequest) -> Result<MessageResponse> {
        let request = MessageRequest {
            stream: false,
            ..request.clone()
        };

        let response = self.send_with_retry(&request).await?;
        let request_id = request_id_from_headers(response.headers());

        let payload = response
            .json::<ChatCompletionResponse>()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        let mut normalized = normalize_response(&self.config.model, payload)?;
        if normalized.request_id.is_none() {
            normalized.request_id = request_id;
        }

        Ok(normalized)
    }

    /// 发送流式消息请求
    pub async fn stream_message(&self, request: &MessageRequest) -> Result<MessageStream> {
        let response = self
            .send_with_retry(&request.clone().with_streaming())
            .await?;

        Ok(MessageStream {
            request_id: request_id_from_headers(response.headers()),
            response,
            parser: OpenAiSseParser::new(),
            pending: VecDeque::new(),
            done: false,
            state: StreamState::new(self.config.model.clone()),
        })
    }

    /// 带重试的请求发送
    async fn send_with_retry(&self, request: &MessageRequest) -> Result<reqwest::Response> {
        let mut attempts = 0;

        let last_error = loop {
            attempts += 1;
            let retryable_error = match self.send_raw_request(request).await {
                Ok(response) => match expect_success(response).await {
                    Ok(response) => return Ok(response),
                    Err(error) if is_retryable_error(&error) && attempts <= self.config.max_retries + 1 => error,
                    Err(error) => return Err(error),
                },
                Err(error) if is_retryable_error(&error) && attempts <= self.config.max_retries + 1 => error,
                Err(error) => return Err(error),
            };

            if attempts > self.config.max_retries {
                break retryable_error;
            }

            tokio::time::sleep(self.backoff_for_attempt(attempts)?).await;
        };

        Err(AppError::NetworkError(format!(
            "重试 {} 次后仍失败: {}",
            attempts, last_error
        )))
    }

    /// 发送原始请求
    async fn send_raw_request(&self, request: &MessageRequest) -> Result<reqwest::Response> {
        let request_url = chat_completions_endpoint(&self.config.base_url);

        self.http
            .post(&request_url)
            .header("content-type", "application/json")
            .bearer_auth(&self.config.api_key)
            .json(&build_chat_completion_request(request, &self.config))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))
    }

    /// 计算退避时间
    fn backoff_for_attempt(&self, attempt: u32) -> Result<Duration> {
        let multiplier = 1_u32
            .checked_shl(attempt.saturating_sub(1))
            .ok_or_else(|| AppError::Unknown("退避时间溢出".to_string()))?;

        Ok(self
            .config
            .initial_backoff
            .checked_mul(multiplier)
            .map_or(self.config.max_backoff, |delay| delay.min(self.config.max_backoff)))
    }
}

/// 消息流
#[derive(Debug)]
pub struct MessageStream {
    request_id: Option<String>,
    response: reqwest::Response,
    parser: OpenAiSseParser,
    pending: VecDeque<StreamEvent>,
    done: bool,
    state: StreamState,
}

impl MessageStream {
    /// 获取请求 ID
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// 获取下一个事件
    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }

            if self.done {
                self.pending.extend(self.state.finish()?);
                if let Some(event) = self.pending.pop_front() {
                    return Ok(Some(event));
                }
                return Ok(None);
            }

            match self.response.chunk().await {
                Ok(Some(chunk)) => {
                    for parsed in self.parser.push(&chunk)? {
                        self.pending.extend(self.state.ingest_chunk(parsed)?);
                    }
                }
                Ok(None) => {
                    self.done = true;
                }
                Err(e) => return Err(AppError::NetworkError(e.to_string())),
            }
        }
    }
}

/// SSE 解析器
#[derive(Debug, Default)]
struct OpenAiSseParser {
    buffer: Vec<u8>,
}

impl OpenAiSseParser {
    fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<ChatCompletionChunk>> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(frame) = next_sse_frame(&mut self.buffer) {
            if let Some(event) = parse_sse_frame(&frame)? {
                events.push(event);
            }
        }

        Ok(events)
    }
}

/// 流状态
#[derive(Debug)]
struct StreamState {
    model: String,
    message_started: bool,
    text_started: bool,
    text_finished: bool,
    finished: bool,
    stop_reason: Option<String>,
    usage: Option<Usage>,
    tool_calls: std::collections::BTreeMap<u32, ToolCallState>,
}

impl StreamState {
    fn new(model: String) -> Self {
        Self {
            model,
            message_started: false,
            text_started: false,
            text_finished: false,
            finished: false,
            stop_reason: None,
            usage: None,
            tool_calls: std::collections::BTreeMap::new(),
        }
    }

    fn ingest_chunk(&mut self, chunk: ChatCompletionChunk) -> Result<Vec<StreamEvent>> {
        let mut events = Vec::new();

        if !self.message_started {
            self.message_started = true;
            events.push(StreamEvent::MessageStart(MessageStartEvent {
                message: MessageResponse {
                    id: chunk.id.clone(),
                    kind: "message".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: chunk.model.clone().unwrap_or_else(|| self.model.clone()),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Usage {
                        input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        output_tokens: 0,
                    },
                    request_id: None,
                },
            }));
        }

        if let Some(usage) = chunk.usage {
            self.usage = Some(Usage {
                input_tokens: usage.prompt_tokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: usage.completion_tokens,
            });
        }

        for choice in chunk.choices {
            if let Some(content) = choice.delta.content.filter(|value| !value.is_empty()) {
                if !self.text_started {
                    self.text_started = true;
                    events.push(StreamEvent::ContentBlockStart(ContentBlockStartEvent {
                        index: 0,
                        content_block: OutputContentBlock::Text {
                            text: String::new(),
                        },
                    }));
                }
                events.push(StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
                    index: 0,
                    delta: ContentBlockDelta::TextDelta { text: content },
                }));
            }

            for tool_call in choice.delta.tool_calls {
                let state = self.tool_calls.entry(tool_call.index).or_default();
                state.apply(tool_call);
                let block_index = state.block_index();

                if !state.started {
                    if let Some(start_event) = state.start_event()? {
                        state.started = true;
                        events.push(StreamEvent::ContentBlockStart(start_event));
                    } else {
                        continue;
                    }
                }

                if let Some(delta_event) = state.delta_event() {
                    events.push(StreamEvent::ContentBlockDelta(delta_event));
                }

                if choice.finish_reason.as_deref() == Some("tool_calls") && !state.stopped {
                    state.stopped = true;
                    events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                        index: block_index,
                    }));
                }
            }

            if let Some(finish_reason) = choice.finish_reason {
                self.stop_reason = Some(normalize_finish_reason(&finish_reason));
                if finish_reason == "tool_calls" {
                    for state in self.tool_calls.values_mut() {
                        if state.started && !state.stopped {
                            state.stopped = true;
                            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                                index: state.block_index(),
                            }));
                        }
                    }
                }
            }
        }

        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;

        let mut events = Vec::new();

        if self.text_started && !self.text_finished {
            self.text_finished = true;
            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent { index: 0 }));
        }

        for state in self.tool_calls.values_mut() {
            if !state.started {
                if let Some(start_event) = state.start_event()? {
                    state.started = true;
                    events.push(StreamEvent::ContentBlockStart(start_event));
                    if let Some(delta_event) = state.delta_event() {
                        events.push(StreamEvent::ContentBlockDelta(delta_event));
                    }
                }
            }
            if state.started && !state.stopped {
                state.stopped = true;
                events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                    index: state.block_index(),
                }));
            }
        }

        if self.message_started {
            events.push(StreamEvent::MessageDelta(MessageDeltaEvent {
                delta: MessageDelta {
                    stop_reason: Some(
                        self.stop_reason
                            .clone()
                            .unwrap_or_else(|| "end_turn".to_string()),
                    ),
                    stop_sequence: None,
                },
                usage: self.usage.clone().unwrap_or(Usage {
                    input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 0,
                }),
            }));
            events.push(StreamEvent::MessageStop(MessageStopEvent {}));
        }

        Ok(events)
    }
}

/// 工具调用状态
#[derive(Debug, Default)]
struct ToolCallState {
    openai_index: u32,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    emitted_len: usize,
    started: bool,
    stopped: bool,
}

impl ToolCallState {
    fn apply(&mut self, tool_call: DeltaToolCall) {
        self.openai_index = tool_call.index;
        if let Some(id) = tool_call.id {
            self.id = Some(id);
        }
        if let Some(name) = tool_call.function.name {
            self.name = Some(name);
        }
        if let Some(arguments) = tool_call.function.arguments {
            self.arguments.push_str(&arguments);
        }
    }

    const fn block_index(&self) -> u32 {
        self.openai_index + 1
    }

    fn start_event(&self) -> Result<Option<ContentBlockStartEvent>> {
        let name = match self.name.clone() {
            Some(n) => n,
            None => return Ok(None),
        };

        let id = self
            .id
            .clone()
            .unwrap_or_else(|| format!("tool_call_{}", self.openai_index));

        Ok(Some(ContentBlockStartEvent {
            index: self.block_index(),
            content_block: OutputContentBlock::ToolUse {
                id,
                name,
                input: json!({}),
            },
        }))
    }

    fn delta_event(&mut self) -> Option<ContentBlockDeltaEvent> {
        if self.emitted_len >= self.arguments.len() {
            return None;
        }

        let delta = self.arguments[self.emitted_len..].to_string();
        self.emitted_len = self.arguments.len();

        Some(ContentBlockDeltaEvent {
            index: self.block_index(),
            delta: ContentBlockDelta::InputJsonDelta { partial_json: delta },
        })
    }
}

// ============================================================================
// OpenAI API 数据结构
// ============================================================================

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    id: String,
    model: String,
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    role: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ResponseToolCall>,
}

#[derive(Debug, Deserialize)]
struct ResponseToolCall {
    id: String,
    function: ResponseToolFunction,
}

#[derive(Debug, Deserialize)]
struct ResponseToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<DeltaToolCall>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: DeltaFunction,
}

#[derive(Debug, Default, Deserialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(rename = "type")]
    error_type: Option<String>,
    message: Option<String>,
}

// ============================================================================
// 辅助函数
// ============================================================================

fn build_chat_completion_request(request: &MessageRequest, config: &OpenAiCompatConfig) -> serde_json::Value {
    let mut messages = Vec::new();

    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        messages.push(json!({
            "role": "system",
            "content": system,
        }));
    }

    for message in &request.messages {
        messages.extend(translate_message(message));
    }

    let mut payload = json!({
        "model": &config.model,
        "max_tokens": request.max_tokens,
        "messages": messages,
        "stream": request.stream,
    });

    if let Some(temperature) = payload.get_mut("temperature") {
        *temperature = json!(config.temperature);
    } else {
        payload["temperature"] = json!(config.temperature);
    }

    if request.stream && should_request_stream_usage(config) {
        payload["stream_options"] = json!({ "include_usage": true });
    }

    if let Some(tools) = &request.tools {
        payload["tools"] = Value::Array(tools.iter().map(openai_tool_definition).collect::<Vec<_>>());
    }

    if let Some(tool_choice) = &request.tool_choice {
        payload["tool_choice"] = openai_tool_choice(tool_choice);
    }

    payload
}

fn translate_message(message: &InputMessage) -> Vec<serde_json::Value> {
    match message.role.as_str() {
        "assistant" => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();

            for block in &message.content {
                match block {
                    InputContentBlock::Text { text: value } => text.push_str(value),
                    InputContentBlock::ToolUse { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": input.to_string(),
                        }
                    })),
                    InputContentBlock::ToolResult { .. } => {}
                }
            }

            if text.is_empty() && tool_calls.is_empty() {
                Vec::new()
            } else {
                vec![json!({
                    "role": "assistant",
                    "content": (!text.is_empty()).then_some(text),
                    "tool_calls": tool_calls,
                })]
            }
        }
        _ => message
            .content
            .iter()
            .filter_map(|block| match block {
                InputContentBlock::Text { text } => Some(json!({
                    "role": "user",
                    "content": text,
                })),
                InputContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": flatten_tool_result_content(content),
                    "is_error": is_error,
                })),
                InputContentBlock::ToolUse { .. } => None,
            })
            .collect(),
    }
}

fn flatten_tool_result_content(content: &[ToolResultContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ToolResultContentBlock::Text { text } => text.clone(),
            ToolResultContentBlock::Json { value } => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn openai_tool_definition(tool: &ToolDefinition) -> serde_json::Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        }
    })
}

fn openai_tool_choice(tool_choice: &ToolChoice) -> serde_json::Value {
    match tool_choice {
        ToolChoice::Auto => serde_json::Value::String("auto".to_string()),
        ToolChoice::Any => serde_json::Value::String("required".to_string()),
        ToolChoice::Tool { name } => json!({
            "type": "function",
            "function": { "name": name },
        }),
    }
}

fn should_request_stream_usage(config: &OpenAiCompatConfig) -> bool {
    config.provider_name == "OpenAI"
}

fn normalize_response(
    model: &str,
    response: ChatCompletionResponse,
) -> Result<MessageResponse> {
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NetworkError("响应缺少 choices".to_string()))?;

    let mut content = Vec::new();

    if let Some(text) = choice.message.content.filter(|value| !value.is_empty()) {
        content.push(OutputContentBlock::Text { text });
    }

    for tool_call in choice.message.tool_calls {
        content.push(OutputContentBlock::ToolUse {
            id: tool_call.id,
            name: tool_call.function.name,
            input: parse_tool_arguments(&tool_call.function.arguments),
        });
    }

    Ok(MessageResponse {
        id: response.id,
        kind: "message".to_string(),
        role: choice.message.role,
        content,
        model: if response.model.is_empty() {
            model.to_string()
        } else {
            response.model
        },
        stop_reason: choice.finish_reason.map(|value| normalize_finish_reason(&value)),
        stop_sequence: None,
        usage: Usage {
            input_tokens: response.usage.as_ref().map_or(0, |usage| usage.prompt_tokens),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: response.usage.as_ref().map_or(0, |usage| usage.completion_tokens),
        },
        request_id: None,
    })
}

fn parse_tool_arguments(arguments: &str) -> serde_json::Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| json!({ "raw": arguments }))
}

fn next_sse_frame(buffer: &mut Vec<u8>) -> Option<String> {
    let separator = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2))
        .or_else(|| {
            buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| (position, 4))
        })?;

    let (position, separator_len) = separator;
    let frame: Vec<u8> = buffer.drain(..position + separator_len).collect();
    let frame_len = frame.len().saturating_sub(separator_len);

    Some(String::from_utf8_lossy(&frame[..frame_len]).into_owned())
}

fn parse_sse_frame(frame: &str) -> Result<Option<ChatCompletionChunk>> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }

    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|e| AppError::NetworkError(format!("解析 SSE 帧失败: {}", e)))
}

fn request_id_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    const REQUEST_ID_HEADER: &str = "request-id";
    const ALT_REQUEST_ID_HEADER: &str = "x-request-id";

    headers
        .get(REQUEST_ID_HEADER)
        .or_else(|| headers.get(ALT_REQUEST_ID_HEADER))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn expect_success(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();
    let parsed_error = serde_json::from_str::<ErrorEnvelope>(&body).ok();
    let retryable = is_retryable_status(status);

    Err(AppError::NetworkError(format!(
        "API 错误 ({}): {} - {}",
        status.as_u16(),
        parsed_error
            .as_ref()
            .and_then(|e| e.error.error_type.as_deref())
            .unwrap_or("unknown"),
        parsed_error
            .as_ref()
            .and_then(|e| e.error.message.as_deref())
            .unwrap_or(&body),
    )))
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 409 | 429 | 500 | 502 | 503 | 504)
}

fn is_retryable_error(error: &AppError) -> bool {
    match error {
        AppError::NetworkError(msg) => {
            msg.contains("超时") || msg.contains("连接") || msg.contains("503") || msg.contains("502")
        }
        _ => false,
    }
}

fn normalize_finish_reason(value: &str) -> String {
    match value {
        "stop" => "end_turn".to_string(),
        "tool_calls" => "tool_use".to_string(),
        other => other.to_string(),
    }
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        let config = OpenAiCompatConfig::default();
        assert_eq!(config.provider_name, "OpenAI");
        assert_eq!(config.max_tokens, 4096);
        assert_eq!(config.temperature, 0.7);
    }

    #[test]
    fn test_config_openai() {
        let config = OpenAiCompatConfig::openai("test-key");
        assert_eq!(config.provider_name, "OpenAI");
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn test_config_xai() {
        let config = OpenAiCompatConfig::xai("test-key");
        assert_eq!(config.provider_name, "xAI");
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.base_url, "https://api.x.ai/v1");
    }

    #[test]
    fn test_config_custom() {
        let config = OpenAiCompatConfig::custom(
            "CustomProvider",
            "custom-key",
            "https://api.custom.com/v1",
            "custom-model",
        );
        assert_eq!(config.provider_name, "CustomProvider");
        assert_eq!(config.api_key, "custom-key");
        assert_eq!(config.base_url, "https://api.custom.com/v1");
        assert_eq!(config.model, "custom-model");
    }

    #[test]
    fn test_endpoint_builder() {
        assert_eq!(
            chat_completions_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_normalize_finish_reason() {
        assert_eq!(normalize_finish_reason("stop"), "end_turn");
        assert_eq!(normalize_finish_reason("tool_calls"), "tool_use");
        assert_eq!(normalize_finish_reason("length"), "length");
    }

    #[test]
    fn test_build_chat_completion_request_basic() {
        let config = OpenAiCompatConfig::openai("test-key").with_model("gpt-4");
        let request = MessageRequest {
            model: "gpt-4".to_string(),
            max_tokens: 100,
            messages: vec![InputMessage::user_text("Hello")],
            system: None,
            tools: None,
            tool_choice: None,
            stream: false,
        };

        let payload = build_chat_completion_request(&request, &config);

        assert_eq!(payload["model"], "gpt-4");
        assert_eq!(payload["max_tokens"], 100);
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][0]["content"], "Hello");
    }

    #[test]
    fn test_build_chat_completion_request_with_system() {
        let config = OpenAiCompatConfig::openai("test-key");
        let request = MessageRequest {
            model: "gpt-4".to_string(),
            max_tokens: 100,
            messages: vec![InputMessage::user_text("Hello")],
            system: Some("You are helpful.".to_string()),
            tools: None,
            tool_choice: None,
            stream: false,
        };

        let payload = build_chat_completion_request(&request, &config);

        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][0]["content"], "You are helpful.");
        assert_eq!(payload["messages"][1]["role"], "user");
    }

    #[test]
    fn test_build_chat_completion_request_with_tools() {
        let config = OpenAiCompatConfig::openai("test-key");
        let request = MessageRequest {
            model: "gpt-4".to_string(),
            max_tokens: 100,
            messages: vec![InputMessage::user_text("What's the weather?")],
            system: None,
            tools: Some(vec![ToolDefinition {
                name: "get_weather".to_string(),
                description: Some("Get weather info".to_string()),
                input_schema: json!({"type": "object"}),
            }]),
            tool_choice: Some(ToolChoice::Auto),
            stream: false,
        };

        let payload = build_chat_completion_request(&request, &config);

        assert_eq!(payload["tools"][0]["type"], "function");
        assert_eq!(payload["tools"][0]["function"]["name"], "get_weather");
        assert_eq!(payload["tool_choice"], "auto");
    }

    #[test]
    fn test_translate_message_user() {
        let msg = InputMessage::user_text("Hello");
        let translated = translate_message(&msg);

        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0]["role"], "user");
        assert_eq!(translated[0]["content"], "Hello");
    }

    #[test]
    fn test_translate_message_assistant() {
        let msg = InputMessage {
            role: "assistant".to_string(),
            content: vec![InputContentBlock::Text {
                text: "Hi there!".to_string(),
            }],
        };
        let translated = translate_message(&msg);

        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0]["role"], "assistant");
        assert_eq!(translated[0]["content"], "Hi there!");
    }

    #[test]
    fn test_parse_tool_arguments() {
        assert_eq!(
            parse_tool_arguments("{\"city\":\"Paris\"}"),
            json!({"city": "Paris"})
        );
        assert_eq!(parse_tool_arguments("not-json"), json!({"raw": "not-json"}));
    }
}
