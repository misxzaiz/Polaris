//! Agnes AI MCP Server
//!
//! Provides image and video generation tools via Agnes AI APIs.
//! - Image generation: Agnes Image 2.1 Flash (text-to-image, image-to-image)
//! - Video generation: Agnes Video V2.0 (text-to-video, image-to-video, multi-image, keyframes)
//!
//! JSON-RPC over stdio, same framework as other Polaris MCP servers.
//!
//! Credentials are read from `<config_dir>/agnes/config.json`, written by the
//! Agnes plugin settings panel. The config is reloaded before every tool call
//! so panel edits take effect without restarting the server.

use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-agnes-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

// Default API config
pub const DEFAULT_API_BASE: &str = "https://apihub.agnes-ai.com";
pub const DEFAULT_IMAGE_MODEL: &str = "agnes-image-2.1-flash";
pub const DEFAULT_VIDEO_MODEL: &str = "agnes-video-v2.0";
pub const DEFAULT_IMAGE_SIZE: &str = "1024x1024";
const DEFAULT_VIDEO_WIDTH: u32 = 1152;
const DEFAULT_VIDEO_HEIGHT: u32 = 768;
const DEFAULT_NUM_FRAMES: u32 = 121;
const DEFAULT_FRAME_RATE: u32 = 24;
pub const MAX_NUM_FRAMES: u32 = 441;

// Polling config for async video generation
const VIDEO_POLL_INTERVAL_MS: u64 = 5_000;
const DEFAULT_VIDEO_TIMEOUT_SEC: u64 = 300;
const MAX_VIDEO_TIMEOUT_SEC: u64 = 360;

// ============================================================================
// Config types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgnesConfig {
    pub api_base: String,
    pub api_key: String,
    pub image_model: String,
    pub video_model: String,
    #[serde(default = "default_image_size")]
    pub default_size: String,
}

fn default_image_size() -> String {
    DEFAULT_IMAGE_SIZE.to_string()
}

impl Default for AgnesConfig {
    fn default() -> Self {
        Self {
            api_base: DEFAULT_API_BASE.to_string(),
            api_key: String::new(),
            image_model: DEFAULT_IMAGE_MODEL.to_string(),
            video_model: DEFAULT_VIDEO_MODEL.to_string(),
            default_size: DEFAULT_IMAGE_SIZE.to_string(),
        }
    }
}

impl AgnesConfig {
    /// Path to the persisted config file: `<config_dir>/agnes/config.json`.
    pub fn config_path(config_dir: &Path) -> PathBuf {
        config_dir.join("agnes").join("config.json")
    }

    /// Load config from disk. Missing file → defaults. Empty api_key falls
    /// back to the `AGNES_API_KEY` environment variable (dev convenience).
    pub fn load(config_dir: &Path) -> Self {
        let path = Self::config_path(config_dir);
        let mut config = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<AgnesConfig>(&text).unwrap_or_default(),
            Err(_) => AgnesConfig::default(),
        };
        if config.api_base.trim().is_empty() {
            config.api_base = DEFAULT_API_BASE.to_string();
        }
        if config.image_model.trim().is_empty() {
            config.image_model = DEFAULT_IMAGE_MODEL.to_string();
        }
        if config.video_model.trim().is_empty() {
            config.video_model = DEFAULT_VIDEO_MODEL.to_string();
        }
        if config.default_size.trim().is_empty() {
            config.default_size = DEFAULT_IMAGE_SIZE.to_string();
        }
        if config.api_key.trim().is_empty() {
            if let Ok(env_key) = std::env::var("AGNES_API_KEY") {
                config.api_key = env_key;
            }
        }
        config
    }

    /// Persist config to disk, creating the parent directory as needed.
    pub fn save(&self, config_dir: &Path) -> Result<()> {
        let path = Self::config_path(config_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::ProcessError(format!("创建配置目录失败: {e}")))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::ProcessError(format!("序列化配置失败: {e}")))?;
        std::fs::write(&path, text)
            .map_err(|e| AppError::ProcessError(format!("写入配置文件失败: {e}")))?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.api_key.trim().is_empty() {
            return Err(AppError::ValidationError(
                "Agnes API Key 未配置。请在 Agnes 插件设置面板中填写 API Key。".to_string(),
            ));
        }
        Ok(())
    }
}

/// Normalize `num_frames` to satisfy the `8n+1` (n≥1) constraint and the
/// `≤441` cap. Returns the corrected value; callers report if it changed.
pub fn normalize_num_frames(requested: u32) -> u32 {
    let clamped = requested.clamp(9, MAX_NUM_FRAMES);
    // Round to nearest 8k+1.
    let k = ((clamped as i64 - 1) as f64 / 8.0).round() as i64;
    let frames = (8 * k + 1).clamp(9, MAX_NUM_FRAMES as i64);
    frames as u32
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
        .timeout(Duration::from_secs(MAX_VIDEO_TIMEOUT_SEC + 30))
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

    read_json_response(resp)
}

fn api_get(client: &reqwest::blocking::Client, config: &AgnesConfig, url: &str) -> Result<Value> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send()
        .map_err(|e| AppError::ProcessError(format!("API 请求失败: {e}")))?;

    read_json_response(resp)
}

fn read_json_response(resp: reqwest::blocking::Response) -> Result<Value> {
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

pub fn run_agnes_mcp_server(config_dir: &str, _workspace_path: Option<&str>) -> Result<()> {
    let config_dir = PathBuf::from(config_dir);
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
            Ok(request) => handle_request(request, &config_dir, &client),
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
    config_dir: &Path,
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
        "tools/call" => handle_tools_call(request.params, config_dir, client),
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
            "description": "使用 Agnes Image 2.1 Flash 生成图片。支持文生图与图生图（传 images 输入图）。同步返回图片 URL 或 Base64。",
            "inputSchema": {
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": { "type": "string", "minLength": 1, "description": "图片生成或编辑提示词" },
                    "size": { "type": "string", "description": "输出尺寸，如 1024x1024、1024x768、768x1024，默认 1024x1024" },
                    "images": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "图生图输入图数组：公开 URL 或 data:image/...;base64,"
                    },
                    "responseFormat": { "type": "string", "enum": ["url", "b64_json"], "description": "返回格式，默认 url" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "generate_video",
            "description": "使用 Agnes Video V2.0 生成视频。支持文生视频/图生视频/多图/关键帧。异步：wait=true 时阻塞轮询直到完成或超时。",
            "inputSchema": {
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": { "type": "string", "minLength": 1, "description": "视频生成提示词" },
                    "image": { "type": "string", "description": "单图模式（图生视频）的输入图 URL 或 data URI" },
                    "images": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "多图/关键帧模式的输入图数组"
                    },
                    "mode": { "type": "string", "enum": ["ti2vid", "keyframes"], "description": "生成模式：ti2vid（图生视频）或 keyframes（关键帧动画）" },
                    "width": { "type": "integer", "description": "视频宽度，默认 1152" },
                    "height": { "type": "integer", "description": "视频高度，默认 768" },
                    "numFrames": { "type": "integer", "description": "帧数，须 ≤441 且满足 8n+1（非法值将自动纠正），默认 121" },
                    "frameRate": { "type": "integer", "description": "帧率 1-60，默认 24" },
                    "seed": { "type": "integer", "description": "随机种子（可复现）" },
                    "negativePrompt": { "type": "string", "description": "反向提示词" },
                    "numInferenceSteps": { "type": "integer", "description": "推理步数" },
                    "wait": { "type": "boolean", "description": "是否阻塞等待完成，默认 true。false 则立即返回 videoId 供 query_video 轮询。" },
                    "timeoutSec": { "type": "integer", "description": "wait=true 时的轮询上限秒数，默认 300，上限 360" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "query_video",
            "description": "查询 Agnes 视频任务状态。完成时返回视频下载 URL。",
            "inputSchema": {
                "type": "object",
                "required": ["videoId"],
                "properties": {
                    "videoId": { "type": "string", "minLength": 1, "description": "视频 ID（由 generate_video 返回）" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "get_config",
            "description": "获取当前 Agnes 配置（API Key 脱敏）。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "set_config",
            "description": "更新并持久化 Agnes 配置。部分更新：仅传需要修改的字段。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "apiKey": { "type": "string", "description": "API Key" },
                    "apiBase": { "type": "string", "description": "API 基础 URL" },
                    "imageModel": { "type": "string", "description": "图片模型名称" },
                    "videoModel": { "type": "string", "description": "视频模型名称" },
                    "defaultSize": { "type": "string", "description": "默认图片尺寸" }
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
    config_dir: &Path,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    // Reload config from disk on every call so panel edits apply without restart.
    let mut config = AgnesConfig::load(config_dir);

    match name {
        "generate_image" => exec_generate_image(&args, &config, client),
        "generate_video" => exec_generate_video(&args, &config, client),
        "query_video" => exec_query_video(&args, &config, client),
        "get_config" => exec_get_config(&config),
        "set_config" => exec_set_config(&args, &mut config, config_dir),
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
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&config.default_size);
    let response_format = args
        .get("responseFormat")
        .and_then(Value::as_str)
        .unwrap_or("url");
    let images: Vec<&str> = args
        .get("images")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut body = json!({
        "model": config.image_model,
        "prompt": prompt,
        "size": size,
    });

    if !images.is_empty() {
        // Image-to-image: image + response_format must live inside extra_body.
        body["extra_body"] = json!({
            "image": images,
            "response_format": response_format,
        });
    } else if response_format == "b64_json" {
        // text-to-image base64: top-level return_base64.
        body["return_base64"] = json!(true);
    } else {
        body["extra_body"] = json!({ "response_format": "url" });
    }

    let resp = api_post(client, config, "/v1/images/generations", body)?;

    let data = resp
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .ok_or_else(|| AppError::ProcessError("响应中缺少 data 数组".to_string()))?;

    let image_url = data.get("url").and_then(Value::as_str);
    let image_b64 = data.get("b64_json").and_then(Value::as_str);
    let revised = data.get("revised_prompt").and_then(Value::as_str);

    if let Some(url) = image_url {
        Ok(json!({
            "structuredContent": {
                "type": "image",
                "url": url,
                "model": config.image_model,
                "size": size,
                "prompt": prompt,
                "revisedPrompt": revised,
            },
            "content": [ { "type": "text", "text": format!("已生成图片: {url}") } ]
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
                "revisedPrompt": revised,
            },
            "content": [ { "type": "text", "text": "已生成图片（Base64）" } ]
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
    let requested_frames = args
        .get("numFrames")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_NUM_FRAMES as u64) as u32;
    let num_frames = normalize_num_frames(requested_frames);
    let frame_rate = args
        .get("frameRate")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_FRAME_RATE as u64) as u32;
    let negative_prompt = args.get("negativePrompt").and_then(Value::as_str);
    let seed = args.get("seed").and_then(Value::as_u64);
    let steps = args.get("numInferenceSteps").and_then(Value::as_u64);
    let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(true);
    let timeout_sec = args
        .get("timeoutSec")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_VIDEO_TIMEOUT_SEC)
        .min(MAX_VIDEO_TIMEOUT_SEC);

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
    if let Some(neg) = negative_prompt {
        body["negative_prompt"] = json!(neg);
    }
    if let Some(s) = seed {
        body["seed"] = json!(s);
    }
    if let Some(st) = steps {
        body["num_inference_steps"] = json!(st);
    }

    // Multi-image / keyframes → extra_body.image (+ extra_body.mode for keyframes).
    let images: Vec<Value> = args
        .get("images")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|v| v.is_string()).cloned().collect())
        .unwrap_or_default();
    let mut extra = serde_json::Map::new();
    if !images.is_empty() {
        extra.insert("image".to_string(), Value::Array(images));
    }
    if let Some(m) = mode {
        // ti2vid is a top-level mode; keyframes lives in extra_body per the docs.
        if m == "keyframes" {
            extra.insert("mode".to_string(), json!(m));
        } else {
            body["mode"] = json!(m);
        }
    }
    if !extra.is_empty() {
        body["extra_body"] = Value::Object(extra);
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
    let seconds = resp.get("seconds").and_then(Value::as_str).unwrap_or("?").to_string();

    let frames_note = if requested_frames != num_frames {
        format!("（帧数 {requested_frames} 已纠正为合法值 {num_frames}）")
    } else {
        String::new()
    };

    if !wait {
        return Ok(json!({
            "structuredContent": {
                "type": "video",
                "videoId": video_id,
                "taskId": task_id,
                "status": status,
                "seconds": seconds,
                "waiting": true,
            },
            "content": [ { "type": "text", "text":
                format!("视频任务已创建 (videoId: {video_id}){frames_note}，请调用 query_video 查询结果。") } ]
        }));
    }

    // Blocking poll until completion or timeout.
    let deadline = Instant::now() + Duration::from_secs(timeout_sec);
    loop {
        thread::sleep(Duration::from_millis(VIDEO_POLL_INTERVAL_MS));
        let poll = query_video_raw(client, config, &video_id)?;
        let poll_status = poll.get("status").and_then(Value::as_str).unwrap_or("unknown");
        let progress = poll.get("progress").and_then(Value::as_u64).unwrap_or(0);

        match poll_status {
            "completed" => {
                let url = extract_video_url(&poll);
                return Ok(json!({
                    "structuredContent": {
                        "type": "video",
                        "videoId": video_id,
                        "url": url,
                        "status": "completed",
                        "seconds": poll.get("seconds").and_then(Value::as_str).unwrap_or(&seconds),
                        "size": poll.get("size").and_then(Value::as_str).unwrap_or(""),
                        "model": config.video_model,
                        "prompt": prompt,
                    },
                    "content": [ { "type": "text", "text": format!("视频生成完成: {}", url.unwrap_or_default()) } ]
                }));
            }
            "failed" => {
                return Err(AppError::ProcessError(format!(
                    "视频生成失败: {}",
                    extract_error(&poll)
                )));
            }
            _ => {
                if Instant::now() >= deadline {
                    return Ok(json!({
                        "structuredContent": {
                            "type": "video",
                            "videoId": video_id,
                            "status": poll_status,
                            "progress": progress,
                            "waiting": true,
                        },
                        "content": [ { "type": "text", "text":
                            format!("等待超时（{timeout_sec}s），视频仍在生成 (进度 {progress}%)。请调用 query_video 继续查询。") } ]
                    }));
                }
            }
        }
    }
}

fn exec_query_video(
    args: &Value,
    config: &AgnesConfig,
    client: &reqwest::blocking::Client,
) -> Result<Value> {
    config.validate()?;
    let video_id = require_str(args, "videoId")?;
    let resp = query_video_raw(client, config, video_id)?;

    let status = resp.get("status").and_then(Value::as_str).unwrap_or("unknown");
    let progress = resp.get("progress").and_then(Value::as_u64).unwrap_or(0);

    match status {
        "completed" => {
            let url = extract_video_url(&resp);
            Ok(json!({
                "structuredContent": {
                    "type": "video",
                    "videoId": video_id,
                    "url": url,
                    "status": "completed",
                    "seconds": resp.get("seconds").and_then(Value::as_str).unwrap_or("?"),
                    "size": resp.get("size").and_then(Value::as_str).unwrap_or(""),
                },
                "content": [ { "type": "text", "text": format!("视频生成完成: {}", url.unwrap_or_default()) } ]
            }))
        }
        "failed" => Ok(json!({
            "structuredContent": {
                "type": "video",
                "videoId": video_id,
                "status": "failed",
                "error": extract_error(&resp),
            },
            "content": [ { "type": "text", "text": format!("视频生成失败: {}", extract_error(&resp)) } ]
        })),
        _ => Ok(json!({
            "structuredContent": {
                "type": "video",
                "videoId": video_id,
                "status": status,
                "progress": progress,
                "waiting": true,
            },
            "content": [ { "type": "text", "text": format!("视频生成中... 进度 {progress}%") } ]
        })),
    }
}

/// Query the video task; a `404` is treated as `queued` (creation latency).
fn query_video_raw(
    client: &reqwest::blocking::Client,
    config: &AgnesConfig,
    video_id: &str,
) -> Result<Value> {
    let encoded = urlencode(video_id);
    let url = format!(
        "{}/agnesapi?video_id={}",
        config.api_base.trim_end_matches('/'),
        encoded
    );
    match api_get(client, config, &url) {
        Ok(v) => Ok(v),
        Err(AppError::ProcessError(msg)) if msg.contains("404") => Ok(json!({ "status": "queued", "progress": 0 })),
        Err(e) => Err(e),
    }
}

fn exec_get_config(config: &AgnesConfig) -> Result<Value> {
    Ok(json!({
        "structuredContent": {
            "apiBase": config.api_base,
            "imageModel": config.image_model,
            "videoModel": config.video_model,
            "defaultSize": config.default_size,
            "hasApiKey": !config.api_key.trim().is_empty(),
            "apiKeyMasked": mask_key(&config.api_key),
        },
        "content": [ { "type": "text", "text": "当前 Agnes 配置" } ]
    }))
}

fn exec_set_config(args: &Value, config: &mut AgnesConfig, config_dir: &Path) -> Result<Value> {
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
    if let Some(size) = args.get("defaultSize").and_then(Value::as_str) {
        config.default_size = size.to_string();
    }
    config.save(config_dir)?;

    Ok(json!({
        "structuredContent": {
            "apiBase": config.api_base,
            "imageModel": config.image_model,
            "videoModel": config.video_model,
            "defaultSize": config.default_size,
            "hasApiKey": !config.api_key.trim().is_empty(),
        },
        "content": [ { "type": "text", "text": "配置已更新并保存" } ]
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

/// The `error` field may be a plain string or an object with a `message` field.
fn extract_error(resp: &Value) -> String {
    match resp.get("error") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => resp
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误")
            .to_string(),
        _ => "未知错误".to_string(),
    }
}

/// Extract the download URL from a completed video query response.
///
/// The current Agnes `/agnesapi` completion payload puts the download address
/// in the top-level `url` field. The legacy `remixed_from_video_id` field is
/// `null` for non-remix tasks and is kept only as a fallback for older API
/// versions that placed the URL there.
fn extract_video_url(resp: &Value) -> Option<String> {
    resp.get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            resp.get("remixed_from_video_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .map(String::from)
}

pub fn mask_key(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}...{tail}")
}

/// Minimal percent-encoding for the video_id query value (it is base64 with
/// `=` padding and may contain `+`/`/`).
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
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
        assert!(names.contains(&"query_video"));
        assert!(names.contains(&"get_config"));
        assert!(names.contains(&"set_config"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize();
        assert_eq!(value["protocolVersion"], Value::String(PROTOCOL_VERSION.to_string()));
        assert_eq!(value["serverInfo"]["name"], Value::String(SERVER_NAME.to_string()));
    }

    #[test]
    fn config_defaults_are_valid() {
        let config = AgnesConfig::default();
        assert_eq!(config.api_base, DEFAULT_API_BASE);
        assert_eq!(config.image_model, DEFAULT_IMAGE_MODEL);
        assert_eq!(config.video_model, DEFAULT_VIDEO_MODEL);
        assert_eq!(config.default_size, DEFAULT_IMAGE_SIZE);
    }

    #[test]
    fn config_validation_requires_api_key() {
        let mut config = AgnesConfig::default();
        assert!(config.validate().is_err());
        config.api_key = "test-key".to_string();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn num_frames_normalized_to_8n_plus_1() {
        assert_eq!(normalize_num_frames(121), 121); // already valid
        assert_eq!(normalize_num_frames(120), 121); // round up
        assert_eq!(normalize_num_frames(100), 97); // 8*12+1
        assert_eq!(normalize_num_frames(1), 9); // floor
        assert_eq!(normalize_num_frames(10_000), 441); // cap
        // Every result satisfies 8n+1.
        for n in [1u32, 50, 121, 200, 441, 999] {
            let f = normalize_num_frames(n);
            assert_eq!((f - 1) % 8, 0);
            assert!((9..=441).contains(&f));
        }
    }

    #[test]
    fn config_roundtrips_through_disk() {
        let dir = std::env::temp_dir().join(format!("agnes-cfg-test-{}", uuid::Uuid::new_v4()));
        let mut cfg = AgnesConfig::default();
        cfg.api_key = "sk-test-123456789".to_string();
        cfg.default_size = "768x1024".to_string();
        cfg.save(&dir).unwrap();
        let loaded = AgnesConfig::load(&dir);
        assert_eq!(loaded.api_key, "sk-test-123456789");
        assert_eq!(loaded.default_size, "768x1024");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn masks_api_key() {
        assert_eq!(mask_key(""), "");
        assert_eq!(mask_key("short"), "*****");
        assert_eq!(mask_key("sk-1234567890"), "sk-1...7890");
    }

    #[test]
    fn extract_video_url_prefers_top_level_url() {
        // 实测完成态:顶层 url 有值,remixed_from_video_id 为 null → 取 url
        let resp = json!({
            "status": "completed",
            "url": "https://platform-outputs.agnes-ai.space/videos/x.mp4",
            "remixed_from_video_id": null,
        });
        assert_eq!(
            extract_video_url(&resp).as_deref(),
            Some("https://platform-outputs.agnes-ai.space/videos/x.mp4")
        );
    }

    #[test]
    fn extract_video_url_falls_back_to_remixed_field() {
        // 旧版上游兼容:无 url 时退回 remixed_from_video_id
        let resp = json!({
            "status": "completed",
            "remixed_from_video_id": "https://legacy/x.mp4",
        });
        assert_eq!(extract_video_url(&resp).as_deref(), Some("https://legacy/x.mp4"));
    }

    #[test]
    fn extract_video_url_none_when_both_empty() {
        // 运行中:两字段均 null → None
        let resp = json!({
            "status": "in_progress",
            "url": null,
            "remixed_from_video_id": null,
        });
        assert!(extract_video_url(&resp).is_none());
    }

    #[test]
    fn extract_video_url_ignores_empty_string() {
        let resp = json!({ "status": "completed", "url": "", "remixed_from_video_id": "" });
        assert!(extract_video_url(&resp).is_none());
    }
}
