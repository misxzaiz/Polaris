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
use serde_json::Value;

use super::forwarder::{forward_raw_response, ForwarderConfig};
use super::streaming::create_anthropic_sse_stream;
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

    if is_streaming {
        handle_streaming(state, openai_body).await
    } else {
        handle_non_streaming(state, openai_body).await
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

/// 处理流式请求
async fn handle_streaming(state: ProxyState, openai_body: Value) -> Response {
    match forward_raw_response(&state.forwarder, &openai_body).await {
        Ok(response) => {
            let byte_stream = response.bytes_stream();
            let anthropic_stream = create_anthropic_sse_stream(byte_stream);

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .body(Body::from_stream(anthropic_stream))
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
