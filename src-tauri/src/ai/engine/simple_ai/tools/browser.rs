/*! 内置浏览器工具：让 SimpleAI 读取和受控操作 Polaris 浏览器 Tab。
 *
 * 该工具暴露导航、上下文读取、可操作元素检查，以及按 index/text 的 click/fill。
 * 不开放任意页面脚本执行。更完整的 CDP/Playwright 调试能力后续可作为独立浏览器 MCP 扩展。
 *
 * Phase 3: 实际分派逻辑已收敛到 BrowserActionDispatcher (ADR 0004 P0 #2),
 * 本文件只负责 tool spec 声明 + 调用 dispatcher。
 */

use serde_json::{json, Value};

use crate::commands::browser::{BrowserActionDispatcher, BrowserActionSource};

use super::{Tool, ToolContext, ToolOutcome};

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
                "description": "Operate Polaris built-in browser tabs. Use acquire first when the agent needs a tab: it binds this agent to an existing label or creates a dedicated browser tab. Later actions without label use the current agent binding before falling back to the most recent tab. Supports navigation, page context, diagnostics, inspect, click, fill, reload, back, forward, and historyState.",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "acquire", "navigate", "context", "diagnostics", "inspect", "click", "fill", "reload", "back", "forward", "historyState"]
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
        // 将 session_id 注入为 agentKey fallback(若未显式提供)
        let mut enriched = args.clone();
        if enriched.get("agentKey").is_none() && enriched.get("agent_key").is_none() {
            if !ctx.session_id.trim().is_empty() {
                enriched["agentKey"] = json!(ctx.session_id);
            }
        }
        match BrowserActionDispatcher::from_app_handle()
            .and_then(|d| {
                // dispatcher 是同步构造,但 dispatch 是 async;不能在 and_then 里 await
                // 这里返回 dispatcher 实例,下面 await
                Ok(d)
            }) {
            Ok(dispatcher) => match dispatcher
                .dispatch(&enriched, BrowserActionSource::SimpleAi)
                .await
            {
                Ok(value) => {
                    let text = serde_json::to_string_pretty(&value)
                        .unwrap_or_else(|_| "{}".to_string());
                    ToolOutcome::ok(truncate_chars(&text, BROWSER_OUTPUT_CAP))
                }
                Err(error) => ToolOutcome::fail(error.to_message()),
            },
            Err(error) => ToolOutcome::fail(error.to_message()),
        }
    }
}

const BROWSER_OUTPUT_CAP: usize = 18_000;

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in value.chars().take(max_chars) {
        out.push(ch);
    }
    if value.chars().count() > max_chars {
        out.push('…');
    }
    out
}
