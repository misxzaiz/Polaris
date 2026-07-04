//! Agnes AI MCP Server
//!
//! Provides image and video generation tools via Agnes AI APIs.
//! - Image generation: Agnes Image 2.1 Flash (text-to-image, image-to-image)
//! - Video generation: Agnes Video V2.0 (text-to-video, image-to-video, multi-image, keyframes)
//!
//! JSON-RPC over stdio, same framework as other Polaris MCP servers.

use std::io::{self, BufRead, BufReader, Write};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-agnes-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

// Default API config
const DEFAULT_API_BASE: &str = "https://apihub.agnes-ai.com";
const DEFAULT_IMAGE_MODEL: &str = "agnes-image-2.1-flash";
const DEFAULT_VIDEO_MODEL: &str = "agnes-video-v2.0";
const DEFAULT_IMAGE_SIZE: &str = "1024x768";
const DEFAULT_VIDEO_WIDTH: u32 = 1152;
const DEFAULT_VIDEO_HEIGHT: u32 = 768;
const DEFAULT_NUM_FRAMES: u32 = 121;
const DEFAULT_FRAME_RATE: u32 = 24;

// Polling config for async video generation
const VIDEO_POLL_INTERVAL_MS: u64 = 5_000;
const VIDEO_POLL_MAX_ATTEMPTS: u32 = 120; // 10 minutes max

// ============================================================================
// Config types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgnesConfig {
    api_base: String,
    api_key: String,
    image_model: String,
    video_model: String,
}

impl Default for AgnesConfig {
    fn default() -> Self {
        Self {
            api_base: DEFAULT_API_BASE.to_string(),
            api_key: String::new(),
            image_model: DEFAULT_IMAGE_MODEL.to_string(),
            video_model: DEFAULT_VIDEO_MODEL.to_string(),
        }
    }
}

impl AgnesConfig {
    fn from_env() -> Self {
        Self {
            api_base: std::env::var("AGNES_API_BASE")
                .unwrap_or_else(|_| DEFAULT_API_BASE.to_string()),
            api_key: std::env::var("AGNES_API_KEY").unwrap_or_default(),
            image_model: std::env::var("AGNES_IMAGE_MODEL")
                .unwrap_or_else(|_| DEFAULT_IMAGE_MODEL.to_string()),
            video_model: std::env::var("AGNES_VIDEO_MODEL")
                .unwrap_or_else(|_| DEFAULT_VIDEO_MODEL.to_string()),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.api_key.is_empty() {
            return Err(AppError::ValidationError(
                "AGNES_API_KEY 未配置。请在环境变量或面板设置中配置 API Key。".to_string(),
            ));
        }
        Ok(())
    }
}

// ============================================================================
// JSON-RPC types
// ============================================================================

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse<'a> {
    jsonrpc: &'a str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ============================================================================
// HTTP client helpers
// ============================================================================

fn build_http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(360))
        .build()
        .map_err(|e| AppError::ProcessError(format!("创建 HTTP 客户端失败: {e}")))
}

fn api_post(
    client: &reqwest::blocking::Client,
    config: &AgnesConfig,
    path: &str,
    body: Value,
) -> Result<Value> {
    let url = format!("{}{}", config.api_base.trim_end_matches('/'), path);
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| AppError::ProcessError(format!("API 请求失败: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

    if !status.is_success() {
        return Err(AppError::ProcessError(format!(
            "API 返回错误 {}: {}",
            status,
            text.chars().take(500).collect::<String>()
        )));
    }

    serde_json::from_str(&text)
        .map_err(|e| AppError::ProcessError(format!("解析响应 JSON 失败: {e}\n{text}")))
}

fn api_get(
    client: &reqwest::blocking::Client,
    config: &AgnesConfig,
    url: &str,
) -> Result<Value> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send()
        .map_err(|e| AppError::ProcessError(format!("API 请求失败: {e}")))?;

    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

    if !status.is_success() {
        return Err(AppError::ProcessError(format!(
            "API 返回错误 {}: {}",
            status,
            text.chars().take(500).collect::<String>()
        )));
    }

    serde_json::from_str(&text)
        .map_err(|e| AppError::ProcessError(format!("解析响应 JSON 失败: {e}\n{text}")))
}

// ============================================================================
// Server main loop
// ============================================================================

pub fn run_agnes_mcp_server(_config_dir: &str, _workspace_path: Option<&str>) -> Result<()> {
    let mut config = AgnesConfig::from_env();
    let client = build_http_client()?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request, &mut config, &client),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {error}"),
                }),
            },
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

// ============================================================================
// Request handling
// ============================================================================

fn handle_request(
    request: JsonRpcRequest,
    config: &mut AgnesConfig,
    client: &reqwest::blocking::Client,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(handle_initialize()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, config, client),
        other => Err(AppError::ValidationError(format!(
            "Unsupported method: {other}"
        ))),
    };

    match result {
        Ok(result) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}

fn handle_initialize() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    })
}

// ============================================================================
// Tool definitions
// ============================================================================

fn handle_tools_list() -> Value {
    json!({ "tools": [
        {
            "name": "generate_image",
            "description": "使用 Agnes Image 2.1 Flash 生成图片。支持文生图和图生图。返回图片 URL，渲染到聊天面板。",
            "inputSchema": {
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": {
                        "type": "string",
                        "minLength": 1,
                        "description": "图片生成提示词"
                    },
                    "image": {
                        "type": "string",
                        "description": "图生图时的输入图片 URL 或 Data URI Base64"
                    },
                    "size": {
                        "type": "string",
                        "description": "输出尺寸，如 1024x768、512x512，默认 1024x768"
                    },
                    "returnBase64": {
                        "type": "boolean",
                        "description": "是否以 Base64 返回图片数据，默认 false（返回 URL）"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "generate_video",
            "description": "使用 Agnes Video V2.0 生成视频。支持文生视频和图生视频。返回 video_id，可轮询 check_video_status 获取结果。",
            "inputSchema": {
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": {
                        "type": "string",
                        "minLength": 1,
                        "description": "视频生成提示词"
                    },
                    "image": {
                        "type": "string",
                        "description": "图生视频的输入图片 URL"
                    },
                    "mode": {
                        "type": "string",
                        "description": "生成模式：ti2vid（图生视频）或 keyframes（关键帧动画）"
                    },
                    "width": {
                        "type": "integer",
                        "description": "视频宽度，默认 1152"
                    },
                    "height": {
                        "type": "integer",
                        "description": "视频高度，默认 768"
                    },
                    "numFrames": {
                        "type": "integer",
                        "description": "视频帧数，必须 ≤ 441 且遵循 8n+1 规则，默认 121（约 5 秒）"
                    },
                    "frameRate": {
                        "type": "integer",
                        "description": "视频帧率，默认 24"
                    },
                    "images": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "多图视频或关键帧模式下的输入图片 URL 数组"
                    },
                    "negativePrompt": {
                        "type": "string",
                        "description": "反向提示词"
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "是否等待视频生成完成（默认 true）。若为 false，立即返回 video_id 供后续轮询。"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "check_video_status",
            "description": "查询 Agnes 视频生成任务状态。完成时返回视频 URL。",
            "inputSchema": {
                "type": "object",
                "required": ["videoId"],
                "properties": {
                    "videoId": {
                        "type": "string",
                        "minLength": 1,
                        "description": "视频 ID（由 generate_video 返回）"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "get_config",
            "description": "获取当前 Agnes AI 配置信息（不含 API Key）。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "set_config",
            "description": "更新 Agnes AI 配置。部分更新：仅传需要修改的字段。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "apiKey": { "type": "string", "description": "API Key" },
                    "apiBase": { "type": "string", "description": "API 基础 URL" },
                    "imageModel": { "type": "string", "description": "图片模型名称" },
                    "videoModel": { "type": "string", "description": "视频模型名称" }
                },
                "additionalProperties": false
            }
        }
    ] })
}

// ============================================================================
// Tool dispatch
// ============================================================================

fn handle_tools_call(
    params: Value,
    config: &mut AgnesConfig,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "generate_image" => exec_generate_image(&args, config, client),
        "generate_video" => exec_generate_video(&args, config, client),
        "check_video_status" => exec_check_video_status(&args, config, client),
        "get_config" => exec_get_config(config),
        "set_config" => exec_set_config(&args, config),
        other => Err(AppError::ValidationError(format!("未知工具: {other}"))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn exec_generate_image(
    args: &Value,
    config: &AgnesConfig,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    config.validate()?;

    let prompt = require_str(args, "prompt")?;
    let size = args
        .get("size")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_IMAGE_SIZE);
    let return_base64 = args.get("returnBase64").and_then(Value::as_bool).unwrap_or(false);
    let image_input = args.get("image").and_then(Value::as_str);

    let mut body = json!({
        "model": config.image_model,
        "prompt": prompt,
        "size": size,
    });

    if let Some(img) = image_input {
        // Image-to-image mode
        body["extra_body"] = json!({
            "image": [img],
            "response_format": if return_base64 { "b64_json" } else { "url" }
        });
    } else if return_base64 {
        body["return_base64"] = json!(true);
    } else {
        body["extra_body"] = json!({
            "response_format": "url"
        });
    }

    let resp = api_post(client, config, "/v1/images/generations", body)?;

    let data = resp
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .ok_or_else(|| AppError::ProcessError("响应中缺少 data 数组".to_string()))?;

    let image_url = data.get("url").and_then(Value::as_str);
    let image_b64 = data.get("b64_json").and_then(Value::as_str);

    if let Some(url) = image_url {
        Ok(json!({
            "structuredContent": {
                "type": "image",
                "url": url,
                "model": config.image_model,
                "size": size,
                "prompt": prompt,
            },
            "content": [
                { "type": "text", "text": format!("已生成图片: {prompt}") }
            ]
        }))
    } else if let Some(b64) = image_b64 {
        Ok(json!({
            "structuredContent": {
                "type": "image",
                "base64": b64,
                "mimeType": "image/png",
                "model": config.image_model,
                "size": size,
                "prompt": prompt,
            },
            "content": [
                { "type": "text", "text": format!("已生成图片: {prompt}") }
            ]
        }))
    } else {
        Err(AppError::ProcessError("响应中缺少 url 或 b64_json".to_string()))
    }
}

fn exec_generate_video(
    args: &Value,
    config: &AgnesConfig,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    config.validate()?;

    let prompt = require_str(args, "prompt")?;
    let image = args.get("image").and_then(Value::as_str);
    let mode = args.get("mode").and_then(Value::as_str);
    let width = args
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_VIDEO_WIDTH as u64) as u32;
    let height = args
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_VIDEO_HEIGHT as u64) as u32;
    let num_frames = args
        .get("numFrames")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_NUM_FRAMES as u64) as u32;
    let frame_rate = args
        .get("frameRate")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_FRAME_RATE as u64) as u32;
    let negative_prompt = args.get("negativePrompt").and_then(Value::as_str);
    let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(true);

    let mut body = json!({
        "model": config.video_model,
        "prompt": prompt,
        "width": width,
        "height": height,
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });

    if let Some(img) = image {
        body["image"] = json!(img);
    }

    if let Some(m) = mode {
        body["extra_body"] = json!({ "mode": m });
    }

    if let Some(images) = args.get("images").and_then(Value::as_array) {
        let extra = body
            .get("extra_body")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut extra_obj = extra.as_object().cloned().unwrap_or_default();
        extra_obj.insert("image".to_string(), json!(images));
        if let Some(m) = mode {
            extra_obj.insert("mode".to_string(), json!(m));
        }
        body["extra_body"] = json!(extra_obj);
    }

    if let Some(neg) = negative_prompt {
        body["negative_prompt"] = json!(neg);
    }

    let resp = api_post(client, config, "/v1/videos", body)?;

    let video_id = resp
        .get("video_id")
        .and_then(Value::as_str)
        .or_else(|| resp.get("id").and_then(Value::as_str))
        .ok_or_else(|| AppError::ProcessError("响应中缺少 video_id".to_string()))?
        .to_string();

    let task_id = resp.get("task_id").and_then(Value::as_str).map(String::from);
    let status = resp.get("status").and_then(Value::as_str).unwrap_or("queued");
    let seconds = resp.get("seconds").and_then(Value::as_str).unwrap_or("?");

    if !wait {
        return Ok(json!({
            "structuredContent": {
                "type": "video",
                "videoId": video_id,
                "taskId": task_id,
                "status": status,
                "seconds": seconds,
                "waiting": false,
            },
            "content": [
                { "type": "text", "text": format!("视频任务已创建 (video_id: {video_id})，请稍后调用 check_video_status 查询结果。") }
            ]
        }));
    }

    // Poll for completion
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        thread::sleep(Duration::from_millis(VIDEO_POLL_INTERVAL_MS));

        let poll_url = format!(
            "{}/agnesapi?video_id={}",
            config.api_base.trim_end_matches('/'),
            video_id
        );
        let poll_resp = api_get(client, config, &poll_url)?;

        let poll_status = poll_resp
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let progress = poll_resp
            .get("progress")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        match poll_status {
            "completed" => {
                let video_url = poll_resp
                    .get("remixed_from_video_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                return Ok(json!({
                    "structuredContent": {
                        "type": "video",
                        "videoId": video_id,
                        "url": video_url,
                        "status": "completed",
                        "seconds": poll_resp.get("seconds").and_then(Value::as_str).unwrap_or(seconds),
                        "size": poll_resp.get("size").and_then(Value::as_str).unwrap_or(""),
                        "model": config.video_model,
                        "prompt": prompt,
                    },
                    "content": [
                        { "type": "text", "text": format!("视频生成完成 ({seconds}s)") }
                    ]
                }));
            }
            "failed" => {
                let error_msg = poll_resp
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误");
                return Err(AppError::ProcessError(format!(
                    "视频生成失败: {error_msg}"
                )));
            }
            _ => {
                if attempts >= VIDEO_POLL_MAX_ATTEMPTS {
                    return Ok(json!({
                        "structuredContent": {
                            "type": "video",
                            "videoId": video_id,
                            "status": poll_status,
                            "progress": progress,
                            "waiting": true,
                        },
                        "content": [
                            { "type": "text", "text": format!("视频仍在生成中 (进度: {progress}%)，请稍后调用 check_video_status 查询结果。") }
                        ]
                    }));
                }
            }
        }
    }
}

fn exec_check_video_status(
    args: &Value,
    config: &AgnesConfig,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    config.validate()?;

    let video_id = require_str(args, "videoId")?;

    let poll_url = format!(
        "{}/agnesapi?video_id={}",
        config.api_base.trim_end_matches('/'),
        video_id
    );
    let resp = api_get(client, config, &poll_url)?;

    let status = resp
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let progress = resp
        .get("progress")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    match status {
        "completed" => {
            let video_url = resp
                .get("remixed_from_video_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({
                "structuredContent": {
                    "type": "video",
                    "videoId": video_id,
                    "url": video_url,
                    "status": "completed",
                    "seconds": resp.get("seconds").and_then(Value::as_str).unwrap_or("?"),
                    "size": resp.get("size").and_then(Value::as_str).unwrap_or(""),
                },
                "content": [
                    { "type": "text", "text": "视频生成完成" }
                ]
            }))
        }
        "failed" => {
            let error_msg = resp
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            Ok(json!({
                "structuredContent": {
                    "type": "video",
                    "videoId": video_id,
                    "status": "failed",
                    "error": error_msg,
                },
                "content": [
                    { "type": "text", "text": format!("视频生成失败: {error_msg}") }
                ]
            }))
        }
        _ => Ok(json!({
            "structuredContent": {
                "type": "video",
                "videoId": video_id,
                "status": status,
                "progress": progress,
                "waiting": true,
            },
            "content": [
                { "type": "text", "text": format!("视频生成中... 进度: {progress}%") }
            ]
        })),
    }
}

fn exec_get_config(config: &AgnesConfig) -> Result<Value> {
    Ok(json!({
        "structuredContent": {
            "apiBase": config.api_base,
            "imageModel": config.image_model,
            "videoModel": config.video_model,
            "hasApiKey": !config.api_key.is_empty(),
        },
        "content": [
            { "type": "text", "text": "当前配置信息" }
        ]
    }))
}

fn exec_set_config(args: &Value, config: &mut AgnesConfig) -> Result<Value> {
    if let Some(key) = args.get("apiKey").and_then(Value::as_str) {
        config.api_key = key.to_string();
    }
    if let Some(base) = args.get("apiBase").and_then(Value::as_str) {
        config.api_base = base.to_string();
    }
    if let Some(model) = args.get("imageModel").and_then(Value::as_str) {
        config.image_model = model.to_string();
    }
    if let Some(model) = args.get("videoModel").and_then(Value::as_str) {
        config.video_model = model.to_string();
    }

    Ok(json!({
        "structuredContent": {
            "apiBase": config.api_base,
            "imageModel": config.image_model,
            "videoModel": config.video_model,
            "hasApiKey": !config.api_key.is_empty(),
        },
        "content": [
            { "type": "text", "text": "配置已更新" }
        ]
    }))
}

// ============================================================================
// Helpers
// ============================================================================

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError(format!("缺少字符串参数: {key}")))
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tools() {
        let listed = handle_tools_list();
        let tools = listed["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"generate_image"));
        assert!(names.contains(&"generate_video"));
        assert!(names.contains(&"check_video_status"));
        assert!(names.contains(&"get_config"));
        assert!(names.contains(&"set_config"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize();
        assert_eq!(
            value["protocolVersion"],
            Value::String(PROTOCOL_VERSION.to_string())
        );
        assert_eq!(
            value["serverInfo"]["name"],
            Value::String(SERVER_NAME.to_string())
        );
    }

    #[test]
    fn config_defaults_are_valid() {
        let config = AgnesConfig::default();
        assert_eq!(config.api_base, DEFAULT_API_BASE);
        assert_eq!(config.image_model, DEFAULT_IMAGE_MODEL);
        assert_eq!(config.video_model, DEFAULT_VIDEO_MODEL);
    }

    #[test]
    fn config_validation_requires_api_key() {
        let mut config = AgnesConfig::default();
        assert!(config.validate().is_err());
        config.api_key = "test-key".to_string();
        assert!(config.validate().is_ok());
    }
}
