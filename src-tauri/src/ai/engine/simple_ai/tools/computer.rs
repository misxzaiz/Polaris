/*! computer 工具：控制本机桌面（鼠标 / 键盘 / Windows 控件树）。
 *
 * 复用 `crate::services::computer_control` 的 `ComputerController`，与 `polaris-computer-mcp`
 * 共享同一套底层逻辑与安全策略（默认开启 + failsafe + 审计日志）。
 *
 * 设计取舍：SimpleAI 直连第三方 OpenAI 兼容 API，工具结果只能回传纯文本，故本工具聚焦
 * **结构化界面查询（inspect_ui，控件树）+ 输入动作**，形成纯文本闭环，不依赖模型视觉能力；
 * 截图（图像回传）能力交由支持视觉的引擎或 polaris-computer-mcp。
 *
 * `Tool::execute` 为 `&self`，而输入模拟需可变借用，故每次调用新建一个 `ComputerController`
 * （enigo 在 Windows 上基于 SendInput，构造开销低）。
 */

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::computer_control::{ComputerConfig, ComputerController};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

/// inspect_ui 输出的最大字符数（控件树可能很大）。
const INSPECT_OUTPUT_CAP: usize = 16_000;

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
inspect_ui=（仅 Windows）返回前台控件树（每个控件含 name/controlType/rect/enabled），用于定位可点击元素，优先用它观察界面；\
cursor_position=获取鼠标坐标；\
move_mouse=移动鼠标到 (x,y)；\
click=鼠标点击（可选 x,y 先移动；button=left/right/middle；double=是否双击）；\
type_text=在焦点处输入 text；\
press_key=按下组合键 keys（如 'ctrl+c'、'alt+f4'、'enter'）；\
scroll=滚动（dx 水平、dy 垂直）；\
wait=等待 ms 毫秒（等界面响应）。\
高危操作，会真实控制鼠标键盘；把光标移到屏幕角落可紧急中断（failsafe）。",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "inspect_ui", "cursor_position", "move_mouse", "click",
                                "type_text", "press_key", "scroll", "wait"
                            ]
                        },
                        "x": { "type": "integer", "description": "move_mouse/click 的横坐标" },
                        "y": { "type": "integer", "description": "move_mouse/click 的纵坐标" },
                        "button": { "type": "string", "enum": ["left", "right", "middle"] },
                        "double": { "type": "boolean", "description": "click 是否双击" },
                        "text": { "type": "string", "description": "type_text 的内容" },
                        "keys": { "type": "string", "description": "press_key 的组合键，如 ctrl+shift+t" },
                        "dx": { "type": "integer", "description": "scroll 水平量" },
                        "dy": { "type": "integer", "description": "scroll 垂直量" },
                        "ms": { "type": "integer", "description": "wait 毫秒数（上限 10000）" },
                        "max_depth": { "type": "integer", "description": "inspect_ui 递归深度，默认 3" }
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

    // wait 不需要输入控制器。
    if action == "wait" {
        let ms = args
            .get("ms")
            .and_then(Value::as_u64)
            .unwrap_or(500)
            .min(10_000);
        std::thread::sleep(std::time::Duration::from_millis(ms));
        return Ok(format!("已等待 {ms} ms"));
    }

    let mut controller = ComputerController::new(ComputerConfig::from_env())?;

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
            let double = args.get("double").and_then(Value::as_bool).unwrap_or(false);
            controller.click(x, y, button, double)?;
            Ok(format!("已{}点击 {button} 键", if double { "双" } else { "单" }))
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
        "scroll" => {
            let dx = optional_i32(args, "dx").unwrap_or(0);
            let dy = optional_i32(args, "dy").unwrap_or(0);
            controller.scroll(dx, dy)?;
            Ok(format!("已滚动 ({dx}, {dy})"))
        }
        "inspect_ui" => {
            let max_depth = args
                .get("max_depth")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .clamp(1, 8) as usize;
            let tree = controller.inspect_ui(max_depth)?;
            let pretty = serde_json::to_string_pretty(&tree).unwrap_or_else(|_| tree.to_string());
            Ok(truncate_chars(&pretty, INSPECT_OUTPUT_CAP))
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
