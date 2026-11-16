//! StreamState/流式增量解析（K-R1 拆分）

use serde_json::json;
use std::collections::HashMap;
use serde_json::Value;
use super::wire::WireProtocol;
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
/// - OpenAIChat：末包 `usage{prompt_tokens, completion_tokens, total_tokens}`，
///   缓存读取取 `prompt_tokens_details.cached_tokens`（DeepSeek/GLM 变体
///   `prompt_cache_hit_tokens`）。
/// - Anthropic：`message_start.message.usage.input_tokens` +
///   `message_delta.usage.output_tokens`（分两次累积）；缓存字段
///   `cache_creation_input_tokens` / `cache_read_input_tokens` 在 start/delta
///   的 usage 中按需出现，后到覆盖先到。部分网关的 delta 还会回带修正后的
///   `input_tokens`（start 值为预估），同样后到覆盖，避免口径混用。
/// - Responses：`response.completed.response.usage`，缓存读取取
///   `input_tokens_details.cached_tokens`。
#[derive(Debug, Default, Clone, Copy)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    /// 命中缓存读取的输入 token（供应商以更低单价计费）。
    pub cache_read: u64,
    /// 写入缓存的输入 token（缓存创建）。
    pub cache_creation: u64,
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
    /// 累积中的响应侧实际模型名（OpenAI 顶层 `model`、Anthropic `message.model`、
    /// Responses `response.model`；逐 chunk 覆盖取最近值）。
    stream_model: Option<String>,
    /// 流末终止原因（统一为 OpenAI 语义：stop / length / tool_calls / ...）。
    /// Anthropic 的 max_tokens、Responses 的 incomplete(max_output_tokens) 归一化为 "length"。
    finish_reason: Option<String>,
}

impl StreamState {
    pub fn new(protocol: WireProtocol) -> Self {
        Self {
            protocol,
            tool_calls: Vec::new(),
            block_index: HashMap::new(),
            item_index: HashMap::new(),
            usage: None,
            stream_model: None,
            finish_reason: None,
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

    /// 取出累积的响应侧实际模型名（透传模型名时可能与请求模型不同）。
    /// 未在响应中观测到时为 `None`（上游/MCP 网关不回填 `model` 字段的场景）。
    pub fn finish_actual_model(&self) -> Option<String> {
        self.stream_model.clone()
    }

    /// 取出流末终止原因（统一 OpenAI 语义；"length" 表示被 max_tokens 截断）。
    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }

    fn feed_openai_chat(&mut self, chunk: &Value, out: &mut Vec<StreamDelta>) {
        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];

        // 内容：str 直接用；部分网关变体返回 parts 数组（type=text 的 text 拼接）。
        match &delta["content"] {
            Value::String(content) => {
                if !content.is_empty() {
                    out.push(StreamDelta::Text(content.clone()));
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        if !t.is_empty() {
                            out.push(StreamDelta::Text(t.to_string()));
                        }
                    }
                }
            }
            _ => {}
        }
        // 思考：依序兼容 reasoning_content（DeepSeek/GLM/vLLM）→ reasoning（SenseNova/
        // OpenRouter/xAI/Groq）→ thinking（少数变体）。对象型变体 as_str()=None 自动跳过。
        let thinking = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
            .or_else(|| delta["thinking"].as_str());
        if let Some(thinking) = thinking {
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
        // 流末终止原因（tool_calls / stop / length）。
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            if !fr.is_empty() {
                self.finish_reason = Some(fr.to_string());
            }
        }
        // OpenAIChat：末包带 usage（需请求 stream_options.include_usage）。
        if let Some(u) = chunk.get("usage").filter(|v| v.is_object()) {
            // 缓存读取：标准 `prompt_tokens_details.cached_tokens`；兼容 DeepSeek/GLM
            // 等 `prompt_cache_hit_tokens` 变体（部分网关仅回填其一）。
            let cache_read = u["prompt_tokens_details"]["cached_tokens"]
                .as_u64()
                .or_else(|| u["prompt_cache_hit_tokens"].as_u64())
                .unwrap_or(0);
            // 缓存写入：`prompt_tokens_details.cached_tokens` 无此分类，部分网关回填
            // `prompt_cache_miss_tokens`（未命中即写入缓存的输入）；无则记 0。
            let cache_creation = u["prompt_tokens_details"]["cache_creation_tokens"]
                .as_u64()
                .or_else(|| u["prompt_cache_miss_tokens"].as_u64())
                .unwrap_or(0);
            self.usage = Some(Usage {
                input_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
                cache_read,
                cache_creation,
            });
        }
        // 响应侧实际模型：OpenAI 兼容流式末包顶层携带 `model`（非流式变体亦然）。
        if let Some(m) = chunk.get("model").and_then(|v| v.as_str()) {
            if !m.is_empty() {
                self.stream_model = Some(m.to_string());
            }
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
                let msg = &chunk["message"];
                let input = msg
                    .pointer("/usage/input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let mut usage = self.usage.unwrap_or_default();
                usage.input_tokens = input;
                // 缓存字段在 start/delta 的 usage 中按需出现（无命中时省略）。
                // 与 output_tokens 类似跨事件累积，后到覆盖先到。
                if let Some(c) = msg.pointer("/usage/cache_creation_input_tokens").and_then(|v| v.as_u64()) {
                    usage.cache_creation = c;
                }
                if let Some(c) = msg.pointer("/usage/cache_read_input_tokens").and_then(|v| v.as_u64()) {
                    usage.cache_read = c;
                }
                self.usage = Some(usage);
                // 响应侧实际模型：Anthropic message_start.message.model。
                if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                    if !m.is_empty() {
                        self.stream_model = Some(m.to_string());
                    }
                }
            }
            "message_delta" => {
                let output = chunk
                    .pointer("/usage/output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let mut usage = self.usage.unwrap_or_default();
                usage.output_tokens = output;
                // 部分网关（实测 CLIProxyAPI→sensenova 链路）在 message_delta.usage
                // 回带**修正后的 input_tokens**——message_start 里的是预估/未结算值。
                // 若不覆盖，input（start 口径）与 cache_read（delta 口径）混用，
                // 会把 ~99% 的真实缓存命中率统计成 ~50% 的假象
                // （取证记录见 docs/simpleai-prompt-cache-breakpoints-plan.md §9）。
                // 与下方缓存字段同策略：delta 携带即覆盖，未携带保持 start 值
                // （Anthropic 官方 API 的 delta 不带 input_tokens，行为不变）。
                if let Some(i) = chunk.pointer("/usage/input_tokens").and_then(|v| v.as_u64()) {
                    usage.input_tokens = i;
                }
                usage.total_tokens = usage.input_tokens + usage.output_tokens;
                // 部分端点把 cache_read/cache_creation 放在 message_delta.usage
                // （而非 message_start），同样覆盖式累积。
                if let Some(c) = chunk.pointer("/usage/cache_creation_input_tokens").and_then(|v| v.as_u64()) {
                    usage.cache_creation = c;
                }
                if let Some(c) = chunk.pointer("/usage/cache_read_input_tokens").and_then(|v| v.as_u64()) {
                    usage.cache_read = c;
                }
                self.usage = Some(usage);
                // stop_reason 归一化为 OpenAI 语义（max_tokens → length）。
                if let Some(sr) = chunk.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                    self.finish_reason = Some(match sr {
                        "max_tokens" => "length".to_string(),
                        "tool_use" => "tool_calls".to_string(),
                        other => other.to_string(),
                    });
                }
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
                    // 缓存读取：OpenAI Responses 在 `input_tokens_details.cached_tokens`。
                    // 缓存写入无标准字段，部分网关回填 `cache_creation_input_tokens`。
                    let cache_read = u["input_tokens_details"]["cached_tokens"]
                        .as_u64()
                        .unwrap_or(0);
                    let cache_creation = u["cache_creation_input_tokens"]
                        .as_u64()
                        .unwrap_or(0);
                    self.usage = Some(Usage {
                        input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                        output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                        total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
                        cache_read,
                        cache_creation,
                    });
                }
                // 响应侧实际模型：Responses response.completed.response.model。
                if let Some(m) = chunk.pointer("/response/model").and_then(|v| v.as_str()) {
                    if !m.is_empty() {
                        self.stream_model = Some(m.to_string());
                    }
                }
                if self.finish_reason.is_none() {
                    self.finish_reason = Some("stop".to_string());
                }
            }
            // 输出被 max_output_tokens 截断等未完成态，归一化为 "length"。
            "response.incomplete" => {
                let reason = chunk
                    .pointer("/response/incomplete_details/reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                self.finish_reason = Some(if reason == "max_output_tokens" {
                    "length".to_string()
                } else if reason.is_empty() {
                    "incomplete".to_string()
                } else {
                    reason.to_string()
                });
            }
            _ => {}
        }
    }
}