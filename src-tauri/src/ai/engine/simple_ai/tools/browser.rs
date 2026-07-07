/*! 内置浏览器工具：让 SimpleAI 读取和受控操作 Polaris 浏览器 Tab。
 *
 * 该工具暴露导航、上下文读取、可操作元素检查，以及按 index/text 的 click/fill。
 * 不开放任意页面脚本执行。更完整的 CDP/Playwright 调试能力后续可作为独立浏览器 MCP 扩展。
 */

use serde_json::{json, Value};

use crate::commands::browser::{
    browser_acquire_with_app, browser_app_handle, browser_click_with_app, browser_fill_with_app,
    browser_get_diagnostics_with_app, browser_get_interactive_elements_with_app,
    browser_get_page_context_with_app, browser_history_with_app, browser_list_registered_sessions,
    browser_navigate_with_app, browser_reload_with_app, emit_browser_operation_with_app,
    resolve_browser_label_for_agent,
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
                "description": "Operate Polaris built-in browser tabs. Use acquire first when the agent needs a tab: it binds this agent to an existing label or creates a dedicated browser tab. Later actions without label use the current agent binding before falling back to the most recent tab. Supports navigation, page context, diagnostics, inspect, click, fill, reload, back, and forward.",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "acquire", "navigate", "context", "diagnostics", "inspect", "click", "fill", "reload", "back", "forward"]
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["auto", "create", "reuse"],
                            "description": "acquire 模式：auto 复用当前 agent 已绑定 tab 或新建；create 总是新建；reuse 优先选择已有 tab"
                        },
                        "agentKey": {
                            "type": "string",
                            "description": "浏览器归属 key；省略时使用当前 SimpleAI 会话/子 agent session_id"
                        },
                        "title": {
                            "type": "string",
                            "description": "acquire 新建 tab 时的临时标题"
                        },
                        "activate": {
                            "type": "boolean",
                            "description": "acquire/select 时是否切换到对应浏览器 tab，默认 true"
                        },
                        "label": {
                            "type": "string",
                            "description": "浏览器 WebView label；acquire 时传入可选择现有 tab；其他 action 省略时优先使用当前 agent 已绑定 tab"
                        },
                        "url": {
                            "type": "string",
                            "description": "navigate 目标 URL，支持 localhost:3000、example.com、https://example.com"
                        },
                        "index": {
                            "type": "integer",
                            "description": "inspect 返回的元素 index，用于 click/fill"
                        },
                        "text": {
                            "type": "string",
                            "description": "当不知道 index 时，用可见文本/placeholder/aria-label 模糊匹配目标元素"
                        },
                        "value": {
                            "type": "string",
                            "description": "fill 要输入的文本"
                        },
                        "includeScreenshot": {
                            "type": "boolean",
                            "description": "diagnostics 是否尝试返回当前内置浏览器区域截图。默认 false；需要视觉判断时再开启。"
                        }
                    },
                    "additionalProperties": false
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        match run(args, ctx).await {
            Ok(text) => ToolOutcome::ok(text),
            Err(error) => ToolOutcome::fail(error.to_message()),
        }
    }
}

async fn run(args: &Value, ctx: &ToolContext<'_>) -> crate::Result<String> {
    let action = args.get("action").and_then(Value::as_str).ok_or_else(|| {
        crate::error::AppError::ValidationError("browser 缺少 action".to_string())
    })?;

    if action == "list" {
        let sessions = browser_list_registered_sessions()?;
        if sessions.is_empty() {
            return Ok("当前没有打开的 Polaris 内置浏览器。".to_string());
        }
        return Ok(serde_json::to_string_pretty(&sessions).unwrap_or_else(|_| "[]".to_string()));
    }

    let agent_key = args
        .get("agentKey")
        .or_else(|| args.get("agent_key"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(ctx.session_id);
    let app = browser_app_handle()?;

    if action == "acquire" {
        let result = browser_acquire_with_app(
            &app,
            Some(agent_key),
            args.get("label").and_then(Value::as_str),
            args.get("url").and_then(Value::as_str),
            args.get("title").and_then(Value::as_str),
            args.get("mode").and_then(Value::as_str),
            args.get("activate")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        )
        .await?;
        let json = serde_json::to_string_pretty(&result)
            .unwrap_or_else(|_| "无法序列化浏览器 acquire 结果".to_string());
        return Ok(json);
    }

    let label = resolve_browser_label_for_agent(
        args.get("label").and_then(Value::as_str),
        Some(agent_key),
    )?;

    match action {
        "navigate" => {
            let url = args.get("url").and_then(Value::as_str).ok_or_else(|| {
                crate::error::AppError::ValidationError("navigate 缺少 url".to_string())
            })?;
            let normalized = browser_navigate_with_app(&app, &label, url)?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "navigate",
                "success",
                format!("AI 导航到 {normalized}"),
                None,
                Some(normalized.clone()),
            );
            Ok(format!("已导航内置浏览器 {label} 到 {normalized}"))
        }
        "context" => {
            let context = browser_get_page_context_with_app(&app, &label).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "context",
                "success",
                if context.title.trim().is_empty() {
                    "AI 读取页面上下文".to_string()
                } else {
                    format!("AI 读取页面上下文：{}", truncate_chars(&context.title, 80))
                },
                None,
                Some(context.url.clone()),
            );
            let json = serde_json::to_string_pretty(&context)
                .unwrap_or_else(|_| "无法序列化浏览器上下文".to_string());
            Ok(truncate_chars(&json, BROWSER_OUTPUT_CAP))
        }
        "inspect" => {
            let elements = browser_get_interactive_elements_with_app(&app, &label).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "inspect",
                "success",
                format!("AI 检查到 {} 个可操作元素", elements.len()),
                None,
                None,
            );
            if elements.is_empty() {
                return Ok("当前页面没有发现可操作元素。".to_string());
            }
            let json = serde_json::to_string_pretty(&elements)
                .unwrap_or_else(|_| "无法序列化浏览器可操作元素".to_string());
            Ok(truncate_chars(&json, BROWSER_OUTPUT_CAP))
        }
        "diagnostics" => {
            let include_screenshot = args
                .get("includeScreenshot")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let diagnostics =
                browser_get_diagnostics_with_app(&app, &label, include_screenshot).await?;
            let json = serde_json::to_string_pretty(&diagnostics)
                .unwrap_or_else(|_| "无法序列化浏览器诊断".to_string());
            Ok(truncate_chars(&json, BROWSER_OUTPUT_CAP))
        }
        "click" => {
            let index = parse_index(args)?;
            let text = args.get("text").and_then(Value::as_str);
            let result = browser_click_with_app(&app, &label, index, text).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "click",
                if result.ok { "success" } else { "warning" },
                result.message.clone(),
                target_text(&result.text),
                Some(result.url.clone()),
            );
            let json = serde_json::to_string_pretty(&result)
                .unwrap_or_else(|_| "无法序列化浏览器点击结果".to_string());
            Ok(json)
        }
        "fill" => {
            let index = parse_index(args)?;
            let text = args.get("text").and_then(Value::as_str);
            let value = args.get("value").and_then(Value::as_str).ok_or_else(|| {
                crate::error::AppError::ValidationError("fill 缺少 value".to_string())
            })?;
            let result = browser_fill_with_app(&app, &label, index, text, value).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "fill",
                if result.ok { "success" } else { "warning" },
                result.message.clone(),
                target_text(&result.text),
                Some(result.url.clone()),
            );
            let json = serde_json::to_string_pretty(&result)
                .unwrap_or_else(|_| "无法序列化浏览器输入结果".to_string());
            Ok(json)
        }
        "reload" => {
            browser_reload_with_app(&app, &label)?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "reload",
                "success",
                "AI 刷新了当前页面".to_string(),
                None,
                None,
            );
            Ok(format!("已刷新内置浏览器 {label}"))
        }
        "back" => {
            browser_history_with_app(&app, &label, "back")?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "back",
                "success",
                "AI 后退到上一页".to_string(),
                None,
                None,
            );
            Ok(format!("已让内置浏览器 {label} 后退"))
        }
        "forward" => {
            browser_history_with_app(&app, &label, "forward")?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "forward",
                "success",
                "AI 前进到下一页".to_string(),
                None,
                None,
            );
            Ok(format!("已让内置浏览器 {label} 前进"))
        }
        other => Err(crate::error::AppError::ValidationError(format!(
            "未知 browser action: {other}"
        ))),
    }
}

fn target_text(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(truncate_chars(text, 120))
    }
}

fn parse_index(args: &Value) -> crate::Result<Option<usize>> {
    match args.get("index").and_then(Value::as_i64) {
        Some(index) if index >= 0 => Ok(Some(index as usize)),
        Some(_) => Err(crate::error::AppError::ValidationError(
            "index 不能为负数".to_string(),
        )),
        None => Ok(None),
    }
}
