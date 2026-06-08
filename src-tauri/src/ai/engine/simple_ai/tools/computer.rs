/*! computer 工具：控制本机桌面（鼠标 / 键盘 / Windows 控件树 / 剪贴板）。
 *
 * 复用 `crate::services::computer_control` 的 `ComputerController`，与 `polaris-computer-mcp`
 * 共享同一套底层逻辑与安全策略（默认开启 + failsafe + 审计日志）。
 *
 * 设计取舍：SimpleAI 工具结果只能回传纯文本，故聚焦**结构化界面查询 + 输入动作**，
 * 不含 screenshot（图像回传交给支持视觉的引擎或 polaris-computer-mcp）。
 * `Tool::execute` 为 `&self`，输入模拟需可变借用，故每次调用新建一个 `ComputerController`。
 */

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::computer_control::ComputerController;

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

/// 文本类输出（inspect_ui / clipboard）的最大字符数。
const TEXT_OUTPUT_CAP: usize = 16_000;

pub(super) struct ComputerTool;

impl Tool for ComputerTool {
    fn name(&self) -> &'static str {
        "computer"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "computer",
                "description": "控制本机桌面：通过 action 指定操作。\
inspect_ui=（优先用）返回前台控件树（每控件含 name/controlType/automationId/rect/center），用于定位元素；\
click_element=按控件名/automationId 直接点击（不靠坐标，最可靠）；set_text=按控件填入文本；\
cursor_position=取光标坐标；move_mouse=移动到 (x,y)；click=点击（x,y/button/count，count=1/2/3 连击）；\
drag=拖拽（from_x,from_y→to_x,to_y）；mouse_down/mouse_up=按下/释放鼠标键；\
type_text=输入 text；press_key=组合键 keys（如 ctrl+c）；hold_key=按住 keys 共 ms 毫秒；\
scroll=滚动（dx,dy）；clipboard_get/clipboard_set=读/写剪贴板；wait=等待 ms；\
find_element=查找/等待控件并返回信息(name 或 automation_id)；list_windows=列出顶层窗口；activate_window=按 title 激活窗口。\
高危操作，会真实控制鼠标键盘；把光标移到屏幕角落可紧急中断（failsafe）。",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "inspect_ui", "click_element", "set_text", "cursor_position",
                                "move_mouse", "click", "drag", "mouse_down", "mouse_up",
                                "type_text", "press_key", "hold_key", "scroll",
                                "clipboard_get", "clipboard_set", "wait",
                                "find_element", "list_windows", "activate_window"
                            ]
                        },
                        "x": { "type": "integer" },
                        "y": { "type": "integer" },
                        "button": { "type": "string", "enum": ["left", "right", "middle"] },
                        "count": { "type": "integer", "minimum": 1, "maximum": 3, "description": "click/click_element 连击次数" },
                        "from_x": { "type": "integer" },
                        "from_y": { "type": "integer" },
                        "to_x": { "type": "integer" },
                        "to_y": { "type": "integer" },
                        "text": { "type": "string", "description": "type_text/set_text/clipboard_set 的文本" },
                        "keys": { "type": "string", "description": "press_key/hold_key 的组合键" },
                        "ms": { "type": "integer", "description": "hold_key/wait 的毫秒数" },
                        "dx": { "type": "integer" },
                        "dy": { "type": "integer" },
                        "name": { "type": "string", "description": "click_element/set_text 的控件名（模糊匹配）" },
                        "automation_id": { "type": "string", "description": "click_element/set_text 的控件 automationId" },
                        "max_depth": { "type": "integer", "description": "inspect_ui 深度，默认 3" },
                        "interactable_only": { "type": "boolean", "description": "inspect_ui 仅保留可交互节点" },
                        "timeout_ms": { "type": "integer", "description": "find_element 等待控件出现的超时(ms)" },
                        "title": { "type": "string", "description": "activate_window 的窗口标题" }
                    },
                    "additionalProperties": false
                }
            }
        })
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutcome {
        match run(args) {
            Ok(text) => ToolOutcome::ok(text),
            Err(error) => ToolOutcome::fail(error.to_message()),
        }
    }
}

fn run(args: &Value) -> Result<String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("computer 缺少 action 参数".to_string()))?;

    // wait 不需要控制器。
    if action == "wait" {
        let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(500).min(10_000);
        std::thread::sleep(std::time::Duration::from_millis(ms));
        return Ok(format!("已等待 {ms} ms"));
    }

    // 使用进程级常驻控制器：保持 enigo 跨调用状态（mouse_down 的按下键不被 drop 释放），
    // Mutex 同时串行化 computer 操作，避免并发输入交错。
    let shared = ComputerController::shared()?;
    let mut controller = shared
        .lock()
        .map_err(|e| AppError::ValidationError(format!("computer 控制器锁异常: {e}")))?;

    match action {
        "cursor_position" => {
            let (x, y) = controller.cursor_position()?;
            Ok(format!("光标位置: ({x}, {y})"))
        }
        "move_mouse" => {
            let x = require_i32(args, "x")?;
            let y = require_i32(args, "y")?;
            controller.move_mouse(x, y)?;
            Ok(format!("已移动鼠标到 ({x}, {y})"))
        }
        "click" => {
            let x = optional_i32(args, "x");
            let y = optional_i32(args, "y");
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3) as u32;
            controller.click(x, y, button, count)?;
            Ok(format!("已点击 {button} 键 x{count}"))
        }
        "drag" => {
            let from_x = require_i32(args, "from_x")?;
            let from_y = require_i32(args, "from_y")?;
            let to_x = require_i32(args, "to_x")?;
            let to_y = require_i32(args, "to_y")?;
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            controller.drag(from_x, from_y, to_x, to_y, button)?;
            Ok(format!("已拖拽 ({from_x},{from_y}) → ({to_x},{to_y})"))
        }
        "mouse_down" => {
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            controller.mouse_down(optional_i32(args, "x"), optional_i32(args, "y"), button)?;
            Ok(format!("已按下 {button} 键"))
        }
        "mouse_up" => {
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            controller.mouse_up(optional_i32(args, "x"), optional_i32(args, "y"), button)?;
            Ok(format!("已释放 {button} 键"))
        }
        "type_text" => {
            let text = require_str(args, "text")?;
            controller.type_text(text)?;
            Ok(format!("已输入 {} 个字符", text.chars().count()))
        }
        "press_key" => {
            let keys = require_str(args, "keys")?;
            controller.press_key(keys)?;
            Ok(format!("已按下 {keys}"))
        }
        "hold_key" => {
            let keys = require_str(args, "keys")?;
            let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(500).min(10_000);
            controller.hold_key(keys, ms)?;
            Ok(format!("已按住 {keys} {ms}ms"))
        }
        "scroll" => {
            let dx = optional_i32(args, "dx").unwrap_or(0);
            let dy = optional_i32(args, "dy").unwrap_or(0);
            controller.scroll(dx, dy)?;
            Ok(format!("已滚动 ({dx}, {dy})"))
        }
        "inspect_ui" => {
            let max_depth = args.get("max_depth").and_then(Value::as_u64).unwrap_or(3).clamp(1, 8) as usize;
            let interactable_only = args.get("interactable_only").and_then(Value::as_bool).unwrap_or(false);
            let tree = controller.inspect_ui(max_depth, interactable_only)?;
            let pretty = serde_json::to_string_pretty(&tree).unwrap_or_else(|_| tree.to_string());
            Ok(truncate_chars(&pretty, TEXT_OUTPUT_CAP))
        }
        "click_element" => {
            let name = args.get("name").and_then(Value::as_str);
            let automation_id = args.get("automation_id").and_then(Value::as_str);
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 2) as u32;
            controller.click_element(name, automation_id, button, count)
        }
        "set_text" => {
            let name = args.get("name").and_then(Value::as_str);
            let automation_id = args.get("automation_id").and_then(Value::as_str);
            let text = require_str(args, "text")?;
            controller.set_text(name, automation_id, text)
        }
        "clipboard_get" => {
            let text = controller.clipboard_get()?;
            Ok(truncate_chars(&text, TEXT_OUTPUT_CAP))
        }
        "clipboard_set" => {
            let text = require_str(args, "text")?;
            controller.clipboard_set(text)?;
            Ok(format!("已写入剪贴板（{} 字符）", text.chars().count()))
        }
        "find_element" => {
            let name = args.get("name").and_then(Value::as_str);
            let automation_id = args.get("automation_id").and_then(Value::as_str);
            let timeout_ms = args
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(1000)
                .min(30_000);
            let info = controller.find_element(name, automation_id, timeout_ms)?;
            let pretty = serde_json::to_string_pretty(&info).unwrap_or_else(|_| info.to_string());
            Ok(truncate_chars(&pretty, TEXT_OUTPUT_CAP))
        }
        "list_windows" => {
            let windows = controller.list_windows()?;
            let pretty =
                serde_json::to_string_pretty(&windows).unwrap_or_else(|_| windows.to_string());
            Ok(truncate_chars(&pretty, TEXT_OUTPUT_CAP))
        }
        "activate_window" => {
            let title = require_str(args, "title")?;
            controller.activate_window(title)
        }
        other => Err(AppError::ValidationError(format!(
            "未知 computer action: {other}"
        ))),
    }
}

fn require_i32(args: &Value, key: &str) -> Result<i32> {
    args.get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| AppError::ValidationError(format!("computer 缺少整数参数: {key}")))
}

fn optional_i32(args: &Value, key: &str) -> Option<i32> {
    args.get(key).and_then(Value::as_i64).map(|v| v as i32)
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError(format!("computer 缺少字符串参数: {key}")))
}
