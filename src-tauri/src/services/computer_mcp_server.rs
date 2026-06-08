//! Computer MCP Server —— 电脑操作（截图 / 鼠标键盘 / Windows 控件树 / 剪贴板）。
//!
//! JSON-RPC over stdio，框架与 `scheduler_mcp_server` / `todo_mcp_server` 一致；
//! 状态持有一个可变 [`ComputerController`]。

use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::computer_control::{ComputerConfig, ComputerController};

const SERVER_NAME: &str = "polaris-computer-mcp";
const SERVER_VERSION: &str = "0.2.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

const MAX_WAIT_MS: u64 = 10_000;
const MAX_HOLD_MS: u64 = 10_000;
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
            "description": "截取屏幕，返回 PNG 图像（base64）。monitor 指定显示器序号（默认主屏 0）；region={x,y,width,height} 只截局部；scale(0~1)降采样缩小体积（如 0.5 半尺寸）。截全屏前建议用 region 或 scale 控制图像 token。",
            "inputSchema": { "type": "object", "properties": {
                "monitor": { "type": "integer", "minimum": 0 },
                "region": { "type": "object", "properties": {
                    "x": { "type": "integer", "minimum": 0 }, "y": { "type": "integer", "minimum": 0 },
                    "width": { "type": "integer", "minimum": 1 }, "height": { "type": "integer", "minimum": 1 }
                }, "required": ["x", "y", "width", "height"], "additionalProperties": false },
                "scale": { "type": "number", "minimum": 0.05, "maximum": 1 }
            }, "additionalProperties": false }
        },
        {
            "name": "cursor_position",
            "description": "获取当前鼠标光标的绝对坐标（屏幕左上角为原点）。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "move_mouse",
            "description": "把鼠标移动到绝对坐标 (x, y)。",
            "inputSchema": { "type": "object", "required": ["x", "y"], "properties": {
                "x": { "type": "integer" }, "y": { "type": "integer" }
            }, "additionalProperties": false }
        },
        {
            "name": "click",
            "description": "鼠标点击。给定 x/y 则先移动再点击；省略则在当前位置点击。button=left/right/middle；count=连击次数（1 单击、2 双击、3 三击）。",
            "inputSchema": { "type": "object", "properties": {
                "x": { "type": "integer" }, "y": { "type": "integer" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] },
                "count": { "type": "integer", "minimum": 1, "maximum": 3 }
            }, "additionalProperties": false }
        },
        {
            "name": "drag",
            "description": "按住鼠标从 (from_x,from_y) 拖拽到 (to_x,to_y)。button 默认 left。",
            "inputSchema": { "type": "object", "required": ["from_x", "from_y", "to_x", "to_y"], "properties": {
                "from_x": { "type": "integer" }, "from_y": { "type": "integer" },
                "to_x": { "type": "integer" }, "to_y": { "type": "integer" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] }
            }, "additionalProperties": false }
        },
        {
            "name": "mouse_down",
            "description": "按下鼠标键不释放（配合 mouse_up 实现自定义拖拽/长按）。可选 x/y 先移动。button 默认 left。",
            "inputSchema": { "type": "object", "properties": {
                "x": { "type": "integer" }, "y": { "type": "integer" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] }
            }, "additionalProperties": false }
        },
        {
            "name": "mouse_up",
            "description": "释放鼠标键。可选 x/y 先移动。button 默认 left。",
            "inputSchema": { "type": "object", "properties": {
                "x": { "type": "integer" }, "y": { "type": "integer" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] }
            }, "additionalProperties": false }
        },
        {
            "name": "type_text",
            "description": "在当前焦点处输入一段文本（逐字符键入）。大段文本建议用 clipboard 设置后 press_key ctrl+v 粘贴。",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "text": { "type": "string" }
            }, "additionalProperties": false }
        },
        {
            "name": "press_key",
            "description": "按下组合键并释放，如 'ctrl+c'、'alt+f4'、'enter'、'ctrl+shift+t'。最后一段为主键。",
            "inputSchema": { "type": "object", "required": ["keys"], "properties": {
                "keys": { "type": "string" }
            }, "additionalProperties": false }
        },
        {
            "name": "hold_key",
            "description": "按住组合键 ms 毫秒后释放（如游戏按住方向键）。上限 10000ms。",
            "inputSchema": { "type": "object", "required": ["keys"], "properties": {
                "keys": { "type": "string" }, "ms": { "type": "integer", "minimum": 0 }
            }, "additionalProperties": false }
        },
        {
            "name": "scroll",
            "description": "滚动滚轮。dx 水平、dy 垂直，正负代表方向。",
            "inputSchema": { "type": "object", "properties": {
                "dx": { "type": "integer" }, "dy": { "type": "integer" }
            }, "additionalProperties": false }
        },
        {
            "name": "wait",
            "description": "等待若干毫秒（等界面响应），上限 10000ms。",
            "inputSchema": { "type": "object", "properties": {
                "ms": { "type": "integer", "minimum": 0 }
            }, "additionalProperties": false }
        },
        {
            "name": "inspect_ui",
            "description": "返回前台桌面的无障碍控件树，每个控件含 name/controlType/automationId/enabled/rect/center。比截图更精确省 token，优先用它定位元素，再用 click（配合 center 坐标）或 click_element 操作。max_depth 默认 3；interactable_only=true 剔除无名噪声节点。",
            "inputSchema": { "type": "object", "properties": {
                "max_depth": { "type": "integer", "minimum": 1, "maximum": 8 },
                "interactable_only": { "type": "boolean" }
            }, "additionalProperties": false }
        },
        {
            "name": "click_element",
            "description": "按控件名(name，模糊匹配)或 automationId 查找并直接点击，不依赖坐标（不受窗口移动/遮挡影响），比 click 更可靠。button=left/right；count>=2 为双击。name 与 automation_id 至少给一个。",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" }, "automation_id": { "type": "string" },
                "button": { "type": "string", "enum": ["left", "right"] },
                "count": { "type": "integer", "minimum": 1, "maximum": 2 }
            }, "additionalProperties": false }
        },
        {
            "name": "set_text",
            "description": "按控件名或 automationId 查找输入框并填入文本（聚焦后剪贴板粘贴，比逐字符可靠）。name 与 automation_id 至少给一个。",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "name": { "type": "string" }, "automation_id": { "type": "string" },
                "text": { "type": "string" }
            }, "additionalProperties": false }
        },
        {
            "name": "clipboard",
            "description": "读写系统剪贴板。action=get 读取当前内容；action=set 写入 text（再 press_key ctrl+v 可粘贴）。",
            "inputSchema": { "type": "object", "required": ["action"], "properties": {
                "action": { "type": "string", "enum": ["get", "set"] },
                "text": { "type": "string" }
            }, "additionalProperties": false }
        }
    ] })
}

fn handle_tools_call(params: Value, controller: &mut ComputerController) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "screenshot" => exec_screenshot(&args, controller),
        "cursor_position" => exec_cursor_position(controller),
        "move_mouse" => exec_move_mouse(&args, controller),
        "click" => exec_click(&args, controller),
        "drag" => exec_drag(&args, controller),
        "mouse_down" => exec_mouse_down(&args, controller),
        "mouse_up" => exec_mouse_up(&args, controller),
        "type_text" => exec_type_text(&args, controller),
        "press_key" => exec_press_key(&args, controller),
        "hold_key" => exec_hold_key(&args, controller),
        "scroll" => exec_scroll(&args, controller),
        "wait" => exec_wait(&args),
        "inspect_ui" => exec_inspect_ui(&args, controller),
        "click_element" => exec_click_element(&args, controller),
        "set_text" => exec_set_text(&args, controller),
        "clipboard" => exec_clipboard(&args, controller),
        other => Err(AppError::ValidationError(format!("未知工具: {other}"))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn exec_screenshot(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let monitor = args.get("monitor").and_then(Value::as_u64).map(|v| v as usize);
    let region = args.get("region").and_then(|r| {
        Some((
            r.get("x")?.as_u64()? as u32,
            r.get("y")?.as_u64()? as u32,
            r.get("width")?.as_u64()? as u32,
            r.get("height")?.as_u64()? as u32,
        ))
    });
    let scale = args.get("scale").and_then(Value::as_f64).map(|v| v as f32);
    let shot = c.screenshot(monitor, region, scale)?;
    Ok(json!({
        "structuredContent": { "width": shot.width, "height": shot.height },
        "content": [
            { "type": "image", "data": shot.png_base64, "mimeType": "image/png" },
            { "type": "text", "text": format!("已截取屏幕 {}x{}", shot.width, shot.height) }
        ]
    }))
}

fn exec_cursor_position(c: &mut ComputerController) -> Result<Value> {
    let (x, y) = c.cursor_position()?;
    Ok(text_result(json!({ "x": x, "y": y }), format!("光标位置: ({x}, {y})")))
}

fn exec_move_mouse(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let x = require_i32(args, "x")?;
    let y = require_i32(args, "y")?;
    c.move_mouse(x, y)?;
    Ok(text_result(json!({ "x": x, "y": y }), format!("已移动鼠标到 ({x}, {y})")))
}

fn exec_click(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let x = optional_i32(args, "x");
    let y = optional_i32(args, "y");
    let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
    let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3) as u32;
    c.click(x, y, button, count)?;
    Ok(text_result(
        json!({ "button": button, "count": count }),
        format!("已点击 {button} 键 x{count}"),
    ))
}

fn exec_drag(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let from_x = require_i32(args, "from_x")?;
    let from_y = require_i32(args, "from_y")?;
    let to_x = require_i32(args, "to_x")?;
    let to_y = require_i32(args, "to_y")?;
    let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
    c.drag(from_x, from_y, to_x, to_y, button)?;
    Ok(text_result(
        json!({ "from": [from_x, from_y], "to": [to_x, to_y] }),
        format!("已拖拽 ({from_x},{from_y}) → ({to_x},{to_y})"),
    ))
}

fn exec_mouse_down(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
    c.mouse_down(optional_i32(args, "x"), optional_i32(args, "y"), button)?;
    Ok(text_result(json!({ "button": button }), format!("已按下 {button} 键")))
}

fn exec_mouse_up(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
    c.mouse_up(optional_i32(args, "x"), optional_i32(args, "y"), button)?;
    Ok(text_result(json!({ "button": button }), format!("已释放 {button} 键")))
}

fn exec_type_text(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let text = require_str(args, "text")?;
    c.type_text(text)?;
    let count = text.chars().count();
    Ok(text_result(json!({ "typed": count }), format!("已输入 {count} 个字符")))
}

fn exec_press_key(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let keys = require_str(args, "keys")?;
    c.press_key(keys)?;
    Ok(text_result(json!({ "keys": keys }), format!("已按下 {keys}")))
}

fn exec_hold_key(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let keys = require_str(args, "keys")?;
    let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(500).min(MAX_HOLD_MS);
    c.hold_key(keys, ms)?;
    Ok(text_result(json!({ "keys": keys, "ms": ms }), format!("已按住 {keys} {ms}ms")))
}

fn exec_scroll(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let dx = optional_i32(args, "dx").unwrap_or(0);
    let dy = optional_i32(args, "dy").unwrap_or(0);
    c.scroll(dx, dy)?;
    Ok(text_result(json!({ "dx": dx, "dy": dy }), format!("已滚动 ({dx}, {dy})")))
}

fn exec_wait(args: &Value) -> Result<Value> {
    let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(500).min(MAX_WAIT_MS);
    thread::sleep(Duration::from_millis(ms));
    Ok(text_result(json!({ "ms": ms }), format!("已等待 {ms} ms")))
}

fn exec_inspect_ui(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let max_depth = args
        .get("max_depth")
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .clamp(1, MAX_INSPECT_DEPTH) as usize;
    let interactable_only = args.get("interactable_only").and_then(Value::as_bool).unwrap_or(false);
    let tree = c.inspect_ui(max_depth, interactable_only)?;
    Ok(json!({
        "structuredContent": tree,
        "content": [ { "type": "text", "text": "已返回前台控件树" } ]
    }))
}

fn exec_click_element(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let name = args.get("name").and_then(Value::as_str);
    let automation_id = args.get("automation_id").and_then(Value::as_str);
    let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
    let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 2) as u32;
    let label = c.click_element(name, automation_id, button, count)?;
    Ok(text_result(json!({ "clicked": label }), label))
}

fn exec_set_text(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let name = args.get("name").and_then(Value::as_str);
    let automation_id = args.get("automation_id").and_then(Value::as_str);
    let text = require_str(args, "text")?;
    let label = c.set_text(name, automation_id, text)?;
    Ok(text_result(json!({ "element": label }), label))
}

fn exec_clipboard(args: &Value, c: &mut ComputerController) -> Result<Value> {
    let action = require_str(args, "action")?;
    match action {
        "get" => {
            let text = c.clipboard_get()?;
            Ok(text_result(json!({ "text": text }), format!("剪贴板内容（{} 字符）", text.chars().count())))
        }
        "set" => {
            let text = require_str(args, "text")?;
            c.clipboard_set(text)?;
            Ok(text_result(json!({ "set": true }), format!("已写入剪贴板（{} 字符）", text.chars().count())))
        }
        other => Err(AppError::ValidationError(format!("未知 clipboard action: {other}"))),
    }
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

fn require_i32(args: &Value, key: &str) -> Result<i32> {
    args.get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| AppError::ValidationError(format!("缺少整数参数: {key}")))
}

fn optional_i32(args: &Value, key: &str) -> Option<i32> {
    args.get(key).and_then(Value::as_i64).map(|v| v as i32)
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
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
        ("click", "鼠标点击（可连击）。"),
        ("drag", "拖拽。"),
        ("mouse_down", "按下鼠标键。"),
        ("mouse_up", "释放鼠标键。"),
        ("type_text", "输入文本。"),
        ("press_key", "按下组合键。"),
        ("hold_key", "按住组合键一段时间。"),
        ("scroll", "滚动。"),
        ("wait", "等待毫秒。"),
        ("inspect_ui", "Windows 控件树。"),
        ("click_element", "按控件查找并点击。"),
        ("set_text", "按控件查找并输入文本。"),
        ("clipboard", "读写剪贴板。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tool_count() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 16);
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
