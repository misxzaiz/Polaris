/*! Simple AI 对话循环
 *
 * 发起 OpenAI 兼容流式请求 → 解析 SSE → 执行工具调用 → 将结果回灌继续，
 * 直至模型不再请求工具或达到轮次上限。三线路协议适配见 `simple_ai_protocol`。
 */

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::ai::engine::simple_ai_protocol::{
    build_request_body, StreamDelta, StreamState, WireProtocol,
};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    ProgressEvent, SessionEndEvent, ThinkingEvent, TokenEvent, ToolCallEndEvent, ToolCallStartEvent,
};
use crate::models::AIEvent;

use super::compact;
use super::history;
use super::tools::{ToolContext, ToolRegistry};

/// 历史中单条 assistant 文本输出的 token 上限，超出则截断头部（约 16k 字符）。
/// 仅截真正巨大的输出（如模型贴大段代码/文件），正常回答不受影响；零额外 API 调用。
const HISTORY_ASSISTANT_TOKEN_CAP: usize = 4000;

/// 默认请求总超时（秒）。可经 ModelProfile.custom_env 的 `SIMPLE_AI_TIMEOUT_SECS` 覆盖。
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 默认流空闲超时（秒）：距上一个数据块超过该时长视为流卡死。
/// 可经 ModelProfile.custom_env 的 `SIMPLE_AI_STREAM_IDLE_SECS` 覆盖。
const STREAM_IDLE_TIMEOUT_SECS: u64 = 120;

/// 工具调用轮次上限，**默认 0 = 不限制**（对齐 codex：靠模型自然终止 + 用户中断 + token
/// 控制，而非数轮次封顶；codex `session/turn.rs` 的工具循环本身无轮次上限）。可经
/// ModelProfile.custom_env 的 `SIMPLE_AI_MAX_TOOL_ROUNDS` 设为正整数作为防御性兜底。
///
/// 注意：SimpleAI 尚未实现上下文压缩(compact)，无限轮次下超长任务的 token 会单调增长，
/// 最终可能触发 API 的上下文超限错误而终止（详见 docs/simple-ai-codex-refactor-plan.md）。
const DEFAULT_MAX_TOOL_ROUNDS: u64 = 0;

/// 发起 OpenAI Chat Completions 流式请求，执行工具调用循环
pub(super) async fn run_chat_loop(
    session_id: &str,
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    work_dir: &str,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    abort_rx: &mut watch::Receiver<bool>,
    mcp_servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer],
    skills: &std::collections::HashMap<String, super::skill::SkillEntry>,
    depth: u32,
) -> Result<()> {
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    tracing::info!(
        "[SimpleAI] run_chat_loop 开始, session={}, protocol={}",
        session_id,
        protocol.as_str()
    );

    // 超时配置：默认常量，可经 profile.custom_env 覆盖（不改 ModelProfile 结构/前端）。
    let request_timeout_secs =
        read_env_u64(&profile.custom_env, "SIMPLE_AI_TIMEOUT_SECS", DEFAULT_REQUEST_TIMEOUT_SECS);
    let stream_idle_secs =
        read_env_u64(&profile.custom_env, "SIMPLE_AI_STREAM_IDLE_SECS", STREAM_IDLE_TIMEOUT_SECS);
    // 工具调用轮次上限：0 = 不限制（默认）。这里不复用 read_env_u64（它会把 0 视为非法回退），
    // 因为 0 对轮次而言是合法的「无限制」语义。
    let max_tool_rounds = profile
        .custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_MAX_TOOL_ROUNDS"))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS);

    // 工具注册表 + 本轮 schema。新增工具无需改动本循环。
    let mut registry = ToolRegistry::with_builtins();
    // dispatch_agent 默认开启；SIMPLE_AI_DISABLE_SUBAGENT=1 时移除（决策 §12-4）。
    let subagent_disabled = profile
        .custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_DISABLE_SUBAGENT"))
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if subagent_disabled {
        tracing::info!("[SimpleAI] dispatch_agent 已禁用（SIMPLE_AI_DISABLE_SUBAGENT）");
        registry = registry.without_tool("dispatch_agent");
    }
    // MCP 工具池（Phase 4b）：若有已启用的 MCP server，spawn 并注入工具。
    if !mcp_servers.is_empty() {
        let pool = Arc::new(super::mcp::McpClientPool::from_servers(mcp_servers.to_vec()).await);
        tracing::info!(
            "[SimpleAI] MCP pool 就绪：{} 个 server 连接，{} 个工具",
            pool.connected_count(),
            pool.tool_specs().len()
        );
        registry = registry.with_mcp(pool);
    }
    let tools = registry.specs();
    // update_plan 的计划面板状态：每轮首次调用先发 plan_start。
    let plan_id = format!("{}-plan", session_id);
    let plan_started = AtomicBool::new(false);

    // 上下文压缩配置（Phase 3.3）：累计 input 达窗口 75% 时触发摘要压缩。
    let context_window = read_env_u64(
        &profile.custom_env,
        "SIMPLE_AI_CONTEXT_WINDOW",
        compact::DEFAULT_CONTEXT_WINDOW,
    );
    let mut usage_acc = compact::UsageAccumulator::default();

    let mut round: u64 = 0;

    loop {
        // 仅当配置了正整数上限时才封顶；默认 0 = 不限制（靠模型自然终止 / 用户中断 / 流超时）。
        if max_tool_rounds > 0 && round >= max_tool_rounds {
            let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                session_id,
                format!("Reached configured tool call round cap ({}), stopping.", max_tool_rounds),
            )));
            break;
        }
        round += 1;

        if *abort_rx.borrow() {
            let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
            return Ok(());
        }

        // 裁剪历史中超长的 assistant 输出，避免长会话撑爆上下文窗口（零额外 API 调用）。
        history::truncate_history_assistant_outputs(messages, HISTORY_ASSISTANT_TOKEN_CAP);

        // 上下文压缩（Phase 3.3）：累计 input 达阈值时，发摘要请求替换历史区间。
        if usage_acc.should_compact(context_window) {
            tracing::info!(
                "[SimpleAI] 触发上下文压缩（累计 input={}，window={}）",
                usage_acc.total_input,
                context_window
            );
            compact::compact_history(messages, profile, event_callback, session_id).await?;
        }

        // 构建请求体（按线路协议转换内部 OpenAI 消息格式）
        let body = build_request_body(protocol, &profile.model, messages, &tools);
        if tools.is_empty() {
            tracing::warn!("[SimpleAI] 工具列表为空!");
        } else {
            tracing::info!(
                "[SimpleAI] 发送 {} 个工具定义 (protocol={})",
                tools.len(),
                protocol.as_str()
            );
        }

        // HTTP 请求（含 429/5xx 指数退避重试，见 super::retry::send_with_retry）。
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(request_timeout_secs))
            .build()
            .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;

        let url = protocol.build_url(&profile.base_url);
        let mut req = client.post(&url).header("Content-Type", "application/json");
        for (k, v) in protocol.auth_headers(&profile.api_key) {
            req = req.header(k, v);
        }
        if let Some(headers) = &profile.custom_headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let req = req.body(body.to_string());

        let retry_max = read_env_u64(
            &profile.custom_env,
            "SIMPLE_AI_RETRY_MAX",
            super::retry::DEFAULT_RETRY_MAX_ATTEMPTS as u64,
        ) as u32;
        let retry_base_ms = read_env_u64(
            &profile.custom_env,
            "SIMPLE_AI_RETRY_BASE_MS",
            super::retry::DEFAULT_RETRY_BASE_MS,
        );
        tracing::info!(
            "[SimpleAI] 发送 API 请求: {} (model={}, retry_max={})",
            url,
            profile.model,
            retry_max
        );
        let response = super::retry::send_with_retry(req, retry_max, retry_base_ms).await?;
        tracing::info!("[SimpleAI] API 响应状态: {}", response.status());

        // 流式解析 SSE
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut assistant_content = String::new();
        let mut stream_state = StreamState::new(protocol);

        loop {
            if *abort_rx.borrow() {
                let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                return Ok(());
            }

            let chunk = tokio::select! {
                chunk = stream.next() => chunk,
                _ = abort_rx.changed() => {
                    let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                    return Ok(());
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(stream_idle_secs)) => {
                    return Err(AppError::ProcessError(format!(
                        "Stream idle timeout: no data for {}s",
                        stream_idle_secs
                    )));
                }
            };

            let Some(chunk_result) = chunk else { break };

            let bytes = chunk_result
                .map_err(|e| AppError::ProcessError(format!("Stream error: {}", e)))?;

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }

                let Ok(chunk_json) = serde_json::from_str::<Value>(data) else {
                    continue;
                };

                for delta in stream_state.feed(&chunk_json) {
                    match delta {
                        StreamDelta::Text(text) => {
                            assistant_content.push_str(&text);
                            let _ = event_callback(AIEvent::Token(TokenEvent::new(
                                session_id,
                                text,
                            )));
                        }
                        StreamDelta::Thinking(thinking) => {
                            let _ = event_callback(AIEvent::Thinking(ThinkingEvent::new(
                                session_id,
                                thinking,
                            )));
                        }
                    }
                }
            }
        }

        // 流处理完毕
        let mut tool_calls = stream_state.finish_tool_calls();
        // token usage（Phase 3.1）：三协议在流末解析，仅日志上报；专用 UsageEvent 待前端 types 同步后启用。
        if let Some(usage) = stream_state.finish_usage() {
            usage_acc.add(usage.input_tokens);
            tracing::info!(
                "[SimpleAI] token usage: input={}, output={}, total={} (累计 input={})",
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
                usage_acc.total_input
            );
        }
        tracing::info!(
            "[SimpleAI] 流处理完毕, session={}, content_len={}, tool_calls={}, first_100_chars={:?}",
            session_id,
            assistant_content.len(),
            tool_calls.len(),
            assistant_content.chars().take(100).collect::<String>()
        );

        if tool_calls.is_empty() {
            // 纯文本回复
            messages.push(json!({
                "role": "assistant",
                "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) }
            }));
            break;
        }

        // === 有工具调用 ===

        // 1. 发送 tool_call_start 事件
        for tc in &tool_calls {
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let mut start_event = ToolCallStartEvent::new(
                session_id,
                tool_name.to_string(),
                args.as_object()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            );
            start_event.call_id = Some(tc["id"].as_str().unwrap_or("").to_string());
            let _ = event_callback(AIEvent::ToolCallStart(start_event));
        }

        // 2. 保存 assistant 消息
        messages.push(json!({
            "role": "assistant",
            "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) },
            "tool_calls": tool_calls
        }));
        assistant_content.clear();

        // 3. 执行工具并收集结果
        for tc in &tool_calls {
            let call_id = tc["id"].as_str().unwrap_or("").to_string();
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let ctx = ToolContext {
                work_dir,
                session_id,
                event_callback,
                plan_id: &plan_id,
                plan_started: &plan_started,
                skills,
                profile,
                mcp_servers,
                subagent_depth: depth,
            };
            let outcome = registry.dispatch(tool_name, &args, &ctx).await;

            let mut end_event =
                ToolCallEndEvent::new(session_id, tool_name.to_string(), outcome.success);
            end_event.call_id = Some(call_id.clone());
            end_event.result = Some(Value::String(outcome.content.clone()));
            let _ = event_callback(AIEvent::ToolCallEnd(end_event));

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": outcome.content
            }));
        }

        tool_calls.clear();
    }

    Ok(())
}

/// 从 profile 的 `custom_env` 读取一个正整数 u64 配置；缺失/非法/为 0 时回退默认值。
fn read_env_u64(
    custom_env: &Option<std::collections::HashMap<String, String>>,
    key: &str,
    default: u64,
) -> u64 {
    custom_env
        .as_ref()
        .and_then(|m| m.get(key))
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}
