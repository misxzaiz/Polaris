//! 请求处理器
//!
//! 处理 Claude CLI 发来的 Anthropic Messages API 请求，
//! 转换为 OpenAI Chat Completions 格式并转发。

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

use super::codex_chat::{
    chat_sse_to_codex_responses_sse, chat_to_codex_response, codex_responses_to_chat,
};
use super::forwarder::{forward_raw_response, ForwarderConfig, ProxyWireApi};
use super::transform::{
    anthropic_to_openai, anthropic_to_responses, openai_to_anthropic, responses_to_anthropic,
};

/// 代理服务器共享状态
#[derive(Debug, Clone)]
pub struct ProxyState {
    /// 上游转发配置
    pub forwarder: ForwarderConfig,
}

/// 处理 Anthropic Messages API 请求
///
/// `POST /v1/messages`
pub async fn handle_messages(
    State(state): State<ProxyState>,
    _headers: HeaderMap,
    body: String,
) -> Response {
    // 解析 Anthropic 请求
    let anthropic_body: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[Proxy] 请求 JSON 解析失败: {}", e);
            return error_response(StatusCode::BAD_REQUEST, &format!("无效的 JSON 请求: {}", e));
        }
    };

    // 检查是否为流式请求
    let is_streaming = anthropic_body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 根据线路格式转换 Anthropic → 上游（Chat Completions / Responses）
    let upstream_result = match state.forwarder.wire_api {
        ProxyWireApi::Responses => anthropic_to_responses(anthropic_body),
        ProxyWireApi::ChatCompletions => anthropic_to_openai(anthropic_body),
        ProxyWireApi::CodexResponsesToChatCompletions => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Codex Responses 代理模式请使用 /v1/responses 入口",
            );
        }
    };
    let openai_body = match upstream_result {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[Proxy] 格式转换失败: {}", e);
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("格式转换失败: {}", e));
        }
    };

    tracing::info!(
        "[Proxy] 转换后请求: model={}, stream={}, messages={}, tools={}",
        openai_body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
        is_streaming,
        openai_body
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        openai_body
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    );

    // 调试：将转换后的请求体写入临时文件
    if let Ok(body_str) = serde_json::to_string_pretty(&openai_body) {
        let debug_path = std::env::temp_dir().join("polaris-proxy-request-debug.json");
        let _ = std::fs::write(&debug_path, &body_str);
        tracing::debug!("[Proxy] 转换后请求体已写入: {:?}", debug_path);
    }

    let start = std::time::Instant::now();
    let result = if is_streaming {
        handle_streaming(state, openai_body).await
    } else {
        handle_non_streaming(state, openai_body).await
    };
    tracing::info!("[Proxy] 请求处理完成，耗时: {:?}", start.elapsed());
    result
}

/// 处理 Codex/OpenAI Responses API 请求
///
/// `POST /v1/responses` 或 `POST /responses`
pub async fn handle_responses(
    State(state): State<ProxyState>,
    _headers: HeaderMap,
    body: String,
) -> Response {
    if state.forwarder.wire_api != ProxyWireApi::CodexResponsesToChatCompletions {
        return error_response(
            StatusCode::BAD_REQUEST,
            "当前代理不是 Codex Responses 转 Chat Completions 模式",
        );
    }

    let responses_body: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[Proxy] Codex Responses JSON 解析失败: {}", e);
            return error_response(StatusCode::BAD_REQUEST, &format!("无效的 JSON 请求: {}", e));
        }
    };

    let is_streaming = responses_body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let chat_body = match codex_responses_to_chat(responses_body) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[Proxy] Codex Responses 转 Chat 失败: {}", e);
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("格式转换失败: {}", e));
        }
    };

    tracing::info!(
        "[Proxy] Codex Responses 转 Chat: model={}, stream={}, messages={}, tools={}",
        chat_body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
        is_streaming,
        chat_body
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        chat_body
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    );

    if is_streaming {
        handle_codex_streaming(state, chat_body).await
    } else {
        handle_codex_non_streaming(state, chat_body).await
    }
}

async fn handle_codex_non_streaming(state: ProxyState, chat_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &chat_body).await {
        Ok(response) => match response.text().await {
            Ok(body_text) => match serde_json::from_str::<Value>(&body_text) {
                Ok(chat_response) => match chat_to_codex_response(chat_response) {
                    Ok(responses_response) => Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(serde_json::to_string(&responses_response).unwrap_or_default()))
                        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建响应失败")),
                    Err(e) => {
                        tracing::error!("[Proxy] Chat 响应转 Codex Responses 失败: {}", e);
                        error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("响应格式转换失败: {}", e))
                    }
                },
                Err(e) => {
                    tracing::error!("[Proxy] Codex 上游 Chat 响应 JSON 解析失败: {}", e);
                    error_response(StatusCode::BAD_GATEWAY, &format!("上游响应无效 JSON: {}", e))
                }
            },
            Err(e) => error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e)),
        },
        Err(e) => {
            tracing::error!("[Proxy] Codex 上游请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            error_response(status, &format!("上游请求失败: {}", e))
        }
    }
}

async fn handle_codex_streaming(state: ProxyState, chat_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &chat_body).await {
        Ok(response) => match response.bytes().await {
            Ok(body_bytes) => {
                let body_str = String::from_utf8_lossy(&body_bytes);
                let sse_body = chat_sse_to_codex_responses_sse(&body_str);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .header("Cache-Control", "no-cache")
                    .body(Body::from(sse_body))
                    .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建流式响应失败"))
            }
            Err(e) => error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e)),
        },
        Err(e) => {
            tracing::error!("[Proxy] Codex 上游流式请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            error_response(status, &format!("上游请求失败: {}", e))
        }
    }
}

/// 处理非流式请求
async fn handle_non_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body).await {
        Ok(response) => {
            let status = response.status();
            match response.text().await {
                Ok(body_text) => {
                    match serde_json::from_str::<Value>(&body_text) {
                        Ok(openai_response) => {
                            let converted = match state.forwarder.wire_api {
                                ProxyWireApi::Responses => responses_to_anthropic(openai_response),
                                ProxyWireApi::ChatCompletions => openai_to_anthropic(openai_response),
                                ProxyWireApi::CodexResponsesToChatCompletions => {
                                    return error_response(
                                        StatusCode::BAD_REQUEST,
                                        "Codex Responses 代理模式请使用 /v1/responses 入口",
                                    );
                                }
                            };
                            match converted {
                                Ok(anthropic_response) => {
                                    let json_str =
                                        serde_json::to_string(&anthropic_response).unwrap_or_default();
                                    Response::builder()
                                        .status(StatusCode::OK)
                                        .header("Content-Type", "application/json")
                                        .body(Body::from(json_str))
                                        .unwrap_or_else(|_| {
                                            error_response(
                                                StatusCode::INTERNAL_SERVER_ERROR,
                                                "构建响应失败",
                                            )
                                        })
                                }
                                Err(e) => {
                                    tracing::error!("[Proxy] 响应格式转换失败: {}", e);
                                    error_response(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        &format!("响应格式转换失败: {}", e),
                                    )
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!(
                                "[Proxy] 上游响应 JSON 解析失败 (status={}): {}",
                                status,
                                e
                            );
                            error_response(
                                StatusCode::BAD_GATEWAY,
                                &format!("上游响应无效 JSON: {}", e),
                            )
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[Proxy] 读取上游响应失败: {}", e);
                    error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e))
                }
            }
        }
        Err(e) => {
            tracing::error!("[Proxy] 上游请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            error_response(status, &format!("上游请求失败: {}", e))
        }
    }
}

/// 累积的工具调用状态
#[derive(Default, Debug, Clone)]
struct AccumulatedToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// 流式收集的中间结果（Chat / Responses 解析统一产出，供阶段二复用）
struct StreamCollected {
    message_id: String,
    model: String,
    stop_reason: String,
    usage_json: Value,
    content_deltas: Vec<ContentDelta>,
    tool_calls: Vec<AccumulatedToolCall>,
}

/// 内容 delta 类型（保持原始顺序）
#[derive(Debug)]
enum ContentDelta {
    Text(String),
    Thinking(String),
}

/// 当前活跃的非 tool content block 状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveBlock {
    None,
    Text,
    Thinking,
}

/// 处理流式请求
///
/// 收集完整的上游响应体，转换为 Anthropic 格式后一次性返回。
/// 使用状态机将连续的 text/reasoning chunks 合并到同一个 content_block，
/// 避免每个 chunk 独立成块导致 markdown 渲染（表格、代码块、列表等）断裂。
async fn handle_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body).await {
        Ok(response) => {
            let body_bytes = match response.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!("[Proxy] 读取上游流式响应体失败: {}", e);
                    return error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e));
                }
            };

            let body_str = String::from_utf8_lossy(&body_bytes);
            tracing::info!("[Proxy] 上游流式响应: {}bytes, {}lines", body_bytes.len(), body_str.lines().count());

            // --- 第一阶段：根据线路格式收集 chunk 数据 ---
            let StreamCollected {
                message_id,
                model,
                mut stop_reason,
                usage_json,
                content_deltas,
                tool_calls,
            } = match state.forwarder.wire_api {
                ProxyWireApi::Responses => collect_from_responses_sse(&body_str),
                ProxyWireApi::ChatCompletions => collect_from_chat_sse(&body_str),
                ProxyWireApi::CodexResponsesToChatCompletions => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "Codex Responses 代理模式请使用 /v1/responses 入口",
                    );
                }
            };

            // --- 第二阶段：用状态机生成 Anthropic SSE 事件 ---
            // 核心：连续的同类型 delta 合并到同一个 content_block
            let mut events: Vec<serde_json::Value> = Vec::new();
            let mut next_index: u32 = 0;
            let mut active_block = ActiveBlock::None;
            let mut has_content = false;

            // 确保 message_start 已发出
            let ensure_message_start = |events: &mut Vec<Value>, has_content: &mut bool| {
                if !*has_content {
                    *has_content = true;
                    events.push(json!({
                        "event": "message_start",
                        "data": {
                            "type": "message_start",
                            "message": {
                                "id": message_id,
                                "type": "message",
                                "role": "assistant",
                                "model": model,
                                "usage": {"input_tokens": 0, "output_tokens": 0}
                            }
                        }
                    }));
                }
            };

            // 关闭当前活跃 block
            let close_block = |events: &mut Vec<Value>, active: &mut ActiveBlock, index: &mut u32| {
                if *active != ActiveBlock::None {
                    events.push(json!({
                        "event": "content_block_stop",
                        "data": {"type": "content_block_stop", "index": *index}
                    }));
                    *index += 1;
                    *active = ActiveBlock::None;
                }
            };

            // 开启新的 text block
            let open_text_block = |events: &mut Vec<Value>, active: &mut ActiveBlock, index: u32| {
                events.push(json!({
                    "event": "content_block_start",
                    "data": {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": {"type": "text", "text": ""}
                    }
                }));
                *active = ActiveBlock::Text;
            };

            // 开启新的 thinking block
            let open_thinking_block = |events: &mut Vec<Value>, active: &mut ActiveBlock, index: u32| {
                events.push(json!({
                    "event": "content_block_start",
                    "data": {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": {"type": "thinking", "thinking": ""}
                    }
                }));
                *active = ActiveBlock::Thinking;
            };

            // 处理所有内容 delta
            for delta in &content_deltas {
                match delta {
                    ContentDelta::Text(text) => {
                        ensure_message_start(&mut events, &mut has_content);
                        if active_block != ActiveBlock::Text {
                            close_block(&mut events, &mut active_block, &mut next_index);
                            open_text_block(&mut events, &mut active_block, next_index);
                        }
                        events.push(json!({
                            "event": "content_block_delta",
                            "data": {
                                "type": "content_block_delta",
                                "index": next_index,
                                "delta": {"type": "text_delta", "text": text}
                            }
                        }));
                    }
                    ContentDelta::Thinking(thinking) => {
                        ensure_message_start(&mut events, &mut has_content);
                        if active_block != ActiveBlock::Thinking {
                            close_block(&mut events, &mut active_block, &mut next_index);
                            open_thinking_block(&mut events, &mut active_block, next_index);
                        }
                        events.push(json!({
                            "event": "content_block_delta",
                            "data": {
                                "type": "content_block_delta",
                                "index": next_index,
                                "delta": {"type": "thinking_delta", "thinking": thinking}
                            }
                        }));
                    }
                }
            }

            // 关闭最后一个非 tool block
            close_block(&mut events, &mut active_block, &mut next_index);

            // --- 生成 tool_use content blocks ---
            let tool_call_count = tool_calls.len();
            if !tool_calls.is_empty() {
                ensure_message_start(&mut events, &mut has_content);
                for tc in tool_calls {
                    let input: Value = serde_json::from_str(&tc.arguments).unwrap_or_else(|e| {
                        tracing::warn!("[Proxy] 工具调用 arguments JSON 解析失败 ({}): {}", e, &tc.arguments[..tc.arguments.len().min(200)]);
                        json!({})
                    });
                    tracing::info!("[Proxy] 生成 tool_use block: id={}, name={}, args_len={}", tc.id, tc.name, tc.arguments.len());

                    events.push(json!({
                        "event": "content_block_start",
                        "data": {
                            "type": "content_block_start",
                            "index": next_index,
                            "content_block": {"type": "tool_use", "id": tc.id, "name": tc.name, "input": {}}
                        }
                    }));
                    if !tc.arguments.is_empty() && tc.arguments != "{}" {
                        events.push(json!({
                            "event": "content_block_delta",
                            "data": {
                                "type": "content_block_delta",
                                "index": next_index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string())
                                }
                            }
                        }));
                    }
                    events.push(json!({
                        "event": "content_block_stop",
                        "data": {"type": "content_block_stop", "index": next_index}
                    }));
                    next_index += 1;
                }
                stop_reason = "tool_use".to_string();
            }

            // 空响应 fallback
            if !has_content {
                events.push(json!({
                    "event": "message_start",
                    "data": {
                        "type": "message_start",
                        "message": {
                            "id": message_id, "type": "message", "role": "assistant",
                            "model": model, "usage": {"input_tokens": 0, "output_tokens": 0}
                        }
                    }
                }));
                events.push(json!({"event": "content_block_start", "data": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}));
                events.push(json!({"event": "content_block_stop", "data": {"type": "content_block_stop", "index": 0}}));
            }

            // message_delta + message_stop
            events.push(json!({"event": "message_delta", "data": {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": null}, "usage": usage_json}}));
            events.push(json!({"event": "message_stop", "data": {"type": "message_stop"}}));

            tracing::info!("[Proxy] 生成 {} 个 Anthropic SSE 事件 (text_deltas={}, tool_calls={})",
                events.len(), content_deltas.len(), tool_call_count);

            // 构建 SSE 响应体
            let mut sse_body = String::new();
            for event in &events {
                let event_name = event["event"].as_str().unwrap_or("message");
                let event_data = serde_json::to_string(&event["data"]).unwrap_or_default();
                sse_body.push_str(&format!("event: {}\ndata: {}\n\n", event_name, event_data));
            }

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .body(Body::from(sse_body))
                .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建流式响应失败"))
        }
        Err(e) => {
            tracing::error!("[Proxy] 上游流式请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            error_response(status, &format!("上游请求失败: {}", e))
        }
    }
}

/// 从 OpenAI Chat Completions SSE 流收集中间数据
fn collect_from_chat_sse(body_str: &str) -> StreamCollected {
    let mut message_id = String::from("msg_proxy");
    let mut model = String::from("unknown");
    let mut stop_reason = String::from("end_turn");
    let mut usage_json = json!({"input_tokens": 0, "output_tokens": 0});
    let mut tool_calls_map: std::collections::HashMap<usize, AccumulatedToolCall> =
        std::collections::HashMap::new();
    let mut content_deltas: Vec<ContentDelta> = Vec::new();

    for line in body_str.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(d) => d.trim(),
            None => continue,
        };
        if data == "[DONE]" {
            break;
        }

        let chunk: super::models::OpenAIStreamChunk = match serde_json::from_str(data) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[Proxy] 跳过无法解析的 chunk: {} - {}", e, &data[..data.len().min(100)]);
                continue;
            }
        };

        if !chunk.id.is_empty() {
            message_id = chunk.id.clone();
        }
        if !chunk.model.is_empty() {
            model = chunk.model.clone();
        }
        if let Some(u) = &chunk.usage {
            usage_json = json!({"input_tokens": u.prompt_tokens, "output_tokens": u.completion_tokens});
        }
        if chunk.choices.is_empty() {
            continue;
        }

        if let Some(choice) = chunk.choices.first() {
            if let Some(content) = &choice.delta.content {
                if !content.is_empty() {
                    content_deltas.push(ContentDelta::Text(content.clone()));
                }
            }
            if let Some(r) = &choice.delta.reasoning {
                if !r.is_empty() {
                    content_deltas.push(ContentDelta::Thinking(r.clone()));
                }
            }
            if let Some(ref delta_tool_calls) = choice.delta.tool_calls {
                for dtc in delta_tool_calls {
                    let entry = tool_calls_map.entry(dtc.index).or_default();
                    if let Some(ref id) = dtc.id {
                        if !id.is_empty() {
                            entry.id = id.clone();
                        }
                    }
                    if let Some(ref func) = dtc.function {
                        if let Some(ref name) = func.name {
                            if !name.is_empty() {
                                entry.name = name.clone();
                            }
                        }
                        if let Some(ref args) = func.arguments {
                            entry.arguments.push_str(args);
                        }
                    }
                }
            }
            if let Some(fr) = &choice.finish_reason {
                stop_reason = match fr.as_str() {
                    "stop" => "end_turn".to_string(),
                    "length" => "max_tokens".to_string(),
                    "tool_calls" => "tool_use".to_string(),
                    _ => "end_turn".to_string(),
                };
            }
        }
    }

    let mut sorted: Vec<(usize, AccumulatedToolCall)> = tool_calls_map.into_iter().collect();
    sorted.sort_by_key(|(i, _)| *i);
    let tool_calls = sorted.into_iter().map(|(_, tc)| tc).collect();

    StreamCollected {
        message_id,
        model,
        stop_reason,
        usage_json,
        content_deltas,
        tool_calls,
    }
}

/// 从 OpenAI Responses SSE 流收集中间数据
///
/// 解析 Responses 专有事件：output_text.delta / reasoning_summary_text.delta /
/// output_item.added / function_call_arguments.delta / output_item.done /
/// response.completed|incomplete（usage / 状态）。
fn collect_from_responses_sse(body_str: &str) -> StreamCollected {
    let mut message_id = String::from("msg_proxy");
    let mut model = String::from("unknown");
    let mut stop_reason = String::from("end_turn");
    let mut usage_json = json!({"input_tokens": 0, "output_tokens": 0});
    let mut content_deltas: Vec<ContentDelta> = Vec::new();
    // function_call 累积：item_id -> AccumulatedToolCall（id 字段存 call_id）
    let mut fc_map: std::collections::HashMap<String, AccumulatedToolCall> =
        std::collections::HashMap::new();
    let mut fc_order: Vec<String> = Vec::new();

    for line in body_str.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(d) => d.trim(),
            None => continue,
        };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }

        let event: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "response.output_text.delta" => {
                if let Some(d) = event.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        content_deltas.push(ContentDelta::Text(d.to_string()));
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(d) = event.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        content_deltas.push(ContentDelta::Thinking(d.to_string()));
                    }
                }
            }
            "response.output_item.added" => {
                if let Some(item) = event.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                        let item_id = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !item_id.is_empty() {
                            let call_id = item
                                .get("call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !fc_order.contains(&item_id) {
                                fc_order.push(item_id.clone());
                            }
                            fc_map.insert(
                                item_id,
                                AccumulatedToolCall {
                                    id: call_id,
                                    name,
                                    arguments: String::new(),
                                },
                            );
                        }
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(item_id) = event.get("item_id").and_then(|v| v.as_str()) {
                    if let Some(entry) = fc_map.get_mut(item_id) {
                        if let Some(d) = event.get("delta").and_then(|d| d.as_str()) {
                            entry.arguments.push_str(d);
                        }
                    }
                }
            }
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                        let item_id = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !item_id.is_empty() {
                            if !fc_order.contains(&item_id) {
                                fc_order.push(item_id.clone());
                            }
                            let entry = fc_map.entry(item_id).or_default();
                            if let Some(call_id) = item.get("call_id").and_then(|v| v.as_str()) {
                                if !call_id.is_empty() {
                                    entry.id = call_id.to_string();
                                }
                            }
                            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                                if !name.is_empty() {
                                    entry.name = name.to_string();
                                }
                            }
                            if let Some(args) = item.get("arguments").and_then(|v| v.as_str()) {
                                if !args.is_empty() {
                                    entry.arguments = args.to_string();
                                }
                            }
                        }
                    }
                }
            }
            "response.created"
            | "response.in_progress"
            | "response.completed"
            | "response.incomplete" => {
                if let Some(resp) = event.get("response") {
                    if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                        if !id.is_empty() {
                            message_id = id.to_string();
                        }
                    }
                    if let Some(m) = resp.get("model").and_then(|v| v.as_str()) {
                        if !m.is_empty() {
                            model = m.to_string();
                        }
                    }
                    if let Some(u) = resp.get("usage") {
                        let it = u.get("input_tokens").cloned().unwrap_or(json!(0));
                        let ot = u.get("output_tokens").cloned().unwrap_or(json!(0));
                        usage_json = json!({"input_tokens": it, "output_tokens": ot});
                    }
                    if event_type == "response.incomplete"
                        && resp
                            .pointer("/incomplete_details/reason")
                            .and_then(|v| v.as_str())
                            == Some("max_output_tokens")
                    {
                        stop_reason = "max_tokens".to_string();
                    }
                }
            }
            _ => {}
        }
    }

    let mut tool_calls: Vec<AccumulatedToolCall> = Vec::new();
    for item_id in &fc_order {
        if let Some(tc) = fc_map.get(item_id) {
            let mut tc = tc.clone();
            if tc.id.is_empty() {
                tc.id = item_id.clone();
            }
            tool_calls.push(tc);
        }
    }
    if !tool_calls.is_empty() {
        stop_reason = "tool_use".to_string();
    }

    StreamCollected {
        message_id,
        model,
        stop_reason,
        usage_json,
        content_deltas,
        tool_calls,
    }
}

/// 构建错误响应
fn error_response(status: StatusCode, message: &str) -> Response {
    let error_body = serde_json::json!({
        "type": "error",
        "error": {
            "type": "api_error",
            "message": message
        }
    });
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(
            serde_json::to_string(&error_body).unwrap_or_default(),
        ))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .unwrap()
        })
}
