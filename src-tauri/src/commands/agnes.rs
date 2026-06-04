//! Agnes 全模态引擎 API 后端代理
//!
//! 将 Agnes（`https://apihub.agnes-ai.com/v1`）的 HTTP 请求从前端浏览器
//! 转移到 Rust 后端，彻底规避开发环境的 CORS 限制（Rust 侧不存在 CORS，
//! dev/打包态行为一致）。
//!
//! 复用 `commands/translate.rs`（`baidu_translate`）的 reqwest 转发范式：
//! command 接收 `base_url`/`api_key`/`model` 等参数，透传 Agnes 原始响应，
//! 前端 adapter 解析逻辑保持不变。

use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, Result};

/// 默认请求超时（秒）。图像生成可能耗时较长。
const AGNES_TIMEOUT_SECS: u64 = 120;

/// 构建带超时的 reqwest 客户端
fn build_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(AGNES_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Unknown(format!("构建 HTTP 客户端失败: {}", e)))
}

/// 从非 2xx 响应体中提取错误消息（兼容 OpenAI 风格 `{ error: { message } }`）
fn extract_api_error(status: reqwest::StatusCode, body: &str) -> AppError {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("Agnes API 错误: HTTP {}", status.as_u16()));
    AppError::ApiError(msg)
}

/// 文生图 / 图生图：`POST {base_url}/images/generations`
///
/// 透传 Agnes 原始响应 JSON，前端按 `AgnesImageResponse` 解析。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn agnes_generate_image(
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    size: Option<String>,
    reference_image_urls: Option<Vec<String>>,
) -> Result<Value> {
    let client = build_client()?;
    let url = format!("{}/images/generations", base_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "size": size.unwrap_or_else(|| "1024x768".to_string()),
    });

    // 图生图模式：携带参考图
    if let Some(refs) = reference_image_urls {
        if !refs.is_empty() {
            body["extra_body"] = serde_json::json!({
                "image": refs,
                "response_format": "url",
            });
        }
    }

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(extract_api_error(status, &text));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| AppError::ParseError(format!("解析图像响应失败: {}", e)))
}

/// 非流式 Chat Completion：`POST {base_url}/chat/completions`（`stream=false`）
///
/// 用于提示词翻译等非流式场景，返回 `choices[0].message.content`。
/// `messages` 为 OpenAI 风格的消息数组（由前端构造）。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn agnes_chat_completion(
    base_url: String,
    api_key: String,
    model: String,
    messages: Value,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<String> {
    let client = build_client()?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.7),
        "stream": false,
    });
    if let Some(mt) = max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(extract_api_error(status, &text));
    }

    let json = response
        .json::<Value>()
        .await
        .map_err(|e| AppError::ParseError(format!("解析对话响应失败: {}", e)))?;

    let content = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if content.is_empty() {
        return Err(AppError::ApiError("Agnes 返回空内容".to_string()));
    }

    Ok(content)
}

/// 创建视频生成任务：`POST {base_url}/videos`
///
/// `body` 由前端构造（含 model/prompt/width/height/num_frames/frame_rate/seed/
/// image/extra_body），整体透传给 Agnes，返回创建响应 JSON（含异步任务 `id`）。
/// 视频采用「创建 → 轮询」异步模型，轮询由前端 `agnes_query_video` 驱动。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn agnes_create_video(base_url: String, api_key: String, body: Value) -> Result<Value> {
    let client = build_client()?;
    let url = format!("{}/videos", base_url.trim_end_matches('/'));

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(extract_api_error(status, &text));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| AppError::ParseError(format!("解析视频创建响应失败: {}", e)))
}

/// 查询视频生成任务状态：`GET {base_url}/videos/{video_task_id}`
///
/// HTTP 404 表示任务记录尚未建立（排队中），转换为
/// `{ "status": "queued", "progress": 0 }` 让前端轮询循环继续，
/// 与原前端 fetch 实现的 404 处理语义保持一致；其余非 2xx 视为错误。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn agnes_query_video(
    base_url: String,
    api_key: String,
    video_task_id: String,
) -> Result<Value> {
    let client = build_client()?;
    let url = format!(
        "{}/videos/{}",
        base_url.trim_end_matches('/'),
        video_task_id
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;

    let status = response.status();

    // 404：任务查询记录尚未就绪，视为排队中，让前端继续轮询
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(serde_json::json!({ "status": "queued", "progress": 0 }));
    }

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(extract_api_error(status, &text));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| AppError::ParseError(format!("解析视频查询响应失败: {}", e)))
}
