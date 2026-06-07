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

use super::tools::{ToolContext, ToolRegistry};

/// 发起 OpenAI Chat Completions 流式请求，执行工具调用循环
pub(super) async fn run_chat_loop(
    session_id: &str,
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    work_dir: &str,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    abort_rx: &mut watch::Receiver<bool>,
) -> Result<()> {
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    tracing::info!(
        "[SimpleAI] run_chat_loop 开始, session={}, protocol={}",
        session_id,
        protocol.as_str()
    );

    // 工具注册表 + 本轮 schema。新增工具无需改动本循环。
    let registry = ToolRegistry::with_builtins();
    let tools = registry.specs();
    // update_plan 的计划面板状态：每轮首次调用先发 plan_start。
    let plan_id = format!("{}-plan", session_id);
    let plan_started = AtomicBool::new(false);

    let max_tool_rounds = 40;
    let mut round = 0;

    loop {
        if round >= max_tool_rounds {
            let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                session_id,
                "Reached maximum tool call rounds (20), stopping.",
            )));
            break;
        }
        round += 1;

        if *abort_rx.borrow() {
            let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
            return Ok(());
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

        // HTTP 请求
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;

        let url = protocol.build_url(&profile.base_url);
        tracing::info!("[SimpleAI] 发送 API 请求: {} (model={})", url, profile.model);

        let mut req = client.post(&url).header("Content-Type", "application/json");

        for (k, v) in protocol.auth_headers(&profile.api_key) {
            req = req.header(k, v);
        }
        if let Some(headers) = &profile.custom_headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }

        let response = req
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| {
                tracing::error!("[SimpleAI] API 请求失败: {}", e);
                AppError::ProcessError(format!("API request failed: {}", e))
            })?;

        let status = response.status();
        tracing::info!("[SimpleAI] API 响应状态: {}", status);

        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            tracing::error!("[SimpleAI] API 错误 ({}): {}", status, error_body);
            return Err(AppError::ProcessError(format!(
                "API error ({}): {}",
                status, error_body
            )));
        }

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
            };
            let outcome = registry.dispatch(tool_name, &args, &ctx);

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
