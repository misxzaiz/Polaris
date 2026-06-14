//! AskUserQuestion MCP Server
//!
//! MCP companion process that intercepts Claude CLI's ask_user_question tool calls,
//! forwards them to the main Tauri process via TCP, and blocks until the user answers.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-ask-mcp";
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

/// TCP frame: u32 LE length prefix + UTF-8 JSON payload
fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;

    let value: Value = serde_json::from_slice(&payload)?;
    Ok(value)
}

fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    let len = (payload.len() as u32).to_le_bytes();
    stream.write_all(&len)?;
    stream.write_all(&payload)?;
    stream.flush()?;
    Ok(())
}

/// Run the ask MCP server
pub fn run_ask_mcp_server(port: u16, token: &str, session_id: Option<&str>) -> Result<()> {
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
            Ok(request) => handle_request(request, port, token, session_id),
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
    port: u16,
    token: &str,
    session_id: Option<&str>,
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
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, port, token, session_id),
        _ => Err(AppError::ValidationError(format!(
            "Unsupported method: {}",
            request.method
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

fn handle_initialize() -> Result<Value> {
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    }))
}

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "ask_user_question",
                "description": "Ask the user a question with multiple-choice options. This tool will block until the user responds.",
                "inputSchema": {
                    "type": "object",
                    "required": ["questions"],
                    "properties": {
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "required": ["question", "header", "options"],
                                "properties": {
                                    "question": {
                                        "type": "string",
                                        "description": "The question to ask the user"
                                    },
                                    "header": {
                                        "type": "string",
                                        "maxLength": 12,
                                        "description": "Short header for the question card"
                                    },
                                    "multiSelect": {
                                        "type": "boolean",
                                        "default": false,
                                        "description": "Whether the user can select multiple options"
                                    },
                                    "options": {
                                        "type": "array",
                                        "minItems": 2,
                                        "maxItems": 4,
                                        "items": {
                                            "type": "object",
                                            "required": ["label"],
                                            "properties": {
                                                "label": {
                                                    "type": "string",
                                                    "description": "Option label"
                                                },
                                                "description": {
                                                    "type": "string",
                                                    "description": "Optional description"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ]
    })
}

fn handle_tools_call(
    params: Value,
    port: u16,
    token: &str,
    session_id: Option<&str>,
) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;

    if name != "ask_user_question" {
        return Err(AppError::ValidationError(format!(
            "未知工具: {}",
            name
        )));
    }

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let questions = arguments
        .get("questions")
        .ok_or_else(|| AppError::ValidationError("缺少 questions 参数".to_string()))?;

    // Connect to main process
    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
        .map_err(|e| AppError::NetworkError(format!("无法连接到主进程: {}", e)))?;

    // Send ask request
    let ask_msg = json!({
        "type": "ask",
        "token": token,
        "sessionId": session_id,
        "questions": questions,
    });
    write_frame(&mut stream, &ask_msg)?;

    // Block and wait for answer
    let answer: Value = read_frame(&mut stream)?;

    // Check if declined
    let declined = answer.get("declined").and_then(Value::as_bool).unwrap_or(false);
    if declined {
        return Ok(json!({
            "content": [{
                "type": "text",
                "text": "User declined to answer the question."
            }],
            "isError": false
        }));
    }

    // Build result with answers
    let answers = answer.get("answers").cloned().unwrap_or_else(|| json!([]));

    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("User answered: {}", serde_json::to_string(&answers).unwrap_or_default())
        }],
        "structuredContent": {
            "answers": answers
        },
        "isError": false
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
