/*! 内置浏览器工具：让 SimpleAI 读取和轻量控制 Polaris 浏览器 Tab。
 *
 * 该工具只暴露导航与上下文读取，不开放任意写入型脚本执行。更完整的 CDP/Playwright
 * 调试能力后续可以作为独立浏览器 MCP 扩展。
 */

use serde_json::{json, Value};

use crate::commands::browser::{
    browser_app_handle, browser_get_page_context_with_app, browser_history_with_app,
    browser_list_registered_sessions, browser_navigate_with_app, browser_reload_with_app,
    resolve_browser_label,
};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

const BROWSER_OUTPUT_CAP: usize = 18_000;

pub(super) struct BrowserTool;

#[async_trait::async_trait]
impl Tool for BrowserTool {
    fn name(&self) -> &'static str {
        "browser"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "browser",
                "description": "操作 Polaris 内置浏览器。可列出当前浏览器、导航到 URL、后退、前进、刷新，并读取当前页面标题、URL、选中文本、正文摘要、标题结构和链接。只作用于 Polaris 内置浏览器 Tab；如未打开浏览器，先让用户打开浏览器面板。",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "navigate", "context", "reload", "back", "forward"]
                        },
                        "label": {
                            "type": "string",
                            "description": "浏览器 WebView label；省略时使用最近活动的内置浏览器"
                        },
                        "url": {
                            "type": "string",
                            "description": "navigate 目标 URL，支持 localhost:3000、example.com、https://example.com"
                        }
                    },
                    "additionalProperties": false
                }
            }
        })
    }

    async fn execute(&self, args: &Value, _ctx: &ToolContext<'_>) -> ToolOutcome {
        match run(args).await {
            Ok(text) => ToolOutcome::ok(text),
            Err(error) => ToolOutcome::fail(error.to_message()),
        }
    }
}

async fn run(args: &Value) -> crate::Result<String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::error::AppError::ValidationError("browser 缺少 action".to_string()))?;

    if action == "list" {
        let sessions = browser_list_registered_sessions()?;
        if sessions.is_empty() {
            return Ok("当前没有打开的 Polaris 内置浏览器。".to_string());
        }
        return Ok(serde_json::to_string_pretty(&sessions).unwrap_or_else(|_| "[]".to_string()));
    }

    let label = resolve_browser_label(args.get("label").and_then(Value::as_str))?;
    let app = browser_app_handle()?;

    match action {
        "navigate" => {
            let url = args
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| crate::error::AppError::ValidationError("navigate 缺少 url".to_string()))?;
            let normalized = browser_navigate_with_app(&app, &label, url)?;
            Ok(format!("已导航内置浏览器 {label} 到 {normalized}"))
        }
        "context" => {
            let context = browser_get_page_context_with_app(&app, &label).await?;
            let json = serde_json::to_string_pretty(&context)
                .unwrap_or_else(|_| "无法序列化浏览器上下文".to_string());
            Ok(truncate_chars(&json, BROWSER_OUTPUT_CAP))
        }
        "reload" => {
            browser_reload_with_app(&app, &label)?;
            Ok(format!("已刷新内置浏览器 {label}"))
        }
        "back" => {
            browser_history_with_app(&app, &label, "back")?;
            Ok(format!("已让内置浏览器 {label} 后退"))
        }
        "forward" => {
            browser_history_with_app(&app, &label, "forward")?;
            Ok(format!("已让内置浏览器 {label} 前进"))
        }
        other => Err(crate::error::AppError::ValidationError(format!(
            "未知 browser action: {other}"
        ))),
    }
}
