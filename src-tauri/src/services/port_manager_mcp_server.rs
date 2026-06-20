//! Port Manager MCP Server
//!
//! MCP server for port management — list, find, kill, and check ports.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::port_manager_service;

const SERVER_NAME: &str = "polaris-port-manager-mcp";
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

/// Run the port manager MCP server
pub fn run_port_manager_mcp_server(
    _config_dir: &str,
    _workspace_path: Option<&str>,
) -> Result<()> {
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
            Ok(request) => handle_request(request),
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

fn handle_request(request: JsonRpcRequest) -> JsonRpcResponse<'static> {
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
        "tools/call" => handle_tools_call(request.params),
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
                "name": "port_list",
                "description": "列出所有监听中的 TCP 端口及其占用进程",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "port_find",
                "description": "查找指定端口的占用进程信息",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": {
                            "type": "integer",
                            "description": "要查找的端口号"
                        }
                    },
                    "required": ["port"]
                }
            },
            {
                "name": "port_kill",
                "description": "终止占用指定端口的进程",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": {
                            "type": "integer",
                            "description": "要释放的端口号"
                        }
                    },
                    "required": ["port"]
                }
            },
            {
                "name": "port_check",
                "description": "检查指定端口是否可用（未被占用）",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "port": {
                            "type": "integer",
                            "description": "要检查的端口号"
                        }
                    },
                    "required": ["port"]
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "port_list" => execute_port_list(),
        "port_find" => execute_port_find(arguments),
        "port_kill" => execute_port_kill(arguments),
        "port_check" => execute_port_check(arguments),
        _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
    }
}

fn execute_port_list() -> Result<Value> {
    let ports = port_manager_service::list_listening_ports()?;

    let ports_json: Vec<Value> = ports
        .iter()
        .map(|p| {
            let mut item = json!({
                "port": p.port,
                "protocol": p.protocol,
                "address": p.address,
                "pid": p.pid,
                "processName": p.process_name,
            });
            if let Some(name) = port_manager_service::common_port_name(p.port) {
                item["commonService"] = json!(name);
            }
            item
        })
        .collect();

    let count = ports_json.len();
    let summary = format!("共 {} 个监听端口", count);

    Ok(json!({
        "structuredContent": {
            "ports": ports_json,
            "total": count
        },
        "content": [
            { "type": "text", "text": summary }
        ]
    }))
}

fn execute_port_find(arguments: Value) -> Result<Value> {
    let port = arguments
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::ValidationError("port_find 需要 port 参数（整数）".to_string()))?
        as u16;

    match port_manager_service::find_port_owner(port)? {
        Some(info) => {
            let mut detail = json!({
                "port": info.port,
                "protocol": info.protocol,
                "address": info.address,
                "pid": info.pid,
                "processName": info.process_name,
            });
            if let Some(name) = port_manager_service::common_port_name(port) {
                detail["commonService"] = json!(name);
            }
            let text = format!(
                "端口 {} 被进程 {} (PID: {}) 占用",
                port, info.process_name, info.pid
            );
            Ok(json!({
                "structuredContent": detail,
                "content": [{ "type": "text", "text": text }]
            }))
        }
        None => Ok(json!({
            "structuredContent": { "port": port, "available": true },
            "content": [{ "type": "text", "text": format!("端口 {} 未被占用，可以使用", port) }]
        })),
    }
}

fn execute_port_kill(arguments: Value) -> Result<Value> {
    let port = arguments
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::ValidationError("port_kill 需要 port 参数（整数）".to_string()))?
        as u16;

    let result = port_manager_service::kill_process_by_port(port)?;

    let text = if result.success {
        format!(
            "已终止占用端口 {} 的进程 {} (PID: {})",
            result.port, result.process_name, result.pid
        )
    } else {
        format!(
            "终止失败: {}",
            result.error.as_deref().unwrap_or("未知错误")
        )
    };

    Ok(json!({
        "structuredContent": {
            "port": result.port,
            "pid": result.pid,
            "processName": result.process_name,
            "success": result.success,
            "error": result.error,
        },
        "content": [{ "type": "text", "text": text }]
    }))
}

fn execute_port_check(arguments: Value) -> Result<Value> {
    let port = arguments
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::ValidationError("port_check 需要 port 参数（整数）".to_string()))?
        as u16;

    let available = port_manager_service::is_port_available(port)?;
    let text = if available {
        format!("端口 {} 可用", port)
    } else {
        format!("端口 {} 已被占用", port)
    };

    Ok(json!({
        "structuredContent": { "port": port, "available": available },
        "content": [{ "type": "text", "text": text }]
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
    tools.insert("port_list", "列出所有监听端口");
    tools.insert("port_find", "查找指定端口占用进程");
    tools.insert("port_kill", "终止占用指定端口的进程");
    tools.insert("port_check", "检查端口是否可用");
    tools
}
