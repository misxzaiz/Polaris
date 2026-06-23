//! Ask User Question MCP Server
//!
//! Stdio JSON-RPC 2.0 server exposing a single `ask_user_question` tool.
//! On tool_call, it opens a TCP connection to the main Polaris process,
//! sends an `ask` frame, blocks waiting for an `answer` frame, then returns
//! the answer as a normal MCP tool_result so the CLI continues the same turn.
//!
//! Wire protocol (matches `services::ask_listener`):
//!   - Length-prefixed frames: u32 LE length + UTF-8 JSON body
//!   - ask frame (client -> server):
//!       { "type":"ask", "token":"<uuid>", "sessionId":"...", "callId":"...",
//!         "questions": [...] }
//!   - answer frame (server -> client):
//!       { "type":"answer", "declined": bool,
//!         "answers":[{ "question":"...", "header":"...",
//!                      "selected":[...], "customInput": null }] }
//!   - cancel frame (client -> server) — when CLI sends notifications/cancelled

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-ask-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";
const TOOL_NAME: &str = "ask_user_question";

/// Server-level configuration, parsed from CLI args.
pub struct AskMcpConfig {
    pub port: u16,
    pub token: String,
    pub session_id: Option<String>,
}

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

/// Run the ask MCP server: stdio JSON-RPC loop.
pub fn run_ask_mcp_server(config: AskMcpConfig) -> Result<()> {
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
            // JSON-RPC 2.0 §4.1: a Notification (no `id`) MUST NOT receive a reply.
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request, &config),
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

fn handle_request(request: JsonRpcRequest, config: &AskMcpConfig) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(handle_initialize()),
        "notifications/initialized" => Ok(json!({})),
        "notifications/cancelled" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, config),
        other => Err(AppError::ValidationError(format!(
            "Unsupported method: {}",
            other
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

/// Tool schema — kept 100% aligned with Claude's native AskUserQuestion:
/// questions[1..=4], options[2..=4], header maxLength 12.
fn handle_tools_list() -> Value {
    json!({
        "tools": [{
            "name": TOOL_NAME,
            "description": concat!(
                "Ask the user a multiple-choice question to clarify requirements ",
                "or get a decision. Use this when you cannot resolve a choice from ",
                "the request, the code, or sensible defaults. Each question presents ",
                "options to the user; the user selects one (or several when ",
                "multiSelect=true) and/or provides custom text. The user can always ",
                "decline. Returned as a JSON array of answers in the same order."
            ),
            "inputSchema": {
                "type": "object",
                "required": ["questions"],
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 4,
                        "description": "Questions to ask the user (1-4 questions).",
                        "items": {
                            "type": "object",
                            "required": ["question", "header", "options"],
                            "properties": {
                                "question": {
                                    "type": "string",
                                    "description": "Full question text shown to the user."
                                },
                                "header": {
                                    "type": "string",
                                    "maxLength": 12,
                                    "description": "Short label (max 12 chars) shown as a tag."
                                },
                                "multiSelect": {
                                    "type": "boolean",
                                    "default": false,
                                    "description": "Allow selecting multiple options."
                                },
                                "options": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 4,
                                    "description": "Available choices (2-4 options).",
                                    "items": {
                                        "type": "object",
                                        "required": ["label"],
                                        "properties": {
                                            "label": { "type": "string" },
                                            "description": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    }
                                }
                            },
                            "additionalProperties": false
                        }
                    }
                },
                "additionalProperties": false
            }
        }]
    })
}

fn handle_tools_call(params: Value, config: &AskMcpConfig) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".into()))?;

    if name != TOOL_NAME {
        return Err(AppError::ValidationError(format!("未知工具: {}", name)));
    }

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let questions = arguments
        .get("questions")
        .cloned()
        .ok_or_else(|| AppError::ValidationError("缺少 questions 参数".into()))?;

    // Each tool_call has a server-generated call id we hand back to the main
    // process so it can route the answer. We use a fresh UUID per call.
    let call_id = uuid::Uuid::new_v4().to_string();

    let ask_frame = json!({
        "type": "ask",
        "token": config.token,
        "sessionId": config.session_id.clone().unwrap_or_default(),
        "callId": call_id,
        "questions": questions,
    });

    let answer = match request_answer_via_tcp(config.port, &ask_frame) {
        Ok(value) => value,
        Err(error) => {
            // Surface as a tool error (not a JSON-RPC error) so the CLI can
            // continue the turn with the failure reason.
            return Ok(json!({
                "isError": true,
                "content": [{
                    "type": "text",
                    "text": format!("Failed to deliver question to Polaris UI: {}", error.to_message())
                }]
            }));
        }
    };

    // The answer payload becomes the tool_result content. The CLI sees raw JSON
    // text it can parse; we keep the shape stable so the model gets a clear
    // answer object back.
    let body = serde_json::to_string(&answer).unwrap_or_else(|_| "{}".to_string());
    Ok(json!({
        "content": [{ "type": "text", "text": body }]
    }))
}

/// Connect to the main process, send the ask frame, block reading the answer.
fn request_answer_via_tcp(port: u16, ask_frame: &Value) -> Result<Value> {
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e| AppError::ProcessError(format!("无效地址 {}: {}", addr, e)))?,
        Duration::from_secs(5),
    )
    .map_err(|e| AppError::ProcessError(format!("无法连接 {}: {}", addr, e)))?;

    // No read timeout — we block as long as the user takes to answer.
    stream.set_read_timeout(None).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

    write_frame(&mut stream, ask_frame)?;

    let answer = read_frame(&mut stream)?;

    // Close gracefully so the listener side knows we're done.
    let _ = stream.shutdown(Shutdown::Both);
    Ok(answer)
}

/// Write a length-prefixed JSON frame: u32 LE length + UTF-8 bytes.
fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len())
        .map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    Ok(())
}

/// Read a length-prefixed JSON frame from the stream.
fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Err(AppError::ProcessError("帧长度为 0".into()));
    }
    // 1 MiB safety cap.
    if len > 1_048_576 {
        return Err(AppError::ProcessError(format!("帧长度过大: {}", len)));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    let value: Value = serde_json::from_slice(&body)?;
    Ok(value)
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
    fn tools_list_returns_ask_user_question() {
        let v = handle_tools_list();
        let tools = v.get("tools").and_then(|t| t.as_array()).unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].get("name").and_then(|s| s.as_str()), Some(TOOL_NAME));
        let schema = tools[0].get("inputSchema").unwrap();
        let q = schema
            .pointer("/properties/questions")
            .unwrap();
        assert_eq!(q.get("minItems").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(q.get("maxItems").and_then(|v| v.as_u64()), Some(4));
        let opts = q.pointer("/items/properties/options").unwrap();
        assert_eq!(opts.get("minItems").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(opts.get("maxItems").and_then(|v| v.as_u64()), Some(4));
        let header = q.pointer("/items/properties/header").unwrap();
        assert_eq!(header.get("maxLength").and_then(|v| v.as_u64()), Some(12));
    }

    #[test]
    fn initialize_carries_protocol_version() {
        let v = handle_initialize();
        assert_eq!(
            v.get("protocolVersion").and_then(|s| s.as_str()),
            Some(PROTOCOL_VERSION)
        );
        assert_eq!(
            v.pointer("/serverInfo/name").and_then(|s| s.as_str()),
            Some(SERVER_NAME)
        );
    }

    #[test]
    fn unknown_tool_yields_validation_error() {
        let params = json!({ "name": "not_a_tool", "arguments": {} });
        let cfg = AskMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
        };
        let err = handle_tools_call(params, &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
    }

    #[test]
    fn missing_questions_yields_validation_error() {
        let params = json!({ "name": TOOL_NAME, "arguments": {} });
        let cfg = AskMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
        };
        let err = handle_tools_call(params, &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
    }
}
