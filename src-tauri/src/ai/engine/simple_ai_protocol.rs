/*! Simple AI 线路协议适配层
 *
 * SimpleAI 引擎内部统一以 **OpenAI Chat Completions** 格式维护消息历史与工具定义，
 * 本模块负责在「请求出口」与「响应入口」按 Profile 的 `wireApi` 适配三种线路协议：
 *
 * | 协议        | URL                | 鉴权                          | 请求体              | 流式事件                      |
 * |-------------|--------------------|-------------------------------|---------------------|-------------------------------|
 * | OpenAIChat  | /chat/completions  | Bearer                        | messages            | choices[].delta               |
 * | Anthropic   | /v1/messages       | x-api-key + anthropic-version | system + messages   | content_block_delta           |
 * | Responses   | /responses         | Bearer                        | instructions + input| response.output_*.delta       |
 *
 * 设计要点：
 * - 内部消息始终是 OpenAI 格式，仅在 [`build_request_body`] 时转换为目标协议格式；
 * - SSE 解析统一产出 [`StreamDelta`]（文本/思考增量），并在 [`StreamState`] 内累积工具调用，
 *   循环结束后 [`StreamState::finish_tool_calls`] 返回 OpenAI 格式 tool_calls，
 *   复用既有的工具执行与历史回写逻辑，三协议工具调用 ID 闭环一致。
 *
 * 鉴权头与 URL 后缀约定与 `services/model_profile_service.rs` 保持一致；
 * 消息/工具字段映射关系参考 `services/proxy/transform.rs`（方向相反）。
 */

use serde_json::{json, Value};
use std::collections::HashMap;

/// 默认 max_tokens（Anthropic 必填、Responses 建议填）。
const DEFAULT_MAX_TOKENS: u64 = 8192;

/// Anthropic API 版本头（与 model_profile_service 保持一致）。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

// ============================================================================
// 线路协议
// ============================================================================

/// 线路协议（由 `Profile.wireApi` 决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProtocol {
    /// OpenAI Chat Completions（`/chat/completions`）。
    OpenAIChat,
    /// Anthropic Messages（`/v1/messages`）。
    Anthropic,
    /// OpenAI Responses（`/responses`）。
    Responses,
}

impl WireProtocol {
    /// 从 Profile 的 `wireApi` 字符串解析。
    ///
    /// `None` / `"anthropic-messages"` → [`WireProtocol::Anthropic`]，
    /// 与 `ModelProfile` 的默认线路（anthropic-messages）保持一致。
    pub fn from_wire_api(s: Option<&str>) -> Self {
        match s {
            Some("openai-chat-completions") => WireProtocol::OpenAIChat,
            Some("openai-responses") => WireProtocol::Responses,
            _ => WireProtocol::Anthropic,
        }
    }

    /// 人类可读标识（日志用）。
    pub fn as_str(&self) -> &'static str {
        match self {
            WireProtocol::OpenAIChat => "openai-chat-completions",
            WireProtocol::Anthropic => "anthropic-messages",
            WireProtocol::Responses => "openai-responses",
        }
    }

    /// 构建完整上游 URL（智能补全路径后缀，与 model_profile_service 约定一致）。
    pub fn build_url(&self, base_url: &str) -> String {
        let base = base_url.trim_end_matches('/');
        match self {
            WireProtocol::OpenAIChat => {
                if base.ends_with("/chat/completions") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/chat/completions", base)
                } else {
                    format!("{}/v1/chat/completions", base)
                }
            }
            WireProtocol::Anthropic => {
                if base.ends_with("/messages") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/messages", base)
                } else {
                    format!("{}/v1/messages", base)
                }
            }
            WireProtocol::Responses => {
                if base.ends_with("/responses") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/responses", base)
                } else {
                    format!("{}/v1/responses", base)
                }
            }
        }
    }

    /// 该协议的鉴权请求头（键值对）。空 api_key 时不注入。
    pub fn auth_headers(&self, api_key: &str) -> Vec<(String, String)> {
        if api_key.is_empty() {
            return Vec::new();
        }
        match self {
            WireProtocol::Anthropic => vec![
                ("x-api-key".to_string(), api_key.to_string()),
                ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
            ],
            WireProtocol::OpenAIChat | WireProtocol::Responses => {
                vec![("Authorization".to_string(), format!("Bearer {}", api_key))]
            }
        }
    }
}

// ============================================================================
// 工具定义转换
// ============================================================================

/// 将内部 OpenAI Chat 工具定义（`{type:"function", function:{name,description,parameters}}`）
/// 转换为目标协议的工具定义。
pub fn tools_for_protocol(protocol: WireProtocol, openai_tools: &[Value]) -> Vec<Value> {
    match protocol {
        WireProtocol::OpenAIChat => openai_tools.to_vec(),
        WireProtocol::Anthropic => openai_tools
            .iter()
            .filter_map(|t| {
                let f = t.get("function")?;
                Some(json!({
                    "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "description": f.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    "input_schema": f
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                }))
            })
            .collect(),
        WireProtocol::Responses => openai_tools
            .iter()
            .filter_map(|t| {
                let f = t.get("function")?;
                let mut tool = json!({
                    "type": "function",
                    "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "parameters": f
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                });
                if let Some(desc) = f.get("description").and_then(|v| v.as_str()) {
                    if !desc.is_empty() {
                        tool["description"] = json!(desc);
                    }
                }
                Some(tool)
            })
            .collect(),
    }
}

// ============================================================================
// 请求体构建（内部 OpenAI messages → 目标协议请求体）
// ============================================================================

/// 构建流式请求体（`stream` 字段已内置为 `true`）。
pub fn build_request_body(
    protocol: WireProtocol,
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
) -> Value {
    match protocol {
        WireProtocol::OpenAIChat => build_openai_chat_body(model, messages, openai_tools),
        WireProtocol::Anthropic => build_anthropic_body(model, messages, openai_tools),
        WireProtocol::Responses => build_responses_body(model, messages, openai_tools),
    }
}

fn build_openai_chat_body(model: &str, messages: &[Value], tools: &[Value]) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        // 请求末包携带 usage（prompt_tokens/completion_tokens/total_tokens）。
        "stream_options": { "include_usage": true },
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    body
}

/// 内部 OpenAI messages → Anthropic Messages 请求体。
///
/// - `system` 角色提取为顶层 `system` 字段（多条拼接）；
/// - `assistant.tool_calls` → `content[]` 中的 `tool_use` block；
/// - `tool` 角色 → `user` turn 中的 `tool_result` block（连续工具结果合并到同一 user 消息，
///   满足 Anthropic 对 user/assistant 交替的要求）。
fn build_anthropic_body(model: &str, messages: &[Value], openai_tools: &[Value]) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        system_parts.push(text.to_string());
                    }
                }
            }
            "tool" => {
                let tool_use_id = msg
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                });
                // 合并到上一条 user 消息（若存在），否则新建 user turn。
                if let Some(last) = out.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            arr.push(block);
                            continue;
                        }
                    }
                }
                out.push(json!({ "role": "user", "content": [block] }));
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = tc
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let args_str = tc
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }
                // Anthropic 不接受空 content，回退一个空文本 block。
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            _ => {
                // user：content 透传；但 Anthropic 要求 user/assistant 严格交替，而 SimpleAI
                // 首轮会注入 environment_context + 项目指令 + 用户消息（连续多条 user）。
                // 故合并相邻 user 消息：字符串直接拼接；若上一条 user 的 content 已是数组
                // （如 tool_result block），则把本条文本作为 text block 追加进去。
                let content = msg.get("content").cloned().unwrap_or_else(|| json!(""));
                if let Some(text) = content.as_str() {
                    if let Some(last) = out.last_mut() {
                        if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                            if let Some(last_content) = last.get_mut("content") {
                                if let Some(prev) = last_content.as_str() {
                                    *last_content = json!(format!("{}\n\n{}", prev, text));
                                    continue;
                                }
                                if let Some(arr) = last_content.as_array_mut() {
                                    arr.push(json!({ "type": "text", "text": text }));
                                    continue;
                                }
                            }
                        }
                    }
                }
                out.push(json!({ "role": "user", "content": content }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "messages": out,
        "stream": true,
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }
    let tools = tools_for_protocol(WireProtocol::Anthropic, openai_tools);
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

/// 内部 OpenAI messages → OpenAI Responses 请求体。
///
/// - `system` → 顶层 `instructions`；
/// - `assistant.tool_calls` → `input[]` 中的 `function_call` item；
/// - `tool` 角色 → `function_call_output` item。
fn build_responses_body(model: &str, messages: &[Value], openai_tools: &[Value]) -> Value {
    let mut instructions_parts: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        instructions_parts.push(text.to_string());
                    }
                }
            }
            "tool" => {
                let call_id = msg
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let output = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }));
            }
            "assistant" => {
                if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        input.push(json!({ "role": "assistant", "content": text }));
                    }
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = tc
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let args = tc
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": args,
                        }));
                    }
                }
            }
            _ => {
                let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                input.push(json!({ "role": "user", "content": content }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "input": input,
        "max_output_tokens": DEFAULT_MAX_TOKENS,
        "stream": true,
    });
    if !instructions_parts.is_empty() {
        body["instructions"] = json!(instructions_parts.join("\n\n"));
    }
    let tools = tools_for_protocol(WireProtocol::Responses, openai_tools);
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

// ============================================================================
// 流式 SSE 解析
// ============================================================================

/// 流式增量（供调用方触发前端事件）。
#[derive(Debug, Clone, PartialEq)]
pub enum StreamDelta {
    /// 助手可见文本增量。
    Text(String),
    /// 思考过程增量。
    Thinking(String),
}

/// 单轮请求的 token 使用量（三协议统一表示）。
///
/// - OpenAIChat：末包 `usage{prompt_tokens, completion_tokens, total_tokens}`。
/// - Anthropic：`message_start.message.usage.input_tokens` +
///   `message_delta.usage.output_tokens`（分两次累积）。
/// - Responses：`response.completed.response.usage`。
#[derive(Debug, Default, Clone, Copy)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

/// 累积中的工具调用（统一中间表示）。
#[derive(Debug, Default, Clone)]
struct ToolCallAccum {
    id: String,
    name: String,
    arguments: String,
}

/// 流式解析状态机（按协议累积工具调用与文本/思考增量）。
///
/// 每个会话的每一轮请求新建一个实例，喂入 `data:` 行后的 JSON。
pub struct StreamState {
    protocol: WireProtocol,
    tool_calls: Vec<ToolCallAccum>,
    /// Anthropic：content block index → tool_calls 下标。
    block_index: HashMap<usize, usize>,
    /// Responses：output item id → tool_calls 下标。
    item_index: HashMap<String, usize>,
    /// 累积的 token usage（流末出现；Anthropic 的 input_tokens 在 message_start，
    /// output_tokens 在 message_delta，分两次更新）。
    usage: Option<Usage>,
}

impl StreamState {
    pub fn new(protocol: WireProtocol) -> Self {
        Self {
            protocol,
            tool_calls: Vec::new(),
            block_index: HashMap::new(),
            item_index: HashMap::new(),
            usage: None,
        }
    }

    /// 喂入一条 `data:` 行解析出的 JSON，返回需要推送给前端的增量。
    pub fn feed(&mut self, chunk: &Value) -> Vec<StreamDelta> {
        let mut out = Vec::new();
        match self.protocol {
            WireProtocol::OpenAIChat => self.feed_openai_chat(chunk, &mut out),
            WireProtocol::Anthropic => self.feed_anthropic(chunk, &mut out),
            WireProtocol::Responses => self.feed_responses(chunk, &mut out),
        }
        out
    }

    /// 取出累积的工具调用，转换为内部 OpenAI Chat 格式。
    ///
    /// 返回的结构可直接 push 进 `assistant.tool_calls`，并被既有工具执行逻辑消费，
    /// 保证三协议下工具调用 ID 闭环一致。
    pub fn finish_tool_calls(&self) -> Vec<Value> {
        self.tool_calls
            .iter()
            .filter(|tc| !tc.name.is_empty())
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": if tc.arguments.is_empty() {
                            "{}".to_string()
                        } else {
                            tc.arguments.clone()
                        },
                    }
                })
            })
            .collect()
    }

    /// 取出本轮累积的 token usage（流末有效）。
    pub fn finish_usage(&self) -> Option<Usage> {
        self.usage
    }

    fn feed_openai_chat(&mut self, chunk: &Value, out: &mut Vec<StreamDelta>) {
        let delta = &chunk["choices"][0]["delta"];

        if let Some(content) = delta["content"].as_str() {
            if !content.is_empty() {
                out.push(StreamDelta::Text(content.to_string()));
            }
        }
        if let Some(thinking) = delta["reasoning_content"].as_str() {
            if !thinking.is_empty() {
                out.push(StreamDelta::Thinking(thinking.to_string()));
            }
        }
        if let Some(tc_deltas) = delta["tool_calls"].as_array() {
            for tc_delta in tc_deltas {
                let index = tc_delta["index"].as_u64().unwrap_or(0) as usize;
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(ToolCallAccum::default());
                }
                let call = &mut self.tool_calls[index];
                if let Some(id) = tc_delta["id"].as_str() {
                    if !id.is_empty() {
                        call.id = id.to_string();
                    }
                }
                if let Some(name) = tc_delta["function"]["name"].as_str() {
                    call.name.push_str(name);
                }
                if let Some(args) = tc_delta["function"]["arguments"].as_str() {
                    call.arguments.push_str(args);
                }
            }
        }
        // OpenAIChat：末包带 usage（需请求 stream_options.include_usage）。
        if let Some(u) = chunk.get("usage").filter(|v| v.is_object()) {
            self.usage = Some(Usage {
                input_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
            });
        }
    }

    fn feed_anthropic(&mut self, chunk: &Value, out: &mut Vec<StreamDelta>) {
        let event_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match event_type {
            "content_block_start" => {
                let index = chunk.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let block = &chunk["content_block"];
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    self.tool_calls.push(ToolCallAccum {
                        id: block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        name: block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        arguments: String::new(),
                    });
                    self.block_index.insert(index, self.tool_calls.len() - 1);
                }
            }
            "content_block_delta" => {
                let index = chunk.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let delta = &chunk["delta"];
                match delta.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                out.push(StreamDelta::Text(t.to_string()));
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                out.push(StreamDelta::Thinking(t.to_string()));
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(pj) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            if let Some(&ti) = self.block_index.get(&index) {
                                self.tool_calls[ti].arguments.push_str(pj);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_start" => {
                let input = chunk
                    .pointer("/message/usage/input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let mut usage = self.usage.unwrap_or_default();
                usage.input_tokens = input;
                self.usage = Some(usage);
            }
            "message_delta" => {
                let output = chunk
                    .pointer("/usage/output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let mut usage = self.usage.unwrap_or_default();
                usage.output_tokens = output;
                usage.total_tokens = usage.input_tokens + usage.output_tokens;
                self.usage = Some(usage);
            }
            _ => {}
        }
    }

    fn feed_responses(&mut self, chunk: &Value, out: &mut Vec<StreamDelta>) {
        let event_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match event_type {
            "response.output_text.delta" => {
                if let Some(d) = chunk.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        out.push(StreamDelta::Text(d.to_string()));
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(d) = chunk.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        out.push(StreamDelta::Thinking(d.to_string()));
                    }
                }
            }
            "response.output_item.added" => {
                let item = &chunk["item"];
                if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                    let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if !item_id.is_empty() {
                        self.tool_calls.push(ToolCallAccum {
                            id: item
                                .get("call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            arguments: String::new(),
                        });
                        self.item_index.insert(item_id, self.tool_calls.len() - 1);
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(item_id) = chunk.get("item_id").and_then(|v| v.as_str()) {
                    if let Some(&ti) = self.item_index.get(item_id) {
                        if let Some(d) = chunk.get("delta").and_then(|d| d.as_str()) {
                            self.tool_calls[ti].arguments.push_str(d);
                        }
                    }
                }
            }
            "response.completed" => {
                if let Some(u) = chunk
                    .pointer("/response/usage")
                    .filter(|v| v.is_object())
                {
                    self.usage = Some(Usage {
                        input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                        output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                        total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
                    });
                }
            }
            _ => {}
        }
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tools() -> Vec<Value> {
        vec![json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a shell command",
                "parameters": {
                    "type": "object",
                    "properties": { "command": { "type": "string" } },
                    "required": ["command"]
                }
            }
        })]
    }

    #[test]
    fn openai_chat_usage_parsed_from_final_chunk() {
        let mut s = StreamState::new(WireProtocol::OpenAIChat);
        let chunk = json!({
            "choices": [],
            "usage": { "prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150 }
        });
        let _ = s.feed(&chunk);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.total_tokens, 150);
    }

    #[test]
    fn anthropic_usage_accumulated_across_messages() {
        let mut s = StreamState::new(WireProtocol::Anthropic);
        // message_start 携带 input_tokens。
        let start = json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 200 } }
        });
        let _ = s.feed(&start);
        let mid = s.finish_usage().expect("usage after start");
        assert_eq!(mid.input_tokens, 200);
        assert_eq!(mid.output_tokens, 0);

        // message_delta 携带 output_tokens；total 由二者相加。
        let delta = json!({
            "type": "message_delta",
            "usage": { "output_tokens": 80 }
        });
        let _ = s.feed(&delta);
        let final_usage = s.finish_usage().expect("usage after delta");
        assert_eq!(final_usage.input_tokens, 200);
        assert_eq!(final_usage.output_tokens, 80);
        assert_eq!(final_usage.total_tokens, 280);
    }

    #[test]
    fn responses_usage_parsed_from_completed_event() {
        let mut s = StreamState::new(WireProtocol::Responses);
        let chunk = json!({
            "type": "response.completed",
            "response": {
                "usage": { "input_tokens": 50, "output_tokens": 25, "total_tokens": 75 }
            }
        });
        let _ = s.feed(&chunk);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.input_tokens, 50);
        assert_eq!(usage.output_tokens, 25);
        assert_eq!(usage.total_tokens, 75);
    }

    #[test]
    fn from_wire_api_defaults_to_anthropic() {
        assert_eq!(WireProtocol::from_wire_api(None), WireProtocol::Anthropic);
        assert_eq!(
            WireProtocol::from_wire_api(Some("anthropic-messages")),
            WireProtocol::Anthropic
        );
        assert_eq!(
            WireProtocol::from_wire_api(Some("openai-chat-completions")),
            WireProtocol::OpenAIChat
        );
        assert_eq!(
            WireProtocol::from_wire_api(Some("openai-responses")),
            WireProtocol::Responses
        );
    }

    #[test]
    fn build_url_completes_suffix() {
        assert_eq!(
            WireProtocol::OpenAIChat.build_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            WireProtocol::OpenAIChat.build_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            WireProtocol::Anthropic.build_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            WireProtocol::Responses.build_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn auth_headers_per_protocol() {
        assert_eq!(
            WireProtocol::Anthropic.auth_headers("k"),
            vec![
                ("x-api-key".to_string(), "k".to_string()),
                ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
            ]
        );
        assert_eq!(
            WireProtocol::OpenAIChat.auth_headers("k"),
            vec![("Authorization".to_string(), "Bearer k".to_string())]
        );
        assert!(WireProtocol::OpenAIChat.auth_headers("").is_empty());
    }

    #[test]
    fn tools_convert_to_anthropic_input_schema() {
        let tools = tools_for_protocol(WireProtocol::Anthropic, &sample_tools());
        assert_eq!(tools[0]["name"], "bash");
        assert_eq!(tools[0]["input_schema"]["properties"]["command"]["type"], "string");
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn tools_convert_to_responses_flat() {
        let tools = tools_for_protocol(WireProtocol::Responses, &sample_tools());
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "bash");
        assert!(tools[0].get("parameters").is_some());
    }

    #[test]
    fn anthropic_body_splits_system_and_converts_tool_roundtrip() {
        let messages = vec![
            json!({ "role": "system", "content": "You are helpful" }),
            json!({ "role": "user", "content": "run ls" }),
            json!({
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{
                    "id": "toolu_1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "toolu_1", "content": "file.txt" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &sample_tools());

        assert_eq!(body["system"], "You are helpful");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        let msgs = body["messages"].as_array().unwrap();
        // system 不在 messages 中：user / assistant / user(tool_result)
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][1]["id"], "toolu_1");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "toolu_1");
    }

    #[test]
    fn responses_body_uses_instructions_and_function_items() {
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "done" }),
        ];
        let body = build_request_body(WireProtocol::Responses, "gpt-x", &messages, &sample_tools());

        assert_eq!(body["instructions"], "sys");
        assert_eq!(body["max_output_tokens"], DEFAULT_MAX_TOKENS);
        let input = body["input"].as_array().unwrap();
        assert!(input.iter().any(|i| i["type"] == "function_call" && i["call_id"] == "call_1"));
        assert!(input
            .iter()
            .any(|i| i["type"] == "function_call_output" && i["call_id"] == "call_1"));
    }

    #[test]
    fn openai_chat_stream_parses_text_and_tool_calls() {
        let mut state = StreamState::new(WireProtocol::OpenAIChat);
        let d1 = state.feed(&json!({ "choices": [{ "delta": { "content": "Hel" } }] }));
        assert_eq!(d1, vec![StreamDelta::Text("Hel".to_string())]);
        state.feed(&json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "id": "c1", "function": { "name": "bash", "arguments": "{\"cmd" }
        }] } }] }));
        state.feed(&json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "\":\"ls\"}" }
        }] } }] }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn anthropic_stream_parses_text_thinking_and_tool_use() {
        let mut state = StreamState::new(WireProtocol::Anthropic);
        let txt = state.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" }
        }));
        assert_eq!(txt, vec![StreamDelta::Text("Hi".to_string())]);

        let think = state.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "hmm" }
        }));
        assert_eq!(think, vec![StreamDelta::Thinking("hmm".to_string())]);

        state.feed(&json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_9", "name": "bash" }
        }));
        state.feed(&json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}" }
        }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["id"], "toolu_9");
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"command\":\"ls\"}");
    }

    #[test]
    fn responses_stream_parses_text_and_function_call() {
        let mut state = StreamState::new(WireProtocol::Responses);
        let txt = state.feed(&json!({ "type": "response.output_text.delta", "delta": "Yo" }));
        assert_eq!(txt, vec![StreamDelta::Text("Yo".to_string())]);

        state.feed(&json!({
            "type": "response.output_item.added",
            "item": { "type": "function_call", "id": "item_1", "call_id": "call_7", "name": "bash" }
        }));
        state.feed(&json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "item_1",
            "delta": "{\"command\":\"pwd\"}"
        }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["id"], "call_7");
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"command\":\"pwd\"}");
    }

    #[test]
    fn anthropic_body_merges_consecutive_user_messages() {
        // SimpleAI 首轮注入 environment_context + 项目指令 + 用户消息，连续三条 user。
        // Anthropic 要求 user/assistant 交替，故应合并为单条 user。
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "<environment_context>cwd</environment_context>" }),
            json!({ "role": "user", "content": "# Project instructions\nrules" }),
            json!({ "role": "user", "content": "actual question" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &[]);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        let c = msgs[0]["content"].as_str().unwrap();
        assert!(c.contains("environment_context"));
        assert!(c.contains("Project instructions"));
        assert!(c.contains("actual question"));
    }

    #[test]
    fn anthropic_body_appends_user_text_after_tool_result() {
        // tool_result 产生 user(content=[block])；随后的 user 文本应作为 text block 追加。
        let messages = vec![
            json!({ "role": "tool", "tool_call_id": "t1", "content": "result" }),
            json!({ "role": "user", "content": "follow-up" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &[]);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        let arr = msgs[0]["content"].as_array().unwrap();
        assert_eq!(arr[0]["type"], "tool_result");
        assert_eq!(arr[1]["type"], "text");
        assert_eq!(arr[1]["text"], "follow-up");
    }
}
