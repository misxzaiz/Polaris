//! Agnes 插件面板使用的 Tauri 命令。
//!
//! 面板自身需要直接调用 Agnes API（生图/生视频/查询）与读写配置，
//! 与 MCP server（供 AI agent 调用）共享 `<config_dir>/agnes/config.json`。
//!
//! 全部命令 `#[cfg(feature = "tauri-app")]` 门控：web-only 打包不编译。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(feature = "tauri-app")]
use tauri::{Manager, State, Window};

use crate::error::{AppError, Result};
use crate::services::agnes_mcp_server::{
    mask_key, normalize_num_frames, AgnesConfig, DEFAULT_API_BASE, DEFAULT_IMAGE_MODEL,
    DEFAULT_VIDEO_MODEL,
};

// ============================================================================
// 共享类型
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgnesConfigView {
    pub api_base: String,
    pub image_model: String,
    pub video_model: String,
    pub default_size: String,
    pub has_api_key: bool,
    pub api_key_masked: String,
}

impl From<&AgnesConfig> for AgnesConfigView {
    fn from(c: &AgnesConfig) -> Self {
        Self {
            api_base: c.api_base.clone(),
            image_model: c.image_model.clone(),
            video_model: c.video_model.clone(),
            default_size: c.default_size.clone(),
            has_api_key: !c.api_key.trim().is_empty(),
            api_key_masked: mask_key(&c.api_key),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgnesImageResult {
    pub url: Option<String>,
    pub base64: Option<String>,
    pub mime_type: Option<String>,
    pub revised_prompt: Option<String>,
    pub size: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgnesVideoTask {
    pub video_id: String,
    pub task_id: Option<String>,
    pub status: String,
    pub progress: u64,
    pub seconds: Option<String>,
    pub size: Option<String>,
    pub url: Option<String>,
    pub error: Option<String>,
    pub frames_normalized: Option<bool>,
}

// ============================================================================
// 配置读写
// ============================================================================

#[cfg(feature = "tauri-app")]
fn config_dir_from_window(window: &Window) -> Result<PathBuf> {
    window
        .path()
        .app_config_dir()
        .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {e}")))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn agnes_get_config(window: Window) -> Result<AgnesConfigView> {
    let dir = config_dir_from_window(&window)?;
    let config = AgnesConfig::load(&dir);
    Ok(AgnesConfigView::from(&config))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn agnes_save_config(
    window: Window,
    api_key: Option<String>,
    api_base: Option<String>,
    image_model: Option<String>,
    video_model: Option<String>,
    default_size: Option<String>,
) -> Result<AgnesConfigView> {
    let dir = config_dir_from_window(&window)?;
    let mut config = AgnesConfig::load(&dir);
    if let Some(key) = api_key {
        config.api_key = key;
    }
    if let Some(base) = api_base {
        if !base.trim().is_empty() {
            config.api_base = base;
        }
    }
    if let Some(m) = image_model {
        if !m.trim().is_empty() {
            config.image_model = m;
        }
    }
    if let Some(m) = video_model {
        if !m.trim().is_empty() {
            config.video_model = m;
        }
    }
    if let Some(s) = default_size {
        if !s.trim().is_empty() {
            config.default_size = s;
        }
    }
    config.save(&dir)?;
    Ok(AgnesConfigView::from(&config))
}

// ============================================================================
// HTTP helpers (async)
// ============================================================================

fn build_async_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(390))
        .build()
        .map_err(|e| AppError::ProcessError(format!("创建 HTTP 客户端失败: {e}")))
}

async fn api_post_json(
    client: &reqwest::Client,
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
        .await
        .map_err(|e| AppError::ProcessError(format!("API 请求失败: {e}")))?;
    read_json_response(resp).await
}

async fn api_get_json(client: &reqwest::Client, config: &AgnesConfig, url: &str) -> Result<Value> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send()
        .await
        .map_err(|e| AppError::ProcessError(format!("API 请求失败: {e}")))?;
    read_json_response(resp).await
}

async fn read_json_response(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let text = resp
        .text()
        .await
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
// 生图
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn agnes_generate_image(
    window: Window,
    prompt: String,
    size: Option<String>,
    images: Option<Vec<String>>,
    response_format: Option<String>,
) -> Result<AgnesImageResult> {
    let dir = config_dir_from_window(&window)?;
    let config = AgnesConfig::load(&dir);
    config.validate()?;

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::ValidationError("prompt 不能为空".to_string()));
    }
    let size = size
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| config.default_size.clone());
    let response_format = response_format.as_deref().unwrap_or("url");
    let images = images.unwrap_or_default();

    let mut body = json!({
        "model": config.image_model,
        "prompt": prompt,
        "size": size,
    });
    if !images.is_empty() {
        body["extra_body"] = json!({ "image": images, "response_format": response_format });
    } else if response_format == "b64_json" {
        body["return_base64"] = json!(true);
    } else {
        body["extra_body"] = json!({ "response_format": "url" });
    }

    let client = build_async_client()?;
    let resp = api_post_json(&client, &config, "/v1/images/generations", body).await?;

    let data = resp
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .ok_or_else(|| AppError::ProcessError("响应中缺少 data 数组".to_string()))?;

    Ok(AgnesImageResult {
        url: data.get("url").and_then(Value::as_str).map(String::from),
        base64: data.get("b64_json").and_then(Value::as_str).map(String::from),
        mime_type: Some("image/png".to_string()),
        revised_prompt: data
            .get("revised_prompt")
            .and_then(Value::as_str)
            .map(String::from),
        size,
        model: config.image_model,
    })
}

// ============================================================================
// 生视频 + 查询
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn agnes_create_video(
    window: Window,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    num_frames: Option<u32>,
    frame_rate: Option<u32>,
    image: Option<String>,
    images: Option<Vec<String>>,
    mode: Option<String>,
    seed: Option<u64>,
    negative_prompt: Option<String>,
    num_inference_steps: Option<u64>,
) -> Result<AgnesVideoTask> {
    let dir = config_dir_from_window(&window)?;
    let config = AgnesConfig::load(&dir);
    config.validate()?;

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::ValidationError("prompt 不能为空".to_string()));
    }

    let width = width.unwrap_or(1152);
    let height = height.unwrap_or(768);
    let requested_frames = num_frames.unwrap_or(121);
    let num_frames = normalize_num_frames(requested_frames);
    let frame_rate = frame_rate.unwrap_or(24);
    let frames_normalized = Some(requested_frames != num_frames);

    let mut body = json!({
        "model": config.video_model,
        "prompt": prompt,
        "width": width,
        "height": height,
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });
    if let Some(img) = image.as_ref().filter(|s| !s.trim().is_empty()) {
        body["image"] = json!(img);
    }
    if let Some(neg) = negative_prompt {
        body["negative_prompt"] = json!(neg);
    }
    if let Some(s) = seed {
        body["seed"] = json!(s);
    }
    if let Some(st) = num_inference_steps {
        body["num_inference_steps"] = json!(st);
    }

    let extra_images: Vec<Value> = images
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .map(Value::String)
        .collect();
    let mut extra = serde_json::Map::new();
    if !extra_images.is_empty() {
        extra.insert("image".to_string(), Value::Array(extra_images));
    }
    if let Some(m) = mode.as_ref() {
        if m == "keyframes" {
            extra.insert("mode".to_string(), json!(m));
        } else {
            body["mode"] = json!(m);
        }
    }
    if !extra.is_empty() {
        body["extra_body"] = Value::Object(extra);
    }

    let client = build_async_client()?;
    let resp = api_post_json(&client, &config, "/v1/videos", body).await?;

    let video_id = resp
        .get("video_id")
        .and_then(Value::as_str)
        .or_else(|| resp.get("id").and_then(Value::as_str))
        .ok_or_else(|| AppError::ProcessError("响应中缺少 video_id".to_string()))?
        .to_string();

    Ok(AgnesVideoTask {
        video_id,
        task_id: resp.get("task_id").and_then(Value::as_str).map(String::from),
        status: resp
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("queued")
            .to_string(),
        progress: resp.get("progress").and_then(Value::as_u64).unwrap_or(0),
        seconds: resp.get("seconds").and_then(Value::as_str).map(String::from),
        size: resp.get("size").and_then(Value::as_str).map(String::from),
        url: None,
        error: None,
        frames_normalized,
    })
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn agnes_query_video(
    window: Window,
    video_id: String,
) -> Result<AgnesVideoTask> {
    let dir = config_dir_from_window(&window)?;
    let config = AgnesConfig::load(&dir);
    config.validate()?;

    let video_id = video_id.trim();
    if video_id.is_empty() {
        return Err(AppError::ValidationError("video_id 不能为空".to_string()));
    }

    let client = build_async_client()?;
    let encoded = urlencode(video_id);
    let url = format!(
        "{}/agnesapi?video_id={}",
        config.api_base.trim_end_matches('/'),
        encoded
    );

    let resp = match api_get_json(&client, &config, &url).await {
        Ok(v) => v,
        Err(AppError::ProcessError(msg)) if msg.contains("404") => {
            json!({ "status": "queued", "progress": 0 })
        }
        Err(e) => return Err(e),
    };

    let status = resp
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let progress = resp.get("progress").and_then(Value::as_u64).unwrap_or(0);
    let url = resp
        .get("remixed_from_video_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let error = match status.as_str() {
        "failed" => Some(extract_error(&resp)),
        _ => None,
    };

    Ok(AgnesVideoTask {
        video_id: video_id.to_string(),
        task_id: None,
        status,
        progress,
        seconds: resp.get("seconds").and_then(Value::as_str).map(String::from),
        size: resp.get("size").and_then(Value::as_str).map(String::from),
        url,
        error,
        frames_normalized: None,
    })
}

// ============================================================================
// helpers
// ============================================================================

fn extract_error(resp: &Value) -> String {
    match resp.get("error") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_) | Value::Array(_)) => resp
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误")
            .to_string(),
        _ => "未知错误".to_string(),
    }
}

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

// 防止未使用警告（web-only 打包时这些常量/导入不参与编译）
#[allow(dead_code)]
const _: &str = DEFAULT_API_BASE;
#[allow(dead_code)]
const _: &str = DEFAULT_IMAGE_MODEL;
#[allow(dead_code)]
const _: &str = DEFAULT_VIDEO_MODEL;

// AppState 占位：保持命令签名与其它面板一致，便于未来扩展。
#[cfg(feature = "tauri-app")]
#[allow(dead_code)]
type _AppStateStub = State<'static, crate::AppState>;
