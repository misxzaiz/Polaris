//! SimpleAI 上游协议层（K-R1 目录化拆分；原 1,967 行单文件）
//!
//! 对外路径 `ai::engine::simple_ai_protocol::*` 经 `pub use` 保持不变
//!（消费方：simple_ai/{chat_loop,compact} 与 simple_ai_protocol_check bin）。

mod anthropic;
mod openai;
mod request;
mod responses;
mod stream;
mod tools;
mod types;
mod wire;

pub use openai::build_openai_chat_body;
pub use request::{build_request_body, build_request_body_with_env};
pub use responses::build_responses_body;
pub use stream::{StreamDelta, StreamState, Usage};
pub use tools::tools_for_protocol;
pub use types::{CliModelSuffix, strip_cli_model_suffix};
pub use wire::WireProtocol;

#[cfg(test)]
mod tests {
    pub use super::stream::*;
    use super::wire::WireProtocol;
    use serde_json::{json, Value};
    use super::request::count_cache_breakpoints;


    use super::super::types::*;
    use super::wire::*;
    use super::request::*;
    use super::tools::*;
    use serde_json::json;

    fn sample_tools() -> Vec<Value> {
        vec![json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a shell command",
                "parameters": {
                    "type": "object",
                    "properties": { "command": { "type": "string" } },
                    "required": ["command"]
                }
            }
        })]
    }

    // ------------------------------------------------------------------
    // 提示词缓存断点（apply_cache_breakpoints）
    // ------------------------------------------------------------------

    fn env_with(k: &str, v: &str) -> Option<HashMap<String, String>> {
        let mut m = HashMap::new();
        m.insert(k.to_string(), v.to_string());
        Some(m)
    }

    #[test]
    fn cache_breakpoints_applied_on_three_locations() {
        let messages = vec![
            json!({ "role": "system", "content": "sys prompt" }),
            json!({ "role": "user", "content": "question" }),
        ];
        let body = build_request_body_with_env(
            WireProtocol::Anthropic,
            "claude-x",
            &messages,
            &sample_tools(),
            None,
            None,
            &None, // custom_env 缺省 = 断点开启
        );

        // system：字符串 → block 数组 + 断点
        let sys = body["system"].as_array().expect("system 应为数组");
        assert_eq!(sys.len(), 1);
        assert_eq!(sys[0]["type"], "text");
        assert_eq!(sys[0]["text"], "sys prompt");
        assert_eq!(sys[0]["cache_control"], json!({ "type": "ephemeral" }));

        // tools 末尾：断点
        let tools = body["tools"].as_array().expect("tools 应存在");
        assert!(tools.len() == 1);
        assert_eq!(tools[0]["cache_control"], json!({ "type": "ephemeral" }));

        // 最后一条 user（纯字符串 content → block 数组 + 断点）
        let msgs = body["messages"].as_array().unwrap();
        let last = msgs.last().unwrap();
        let c = last["content"].as_array().expect("user content 应为数组");
        assert_eq!(c[0]["type"], "text");
        assert_eq!(c[0]["text"], "question");
        assert_eq!(c[0]["cache_control"], json!({ "type": "ephemeral" }));

        // 总数 ≤ 3
        assert!(
            count_cache_breakpoints(&body) <= CACHE_BREAKPOINT_LIMIT,
            "断点数 {} 超过上限 {}",
            count_cache_breakpoints(&body),
            CACHE_BREAKPOINT_LIMIT
        );
    }

    #[test]
    fn cache_breakpoint_on_user_with_tool_result_blocks() {
        // tool_result 合并后的 user(content=[block]) 形态：断点挂到最后一个 block。
        let messages = vec![
            json!({ "role": "tool", "tool_call_id": "t1", "content": "result" }),
            json!({ "role": "user", "content": "follow-up" }),
        ];
        let body = build_request_body_with_env(
            WireProtocol::Anthropic, "m", &messages, &[], None, None, &None,
        );
        let msgs = body["messages"].as_array().unwrap();
        let arr = msgs[0]["content"].as_array().unwrap();
        // 断点落在最后一个 block（text 的 follow-up），而非 tool_result。
        assert!(arr[0].get("cache_control").is_none(), "tool_result 不应带断点");
        assert_eq!(arr[1]["type"], "text");
        assert_eq!(arr[1]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(count_cache_breakpoints(&body), 1);
    }

    #[test]
    fn cache_breakpoints_disabled_via_custom_env() {
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        let body = build_request_body_with_env(
            WireProtocol::Anthropic,
            "m",
            &messages,
            &sample_tools(),
            None,
            None,
            &env_with("SIMPLE_AI_CACHE_CONTROL", "false"),
        );
        // system 保持字符串形态，三处断点均不出现
        assert_eq!(body["system"], "sys");
        assert!(body["tools"][0].get("cache_control").is_none());
        assert!(body["messages"][0]["content"].as_str().is_some());
        assert_eq!(count_cache_breakpoints(&body), 0);
    }

    #[test]
    fn cache_breakpoints_default_enabled_when_env_missing_or_invalid() {
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        for env in [
            None,
            Some(HashMap::new()),
            env_with("SIMPLE_AI_CACHE_CONTROL", "true"),
            env_with("SIMPLE_AI_CACHE_CONTROL", "yes"), // 非法值 → 回退默认（开启）
            env_with("OTHER_KEY", "false"),
        ] {
            let body = build_request_body_with_env(
                WireProtocol::Anthropic, "m", &messages, &sample_tools(), None, None, &env,
            );
            assert_eq!(
                count_cache_breakpoints(&body), 3,
                "env={env:?} 应默认开启断点"
            );
        }
    }

    #[test]
    fn cache_breakpoints_ignored_for_non_anthropic_protocols() {
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        for protocol in [WireProtocol::OpenAIChat, WireProtocol::Responses] {
            let body = build_request_body_with_env(
                protocol, "m", &messages, &sample_tools(), None, None, &None,
            );
            assert_eq!(
                count_cache_breakpoints(&body), 0,
                "{protocol:?} 不应注入 Anthropic 专有断点"
            );
        }
    }

    #[test]
    fn cache_breakpoints_are_idempotent() {
        // 二次注入不得重复挂断点（compact 等非典型路径可能多次经过）。
        let mut body = build_request_body_with_env(
            WireProtocol::Anthropic, "m",
            &[json!({ "role": "user", "content": "hi" })],
            &sample_tools(), None, None, &None,
        );
        let before = count_cache_breakpoints(&body);
        apply_cache_breakpoints(&mut body, WireProtocol::Anthropic, &None);
        assert_eq!(count_cache_breakpoints(&body), before, "重复注入应被忽略");
    }

    #[test]
    fn compact_style_body_keeps_only_system_and_tail_breakpoints() {
        // 复现 compact 路径：无工具、末尾 user 携带历史摘要文本。
        let messages = vec![
            json!({ "role": "system", "content": "You are compacting a conversation history." }),
            json!({ "role": "user", "content": "history to summarize" }),
        ];
        let body = build_request_body_with_env(
            WireProtocol::Anthropic, "m", &messages, &[], None, None, &None,
        );
        // 空工具 → 只有 system 与末尾 user 两处
        assert_eq!(count_cache_breakpoints(&body), 2);
    }

    #[test]
    fn openai_chat_usage_parsed_from_final_chunk() {
        let mut s = StreamState::new(WireProtocol::OpenAIChat);
        let chunk = json!({
            "model": "deepseek-v4-real",
            "choices": [],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "total_tokens": 150,
                "prompt_tokens_details": { "cached_tokens": 80 }
            }
        });
        let _ = s.feed(&chunk);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.total_tokens, 150);
        assert_eq!(usage.cache_read, 80);
        assert_eq!(usage.cache_creation, 0);
        // 响应侧实际模型（OpenAI 顶层层 model）。
        assert_eq!(s.finish_actual_model().as_deref(), Some("deepseek-v4-real"));
    }

    #[test]
    fn openai_chat_usage_parses_deepseek_cache_variants() {
        // DeepSeek openrouter 风格：缓存读取在 prompt_cache_hit_tokens，
        // 缓存写入在 prompt_cache_miss_tokens。
        let mut s = StreamState::new(WireProtocol::OpenAIChat);
        let chunk = json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 200,
                "completion_tokens": 40,
                "total_tokens": 240,
                "prompt_cache_hit_tokens": 150,
                "prompt_cache_miss_tokens": 50
            }
        });
        let _ = s.feed(&chunk);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.cache_read, 150);
        assert_eq!(usage.cache_creation, 50);
    }

    #[test]
    fn anthropic_usage_accumulated_across_messages() {
        let mut s = StreamState::new(WireProtocol::Anthropic);
        // message_start 携带 input_tokens 与缓存明细、实际模型。
        let start = json!({
            "type": "message_start",
            "message": {
                "model": "claude-sonnet-real",
                "usage": {
                    "input_tokens": 200,
                    "cache_creation_input_tokens": 100,
                    "cache_read_input_tokens": 60
                }
            }
        });
        let _ = s.feed(&start);
        let mid = s.finish_usage().expect("usage after start");
        assert_eq!(mid.input_tokens, 200);
        assert_eq!(mid.output_tokens, 0);
        assert_eq!(mid.cache_creation, 100);
        assert_eq!(mid.cache_read, 60);
        assert_eq!(s.finish_actual_model().as_deref(), Some("claude-sonnet-real"));

        // message_delta 携带 output_tokens；total 由二者相加。
        let delta = json!({
            "type": "message_delta",
            "usage": { "output_tokens": 80 }
        });
        let _ = s.feed(&delta);
        let final_usage = s.finish_usage().expect("usage after delta");
        assert_eq!(final_usage.input_tokens, 200);
        assert_eq!(final_usage.output_tokens, 80);
        assert_eq!(final_usage.total_tokens, 280);
        assert_eq!(final_usage.cache_creation, 100);
        assert_eq!(final_usage.cache_read, 60);
    }

    #[test]
    fn anthropic_delta_input_tokens_overrides_start_estimate() {
        // 实测 CLIProxyAPI→sensenova 链路：message_start.usage.input_tokens 为
        // 预估/未结算值（41087），message_delta.usage 回带修正后的 input_tokens
        // （167）与 cache_read。若不覆盖，167 的真实未命中会被记成 41087，
        // 命中率从 99.6% 失真为 ~52%
        // （见 docs/simpleai-prompt-cache-breakpoints-plan.md §9）。
        let mut s = StreamState::new(WireProtocol::Anthropic);
        let start = json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 41087 } }
        });
        let _ = s.feed(&start);
        let delta = json!({
            "type": "message_delta",
            "usage": {
                "input_tokens": 167,
                "output_tokens": 64,
                "cache_read_input_tokens": 45312
            }
        });
        let _ = s.feed(&delta);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.input_tokens, 167);
        assert_eq!(usage.output_tokens, 64);
        assert_eq!(usage.cache_read, 45312);
        assert_eq!(usage.total_tokens, 231);
    }

    #[test]
    fn responses_usage_parsed_from_completed_event() {
        let mut s = StreamState::new(WireProtocol::Responses);
        let chunk = json!({
            "type": "response.completed",
            "response": {
                "model": "o4-mini-real",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 25,
                    "total_tokens": 75,
                    "input_tokens_details": { "cached_tokens": 30 }
                }
            }
        });
        let _ = s.feed(&chunk);
        let usage = s.finish_usage().expect("usage");
        assert_eq!(usage.input_tokens, 50);
        assert_eq!(usage.output_tokens, 25);
        assert_eq!(usage.total_tokens, 75);
        assert_eq!(usage.cache_read, 30);
        assert_eq!(usage.cache_creation, 0);
        // 响应侧实际模型（Responses response.model）。
        assert_eq!(s.finish_actual_model().as_deref(), Some("o4-mini-real"));
    }

    #[test]
    fn from_wire_api_defaults_to_anthropic() {
        assert_eq!(WireProtocol::from_wire_api(None), WireProtocol::Anthropic);
        assert_eq!(
            WireProtocol::from_wire_api(Some("anthropic-messages")),
            WireProtocol::Anthropic
        );
        assert_eq!(
            WireProtocol::from_wire_api(Some("openai-chat-completions")),
            WireProtocol::OpenAIChat
        );
        assert_eq!(
            WireProtocol::from_wire_api(Some("openai-responses")),
            WireProtocol::Responses
        );
    }

    #[test]
    fn build_url_completes_suffix() {
        assert_eq!(
            WireProtocol::OpenAIChat.build_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            WireProtocol::OpenAIChat.build_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            WireProtocol::Anthropic.build_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            WireProtocol::Responses.build_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn auth_headers_per_protocol() {
        assert_eq!(
            WireProtocol::Anthropic.auth_headers("k"),
            vec![
                ("x-api-key".to_string(), "k".to_string()),
                ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
            ]
        );
        assert_eq!(
            WireProtocol::OpenAIChat.auth_headers("k"),
            vec![("Authorization".to_string(), "Bearer k".to_string())]
        );
        assert!(WireProtocol::OpenAIChat.auth_headers("").is_empty());
    }

    #[test]
    fn tools_convert_to_anthropic_input_schema() {
        let tools = tools_for_protocol(WireProtocol::Anthropic, &sample_tools());
        assert_eq!(tools[0]["name"], "bash");
        assert_eq!(tools[0]["input_schema"]["properties"]["command"]["type"], "string");
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn tools_convert_to_responses_flat() {
        let tools = tools_for_protocol(WireProtocol::Responses, &sample_tools());
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "bash");
        assert!(tools[0].get("parameters").is_some());
    }

    #[test]
    fn anthropic_body_splits_system_and_converts_tool_roundtrip() {
        let messages = vec![
            json!({ "role": "system", "content": "You are helpful" }),
            json!({ "role": "user", "content": "run ls" }),
            json!({
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{
                    "id": "toolu_1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "toolu_1", "content": "file.txt" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &sample_tools(), None, None);

        assert_eq!(body["system"], "You are helpful");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        let msgs = body["messages"].as_array().unwrap();
        // system 不在 messages 中：user / assistant / user(tool_result)
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][1]["id"], "toolu_1");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "toolu_1");
    }

    #[test]
    fn responses_body_uses_instructions_and_function_items() {
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "done" }),
        ];
        let body = build_request_body(WireProtocol::Responses, "gpt-x", &messages, &sample_tools(), None, None);

        assert_eq!(body["instructions"], "sys");
        assert_eq!(body["max_output_tokens"], DEFAULT_MAX_TOKENS);
        let input = body["input"].as_array().unwrap();
        assert!(input.iter().any(|i| i["type"] == "function_call" && i["call_id"] == "call_1"));
        assert!(input
            .iter()
            .any(|i| i["type"] == "function_call_output" && i["call_id"] == "call_1"));
    }

    #[test]
    fn openai_chat_stream_parses_text_and_tool_calls() {
        let mut state = StreamState::new(WireProtocol::OpenAIChat);
        let d1 = state.feed(&json!({ "choices": [{ "delta": { "content": "Hel" } }] }));
        assert_eq!(d1, vec![StreamDelta::Text("Hel".to_string())]);
        state.feed(&json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "id": "c1", "function": { "name": "bash", "arguments": "{\"cmd" }
        }] } }] }));
        state.feed(&json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "\":\"ls\"}" }
        }] } }] }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn anthropic_stream_parses_text_thinking_and_tool_use() {
        let mut state = StreamState::new(WireProtocol::Anthropic);
        let txt = state.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" }
        }));
        assert_eq!(txt, vec![StreamDelta::Text("Hi".to_string())]);

        let think = state.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "hmm" }
        }));
        assert_eq!(think, vec![StreamDelta::Thinking("hmm".to_string())]);

        state.feed(&json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_9", "name": "bash" }
        }));
        state.feed(&json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}" }
        }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["id"], "toolu_9");
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"command\":\"ls\"}");
    }

    #[test]
    fn responses_stream_parses_text_and_function_call() {
        let mut state = StreamState::new(WireProtocol::Responses);
        let txt = state.feed(&json!({ "type": "response.output_text.delta", "delta": "Yo" }));
        assert_eq!(txt, vec![StreamDelta::Text("Yo".to_string())]);

        state.feed(&json!({
            "type": "response.output_item.added",
            "item": { "type": "function_call", "id": "item_1", "call_id": "call_7", "name": "bash" }
        }));
        state.feed(&json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "item_1",
            "delta": "{\"command\":\"pwd\"}"
        }));
        let tcs = state.finish_tool_calls();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0]["id"], "call_7");
        assert_eq!(tcs[0]["function"]["name"], "bash");
        assert_eq!(tcs[0]["function"]["arguments"], "{\"command\":\"pwd\"}");
    }

    #[test]
    fn anthropic_body_merges_consecutive_user_messages() {
        // SimpleAI 首轮注入 environment_context + 项目指令 + 用户消息，连续三条 user。
        // Anthropic 要求 user/assistant 交替，故应合并为单条 user。
        let messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "<environment_context>cwd</environment_context>" }),
            json!({ "role": "user", "content": "# Project instructions\nrules" }),
            json!({ "role": "user", "content": "actual question" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &[], None, None);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        let c = msgs[0]["content"].as_str().unwrap();
        assert!(c.contains("environment_context"));
        assert!(c.contains("Project instructions"));
        assert!(c.contains("actual question"));
    }

    #[test]
    fn anthropic_body_appends_user_text_after_tool_result() {
        // tool_result 产生 user(content=[block])；随后的 user 文本应作为 text block 追加。
        let messages = vec![
            json!({ "role": "tool", "tool_call_id": "t1", "content": "result" }),
            json!({ "role": "user", "content": "follow-up" }),
        ];
        let body = build_request_body(WireProtocol::Anthropic, "claude-x", &messages, &[], None, None);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        let arr = msgs[0]["content"].as_array().unwrap();
        assert_eq!(arr[0]["type"], "tool_result");
        assert_eq!(arr[1]["type"], "text");
        assert_eq!(arr[1]["text"], "follow-up");
    }

    #[test]
    fn openai_chat_thinking_falls_back_to_reasoning_field() {
        // SenseNova / OpenRouter / xAI 风格：思考在 delta.reasoning 而非 reasoning_content。
        let mut state = StreamState::new(WireProtocol::OpenAIChat);
        let d = state.feed(&json!({ "choices": [{ "delta": { "reasoning": "think..." } }] }));
        assert_eq!(d, vec![StreamDelta::Thinking("think...".to_string())]);
        // thinking 变体。
        let d = state.feed(&json!({ "choices": [{ "delta": { "thinking": "more" } }] }));
        assert_eq!(d, vec![StreamDelta::Thinking("more".to_string())]);
        // reasoning_content 优先级最高，且不重复推送其他字段。
        let d = state.feed(&json!({ "choices": [{ "delta": {
            "reasoning_content": "primary", "reasoning": "ignored"
        } }] }));
        assert_eq!(d, vec![StreamDelta::Thinking("primary".to_string())]);
        // 对象型 reasoning 变体安全跳过。
        let d = state.feed(&json!({ "choices": [{ "delta": { "reasoning": {"detail": 1} } }] }));
        assert!(d.is_empty());
    }

    #[test]
    fn openai_chat_content_parts_array_concatenated() {
        let mut state = StreamState::new(WireProtocol::OpenAIChat);
        let d = state.feed(&json!({ "choices": [{ "delta": { "content": [
            { "type": "text", "text": "a" },
            { "type": "text", "text": "b" }
        ] } }] }));
        assert_eq!(
            d,
            vec![
                StreamDelta::Text("a".to_string()),
                StreamDelta::Text("b".to_string())
            ]
        );
    }

    #[test]
    fn openai_chat_records_finish_reason() {
        let mut state = StreamState::new(WireProtocol::OpenAIChat);
        assert!(state.finish_reason().is_none());
        state.feed(&json!({ "choices": [{ "delta": {}, "finish_reason": "length" }] }));
        assert_eq!(state.finish_reason(), Some("length"));
    }

    #[test]
    fn anthropic_stop_reason_normalized() {
        let mut state = StreamState::new(WireProtocol::Anthropic);
        state.feed(&json!({
            "type": "message_delta",
            "delta": { "stop_reason": "max_tokens" },
            "usage": { "output_tokens": 5 }
        }));
        assert_eq!(state.finish_reason(), Some("length"));
    }

    #[test]
    fn responses_incomplete_normalized_to_length() {
        let mut state = StreamState::new(WireProtocol::Responses);
        state.feed(&json!({
            "type": "response.incomplete",
            "response": { "incomplete_details": { "reason": "max_output_tokens" } }
        }));
        assert_eq!(state.finish_reason(), Some("length"));
    }

    #[test]
    fn max_tokens_injection_per_protocol() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        // OpenAIChat：None 不发，Some 显式携带。
        let body = build_request_body(WireProtocol::OpenAIChat, "m", &messages, &[], None, None);
        assert!(body.get("max_tokens").is_none());
        let body = build_request_body(WireProtocol::OpenAIChat, "m", &messages, &[], Some(16384), None);
        assert_eq!(body["max_tokens"], 16384);
        // Anthropic：None 回退默认，Some 覆盖。
        let body = build_request_body(WireProtocol::Anthropic, "m", &messages, &[], Some(4096), None);
        assert_eq!(body["max_tokens"], 4096);
        // Responses：Some 覆盖 max_output_tokens。
        let body = build_request_body(WireProtocol::Responses, "m", &messages, &[], Some(2048), None);
        assert_eq!(body["max_output_tokens"], 2048);
    }

    #[test]
    fn effort_injected_per_protocol() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        // OpenAIChat：effort → reasoning_effort。
        let body = build_request_body(WireProtocol::OpenAIChat, "m", &messages, &[], None, Some("high"));
        assert_eq!(body["reasoning_effort"], "high");
        // Anthropic：effort → thinking.budget_tokens（随级别缩放）。
        let body = build_request_body(WireProtocol::Anthropic, "m", &messages, &[], None, Some("high"));
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 16000);
        let body_low = build_request_body(WireProtocol::Anthropic, "m", &messages, &[], None, Some("low"));
        assert_eq!(body_low["thinking"]["budget_tokens"], 2048);
        // Responses：effort → reasoning.effort。
        let body = build_request_body(WireProtocol::Responses, "m", &messages, &[], None, Some("medium"));
        assert_eq!(body["reasoning"]["effort"], "medium");
        // None / 空串：不注入思考参数。
        let body = build_request_body(WireProtocol::OpenAIChat, "m", &messages, &[], None, None);
        assert!(body.get("reasoning_effort").is_none());
        let body = build_request_body(WireProtocol::OpenAIChat, "m", &messages, &[], None, Some(""));
        assert!(body.get("reasoning_effort").is_none());
        let body = build_request_body(WireProtocol::Anthropic, "m", &messages, &[], None, None);
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn strip_cli_model_suffix_no_suffix() {
        let s = strip_cli_model_suffix("claude-fable-5");
        assert_eq!(s.base_model, Some("claude-fable-5".to_string()));
        assert!(s.beta_tokens.is_none());
        assert!(s.query.is_none());

        let s = strip_cli_model_suffix("glm-5.2");
        assert_eq!(s.base_model, Some("glm-5.2".to_string()));
        assert!(s.beta_tokens.is_none());

        let s = strip_cli_model_suffix("deepseek-v3");
        assert_eq!(s.base_model, Some("deepseek-v3".to_string()));
    }

    #[test]
    fn strip_cli_model_suffix_1m_yields_beta() {
        let s = strip_cli_model_suffix("claude-fable-5[1m]");
        assert_eq!(s.base_model, Some("claude-fable-5".to_string()));
        assert!(s.beta_tokens.is_some());
        assert!(s.beta_tokens.as_ref().unwrap().contains(&"context-1m-2025-08-07".to_string()));
        assert!(s.query.is_some());
        assert_eq!(s.query.as_ref().unwrap(), "beta=true");
        assert_eq!(s.context_window, Some(1_000_000));
    }

    #[test]
    fn strip_cli_model_suffix_k_m_units_yield_window() {
        // 大小写不敏感的单位后缀：仅窗口信号，不注入 beta。
        let s = strip_cli_model_suffix("claude-4[200k]");
        assert_eq!(s.base_model, Some("claude-4".to_string()));
        assert!(s.beta_tokens.is_none());
        assert!(s.query.is_none());
        assert_eq!(s.context_window, Some(200_000));

        let s = strip_cli_model_suffix("claude-4[200K]");
        assert_eq!(s.context_window, Some(200_000));

        let s = strip_cli_model_suffix("claude-4[1M]");
        assert_eq!(s.base_model, Some("claude-4".to_string()));
        assert!(s.beta_tokens.is_none());
        assert_eq!(s.context_window, Some(1_000_000));
    }

    #[test]
    fn strip_cli_model_suffix_pure_number_and_decimal() {
        // 纯数值后缀：原值。
        let s = strip_cli_model_suffix("model-x[128000]");
        assert_eq!(s.base_model, Some("model-x".to_string()));
        assert!(s.beta_tokens.is_none());
        assert_eq!(s.context_window, Some(128_000));

        // 小数 + 单位：四舍五入。
        let s = strip_cli_model_suffix("model-x[0.2m]");
        assert_eq!(s.context_window, Some(200_000));
        let s = strip_cli_model_suffix("model-x[1.5k]");
        assert_eq!(s.context_window, Some(1500));
    }

    #[test]
    fn strip_cli_model_suffix_unparseable_window_none() {
        // 不可解析后缀：仅剥离，窗口信号为 None（现状不变）。
        for model in [
            "glm-5.2[1m]",     // 可解析（1M），见下
            "gpt-4o[thinking]",
            "gpt-4o[128000m]",
        ] {
            let s = strip_cli_model_suffix(model);
            assert!(s.base_model.is_some());
        }
        let s = strip_cli_model_suffix("gpt-4o[thinking]");
        assert_eq!(s.context_window, None);
        let s = strip_cli_model_suffix("gpt-4o[0]");
        assert_eq!(s.context_window, None);
        let s = strip_cli_model_suffix("gpt-4o[1000000m]");
        assert_eq!(s.context_window, None); // 超上限 16M
    }

    #[test]
    fn strip_cli_model_suffix_unknown_suffix_stripped_but_no_beta() {
        // 未知后缀（如从 CLI 复制的 glm-5.2[1m]）：剥离；[1m] 仍注入 beta（现状）。
        let s = strip_cli_model_suffix("glm-5.2[1m]");
        assert_eq!(s.base_model, Some("glm-5.2".to_string()));
        assert!(s.beta_tokens.is_some());
        assert!(s.query.is_some());
        assert_eq!(s.context_window, Some(1_000_000));

        let s = strip_cli_model_suffix("gpt-4o[thinking]");
        assert_eq!(s.base_model, Some("gpt-4o".to_string()));
        assert!(s.beta_tokens.is_none());
        assert!(s.context_window.is_none());
    }

    #[test]
    fn strip_cli_model_suffix_malformed() {
        // 空 base（仅后缀）：保守返回原样，不剥离。
        let s = strip_cli_model_suffix("[1m]");
        assert_eq!(s.base_model, Some("[1m]".to_string()));
        assert!(s.beta_tokens.is_none());
        assert!(s.context_window.is_none());

        let s = strip_cli_model_suffix("model[");
        assert_eq!(s.base_model, Some("model".to_string()));
        assert!(s.beta_tokens.is_none());
    }

    #[test]
    fn strip_cli_model_suffix_trims_trailing_space_before_bracket() {
        let s = strip_cli_model_suffix("claude-fable-5 [1m]");
        assert_eq!(s.base_model, Some("claude-fable-5".to_string()));
        assert!(s.beta_tokens.is_some());
        assert_eq!(s.context_window, Some(1_000_000));
    }
}
