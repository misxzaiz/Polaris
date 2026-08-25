//! Browser MCP Server
//!
//! Stdio JSON-RPC 2.0 server exposing Polaris built-in browser tools to
//! Claude/Codex-style MCP clients. Tool calls connect back to the main Polaris
//! process through the token-protected local listener started by `ask_listener`.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-browser-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

pub struct BrowserMcpConfig {
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

pub fn run_browser_mcp_server(config: BrowserMcpConfig) -> Result<()> {
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
            Ok(request) => handle_request(request, &config),
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

fn handle_request(request: JsonRpcRequest, config: &BrowserMcpConfig) -> JsonRpcResponse<'static> {
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
        "notifications/cancelled" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, config),
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
    let label_property = json!({
        "type": "string",
        "description": "Optional Polaris browser WebView label. Omit to use this agent's acquired tab when available, otherwise the most recently active built-in browser tab."
    });
    let index_property = json!({
        "type": "integer",
        "minimum": 0,
        "description": "Element index returned by browser_inspect or browser_diagnostics."
    });
    let text_property = json!({
        "type": "string",
        "description": "Visible text, placeholder, aria-label, title, or href used to fuzzy-match an element when index is unknown."
    });

    json!({ "tools": [
        {
            "name": "browser_list",
            "description": "List currently open Polaris built-in browser tabs. Use this first when no browser label is known.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "browser_acquire",
            "description": "Acquire a Polaris built-in browser tab for this agent. By default, this creates a dedicated tab when the agent has no bound tab; pass label or mode='reuse' to bind an existing tab.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property,
                "url": { "type": "string", "description": "Optional URL or search query to open in the acquired tab." },
                "title": { "type": "string", "description": "Optional tab title while the page is loading." },
                "mode": {
                    "type": "string",
                    "enum": ["auto", "create", "reuse"],
                    "default": "auto",
                    "description": "auto reuses this agent's bound tab or creates a new one; create always opens a new tab; reuse binds the most recent existing tab when possible."
                },
                "agentKey": { "type": "string", "description": "Optional stable owner key. Defaults to the Polaris session id injected into this MCP server." },
                "activate": { "type": "boolean", "default": true, "description": "Whether to switch the workbench to the acquired browser tab." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_navigate",
            "description": "Navigate a Polaris built-in browser tab to a URL or search query. Supports localhost:3000, example.com, and full http/https/file URLs.",
            "inputSchema": { "type": "object", "required": ["url"], "properties": {
                "label": label_property,
                "url": { "type": "string", "description": "Destination URL or search text." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_context",
            "description": "Read the current page title, URL, selected text, main text, headings, and links from the built-in browser.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_diagnostics",
            "description": "Return a production debugging snapshot: page context, actionable elements, visible element rectangles, captured console messages, and optionally a browser-region screenshot.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property,
                "includeScreenshot": {
                    "type": "boolean",
                    "default": false,
                    "description": "Set true only when visual layout inspection is needed. Text/DOM diagnostics are usually cheaper and more reliable."
                }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_inspect",
            "description": "List clickable/fillable elements with stable indexes. Prefer this before browser_click or browser_fill.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_click",
            "description": "Click an element in the built-in browser by inspect index or visible text. Use browser_inspect first for reliability.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property,
                "index": index_property,
                "text": text_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_fill",
            "description": "Fill an input/textarea/select/contenteditable element by inspect index or visible text. Use fillable=true elements from browser_inspect.",
            "inputSchema": { "type": "object", "required": ["value"], "properties": {
                "label": label_property,
                "index": index_property,
                "text": text_property,
                "value": { "type": "string", "description": "Text/value to enter." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_reload",
            "description": "Reload the current built-in browser page.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_back",
            "description": "Navigate the built-in browser one step back in history.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_forward",
            "description": "Navigate the built-in browser one step forward in history.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_history_state",
            "description": "Check whether the browser tab can go back or forward in history.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_wait",
            "description": "Wait for a condition: url_change, text_appear, element_appear, network_idle, navigation, or timeout. Polls every 200ms until the condition is met or the timeout expires.",
            "inputSchema": { "type": "object", "required": ["condition"], "properties": {
                "label": label_property,
                "condition": {
                    "type": "string",
                    "enum": ["url_change", "text_appear", "element_appear", "network_idle", "navigation", "timeout"],
                    "description": "The condition to wait for."
                },
                "text": { "type": "string", "description": "Text to wait for (text_appear/element_appear)." },
                "index": index_property,
                "ms": { "type": "integer", "description": "Fixed delay in ms (timeout condition)." },
                "timeoutMs": { "type": "integer", "description": "Maximum wait time in ms (default 15s, 30s for network_idle/navigation)." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_scroll",
            "description": "Scroll the page: to_element, by, to, top, bottom, up, down, left, or right.",
            "inputSchema": { "type": "object", "required": ["mode"], "properties": {
                "label": label_property,
                "mode": {
                    "type": "string",
                    "enum": ["to_element", "by", "to", "top", "bottom", "up", "down", "left", "right"],
                    "description": "Scroll mode."
                },
                "index": index_property,
                "text": text_property,
                "x": { "type": "number", "description": "Horizontal scroll target or offset." },
                "y": { "type": "number", "description": "Vertical scroll target or offset." },
                "amount": { "type": "number", "description": "Scroll amount (up/down/left/right). Defaults to viewport size." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_press_key",
            "description": "Send a keyboard shortcut to the built-in browser. Supports modifiers (Ctrl, Shift, Alt, Meta) and key names (Enter, Escape, Tab, ArrowUp, F1-F12, etc.).",
            "inputSchema": { "type": "object", "required": ["keys"], "properties": {
                "label": label_property,
                "keys": { "type": "string", "description": "Key combination, e.g. 'Ctrl+S', 'Escape', 'Ctrl+Shift+I'." },
                "index": index_property,
                "text": text_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_type_text",
            "description": "Type text character by character into the focused element. Slower than browser_fill but triggers real keyboard events.",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "label": label_property,
                "text": { "type": "string", "description": "Text to type." },
                "index": index_property,
                "elementText": text_property,
                "delayMs": { "type": "integer", "minimum": 0, "maximum": 200, "description": "Delay between characters in ms (default 10)." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_marquee",
            "description": "Enable or disable circular selection (marquee) overlay on the built-in browser. When enabled, the user can drag to select regions. Use browser_select_region to inspect the selected area.",
            "inputSchema": { "type": "object", "required": ["enabled"], "properties": {
                "label": label_property,
                "enabled": { "type": "boolean", "description": "Set true to enable the marquee overlay, false to disable." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_select_region",
            "description": "Inspect elements inside a selected rectangular region. Returns interactive elements, HTML snippet, and text snippet within the bounds.",
            "inputSchema": { "type": "object", "required": ["region"], "properties": {
                "label": label_property,
                "region": {
                    "type": "object",
                    "required": ["x", "y", "width", "height"],
                    "properties": {
                        "x": { "type": "number", "description": "Left edge of the region (viewport coordinates)." },
                        "y": { "type": "number", "description": "Top edge of the region." },
                        "width": { "type": "number", "minimum": 20, "description": "Width of the region." },
                        "height": { "type": "number", "minimum": 20, "description": "Height of the region." }
                    }
                }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_history_state",
            "description": "Check whether the browser tab can go back or forward in history.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        },
        {
            "name": "browser_find",
            "description": "Find text in the current page. Returns match count and navigates to the first match.",
            "inputSchema": { "type": "object", "required": ["query"], "properties": {
                "label": label_property,
                "query": { "type": "string", "description": "Text to search for on the page." },
                "caseSensitive": { "type": "boolean", "default": false, "description": "Whether the search is case-sensitive." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_zoom",
            "description": "Set the page zoom level (0.25 to 5.0). Uses CSS transform scaling.",
            "inputSchema": { "type": "object", "required": ["scale"], "properties": {
                "label": label_property,
                "scale": { "type": "number", "minimum": 0.25, "maximum": 5.0, "description": "Zoom level (1.0 = 100%)." }
            }, "additionalProperties": false }
        },
        {
            "name": "browser_network_info",
            "description": "Get page load performance data: load time, resource count, transfer size.",
            "inputSchema": { "type": "object", "properties": {
                "label": label_property
            }, "additionalProperties": false }
        }
    ] })
}

fn handle_tools_call(params: Value, config: &BrowserMcpConfig) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let action = tool_name_to_action(name)?;
    let frame = browser_frame(config, action, &args);

    let response = match request_browser_via_tcp(config.port, &frame) {
        Ok(value) => value,
        Err(error) => {
            return Ok(tool_error(format!(
                "Failed to reach Polaris built-in browser bridge: {}",
                error.to_message()
            )));
        }
    };

    if !response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(tool_error(
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Polaris browser bridge returned an error")
                .to_string(),
        ));
    }

    let result = response.get("result").cloned().unwrap_or(Value::Null);
    Ok(tool_success(result))
}

fn tool_name_to_action(name: &str) -> Result<&'static str> {
    match name {
        "browser_list" => Ok("list"),
        "browser_acquire" => Ok("acquire"),
        "browser_navigate" => Ok("navigate"),
        "browser_context" => Ok("context"),
        "browser_diagnostics" => Ok("diagnostics"),
        "browser_inspect" => Ok("inspect"),
        "browser_click" => Ok("click"),
        "browser_fill" => Ok("fill"),
        "browser_reload" => Ok("reload"),
        "browser_back" => Ok("back"),
        "browser_forward" => Ok("forward"),
        "browser_wait" => Ok("wait"),
        "browser_scroll" => Ok("scroll"),
        "browser_press_key" => Ok("press_key"),
        "browser_type_text" => Ok("type_text"),
        "browser_history_state" => Ok("history_state"),
        "browser_marquee" => Ok("marquee"),
        "browser_select_region" => Ok("select_region"),
        "browser_find" => Ok("find"),
        "browser_zoom" => Ok("zoom"),
        "browser_network_info" => Ok("network_info"),
        other => Err(AppError::ValidationError(format!(
            "未知浏览器工具: {other}"
        ))),
    }
}

fn browser_frame(config: &BrowserMcpConfig, action: &str, args: &Value) -> Value {
    let mut frame = Map::new();
    frame.insert("type".to_string(), Value::String("browser".to_string()));
    frame.insert("token".to_string(), Value::String(config.token.clone()));
    frame.insert(
        "sessionId".to_string(),
        Value::String(config.session_id.clone().unwrap_or_default()),
    );
    frame.insert(
        "callId".to_string(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    frame.insert("action".to_string(), Value::String(action.to_string()));

    for key in [
        "label",
        "url",
        "index",
        "text",
        "value",
        "includeScreenshot",
        "title",
        "mode",
        "agentKey",
        "activate",
        "condition",
        "ms",
        "timeoutMs",
        "x",
        "y",
        "amount",
        "keys",
        "elementText",
        "delayMs",
        "enabled",
        "region",
        "query",
        "caseSensitive",
        "scale",
    ] {
        if let Some(value) = args.get(key) {
            frame.insert(key.to_string(), value.clone());
        }
    }

    Value::Object(frame)
}

/// Ensure a value is a JSON object. If it is an array (e.g. `browser_list`
/// returns `[]`), wrap it as `{ "items": [...] }` so that `structuredContent`
/// always satisfies the MCP protocol requirement of being an object.
fn ensure_object(value: Value) -> Value {
    if let Value::Array(arr) = value {
        Value::Object({
            let mut map = Map::new();
            map.insert("items".to_string(), Value::Array(arr));
            map
        })
    } else {
        value
    }
}

fn tool_success(result: Value) -> Value {
    let sanitized = sanitize_screenshot_payload(result.clone());
    let structured_content = ensure_object(sanitized);
    let mut content = vec![json!({
        "type": "text",
        "text": serde_json::to_string_pretty(&structured_content)
            .unwrap_or_else(|_| "{}".to_string()),
    })];

    if let Some((mime_type, data)) = extract_screenshot(&result) {
        content.push(json!({
            "type": "image",
            "data": data,
            "mimeType": mime_type,
        }));
    }

    json!({
        "structuredContent": structured_content,
        "content": content
    })
}

fn tool_error(message: String) -> Value {
    json!({
        "isError": true,
        "content": [{ "type": "text", "text": message }]
    })
}

fn sanitize_screenshot_payload(mut value: Value) -> Value {
    if let Some(screenshot) = value
        .pointer_mut("/visual/screenshot")
        .and_then(Value::as_object_mut)
    {
        if screenshot.contains_key("data") {
            screenshot.insert(
                "data".to_string(),
                Value::String("<returned as MCP image content>".to_string()),
            );
        }
    }
    value
}

fn extract_screenshot(value: &Value) -> Option<(String, String)> {
    let screenshot = value.pointer("/visual/screenshot")?;
    let data = screenshot.get("data")?.as_str()?.to_string();
    if data.trim().is_empty() {
        return None;
    }
    let mime_type = screenshot
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png")
        .to_string();
    Some((mime_type, data))
}

fn request_browser_via_tcp(port: u16, frame: &Value) -> Result<Value> {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e| AppError::ProcessError(format!("无效地址 {addr}: {e}")))?,
        Duration::from_secs(5),
    )
    .map_err(|e| AppError::ProcessError(format!("无法连接 {addr}: {e}")))?;

    stream.set_read_timeout(Some(Duration::from_secs(45))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

    write_frame(&mut stream, frame)?;
    let response = read_frame(&mut stream)?;
    let _ = stream.shutdown(Shutdown::Both);
    Ok(response)
}

fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len()).map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    Ok(())
}

fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_SIZE {
        return Err(AppError::ProcessError(format!("非法帧长度: {len}")));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
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
    fn exposes_browser_tools() {
        let tools = handle_tools_list();
        let names: Vec<_> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert!(names.contains(&"browser_list"));
        assert!(names.contains(&"browser_acquire"));
        assert!(names.contains(&"browser_diagnostics"));
        assert!(names.contains(&"browser_click"));
        assert!(names.contains(&"browser_fill"));
        assert!(names.contains(&"browser_wait"));
        assert!(names.contains(&"browser_scroll"));
        assert!(names.contains(&"browser_press_key"));
        assert!(names.contains(&"browser_type_text"));
        assert!(names.contains(&"browser_history_state"));
        assert!(names.contains(&"browser_marquee"));
        assert!(names.contains(&"browser_select_region"));
        assert_eq!(names.len(), 21);
    }

    #[test]
    fn sanitize_screenshot_keeps_image_out_of_text_payload() {
        let value = json!({
            "visual": {
                "screenshot": {
                    "mimeType": "image/png",
                    "data": "abc",
                    "width": 1,
                    "height": 1,
                    "scale": 1.0
                }
            }
        });
        let sanitized = sanitize_screenshot_payload(value);
        assert_eq!(
            sanitized
                .pointer("/visual/screenshot/data")
                .and_then(Value::as_str),
            Some("<returned as MCP image content>")
        );
    }

    #[test]
    fn ensure_object_wraps_array_into_items() {
        let result = ensure_object(json!([1, 2, 3]));
        assert_eq!(result.pointer("/items").and_then(Value::as_array).unwrap().len(), 3);
        assert!(result.is_object());
    }

    #[test]
    fn ensure_object_passes_through_object() {
        let result = ensure_object(json!({"a": 1, "b": 2}));
        assert_eq!(result.get("a").unwrap(), 1);
        assert!(result.is_object());
    }

    #[test]
    fn tool_success_wraps_array_result_as_object() {
        let result = tool_success(json!([1, 2, 3]));
        assert!(result.is_object());
        let sc = result.get("structuredContent").unwrap();
        assert!(sc.is_object());
        assert_eq!(sc.pointer("/items").and_then(Value::as_array).unwrap().len(), 3);
    }

    #[test]
    fn tool_success_passes_through_object_result() {
        let result = tool_success(json!({"label": "test", "url": "https://example.com"}));
        let sc = result.get("structuredContent").unwrap();
        assert_eq!(sc.get("label").and_then(Value::as_str).unwrap(), "test");
    }
}
