//! 请求处理器
//!
//! 处理 Claude CLI 发来的 Anthropic Messages API 请求，
//! 转换为 OpenAI Chat Completions 格式并转发。

use axum::{
    body::Body,
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

use super::codex_chat::{
    chat_sse_to_codex_responses_sse, chat_to_codex_response, codex_responses_to_chat,
};
use super::forwarder::{
    forward_raw_response, ForwarderConfig, ProxyWireApi, RequestPassthrough,
};
use super::sanitizer::{sanitize_anthropic_messages_body, AnthropicProviderCapability};
use super::transform::{
    anthropic_to_openai, anthropic_to_responses, openai_to_anthropic, responses_to_anthropic,
};

/// 从 OpenAI 响应中提取 usage 并记录到用量数据库
fn record_openai_usage(openai_body: &Value, request_model: Option<&str>, engine_id: Option<&str>, latency_ms: u64, status_code: u16, is_streaming: bool) {
    let model = openai_body.get("model").and_then(|v| v.as_str()).unwrap_or("unknown");
    let usage = openai_body.get("usage");
    if let Some(usage) = usage {
        let input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let output_tokens = usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let cache_read = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        // OpenAI 格式没有 cache_creation 字段，设为 0
        let cache_creation = 0;

        crate::services::usage_db::record_usage(
            model,
            request_model,
            engine_id,
            input_tokens,
            output_tokens,
            cache_read,
            cache_creation,
            latency_ms as i64,
            status_code as i64,
            is_streaming,
        );
    }
}

/// 从线路协议推断引擎标识
fn wire_api_to_engine(wire_api: ProxyWireApi) -> &'static str {
    match wire_api {
        ProxyWireApi::AnthropicMessages => "claude",
        ProxyWireApi::ChatCompletions => "claude",
        ProxyWireApi::Responses => "claude",
        ProxyWireApi::CodexResponsesToChatCompletions => "codex",
    }
}

/// 不透传给上游的入站请求头（小写）：
/// hop-by-hop 头由本地连接管理；认证头以 Profile 配置替换；
/// content-type / accept-encoding 由转发客户端自行设置。
const PASSTHROUGH_SKIP_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "content-type",
    "connection",
    "accept-encoding",
    "transfer-encoding",
    "authorization",
    "x-api-key",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "expect",
];

/// 过滤入站请求头，保留可安全透传给上游的部分
///
/// Claude CLI 的 `anthropic-beta`（1M 上下文等能力开关）、`user-agent`、
/// `x-app`、`x-stainless-*` 等都必须原样到达上游，否则部分供应商
/// 会拒绝请求或以不同能力集响应。
fn filter_passthrough_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !PASSTHROUGH_SKIP_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_string(), v.to_string()))
        })
        .collect()
}

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
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
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

    // 调试:把 claude CLI 发来的原始 Anthropic 请求体落盘(直通 + 转换模式均落盘)。
    // 用于诊断 Stop 后 400:对比 claude CLI 实际请求与 curl 重放请求的差异。
    // 路径:%TEMP%/polaris-proxy-<wire>-request-debug.json
    {
        let wire_tag = match state.forwarder.wire_api {
            ProxyWireApi::AnthropicMessages => "anthropic",
            ProxyWireApi::ChatCompletions => "chat",
            ProxyWireApi::Responses => "responses",
            ProxyWireApi::CodexResponsesToChatCompletions => "codex",
        };
        let debug_path = std::env::temp_dir()
            .join(format!("polaris-proxy-{}-request-debug.json", wire_tag));
        if let Ok(body_str) = serde_json::to_string_pretty(&anthropic_body) {
            let _ = std::fs::write(&debug_path, &body_str);
            tracing::info!(
                "[Proxy] 原始 Anthropic 请求体已落盘: {:?} (model={}, messages={}, tools={})",
                debug_path,
                anthropic_body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
                anthropic_body.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0),
                anthropic_body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0),
            );
        }
    }

    // 检查是否为流式请求
    let is_streaming = anthropic_body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if state.forwarder.wire_api == ProxyWireApi::AnthropicMessages {
        let sanitized_body = sanitize_anthropic_messages_body(
            anthropic_body,
            AnthropicProviderCapability {
                supports_server_tools: false,
            },
        );
        // 直通模式：透传客户端原始头（含 anthropic-beta 能力开关）与 query，
        // 使上游看到的请求与 CLI 直连时一致
        let passthrough = RequestPassthrough {
            headers: filter_passthrough_headers(&headers),
            query: raw_query,
        };
        tracing::info!(
            "[Proxy] Anthropic 直通净化请求: model={}, stream={}, messages={}, 透传头={}, beta={:?}",
            sanitized_body
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("?"),
            is_streaming,
            sanitized_body
                .get("messages")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0),
            passthrough.headers.len(),
            headers.get("anthropic-beta").and_then(|v| v.to_str().ok())
        );
        return handle_anthropic_passthrough(state, sanitized_body, is_streaming, passthrough)
            .await;
    }

    // 根据线路格式转换 Anthropic → 上游（Chat Completions / Responses）
    let upstream_result = match state.forwarder.wire_api {
        ProxyWireApi::Responses => anthropic_to_responses(anthropic_body),
        ProxyWireApi::ChatCompletions => anthropic_to_openai(anthropic_body),
        ProxyWireApi::AnthropicMessages => unreachable!("handled above"),
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
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("格式转换失败: {}", e),
            );
        }
    };

    tracing::info!(
        "[Proxy] 转换后请求: model={}, stream={}, messages={}, tools={}",
        openai_body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
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

async fn handle_anthropic_passthrough(
    state: ProxyState,
    body: Value,
    is_streaming: bool,
    passthrough: RequestPassthrough,
) -> Response {
    match forward_raw_response(&state.forwarder, &body, Some(&passthrough)).await {
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if is_streaming {
                        "text/event-stream".to_string()
                    } else {
                        "application/json".to_string()
                    }
                });

            match response.bytes().await {
                Ok(bytes) => {
                    // DX: 解析响应提取 usage 并记录到用量数据库（覆盖 Anthropic 直通路径）
                    let body_str = String::from_utf8_lossy(&bytes);
                    if !is_streaming {
                        if let Ok(body_json) = serde_json::from_str::<Value>(&body_str) {
                            if let Some(usage) = body_json.get("usage") {
                                let model = body_json.get("model")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");
                                let input_tokens = usage.get("input_tokens")
                                    .and_then(|v| v.as_i64()).unwrap_or(0);
                                let output_tokens = usage.get("output_tokens")
                                    .and_then(|v| v.as_i64()).unwrap_or(0);
                                let cache_read = usage.get("cache_read_input_tokens")
                                    .and_then(|v| v.as_i64()).unwrap_or(0);
                                let cache_creation = usage.get("cache_creation_input_tokens")
                                    .and_then(|v| v.as_i64()).unwrap_or(0);
                                let request_model = body.get("model")
                                    .and_then(|v| v.as_str());
                                tracing::debug!("[Proxy] Anthropic 直通记录 usage: model={}, input={}, output={}", model, input_tokens, output_tokens);
                                crate::services::usage_db::record_usage(
                                    model, request_model, Some("claude"), input_tokens, output_tokens,
                                    cache_read, cache_creation,
                                    0, status.as_u16() as i64, false,
                                );
                            }
                        }
                    } else {
                        for line in body_str.lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(event) = serde_json::from_str::<Value>(data) {
                                    if event.get("type").and_then(|v| v.as_str()) == Some("message_delta") {
                                        if let Some(usage) = event.get("usage") {
                                            let input_tokens = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                            let output_tokens = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                            let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                            let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                            let request_model = body.get("model").and_then(|v| v.as_str());
                                            let model = request_model.unwrap_or("unknown");
                                            tracing::debug!("[Proxy] Anthropic 直通流式记录 usage: model={}, input={}, output={}", model, input_tokens, output_tokens);
                                            crate::services::usage_db::record_usage(
                                                model, request_model, Some("claude"), input_tokens, output_tokens,
                                                cache_read, cache_creation,
                                                0, status.as_u16() as i64, true,
                                            );
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Response::builder()
                        .status(status)
                        .header("Content-Type", content_type)
                        .body(Body::from(bytes))
                        .unwrap_or_else(|_| {
                            error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建直通响应失败")
                        })
                }
                Err(e) => {
                    tracing::error!("[Proxy] 读取 Anthropic 直通上游响应失败: {}", e);
                    error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e))
                }
            }
        }
        Err(e) => {
            tracing::error!("[Proxy] Anthropic 直通上游请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            // P3:错误体透传上游原始 body,保留结构化错误码便于排查。
            // server_tool_use 场景仍追加 Polaris 提示(作为 x-polaris-hint header,
            // 不污染上游原始 body)。
            let hint = if e.to_string().contains("server_tool_use") {
                Some("上游拒绝 server_tool_use 历史块；请确认该会话已通过 Polaris 净化代理重试，或切换到支持 Anthropic server tools 的供应商。")
            } else {
                None
            };
            match e.upstream_body() {
                Some(body) => upstream_error_response(status, body, hint),
                None => error_response(status, &format!("上游请求失败: {}", e)),
            }
        }
    }
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
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("格式转换失败: {}", e),
            );
        }
    };

    tracing::info!(
        "[Proxy] Codex Responses 转 Chat: model={}, stream={}, messages={}, tools={}",
        chat_body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
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
    match forward_raw_response(&state.forwarder, &chat_body, None).await {
        Ok(response) => match response.text().await {
            Ok(body_text) => match serde_json::from_str::<Value>(&body_text) {
                Ok(chat_response) => {
                    // DX: 记录用量 - Codex 上游 Chat Completions 响应
                    let request_model = chat_body.get("model").and_then(|v| v.as_str());
                    record_openai_usage(&chat_response, request_model, Some("codex"), 0, 200, false);

                    match chat_to_codex_response(chat_response) {
                        Ok(responses_response) => Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "application/json")
                            .body(Body::from(
                                serde_json::to_string(&responses_response).unwrap_or_default(),
                            ))
                            .unwrap_or_else(|_| {
                                error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建响应失败")
                            }),
                        Err(e) => {
                            tracing::error!("[Proxy] Chat 响应转 Codex Responses 失败: {}", e);
                            error_response(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                &format!("响应格式转换失败: {}", e),
                            )
                        }
                    }
                },
                Err(e) => {
                    tracing::error!("[Proxy] Codex 上游 Chat 响应 JSON 解析失败: {}", e);
                    error_response(
                        StatusCode::BAD_GATEWAY,
                        &format!("上游响应无效 JSON: {}", e),
                    )
                }
            },
            Err(e) => error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e)),
        },
        Err(e) => {
            tracing::error!("[Proxy] Codex 上游请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            match e.upstream_body() {
                Some(body) => upstream_error_response(status, body, None),
                None => error_response(status, &format!("上游请求失败: {}", e)),
            }
        }
    }
}

async fn handle_codex_streaming(state: ProxyState, chat_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &chat_body, None).await {
        Ok(response) => match response.bytes().await {
            Ok(body_bytes) => {
                let body_str = String::from_utf8_lossy(&body_bytes);
                tracing::info!(
                    "[CodexStreaming] 上游 SSE 体: {}bytes, 前 500 字符: {:?}",
                    body_bytes.len(),
                    &body_str[..body_str.len().min(500)]
                );
                let sse_body = chat_sse_to_codex_responses_sse(&body_str);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .header("Cache-Control", "no-cache")
                    .body(Body::from(sse_body))
                    .unwrap_or_else(|_| {
                        error_response(StatusCode::INTERNAL_SERVER_ERROR, "构建流式响应失败")
                    })
            }
            Err(e) => error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e)),
        },
        Err(e) => {
            tracing::error!("[Proxy] Codex 上游流式请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            match e.upstream_body() {
                Some(body) => upstream_error_response(status, body, None),
                None => error_response(status, &format!("上游请求失败: {}", e)),
            }
        }
    }
}

/// 处理非流式请求
async fn handle_non_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body, None).await {
        Ok(response) => {
            let status = response.status();
            match response.text().await {
                Ok(body_text) => match serde_json::from_str::<Value>(&body_text) {
                    Ok(openai_response) => {
                        // 记录用量：从响应中提取 usage 字段
                        let request_model = openai_body.get("model").and_then(|v| v.as_str());
                        record_openai_usage(&openai_response, request_model, Some(wire_api_to_engine(state.forwarder.wire_api)), 0, status.as_u16(), false);

                        let converted = match state.forwarder.wire_api {
                            ProxyWireApi::Responses => responses_to_anthropic(openai_response),
                            ProxyWireApi::ChatCompletions => openai_to_anthropic(openai_response),
                            ProxyWireApi::AnthropicMessages => {
                                return error_response(
                                    StatusCode::BAD_REQUEST,
                                    "Anthropic 直通代理模式不应进入 OpenAI 响应转换",
                                );
                            }
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
                },
                Err(e) => {
                    tracing::error!("[Proxy] 读取上游响应失败: {}", e);
                    error_response(StatusCode::BAD_GATEWAY, &format!("读取上游响应失败: {}", e))
                }
            }
        }
        Err(e) => {
            tracing::error!("[Proxy] 上游请求失败: {}", e);
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::BAD_GATEWAY);
            match e.upstream_body() {
                Some(body) => upstream_error_response(status, body, None),
                None => error_response(status, &format!("上游请求失败: {}", e)),
            }
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
    match forward_raw_response(&state.forwarder, &openai_body, None).await {
        Ok(response) => {
            let body_bytes = match response.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!("[Proxy] 读取上游流式响应体失败: {}", e);
                    return error_response(
                        StatusCode::BAD_GATEWAY,
                        &format!("读取上游响应失败: {}", e),
                    );
                }
            };

            let body_str = String::from_utf8_lossy(&body_bytes);
            tracing::info!(
                "[Proxy] 上游流式响应: {}bytes, {}lines",
                body_bytes.len(),
                body_str.lines().count()
            );

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
                ProxyWireApi::AnthropicMessages => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "Anthropic 直通代理模式不应进入 OpenAI 流式转换",
                    );
                }
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
            let close_block =
                |events: &mut Vec<Value>, active: &mut ActiveBlock, index: &mut u32| {
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
            let open_text_block =
                |events: &mut Vec<Value>, active: &mut ActiveBlock, index: u32| {
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
            let open_thinking_block =
                |events: &mut Vec<Value>, active: &mut ActiveBlock, index: u32| {
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
                        tracing::warn!(
                            "[Proxy] 工具调用 arguments JSON 解析失败 ({}): {}",
                            e,
                            &tc.arguments[..tc.arguments.len().min(200)]
                        );
                        json!({})
                    });
                    tracing::info!(
                        "[Proxy] 生成 tool_use block: id={}, name={}, args_len={}",
                        tc.id,
                        tc.name,
                        tc.arguments.len()
                    );

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

            tracing::info!(
                "[Proxy] 生成 {} 个 Anthropic SSE 事件 (text_deltas={}, tool_calls={})",
                events.len(),
                content_deltas.len(),
                tool_call_count
            );

            // 构建 SSE 响应体
            let mut sse_body = String::new();
            for event in &events {
                let event_name = event["event"].as_str().unwrap_or("message");
                let event_data = serde_json::to_string(&event["data"]).unwrap_or_default();
                sse_body.push_str(&format!("event: {}\ndata: {}\n\n", event_name, event_data));
            }

            // 记录用量（流式响应：从 usage_json 提取）
            if let Some(u) = usage_json.as_object() {
                let input_tokens = u.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                let output_tokens = u.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                let request_model = openai_body.get("model").and_then(|v| v.as_str());
                let engine_id = wire_api_to_engine(state.forwarder.wire_api);
                crate::services::usage_db::record_usage(
                    &model,
                    request_model,
                    Some(engine_id),
                    input_tokens,
                    output_tokens,
                    0, 0, 0, 200, true,
                );
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
            match e.upstream_body() {
                Some(body) => upstream_error_response(status, body, None),
                None => error_response(status, &format!("上游请求失败: {}", e)),
            }
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
                tracing::warn!(
                    "[Proxy] 跳过无法解析的 chunk: {} - {}",
                    e,
                    &data[..data.len().min(100)]
                );
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
            usage_json =
                json!({"input_tokens": u.prompt_tokens, "output_tokens": u.completion_tokens});
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

/// 构建上游错误透传响应(P3:错误体透传上游原始 body)。
///
/// 上游 4xx/5xx 时,`forward_raw_response` 已把上游原始响应体读到
/// `ProxyError::UpstreamError.body`。本函数优先把原始 body 原样透传给客户端
/// (Content-Type: application/json),保留上游结构化错误码(如
/// `invalid_request_error` + `tool_use ids were found without tool_result blocks`),
/// 便于排查。原始 body 非 JSON 时退化为 `error_response` 包装,保持兼容。
///
/// `extra_hint` 用于追加 Polaris 侧提示(如 server_tool_use 处理建议),
/// 仅在透传成功时作为独立 header `x-polaris-hint` 返回,不污染上游原始 body。
fn upstream_error_response(status: StatusCode, upstream_body: &str, extra_hint: Option<&str>) -> Response {
    // 尝试把上游 body 解析为 JSON 原样透传
    if let Ok(parsed) = serde_json::from_str::<Value>(upstream_body) {
        let body_str = serde_json::to_string(&parsed).unwrap_or_else(|_| upstream_body.to_string());
        let mut builder = Response::builder()
            .status(status)
            .header("Content-Type", "application/json");
        if let Some(hint) = extra_hint {
            // HeaderValue::from_str 不接受非 ASCII(如中文提示),用 from_bytes 兜底。
            if let Ok(v) = HeaderValue::from_bytes(hint.as_bytes()) {
                builder = builder.header("x-polaris-hint", v);
            }
        }
        return builder
            .body(Body::from(body_str))
            .unwrap_or_else(|_| {
                error_response(status, &format!("上游请求失败: {}", upstream_body))
            });
    }
    // 上游 body 非 JSON(如纯文本/HTML 错误页):退化为包装格式
    error_response(status, &format!("上游请求失败: {}", upstream_body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn filter_keeps_capability_headers_and_strips_auth() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("context-1m-2025-08-07"),
        );
        headers.insert("user-agent", HeaderValue::from_static("claude-cli/2.0.0"));
        headers.insert("x-app", HeaderValue::from_static("cli"));
        headers.insert("authorization", HeaderValue::from_static("Bearer leak"));
        headers.insert("x-api-key", HeaderValue::from_static("leak"));
        headers.insert("host", HeaderValue::from_static("127.0.0.1:1234"));
        headers.insert("content-length", HeaderValue::from_static("42"));
        headers.insert("accept-encoding", HeaderValue::from_static("gzip"));

        let filtered = filter_passthrough_headers(&headers);
        let names: Vec<&str> = filtered.iter().map(|(k, _)| k.as_str()).collect();

        assert!(names.contains(&"anthropic-beta"));
        assert!(names.contains(&"user-agent"));
        assert!(names.contains(&"x-app"));
        assert!(!names.contains(&"authorization"));
        assert!(!names.contains(&"x-api-key"));
        assert!(!names.contains(&"host"));
        assert!(!names.contains(&"content-length"));
        assert!(!names.contains(&"accept-encoding"));
    }

    // ============================================================
    // P0 回归测试:孤儿 tool_use 经 Polaris 净化后不再触发上游 400
    //
    // 场景:ClaudeCode 引擎 + AnthropicMessages 直通。Stop 中断后 claude code
    // 留下孤儿 assistant(tool_use)(无 tool_result)。mock 上游模拟真实 Anthropic
    // 严格校验(每个 tool_use 必须有对应 tool_result,否则 400)。
    //
    // P0 修复前:代理原样透传孤儿 → 上游 400(本测试原名 reproduce_..._400)。
    // P0 修复后:代理在 sanitize 出口把孤儿 tool_use 降级为 text → 上游 200。
    // ============================================================
    #[tokio::test]
    async fn orphan_tool_use_replay_passes_after_p0_repair() {
        use axum::{routing::post, Router};
        use std::collections::HashMap;
        use tokio::net::TcpListener;

        // --- 1. mock 上游:模拟真实 Anthropic 严格校验 tool_use/tool_result 配对 ---
        let upstream = Router::new().route(
            "/v1/messages",
            post(|body: String| async move {
                let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let mut tool_use_ids: Vec<String> = Vec::new();
                let mut tool_result_ids: Vec<String> = Vec::new();
                if let Some(msgs) = v.get("messages").and_then(Value::as_array) {
                    for msg in msgs {
                        if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                            for b in blocks {
                                match b.get("type").and_then(Value::as_str) {
                                    Some("tool_use") => {
                                        if let Some(id) = b.get("id").and_then(Value::as_str) {
                                            tool_use_ids.push(id.to_string());
                                        }
                                    }
                                    Some("tool_result") => {
                                        if let Some(id) =
                                            b.get("tool_use_id").and_then(Value::as_str)
                                        {
                                            tool_result_ids.push(id.to_string());
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                // 真实 Anthropic 校验:每个 tool_use 必须有对应 tool_result
                let orphan: Vec<&String> = tool_use_ids
                    .iter()
                    .filter(|id| !tool_result_ids.contains(id))
                    .collect();
                if !orphan.is_empty() {
                    return (
                        axum::http::StatusCode::BAD_REQUEST,
                        axum::Json(json!({
                            "type": "error",
                            "error": {
                                "type": "invalid_request_error",
                                "message": format!(
                                    "tool_use ids without tool_result: {:?}",
                                    orphan
                                )
                            }
                        })),
                    );
                }
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({"id":"msg_ok","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-test","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})),
                )
            }),
        );
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(upstream_listener, upstream).await.unwrap();
        });
        let upstream_url = format!("http://127.0.0.1:{}/v1/messages", upstream_addr.port());

        // --- 2. 起 Polaris 代理,直通模式指向 mock 上游(P0 修复在 sanitize 出口) ---
        let forwarder = ForwarderConfig::with_options(
            &upstream_url,
            "test-key",
            ProxyWireApi::AnthropicMessages,
            HashMap::new(),
        );
        let proxy = super::super::server::start_proxy_server(forwarder, 0).await.unwrap();
        let proxy_url = format!("http://{}/v1/messages", proxy.addr);

        // --- 3. 模拟 claude CLI 中断后重试:历史含孤儿 tool_use ---
        // assistant 消息带 tool_use(id=toolu_orphan),但后续 user turn 没有 tool_result。
        let orphan_request = json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "stream": false,
            "messages": [
                {"role": "user", "content": "list files"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "I'll run bash."},
                    {"type": "tool_use", "id": "toolu_orphan", "name": "bash", "input": {"command": "ls"}}
                ]},
                {"role": "user", "content": "continue"}  // 没有 tool_result!
            ]
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(&proxy_url)
            .header("x-api-key", "test-key")
            .header("anthropic-version", "2023-06-01")
            .json(&orphan_request)
            .send()
            .await
            .expect("代理请求应成功发送");

        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);

        proxy.shutdown();

        // --- 4. 断言:P0 修复后上游返回 200(孤儿已被出口净化降级为 text) ---
        assert_eq!(
            status.as_u16(),
            200u16,
            "孤儿 tool_use 经 Polaris P0 净化后上游应返回 200,实际 status={}, body={}",
            status,
            body
        );
        assert_eq!(body["type"], "message");
        assert_eq!(body["stop_reason"], "end_turn");
        eprintln!("P0_VERIFIED: orphan tool_use repaired → upstream 200");
    }

    // ============================================================
    // P3:错误体透传上游原始 body
    // ============================================================

    /// 上游 JSON 错误体透传:上游原始 body 被原样返回,不包装成 `api_error`。
    #[tokio::test]
    async fn p3_verify_upstream_error_body_passthrough() {
        use axum::body::to_bytes;

        // 1. JSON 错误体透传:Anthropic 的 invalid_request_error
        let upstream_json = r#"{"type":"error","error":{"type":"invalid_request_error","message":"tool_use ids were found without tool_result blocks"}}"#;
        let resp = upstream_error_response(StatusCode::BAD_REQUEST, upstream_json, None);
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8_lossy(&bytes);

        assert!(body.contains("invalid_request_error"));
        assert!(body.contains("tool_use ids were found without tool_result blocks"));
        assert!(!body.contains("api_error"), "上游 JSON 不应被包装成 api_error");

        // 2. 非 JSON 退化:纯文本错误页退化为包装格式
        let resp2 = upstream_error_response(
            StatusCode::BAD_GATEWAY,
            "upstream connection failed: text error",
            None,
        );
        let bytes2 = to_bytes(resp2.into_body(), usize::MAX).await.unwrap();
        let body2 = String::from_utf8_lossy(&bytes2);

        assert!(body2.contains("api_error"));
        assert!(body2.contains("upstream connection failed: text error"));

        // 3. 带 hint 的场景:直通模式 server_tool_use 拒绝时
        let resp3 = upstream_error_response(
            StatusCode::BAD_REQUEST,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"server_tool_use not supported"}}"#,
            Some("请确认会话已通过净化代理重试"),
        );
        // header 值可能含非 ASCII(中文),用 from_bytes 比较
        let hint_bytes = resp3
            .headers()
            .get("x-polaris-hint")
            .map(|v| v.as_bytes().to_vec());
        assert_eq!(
            hint_bytes,
            Some("请确认会话已通过净化代理重试".as_bytes().to_vec())
        );

        eprintln!("P3_VERIFIED: JSON body passthrough + non-JSON fallback + hint header");
    }
}
