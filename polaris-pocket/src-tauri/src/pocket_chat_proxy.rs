/// Pocket AI 聊天 HTTP 代理命令模块
///
/// 前端 `fetch()` 在 Android WebView 中受 CORS 限制，导致 API 请求失败。
/// 本模块通过 Rust 后端直接发起 HTTP 请求，绕过 WebView 的 CORS 策略。
///
/// 核心设计：
/// - `pocket_chat_completions` — 非流式请求，返回完整响应（Text、API 回退路径）
/// - `pocket_chat_completions_stream` — 流式请求，通过 Tauri 事件逐块推送 SSE 响应
///
/// 注意：CORS 不受 API 的 HTTPS/HTTP 影响——即使 API 是 HTTPS，如果其响应头不含
/// `Access-Control-Allow-Origin`，浏览器也会拦截。本模块完全绕过该限制。

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ============================================================================
// 非流式请求（AI 纯文本模式回退）
// ============================================================================

/// 非流式请求参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
    /// API 完整 URL（含 /chat/completions）
    pub url: String,
    /// API Key（Bearer token）
    pub api_key: String,
    /// 请求体 JSON
    pub body: serde_json::Value,
}

/// 非流式响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionResponse {
    pub status: u16,
    pub body: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 非流式聊天完成请求
///
/// 前端不再直接 `fetch()`，而是通过 Tauri 调用本命令，
/// Rust 后端用 reqwest 发起 HTTP 请求，完全绕过 WebView CORS。
#[tauri::command]
pub async fn pocket_chat_completions(
    req: ChatCompletionRequest,
) -> Result<ChatCompletionResponse, String> {
    let client = Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let res = client
        .post(&req.url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", req.api_key))
        .json(&req.body)
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {} (url: {})", e, req.url))?;

    let status = res.status().as_u16();
    let body: serde_json::Value = res.json().await.map_err(|e| {
        format!("解析响应 JSON 失败: {}", e)
    })?;

    Ok(ChatCompletionResponse {
        status,
        body,
        error: None,
    })
}

// ============================================================================
// 流式请求（通过 Tauri 事件逐块推送）
// ============================================================================

/// 流式 SSE 块事件（前端监听）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunkEvent {
    pub chunk: String,
    pub is_done: bool,
    pub error: Option<String>,
}

/// 流式聊天完成请求
///
/// 前端通过 `invoke("pocket_chat_completions_stream", ...)` 发起，然后
/// 监听 `pocket-stream-chunk` 事件接收 SSE 数据块。
///
/// 事件流：
///   1. 前端调用 invoke → 收到空响应（表示请求已启动）
///   2. Rust 后端逐块读取 SSE → 每块 emit `pocket-stream-chunk` 事件
///   3. 前端监听事件 → 累积渲染
///   4. 最后一块 is_done=true → 前端清理
#[tauri::command]
pub async fn pocket_chat_completions_stream(
    app: AppHandle,
    req: ChatCompletionRequest,
) -> Result<(), String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let res = client
        .post(&req.url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", req.api_key))
        .header("Accept", "text/event-stream")
        .json(&req.body)
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {} (url: {})", e, req.url))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let _ = app.emit(
            "pocket-stream-chunk",
            StreamChunkEvent {
                chunk: String::new(),
                is_done: true,
                error: Some(format!("HTTP {}: {}", status, body)),
            },
        );
        return Ok(());
    }

    // 逐块读取 SSE 流
    use futures_util::StreamExt;
    let mut stream = res.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                let chunk_str = String::from_utf8_lossy(&bytes).to_string();
                let _ = app.emit(
                    "pocket-stream-chunk",
                    StreamChunkEvent {
                        chunk: chunk_str,
                        is_done: false,
                        error: None,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "pocket-stream-chunk",
                    StreamChunkEvent {
                        chunk: String::new(),
                        is_done: true,
                        error: Some(format!("流读取错误: {}", e)),
                    },
                );
                return Ok(());
            }
        }
    }

    // 发送完成信号
    let _ = app.emit(
        "pocket-stream-chunk",
        StreamChunkEvent {
            chunk: String::new(),
            is_done: true,
            error: None,
        },
    );

    Ok(())
}