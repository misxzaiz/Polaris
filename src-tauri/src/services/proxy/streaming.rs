//! OpenAI SSE → Anthropic SSE 流式格式转换
//!
//! 将 OpenAI Chat Completions 的流式响应（`data: {...}` 行）实时转换为
//! Anthropic Messages API 的 SSE 事件格式。

use super::models::OpenAIStreamChunk;
use super::sse::{append_utf8_safe, strip_sse_field, take_sse_block};
use bytes::Bytes;
use futures_util::stream::Stream;
use serde_json::{json, Value};
use std::collections::HashMap;

/// 工具调用块的累积状态
#[derive(Debug, Clone)]
struct ToolBlockState {
    anthropic_index: u32,
    id: String,
    name: String,
    started: bool,
    pending_args: String,
}

/// 创建将 OpenAI SSE 流转换为 Anthropic SSE 格式的流。
///
/// 处理：
/// - `message_start` / `message_stop` 事件
/// - `content_block_start` / `delta` / `stop` 事件（text、thinking、tool_use）
/// - 工具调用参数的增量累积
/// - usage 统计的正确传递
pub fn create_anthropic_sse_stream<E: std::error::Error + Send + 'static>(
    stream: impl Stream<Item = Result<Bytes, E>> + Send + 'static,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut buffer = String::new();
        let mut utf8_remainder: Vec<u8> = Vec::new();
        let mut message_id: Option<String> = None;
        let mut current_model: Option<String> = None;
        let mut next_content_index: u32 = 0;
        let mut has_sent_message_start = false;
        // 去重：只处理第一个 finish_reason
        let mut has_emitted_message_delta = false;
        // 延迟到 [DONE] 发送，确保 usage 完整
        let mut pending_message_delta: Option<(Option<String>, Option<Value>)> = None;
        let mut has_sent_message_stop = false;
        let mut latest_usage: Option<Value> = None;
        let mut current_non_tool_block_type: Option<&'static str> = None;
        let mut current_non_tool_block_index: Option<u32> = None;
        let mut tool_blocks_by_index: HashMap<usize, ToolBlockState> = HashMap::new();

        use futures_util::StreamExt;
        tokio::pin!(stream);
        let mut chunk_count: u32 = 0;
        let event_count: u32 = 0;

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    chunk_count += 1;
                    tracing::debug!("[SSE] 收到 chunk #{}: {}bytes", chunk_count, bytes.len());
                    append_utf8_safe(&mut buffer, &mut utf8_remainder, &bytes);

                    while let Some(block) = take_sse_block(&mut buffer) {
                        if block.trim().is_empty() {
                            continue;
                        }

                        if chunk_count <= 3 {
                            tracing::info!("[SSE] block#{}: {}", chunk_count, &block[..block.len().min(300)]);
                        }

                        for line in block.lines() {
                            let Some(data) = strip_sse_field(line, "data") else {
                                continue;
                            };

                            // [DONE] 标记流结束
                            if data.trim() == "[DONE]" {
                                tracing::info!("[SSE] 收到 [DONE]，已发出 {} 个事件", event_count);
                                // 发出缓存的 message_delta（含完整 usage）
                                if let Some((stop_reason, usage_json)) = pending_message_delta.take() {
                                    let event = build_message_delta_event(stop_reason, usage_json);
                                    let sse = format_sse("message_delta", &event);
                                    yield Ok(Bytes::from(sse));
                                }

                                if !has_sent_message_stop {
                                    let sse = format_sse("message_stop", &json!({"type": "message_stop"}));
                                    yield Ok(Bytes::from(sse));
                                    has_sent_message_stop = true;
                                }
                                continue;
                            }

                            // 解析 OpenAI chunk
                            let chunk = match serde_json::from_str::<OpenAIStreamChunk>(data) {
                                Ok(c) => {
                                    if chunk_count <= 3 {
                                        tracing::info!("[SSE] chunk#{} 解析成功: choices={}", chunk_count, c.choices.len());
                                    }
                                    c
                                }
                                Err(e) => {
                                    tracing::error!("[SSE] 无法解析 OpenAI chunk: error={}, data={}", e, &data[..data.len().min(500)]);
                                    continue;
                                }
                            };

                            // 记录 message_id 和 model
                            if message_id.is_none() && !chunk.id.is_empty() {
                                message_id = Some(chunk.id.clone());
                            }
                            if current_model.is_none() && !chunk.model.is_empty() {
                                current_model = Some(chunk.model.clone());
                            }

                            // 提取 usage
                            let chunk_usage_json = chunk.usage.as_ref().map(build_anthropic_usage);
                            if let Some(ref usage_json) = chunk_usage_json {
                                latest_usage = Some(usage_json.clone());
                                if let Some((_, ref mut pending_usage)) = pending_message_delta {
                                    *pending_usage = Some(usage_json.clone());
                                }
                            }

                            let Some(choice) = chunk.choices.first() else {
                                continue;
                            };

                            // --- message_start ---
                            if !has_sent_message_start {
                                let start_usage = build_start_usage(chunk.usage.as_ref());
                                let event = json!({
                                    "type": "message_start",
                                    "message": {
                                        "id": message_id.clone().unwrap_or_else(|| "msg_proxy".to_string()),
                                        "type": "message",
                                        "role": "assistant",
                                        "model": current_model.clone().unwrap_or_default(),
                                        "usage": start_usage
                                    }
                                });
                                let sse = format_sse("message_start", &event);
                                yield Ok(Bytes::from(sse));
                                has_sent_message_start = true;
                            }

                            // --- reasoning (thinking) ---
                            if let Some(ref reasoning) = choice.delta.reasoning {
                                if !reasoning.is_empty() {
                                    if current_non_tool_block_type != Some("thinking") {
                                        // 关闭前一个非 tool block
                                        if let Some(idx) = current_non_tool_block_index.take() {
                                            let sse = format_sse("content_block_stop", &json!({"index": idx}));
                                            yield Ok(Bytes::from(sse));
                                        }
                                        // 开始新的 thinking block
                                        let index = next_content_index;
                                        next_content_index += 1;
                                        let event = json!({
                                            "type": "content_block_start",
                                            "index": index,
                                            "content_block": {
                                                "type": "thinking",
                                                "thinking": ""
                                            }
                                        });
                                        let sse = format_sse("content_block_start", &event);
                                        yield Ok(Bytes::from(sse));
                                        current_non_tool_block_type = Some("thinking");
                                        current_non_tool_block_index = Some(index);
                                    }
                                    let index = current_non_tool_block_index.unwrap_or(0);
                                    let event = json!({
                                        "type": "content_block_delta",
                                        "index": index,
                                        "delta": {
                                            "type": "thinking_delta",
                                            "thinking": reasoning
                                        }
                                    });
                                    let sse = format_sse("content_block_delta", &event);
                                    yield Ok(Bytes::from(sse));
                                }
                            }

                            // --- text content ---
                            if let Some(ref content) = choice.delta.content {
                                if !content.is_empty() {
                                    if current_non_tool_block_type != Some("text") {
                                        if let Some(idx) = current_non_tool_block_index.take() {
                                            let sse = format_sse("content_block_stop", &json!({"index": idx}));
                                            yield Ok(Bytes::from(sse));
                                        }
                                        let index = next_content_index;
                                        next_content_index += 1;
                                        let event = json!({
                                            "type": "content_block_start",
                                            "index": index,
                                            "content_block": {
                                                "type": "text",
                                                "text": ""
                                            }
                                        });
                                        let sse = format_sse("content_block_start", &event);
                                        yield Ok(Bytes::from(sse));
                                        current_non_tool_block_type = Some("text");
                                        current_non_tool_block_index = Some(index);
                                    }
                                    let index = current_non_tool_block_index.unwrap_or(0);
                                    let event = json!({
                                        "type": "content_block_delta",
                                        "index": index,
                                        "delta": {
                                            "type": "text_delta",
                                            "text": content
                                        }
                                    });
                                    let sse = format_sse("content_block_delta", &event);
                                    yield Ok(Bytes::from(sse));
                                }
                            }

                            // --- tool calls ---
                            if let Some(ref tool_calls) = choice.delta.tool_calls {
                                for tc in tool_calls {
                                    let state = tool_blocks_by_index.entry(tc.index).or_insert_with(|| {
                                        let anthropic_index = next_content_index;
                                        next_content_index += 1;
                                        ToolBlockState {
                                            anthropic_index,
                                            id: String::new(),
                                            name: String::new(),
                                            started: false,
                                            pending_args: String::new(),
                                        }
                                    });

                                    // 收集 id 和 name
                                    if let Some(ref id) = tc.id {
                                        state.id = id.clone();
                                    }
                                    if let Some(ref func) = tc.function {
                                        if let Some(ref name) = func.name {
                                            state.name = name.clone();
                                        }
                                        if let Some(ref args) = func.arguments {
                                            state.pending_args.push_str(args);
                                        }
                                    }

                                    // 当 id 和 name 都收到后，发出 content_block_start
                                    if !state.started && !state.id.is_empty() && !state.name.is_empty() {
                                        let event = json!({
                                            "type": "content_block_start",
                                            "index": state.anthropic_index,
                                            "content_block": {
                                                "type": "tool_use",
                                                "id": state.id,
                                                "name": state.name,
                                                "input": {}
                                            }
                                        });
                                        let sse = format_sse("content_block_start", &event);
                                        yield Ok(Bytes::from(sse));
                                        state.started = true;
                                    }

                                    // 发出参数 delta
                                    if state.started {
                                        if let Some(ref func) = tc.function {
                                            if let Some(ref args) = func.arguments {
                                                if !args.is_empty() {
                                                    let event = json!({
                                                        "type": "content_block_delta",
                                                        "index": state.anthropic_index,
                                                        "delta": {
                                                            "type": "input_json_delta",
                                                            "partial_json": args
                                                        }
                                                    });
                                                    let sse = format_sse("content_block_delta", &event);
                                                    yield Ok(Bytes::from(sse));
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // --- finish_reason ---
                            if let Some(ref finish_reason) = choice.finish_reason {
                                if !has_emitted_message_delta {
                                    has_emitted_message_delta = true;
                                    let stop_reason = match finish_reason.as_str() {
                                        "stop" => "end_turn",
                                        "length" => "max_tokens",
                                        "tool_calls" => "tool_use",
                                        _ => "end_turn",
                                    };
                                    // 延迟到 [DONE] 发送以确保 usage 完整
                                    pending_message_delta = Some((
                                        Some(stop_reason.to_string()),
                                        chunk_usage_json.clone().or_else(|| latest_usage.clone()),
                                    ));
                                }
                            }
                        } // end line loop
                    } // end SSE block loop
                }
                Err(_) => {
                    // 流错误，发出终止事件
                    if !has_sent_message_stop {
                        // 关闭未关闭的 block
                        if let Some(idx) = current_non_tool_block_index.take() {
                            let sse = format_sse("content_block_stop", &json!({"index": idx}));
                            yield Ok(Bytes::from(sse));
                        }
                        for state in tool_blocks_by_index.values() {
                            if state.started {
                                let sse = format_sse("content_block_stop", &json!({"index": state.anthropic_index}));
                                yield Ok(Bytes::from(sse));
                            }
                        }

                        let sse = format_sse("message_delta", &build_message_delta_event(
                            Some("end_turn".to_string()),
                            latest_usage.clone(),
                        ));
                        yield Ok(Bytes::from(sse));
                        let sse = format_sse("message_stop", &json!({"type": "message_stop"}));
                        yield Ok(Bytes::from(sse));
                        has_sent_message_stop = true;
                    }
                    break;
                }
            }
        } // end while

        // 流正常结束但没有 [DONE]，发出终止事件
        if !has_sent_message_stop {
            // 关闭未关闭的 block
            if let Some(idx) = current_non_tool_block_index.take() {
                let sse = format_sse("content_block_stop", &json!({"index": idx}));
                yield Ok(Bytes::from(sse));
            }
            for state in tool_blocks_by_index.values() {
                if state.started {
                    let sse = format_sse("content_block_stop", &json!({"index": state.anthropic_index}));
                    yield Ok(Bytes::from(sse));
                }
            }

            if let Some((stop_reason, usage_json)) = pending_message_delta.take() {
                let sse = format_sse("message_delta", &build_message_delta_event(stop_reason, usage_json));
                yield Ok(Bytes::from(sse));
            } else {
                let sse = format_sse("message_delta", &build_message_delta_event(
                    Some("end_turn".to_string()),
                    latest_usage.clone(),
                ));
                yield Ok(Bytes::from(sse));
            }
            let sse = format_sse("message_stop", &json!({"type": "message_stop"}));
            yield Ok(Bytes::from(sse));
        }

        tracing::info!(
            "[SSE] 流转换完成: chunks={}, message_stop={}",
            chunk_count,
            has_sent_message_stop
        );
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 格式化 Anthropic SSE 事件
fn format_sse(event_type: &str, data: &Value) -> String {
    format!(
        "event: {}\ndata: {}\n\n",
        event_type,
        serde_json::to_string(data).unwrap_or_default()
    )
}

/// 从 OpenAI usage 构建 Anthropic usage JSON
fn build_anthropic_usage(usage: &super::models::OpenAIUsage) -> Value {
    let mut usage_json = json!({
        "input_tokens": usage.prompt_tokens,
        "output_tokens": usage.completion_tokens
    });
    if let Some(cached) = usage
        .prompt_tokens_details
        .as_ref()
        .map(|d| d.cached_tokens)
        .filter(|&v| v > 0)
    {
        usage_json["cache_read_input_tokens"] = json!(cached);
    }
    usage_json
}

/// 构建 message_start 事件中的 usage
fn build_start_usage(usage: Option<&super::models::OpenAIUsage>) -> Value {
    let mut start_usage = json!({
        "input_tokens": 0,
        "output_tokens": 0
    });
    if let Some(u) = usage {
        start_usage["input_tokens"] = json!(u.prompt_tokens);
        if let Some(cached) = u
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .filter(|&v| v > 0)
        {
            start_usage["cache_read_input_tokens"] = json!(cached);
        }
    }
    start_usage
}

/// 构建 message_delta 事件
fn build_message_delta_event(stop_reason: Option<String>, usage_json: Option<Value>) -> Value {
    let usage = usage_json.unwrap_or_else(|| {
        json!({"input_tokens": 0, "output_tokens": 0})
    });
    json!({
        "type": "message_delta",
        "delta": {
            "stop_reason": stop_reason,
            "stop_sequence": null
        },
        "usage": usage
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::proxy::models::OpenAIStreamChunk;

    #[test]
    fn test_parse_agnes_normal_chunk() {
        // agnes API 正常 chunk（空 content）
        let data = r#"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#;
        let result = serde_json::from_str::<OpenAIStreamChunk>(data);
        assert!(result.is_ok(), "Failed to parse: {:?}", result.err());
        let chunk = result.unwrap();
        assert_eq!(chunk.choices.len(), 1);
        assert_eq!(chunk.choices[0].delta.content, Some("".to_string()));
    }

    #[test]
    fn test_parse_agnes_text_chunk() {
        // agnes API 文本 chunk
        let data = r#"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{"content":"Hi"}}]}"#;
        let result = serde_json::from_str::<OpenAIStreamChunk>(data);
        assert!(result.is_ok(), "Failed to parse: {:?}", result.err());
        let chunk = result.unwrap();
        assert_eq!(chunk.choices[0].delta.content, Some("Hi".to_string()));
    }

    #[test]
    fn test_parse_agnes_usage_chunk() {
        // agnes API usage chunk — choices 为空数组！
        let data = r#"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","system_fingerprint":"","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":0,"text_tokens":0},"input_tokens":0,"output_tokens":0}}"#;
        let result = serde_json::from_str::<OpenAIStreamChunk>(data);
        assert!(result.is_ok(), "Failed to parse usage chunk: {:?}", result.err());
        let chunk = result.unwrap();
        assert_eq!(chunk.choices.len(), 0);
        assert!(chunk.usage.is_some());
        assert_eq!(chunk.usage.as_ref().unwrap().prompt_tokens, 10);
    }

    #[test]
    fn test_parse_agnes_finish_chunk() {
        // agnes API finish chunk
        let data = r#"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let result = serde_json::from_str::<OpenAIStreamChunk>(data);
        assert!(result.is_ok(), "Failed to parse: {:?}", result.err());
        let chunk = result.unwrap();
        assert_eq!(chunk.choices[0].finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn test_parse_agnes_real_response() {
        // 完整的 agnes API 流式响应
        let lines = vec![
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{"content":"Hi"}}]}"#,
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{"content":"!"}}]}"#,
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1780682244,"model":"agnes-2.0-flash","system_fingerprint":"","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":0,"text_tokens":0},"input_tokens":0,"output_tokens":0}}"#,
        ];

        let mut parsed_count = 0;
        for line in &lines {
            if let Some(data) = strip_sse_field(line, "data") {
                if data.trim() == "[DONE]" {
                    continue;
                }
                let result = serde_json::from_str::<OpenAIStreamChunk>(data);
                match result {
                    Ok(_) => parsed_count += 1,
                    Err(e) => panic!("Failed to parse chunk: {}\nData: {}", e, data),
                }
            }
        }
        assert_eq!(parsed_count, 5, "Expected 5 chunks to parse successfully");
    }
}
