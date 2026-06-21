//! HTTP Client MCP Server
//!
//! MCP server for issuing HTTP requests — exposes an `http_request` tool so the
//! AI can call REST APIs, debug endpoints, or integrate with third-party services.
//!
//! JSON-RPC 2.0 over stdio，遵循 MCP 2024-11-05 协议。
//! 请求执行复用 `http_client_service::execute_request`（通过 tokio runtime）。

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::http_client_service::{self, HttpRequestSpec};

const SERVER_NAME: &str = "polaris-http-client-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

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

/// Run the HTTP client MCP server
pub fn run_http_client_mcp_server(
    _config_dir: &str,
    _workspace_path: Option<&str>,
) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    // 单一 tokio runtime 复用，避免每次请求创建
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::ProcessError(format!("创建 tokio runtime 失败: {}", e)))?;

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
            Ok(request) => handle_request(request, &runtime),
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

fn handle_request(request: JsonRpcRequest, runtime: &tokio::runtime::Runtime) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(
            id,
            -32600,
            "Invalid Request: jsonrpc must be 2.0".to_string(),
        );
    }

    let result = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, runtime),
        _ => Err(AppError::ValidationError(format!(
            "Unsupported method: {}",
            request.method
        ))),
    };

    match result {
        Ok(value) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(value),
            error: None,
        },
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}

fn handle_initialize() -> Result<Value> {
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    }))
}

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "http_request",
                "description": "发起一次 HTTP 请求并返回响应（状态码、响应头、响应体、耗时）。可用于调用 REST API、调试接口、对接第三方服务。注意：会在本机直接发起请求，请确认目标地址安全。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "method": {
                            "type": "string",
                            "description": "HTTP 方法，如 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS",
                            "default": "GET"
                        },
                        "url": {
                            "type": "string",
                            "description": "完整请求 URL，如 https://api.example.com/users"
                        },
                        "headers": {
                            "type": "array",
                            "description": "请求头列表",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "value": { "type": "string" }
                                },
                                "required": ["name", "value"]
                            }
                        },
                        "query": {
                            "type": "array",
                            "description": "URL 查询参数",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "value": { "type": "string" }
                                },
                                "required": ["name", "value"]
                            }
                        },
                        "body": {
                            "type": "string",
                            "description": "请求体（原始字符串，通常为 JSON）"
                        },
                        "bodyType": {
                            "type": "string",
                            "enum": ["json", "text", "form", "none"],
                            "default": "none",
                            "description": "请求体类型，决定是否自动补全 Content-Type"
                        },
                        "timeoutMs": {
                            "type": "integer",
                            "description": "超时毫秒数，默认 30000"
                        },
                        "followRedirects": {
                            "type": "boolean",
                            "default": true,
                            "description": "是否跟随重定向"
                        }
                    },
                    "required": ["method", "url"]
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, runtime: &tokio::runtime::Runtime) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "http_request" => execute_http_request(arguments, runtime),
        _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
    }
}

fn execute_http_request(arguments: Value, runtime: &tokio::runtime::Runtime) -> Result<Value> {
    // 兼容 camelCase（MCP schema）与 snake_case 两种字段名
    let mut spec: HttpRequestSpec = serde_json::from_value(arguments.clone()).map_err(|e| {
        AppError::ValidationError(format!("参数解析失败: {}。参数: {}", e, arguments))
    })?;

    // 字段兜底：默认 GET 方法
    if spec.method.trim().is_empty() {
        spec.method = "GET".to_string();
    }

    let response = runtime
        .block_on(async { http_client_service::execute_request(&spec).await })?;

    let summary = http_client_service::summarize_response(&response);
    Ok(json!({
        "structuredContent": response,
        "content": [{ "type": "text", "text": summary }]
    }))
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

/// 供诊断使用的工具定义列表
pub fn current_tool_definitions() -> BTreeMap<&'static str, &'static str> {
    let mut tools = BTreeMap::new();
    tools.insert("http_request", "发起 HTTP 请求并返回响应");
    tools
}
