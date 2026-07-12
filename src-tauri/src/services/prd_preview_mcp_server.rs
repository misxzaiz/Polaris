//! PRD Preview MCP Server
//!
//! Stores self-contained HTML artifacts under the current workspace and returns
//! a structured marker that the Polaris chat UI can turn into an iframe preview.

use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
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
    created_at: String,
    version: u32,
    version_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requirement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewMetadata {
    artifact_type: String,
    preview_id: String,
    title: String,
    content_type: String,
    source_path: String,
    created_at: String,
    version: u32,
    version_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requirement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
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
                    "html": { "type": "string", "minLength": 1, "description": "完整 HTML 源码，建议内联 CSS/JS" },
                    "requirementId": { "type": "string", "description": "可选，关联的需求 ID；同一需求下版本号会递增" },
                    "description": { "type": "string", "description": "可选，预览说明或本版本变更摘要" },
                    "versionLabel": { "type": "string", "description": "可选，展示版本名；未传时自动生成 v1/v2..." }
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
    let requirement_id = optional_trimmed_string(args.get("requirementId"));
    let description = optional_trimmed_string(args.get("description"));
    let version = repository.next_version(requirement_id.as_deref())?;
    let version_label =
        optional_trimmed_string(args.get("versionLabel")).unwrap_or_else(|| format!("v{version}"));
    let created_at = now_iso();

    let preview_id = Uuid::new_v4().to_string();
    let dir = repository.preview_dir(&preview_id)?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::ProcessError(format!("创建预览目录失败: {}", e)))?;

    let index_path = dir.join("index.html");
    fs::write(&index_path, html.as_bytes())
        .map_err(|e| AppError::ProcessError(format!("写入预览 HTML 失败: {}", e)))?;

    let metadata = PreviewMetadata {
        artifact_type: ARTIFACT_TYPE.to_string(),
        preview_id: preview_id.clone(),
        title,
        content_type: "html".to_string(),
        source_path: index_path.to_string_lossy().to_string(),
        created_at,
        version,
        version_label,
        requirement_id,
        description,
    };
    repository.write_metadata(&metadata)?;

    let artifact = PreviewArtifact {
        artifact_type: metadata.artifact_type.clone(),
        preview_id,
        title: metadata.title,
        content_type: metadata.content_type,
        source_path: metadata.source_path,
        html,
        created_at: metadata.created_at,
        version: metadata.version,
        version_label: metadata.version_label,
        requirement_id: metadata.requirement_id,
        description: metadata.description,
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
    let metadata = repository
        .read_metadata(preview_id)?
        .unwrap_or_else(|| repository.fallback_metadata(preview_id, &path));

    let artifact = PreviewArtifact {
        artifact_type: metadata.artifact_type,
        preview_id: preview_id.to_string(),
        title: metadata.title,
        content_type: metadata.content_type,
        source_path: path.to_string_lossy().to_string(),
        html,
        created_at: metadata.created_at,
        version: metadata.version,
        version_label: metadata.version_label,
        requirement_id: metadata.requirement_id,
        description: metadata.description,
    };

    Ok(artifact_result(&artifact, "已读取预览".to_string()))
}

fn exec_list_previews(args: &Value, repository: &PreviewRepository) -> Result<Value> {
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 50) as usize;

    let mut previews: Vec<PreviewMetadata> = Vec::new();
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
                let metadata = repository
                    .read_metadata(preview_id)?
                    .unwrap_or_else(|| repository.fallback_metadata(preview_id, &index_path));
                previews.push(metadata);
            }
        }
    }

    previews.sort_by(|a, b| b.created_at.cmp(&a.created_at));
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

    fn metadata_path(&self, preview_id: &str) -> Result<PathBuf> {
        Ok(self.preview_dir(preview_id)?.join("metadata.json"))
    }

    fn write_metadata(&self, metadata: &PreviewMetadata) -> Result<()> {
        let path = self.metadata_path(&metadata.preview_id)?;
        let payload = serde_json::to_vec_pretty(metadata)
            .map_err(|e| AppError::ProcessError(format!("序列化预览元数据失败: {}", e)))?;
        fs::write(&path, payload)
            .map_err(|e| AppError::ProcessError(format!("写入预览元数据失败: {}", e)))?;
        Ok(())
    }

    fn read_metadata(&self, preview_id: &str) -> Result<Option<PreviewMetadata>> {
        let path = self.metadata_path(preview_id)?;
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| AppError::ProcessError(format!("读取预览元数据失败: {}", e)))?;
        let metadata = serde_json::from_str::<PreviewMetadata>(&content)
            .map_err(|e| AppError::ProcessError(format!("解析预览元数据失败: {}", e)))?;
        Ok(Some(metadata))
    }

    fn fallback_metadata(&self, preview_id: &str, index_path: &Path) -> PreviewMetadata {
        PreviewMetadata {
            artifact_type: ARTIFACT_TYPE.to_string(),
            preview_id: preview_id.to_string(),
            title: "PRD Prototype".to_string(),
            content_type: "html".to_string(),
            source_path: index_path.to_string_lossy().to_string(),
            created_at: file_modified_iso(index_path).unwrap_or_else(now_iso),
            version: 1,
            version_label: "v1".to_string(),
            requirement_id: None,
            description: None,
        }
    }

    fn next_version(&self, requirement_id: Option<&str>) -> Result<u32> {
        let Some(requirement_id) = requirement_id else {
            return Ok(1);
        };
        if !self.root.exists() {
            return Ok(1);
        }

        let mut max_version = 0_u32;
        let entries = fs::read_dir(&self.root)
            .map_err(|e| AppError::ProcessError(format!("读取预览目录失败: {}", e)))?;
        for entry in entries.flatten() {
            let Some(preview_id) = entry
                .path()
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            if !is_safe_preview_id(&preview_id) {
                continue;
            }
            let Some(metadata) = self.read_metadata(&preview_id)? else {
                continue;
            };
            if metadata.requirement_id.as_deref() == Some(requirement_id) {
                max_version = max_version.max(metadata.version);
            }
        }

        Ok(max_version.saturating_add(1))
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

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn file_modified_iso(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let datetime: chrono::DateTime<Utc> = modified.into();
    Some(datetime.to_rfc3339_opts(SecondsFormat::Millis, true))
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

    #[test]
    fn stores_preview_metadata_and_increments_requirement_versions() {
        let config_dir = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let repository = PreviewRepository::new(
            config_dir.path().to_str().unwrap(),
            Some(workspace_dir.path().to_str().unwrap()),
        )
        .unwrap();

        let first = exec_preview_html(
            &json!({
                "title": "Checkout Flow",
                "html": "<!doctype html><html><body>v1</body></html>",
                "requirementId": "REQ-100",
                "description": "Initial prototype"
            }),
            &repository,
        )
        .unwrap();
        let first_artifact = &first["structuredContent"];
        let first_id = first_artifact["previewId"].as_str().unwrap();
        assert_eq!(first_artifact["version"], Value::from(1));
        assert_eq!(
            first_artifact["versionLabel"],
            Value::String("v1".to_string())
        );
        assert_eq!(
            first_artifact["requirementId"],
            Value::String("REQ-100".to_string())
        );
        assert!(repository.metadata_path(first_id).unwrap().exists());

        let read = exec_read_preview(&json!({ "previewId": first_id }), &repository).unwrap();
        assert_eq!(
            read["structuredContent"]["title"],
            Value::String("Checkout Flow".to_string())
        );
        assert_eq!(read["structuredContent"]["version"], Value::from(1));

        let second = exec_preview_html(
            &json!({
                "title": "Checkout Flow",
                "html": "<!doctype html><html><body>v2</body></html>",
                "requirementId": "REQ-100"
            }),
            &repository,
        )
        .unwrap();
        assert_eq!(second["structuredContent"]["version"], Value::from(2));
        assert_eq!(
            second["structuredContent"]["versionLabel"],
            Value::String("v2".to_string())
        );

        let listed = exec_list_previews(&json!({ "limit": 10 }), &repository).unwrap();
        let previews = listed["structuredContent"]["previews"].as_array().unwrap();
        assert_eq!(previews.len(), 2);
        assert!(previews
            .iter()
            .any(|preview| preview["version"] == Value::from(2)));
    }
}
