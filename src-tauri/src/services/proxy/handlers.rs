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

use super::forwarder::{forward_raw_response, ForwarderConfig};
use super::transform::{anthropic_to_openai, openai_to_anthropic};

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

    // 转换 Anthropic → OpenAI
    let openai_body = match anthropic_to_openai(anthropic_body) {
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

/// 处理非流式请求
async fn handle_non_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body).await {
        Ok(response) => {
            let status = response.status();
            match response.text().await {
                Ok(body_text) => {
                    match serde_json::from_str::<Value>(&body_text) {
                        Ok(openai_response) => {
                            match openai_to_anthropic(openai_response) {
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
#[derive(Default, Debug)]
struct AccumulatedToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// 处理流式请求
///
/// 收集完整的上游响应体，转换为 Anthropic 格式后一次性返回。
async fn handle_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body).await {
        Ok(response) => {
            // 收集完整的上游响应体
            let body_bytes = match response.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!("[Proxy] 读取上游流式响应体失败: {}", e);
                    return error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e));
                }
            };

            let body_str = String::from_utf8_lossy(&body_bytes);
            tracing::info!("[Proxy] 上游流式响应: {}bytes, {}lines", body_bytes.len(), body_str.lines().count());

            // 解析所有 SSE data 行为 OpenAI chunks，转换为 Anthropic 格式
            let mut anthropic_events: Vec<serde_json::Value> = Vec::new();
            let mut message_id = String::from("msg_proxy");
            let mut model = String::from("unknown");
            let mut next_content_index: u32 = 0;
            let mut has_emitted_content = false;
            let mut stop_reason = String::from("end_turn");
            let mut usage_json = json!({"input_tokens": 0, "output_tokens": 0});
            // 按 index 累积 tool_calls delta
            let mut tool_calls_map: std::collections::HashMap<usize, AccumulatedToolCall> =
                std::collections::HashMap::new();

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
                    usage_json = json!({
                        "input_tokens": u.prompt_tokens,
                        "output_tokens": u.completion_tokens
                    });
                }

                // 也检查 usage chunk（choices 为空数组）
                if chunk.choices.is_empty() {
                    continue;
                }

                if let Some(choice) = chunk.choices.first() {
                    // 首次有内容时发出 message_start
                    if !has_emitted_content {
                        has_emitted_content = true;
                        anthropic_events.push(json!({
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

                    // 文本内容
                    if let Some(content) = &choice.delta.content {
                        if !content.is_empty() {
                            anthropic_events.push(json!({
                                "event": "content_block_start",
                                "data": {
                                    "type": "content_block_start",
                                    "index": next_content_index,
                                    "content_block": {"type": "text", "text": ""}
                                }
                            }));
                            anthropic_events.push(json!({
                                "event": "content_block_delta",
                                "data": {
                                    "type": "content_block_delta",
                                    "index": next_content_index,
                                    "delta": {"type": "text_delta", "text": content}
                                }
                            }));
                            anthropic_events.push(json!({
                                "event": "content_block_stop",
                                "data": {"type": "content_block_stop", "index": next_content_index}
                            }));
                            next_content_index += 1;
                        }
                    }

                    // reasoning / thinking
                    let reasoning = choice.delta.reasoning.as_deref();
                    if let Some(r) = reasoning {
                        if !r.is_empty() {
                            anthropic_events.push(json!({
                                "event": "content_block_start",
                                "data": {
                                    "type": "content_block_start",
                                    "index": next_content_index,
                                    "content_block": {"type": "thinking", "thinking": ""}
                                }
                            }));
                            anthropic_events.push(json!({
                                "event": "content_block_delta",
                                "data": {
                                    "type": "content_block_delta",
                                    "index": next_content_index,
                                    "delta": {"type": "thinking_delta", "thinking": r}
                                }
                            }));
                            anthropic_events.push(json!({
                                "event": "content_block_stop",
                                "data": {"type": "content_block_stop", "index": next_content_index}
                            }));
                            next_content_index += 1;
                        }
                    }

                    // 累积 tool_calls delta
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

                    // finish_reason
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

            // --- 后处理：生成 tool_use content blocks ---
            if !tool_calls_map.is_empty() {
                // 确保 message_start 已发出
                if !has_emitted_content {
                    has_emitted_content = true;
                    anthropic_events.push(json!({
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

                // 按 index 排序保证顺序一致
                let mut sorted_calls: Vec<(usize, AccumulatedToolCall)> = tool_calls_map.into_iter().collect();
                sorted_calls.sort_by_key(|(i, _)| *i);

                for (_idx, tc) in sorted_calls {
                    // 解析累积的 arguments JSON 字符串
                    let input: Value = serde_json::from_str(&tc.arguments).unwrap_or_else(|e| {
                        tracing::warn!(
                            "[Proxy] 工具调用 arguments JSON 解析失败 ({}): {}",
                            e,
                            &tc.arguments[..tc.arguments.len().min(200)]
                        );
                        json!({})
                    });

                    tracing::info!(
                        "[Proxy] 生成 tool_use block: id={}, name={}, args_len={}",
                        tc.id, tc.name, tc.arguments.len()
                    );

                    anthropic_events.push(json!({
                        "event": "content_block_start",
                        "data": {
                            "type": "content_block_start",
                            "index": next_content_index,
                            "content_block": {
                                "type": "tool_use",
                                "id": tc.id,
                                "name": tc.name,
                                "input": {}
                            }
                        }
                    }));
                    // 只在有实际参数时发送 delta
                    if !tc.arguments.is_empty() && tc.arguments != "{}" {
                        anthropic_events.push(json!({
                            "event": "content_block_delta",
                            "data": {
                                "type": "content_block_delta",
                                "index": next_content_index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string())
                                }
                            }
                        }));
                    }
                    anthropic_events.push(json!({
                        "event": "content_block_stop",
                        "data": {"type": "content_block_stop", "index": next_content_index}
                    }));
                    next_content_index += 1;
                }

                // tool_calls 模式下强制 stop_reason 为 tool_use
                stop_reason = "tool_use".to_string();
            }

            // 如果没有发出任何内容（纯文本响应也为空），发出一个空文本块
            if !has_emitted_content {
                anthropic_events.push(json!({
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
                anthropic_events.push(json!({
                    "event": "content_block_start",
                    "data": {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""}
                    }
                }));
                anthropic_events.push(json!({
                    "event": "content_block_stop",
                    "data": {"type": "content_block_stop", "index": 0}
                }));
            }

            // 发出 message_delta + message_stop
            anthropic_events.push(json!({
                "event": "message_delta",
                "data": {
                    "type": "message_delta",
                    "delta": {"stop_reason": stop_reason, "stop_sequence": null},
                    "usage": usage_json
                }
            }));
            anthropic_events.push(json!({
                "event": "message_stop",
                "data": {"type": "message_stop"}
            }));

            tracing::info!("[Proxy] 生成 {} 个 Anthropic SSE 事件", anthropic_events.len());

            // 构建 SSE 响应体
            let mut sse_body = String::new();
            for event in &anthropic_events {
                let event_name = event["event"].as_str().unwrap_or("message");
                let event_data = serde_json::to_string(&event["data"]).unwrap_or_default();
                sse_body.push_str(&format!("event: {}\ndata: {}\n\n", event_name, event_data));
            }

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .body(Body::from(sse_body))
                .unwrap_or_else(|_| {
                    error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建流式响应失败")
                })
        }
        Err(e) => {
            tracing::error!("[Proxy] 上游流式请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            error_response(status, &format!("上游请求失败: {}", e))
        }
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
