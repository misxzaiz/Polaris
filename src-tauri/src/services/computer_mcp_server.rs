//! Computer MCP Server —— 电脑操作（截图 / 鼠标键盘 / Windows 控件树）。
//!
//! JSON-RPC over stdio，框架与 `scheduler_mcp_server` / `todo_mcp_server` 完全一致；
//! 状态持有一个可变 [`ComputerController`]（输入模拟有状态）。

use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::computer_control::{ComputerConfig, ComputerController};

const SERVER_NAME: &str = "polaris-computer-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

/// 单次工具输出的最大等待时长（wait 工具），避免模型挂起会话。
const MAX_WAIT_MS: u64 = 10_000;
/// inspect_ui 递归深度上限。
const MAX_INSPECT_DEPTH: u64 = 8;

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

/// 运行 computer MCP server。
///
/// `_config_dir` / `_workspace_path` 仅为与其它内置 MCP server 的命令行约定对齐而保留，
/// 电脑操作本身与工作区无关。配置从环境变量读取（见 [`ComputerConfig::from_env`]）。
pub fn run_computer_mcp_server(_config_dir: &str, _workspace_path: Option<&str>) -> Result<()> {
    let mut controller = ComputerController::new(ComputerConfig::from_env())?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = io::BufReader::new(stdin.lock());
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
            // JSON-RPC 2.0 §4.1：无 `id` 的请求是通知，不得回复（与其它 server 一致）。
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request, &mut controller),
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

fn handle_request(
    request: JsonRpcRequest,
    controller: &mut ComputerController,
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
        "tools/call" => handle_tools_call(request.params, controller),
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
            "name": "screenshot",
            "description": "截取屏幕，返回 PNG 图像（base64）。用它来观察当前界面。可选 monitor 指定显示器序号（默认主屏 0）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "monitor": { "type": "integer", "minimum": 0, "description": "显示器序号，默认 0" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "cursor_position",
            "description": "获取当前鼠标光标的绝对坐标（屏幕左上角为原点）。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "move_mouse",
            "description": "把鼠标移动到绝对坐标 (x, y)。",
            "inputSchema": {
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x": { "type": "integer" },
                    "y": { "type": "integer" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "click",
            "description": "鼠标点击。给定 x/y 则先移动再点击；省略则在当前位置点击。button 取 left/right/middle，double=true 为双击。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "integer" },
                    "y": { "type": "integer" },
                    "button": { "type": "string", "enum": ["left", "right", "middle"] },
                    "double": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "type_text",
            "description": "在当前焦点处输入一段文本（逐字符键入）。",
            "inputSchema": {
                "type": "object",
                "required": ["text"],
                "properties": { "text": { "type": "string" } },
                "additionalProperties": false
            }
        },
        {
            "name": "press_key",
            "description": "按下组合键，如 'ctrl+c'、'alt+f4'、'enter'、'ctrl+shift+t'。最后一段为主键，前面为修饰键。",
            "inputSchema": {
                "type": "object",
                "required": ["keys"],
                "properties": { "keys": { "type": "string" } },
                "additionalProperties": false
            }
        },
        {
            "name": "scroll",
            "description": "滚动滚轮。dx 水平、dy 垂直，正负代表方向。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dx": { "type": "integer" },
                    "dy": { "type": "integer" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "wait",
            "description": "等待若干毫秒（用于等待界面响应），上限 10000ms。",
            "inputSchema": {
                "type": "object",
                "properties": { "ms": { "type": "integer", "minimum": 0 } },
                "additionalProperties": false
            }
        },
        {
            "name": "inspect_ui",
            "description": "（仅 Windows）返回前台桌面的无障碍控件树，含每个控件的 name/controlType/enabled/rect。比截图更精确、更省 token，优先用它定位可点击元素。max_depth 控制深度（默认 3）。",
            "inputSchema": {
                "type": "object",
                "properties": { "max_depth": { "type": "integer", "minimum": 1, "maximum": 8 } },
                "additionalProperties": false
            }
        }
    ] })
}

fn handle_tools_call(params: Value, controller: &mut ComputerController) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "screenshot" => exec_screenshot(&arguments, controller),
        "cursor_position" => exec_cursor_position(controller),
        "move_mouse" => exec_move_mouse(&arguments, controller),
        "click" => exec_click(&arguments, controller),
        "type_text" => exec_type_text(&arguments, controller),
        "press_key" => exec_press_key(&arguments, controller),
        "scroll" => exec_scroll(&arguments, controller),
        "wait" => exec_wait(&arguments),
        "inspect_ui" => exec_inspect_ui(&arguments, controller),
        other => Err(AppError::ValidationError(format!("未知工具: {other}"))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn exec_screenshot(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let monitor = arguments
        .get("monitor")
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    let shot = controller.screenshot(monitor)?;
    Ok(json!({
        "structuredContent": { "width": shot.width, "height": shot.height },
        "content": [
            { "type": "image", "data": shot.png_base64, "mimeType": "image/png" },
            { "type": "text", "text": format!("已截取屏幕 {}x{}", shot.width, shot.height) }
        ]
    }))
}

fn exec_cursor_position(controller: &mut ComputerController) -> Result<Value> {
    let (x, y) = controller.cursor_position()?;
    Ok(text_result(json!({ "x": x, "y": y }), format!("光标位置: ({x}, {y})")))
}

fn exec_move_mouse(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let x = require_i32(arguments, "x")?;
    let y = require_i32(arguments, "y")?;
    controller.move_mouse(x, y)?;
    Ok(text_result(json!({ "x": x, "y": y }), format!("已移动鼠标到 ({x}, {y})")))
}

fn exec_click(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let x = optional_i32(arguments, "x");
    let y = optional_i32(arguments, "y");
    let button = arguments
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left");
    let double = arguments
        .get("double")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    controller.click(x, y, button, double)?;
    let kind = if double { "双击" } else { "单击" };
    Ok(text_result(
        json!({ "clicked": true, "button": button, "double": double }),
        format!("已{kind} {button} 键"),
    ))
}

fn exec_type_text(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let text = require_str(arguments, "text")?;
    controller.type_text(text)?;
    let count = text.chars().count();
    Ok(text_result(json!({ "typed": count }), format!("已输入 {count} 个字符")))
}

fn exec_press_key(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let keys = require_str(arguments, "keys")?;
    controller.press_key(keys)?;
    Ok(text_result(json!({ "keys": keys }), format!("已按下 {keys}")))
}

fn exec_scroll(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let dx = optional_i32(arguments, "dx").unwrap_or(0);
    let dy = optional_i32(arguments, "dy").unwrap_or(0);
    controller.scroll(dx, dy)?;
    Ok(text_result(json!({ "dx": dx, "dy": dy }), format!("已滚动 ({dx}, {dy})")))
}

fn exec_wait(arguments: &Value) -> Result<Value> {
    let ms = arguments
        .get("ms")
        .and_then(Value::as_u64)
        .unwrap_or(500)
        .min(MAX_WAIT_MS);
    thread::sleep(Duration::from_millis(ms));
    Ok(text_result(json!({ "ms": ms }), format!("已等待 {ms} ms")))
}

fn exec_inspect_ui(arguments: &Value, controller: &mut ComputerController) -> Result<Value> {
    let max_depth = arguments
        .get("max_depth")
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .clamp(1, MAX_INSPECT_DEPTH) as usize;
    let tree = controller.inspect_ui(max_depth)?;
    Ok(json!({
        "structuredContent": tree,
        "content": [ { "type": "text", "text": "已返回前台控件树" } ]
    }))
}

// ============================================================================
// Helpers
// ============================================================================

fn text_result(structured: Value, message: String) -> Value {
    json!({
        "structuredContent": structured,
        "content": [ { "type": "text", "text": message } ]
    })
}

fn require_i32(arguments: &Value, key: &str) -> Result<i32> {
    arguments
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| AppError::ValidationError(format!("缺少整数参数: {key}")))
}

fn optional_i32(arguments: &Value, key: &str) -> Option<i32> {
    arguments.get(key).and_then(Value::as_i64).map(|v| v as i32)
}

fn require_str<'a>(arguments: &'a Value, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
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

/// 工具名 → 描述，供诊断/测试枚举。
pub fn current_tool_definitions() -> std::collections::BTreeMap<&'static str, &'static str> {
    std::collections::BTreeMap::from([
        ("screenshot", "截屏为 PNG。"),
        ("cursor_position", "获取光标坐标。"),
        ("move_mouse", "移动鼠标到坐标。"),
        ("click", "鼠标点击。"),
        ("type_text", "输入文本。"),
        ("press_key", "按下组合键。"),
        ("scroll", "滚动。"),
        ("wait", "等待毫秒。"),
        ("inspect_ui", "Windows 控件树。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tool_count() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 9);
        let listed = handle_tools_list();
        let tools = listed["tools"].as_array().unwrap();
        assert_eq!(tools.len(), defs.len());
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize();
        assert_eq!(value["protocolVersion"], Value::String(PROTOCOL_VERSION.to_string()));
        assert_eq!(value["serverInfo"]["name"], Value::String(SERVER_NAME.to_string()));
    }

    #[test]
    fn notification_is_detected_when_id_field_is_absent() {
        let payload = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let request: JsonRpcRequest = serde_json::from_str(payload).unwrap();
        assert!(request.id.is_none());
    }

    #[test]
    fn require_i32_reports_missing() {
        let args = json!({ "x": 10 });
        assert_eq!(require_i32(&args, "x").unwrap(), 10);
        assert!(require_i32(&args, "y").is_err());
    }
}
