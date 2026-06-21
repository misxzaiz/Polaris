//! PRD Preview MCP Server
//!
//! Stores self-contained HTML artifacts under the current workspace and returns
//! a structured marker that the Polaris chat UI can turn into an iframe preview.

use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-prd-preview-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const PREVIEW_DIR: &str = ".polaris/previews";
const ARTIFACT_TYPE: &str = "polaris.preview";

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

#[derive(Debug, Clone)]
struct PreviewRepository {
    root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArtifact {
    artifact_type: String,
    preview_id: String,
    title: String,
    content_type: String,
    source_path: String,
    html: String,
}

pub fn run_prd_preview_mcp_server(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let repository = PreviewRepository::new(config_dir, workspace_path)?;

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
            Ok(request) => handle_request(request, &repository),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {}", error),
                }),
            },
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

fn handle_request(
    request: JsonRpcRequest,
    repository: &PreviewRepository,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(
            id,
            -32600,
            "Invalid Request: jsonrpc must be 2.0".to_string(),
        );
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(handle_initialize()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, repository),
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

fn handle_tools_list() -> Value {
    json!({ "tools": [
        {
            "name": "preview_html",
            "description": "创建一个自包含 HTML 原型预览。html 必须是完整 HTML 文档或可独立渲染的片段；不要引用本地任意路径。返回内容会在 Polaris 聊天中渲染为 artifact_preview。",
            "inputSchema": {
                "type": "object",
                "required": ["html"],
                "properties": {
                    "title": { "type": "string", "description": "预览标题" },
                    "html": { "type": "string", "minLength": 1, "description": "完整 HTML 源码，建议内联 CSS/JS" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "read_preview",
            "description": "读取之前创建的 HTML 预览源码。",
            "inputSchema": {
                "type": "object",
                "required": ["previewId"],
                "properties": {
                    "previewId": { "type": "string", "minLength": 1 }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "list_previews",
            "description": "列出当前工作区最近保存的 Polaris HTML 预览。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "additionalProperties": false
            }
        }
    ] })
}

fn handle_tools_call(params: Value, repository: &PreviewRepository) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "preview_html" => exec_preview_html(&args, repository),
        "read_preview" => exec_read_preview(&args, repository),
        "list_previews" => exec_list_previews(&args, repository),
        other => Err(AppError::ValidationError(format!("未知工具: {other}"))),
    }
}

fn exec_preview_html(args: &Value, repository: &PreviewRepository) -> Result<Value> {
    let html = require_str(args, "html")?.to_string();
    validate_html_size(&html)?;
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("PRD Prototype")
        .to_string();

    let preview_id = Uuid::new_v4().to_string();
    let dir = repository.preview_dir(&preview_id)?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::ProcessError(format!("创建预览目录失败: {}", e)))?;

    let index_path = dir.join("index.html");
    fs::write(&index_path, html.as_bytes())
        .map_err(|e| AppError::ProcessError(format!("写入预览 HTML 失败: {}", e)))?;

    let artifact = PreviewArtifact {
        artifact_type: ARTIFACT_TYPE.to_string(),
        preview_id,
        title,
        content_type: "html".to_string(),
        source_path: index_path.to_string_lossy().to_string(),
        html,
    };

    Ok(artifact_result(
        &artifact,
        format!("已创建预览: {}", artifact.title),
    ))
}

fn exec_read_preview(args: &Value, repository: &PreviewRepository) -> Result<Value> {
    let preview_id = require_str(args, "previewId")?;
    let path = repository.index_path(preview_id)?;
    let html = fs::read_to_string(&path)
        .map_err(|e| AppError::ProcessError(format!("读取预览失败: {}", e)))?;
    validate_html_size(&html)?;

    let artifact = PreviewArtifact {
        artifact_type: ARTIFACT_TYPE.to_string(),
        preview_id: preview_id.to_string(),
        title: "PRD Prototype".to_string(),
        content_type: "html".to_string(),
        source_path: path.to_string_lossy().to_string(),
        html,
    };

    Ok(artifact_result(&artifact, "已读取预览".to_string()))
}

fn exec_list_previews(args: &Value, repository: &PreviewRepository) -> Result<Value> {
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 50) as usize;

    let mut previews = Vec::new();
    if repository.root.exists() {
        let entries = fs::read_dir(&repository.root)
            .map_err(|e| AppError::ProcessError(format!("读取预览目录失败: {}", e)))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(preview_id) = path.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            if !is_safe_preview_id(preview_id) {
                continue;
            }
            let index_path = path.join("index.html");
            if index_path.exists() {
                previews.push(json!({
                    "previewId": preview_id,
                    "sourcePath": index_path.to_string_lossy().to_string(),
                }));
            }
        }
    }

    previews.truncate(limit);
    Ok(json!({
        "structuredContent": { "previews": previews },
        "content": [ { "type": "text", "text": format!("共 {} 个预览", previews.len()) } ]
    }))
}

fn artifact_result(artifact: &PreviewArtifact, message: String) -> Value {
    let artifact_json = serde_json::to_string(artifact).unwrap_or_else(|_| "{}".to_string());
    json!({
        "structuredContent": artifact,
        "content": [
            {
                "type": "text",
                "text": format!("{message}\n```json\n{artifact_json}\n```")
            }
        ]
    })
}

impl PreviewRepository {
    fn new(config_dir: &str, workspace_path: Option<&str>) -> Result<Self> {
        let root_base = workspace_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(config_dir).join("previews-workspace"));

        Ok(Self {
            root: root_base.join(Path::new(PREVIEW_DIR)),
        })
    }

    fn preview_dir(&self, preview_id: &str) -> Result<PathBuf> {
        if !is_safe_preview_id(preview_id) {
            return Err(AppError::ValidationError("previewId 不合法".to_string()));
        }
        Ok(self.root.join(preview_id))
    }

    fn index_path(&self, preview_id: &str) -> Result<PathBuf> {
        Ok(self.preview_dir(preview_id)?.join("index.html"))
    }
}

fn validate_html_size(html: &str) -> Result<()> {
    if html.len() > MAX_HTML_BYTES {
        return Err(AppError::ValidationError(format!(
            "HTML 过大，最大允许 {} bytes",
            MAX_HTML_BYTES
        )));
    }
    Ok(())
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError(format!("缺少字符串参数: {key}")))
}

fn is_safe_preview_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !value.contains("..")
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
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], Value::String("preview_html".to_string()));
    }

    #[test]
    fn rejects_unsafe_preview_ids() {
        assert!(is_safe_preview_id("a3b2-hello_world"));
        assert!(!is_safe_preview_id("../secret"));
        assert!(!is_safe_preview_id("a/b"));
        assert!(!is_safe_preview_id(""));
    }
}
