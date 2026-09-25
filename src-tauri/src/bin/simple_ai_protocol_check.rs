//! 独立验证 simple_ai_protocol 的 usage/模型解析（绕过 Tauri DLL 限制）。
//! 与库内 `#[cfg(test)]` 断言保持一致：本二进制仅做运行时验证，不参与交付。
use serde_json::{json, Value};

#[path = "../ai/engine/simple_ai_protocol.rs"]
mod simple_ai_protocol;

use simple_ai_protocol::{StreamState, WireProtocol};

fn main() {
    let mut failures = 0;

    // OpenAIChat：缓存读取 + 缓存写入 + 响应侧实际模型。
    let mut s = StreamState::new(WireProtocol::OpenAIChat);
    s.feed(&json!({
        "model": "deepseek-v4-real",
        "choices": [],
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 30,
            "total_tokens": 150,
            "prompt_tokens_details": { "cached_tokens": 80 }
        }
    }));
    let u = s.finish_usage().expect("openai usage");
    assert_eq!(u.input_tokens, 120, "openai input");
    assert_eq!(u.output_tokens, 30, "openai output");
    assert_eq!(u.cache_read, 80, "openai cache_read");
    assert_eq!(u.cache_creation, 0, "openai cache_creation default 0");
    assert_eq!(
        s.finish_actual_model().as_deref(),
        Some("deepseek-v4-real"),
        "openai actual model"
    );

    // OpenAIChat：DeepSeek/openrouter 变体 prompt_cache_hit/miss_tokens。
    let mut s = StreamState::new(WireProtocol::OpenAIChat);
    s.feed(&json!({
        "choices": [],
        "usage": {
            "prompt_tokens": 200,
            "completion_tokens": 40,
            "total_tokens": 240,
            "prompt_cache_hit_tokens": 150,
            "prompt_cache_miss_tokens": 50
        }
    }));
    let u = s.finish_usage().expect("deepseek usage");
    assert_eq!(u.cache_read, 150, "deepseek cache_read");
    assert_eq!(u.cache_creation, 50, "deepseek cache_creation");

    // Anthropic：start 携带 input + 缓存 + 模型；delta 携带 output。
    let mut s = StreamState::new(WireProtocol::Anthropic);
    s.feed(&json!({
        "type": "message_start",
        "message": {
            "model": "claude-sonnet-real",
            "usage": {
                "input_tokens": 200,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 60
            }
        }
    }));
    s.feed(&json!({
        "type": "message_delta",
        "usage": { "output_tokens": 80 }
    }));
    let u = s.finish_usage().expect("anthropic usage");
    assert_eq!(u.input_tokens, 200, "anthropic input");
    assert_eq!(u.output_tokens, 80, "anthropic output");
    assert_eq!(u.total_tokens, 280, "anthropic total");
    assert_eq!(u.cache_creation, 100, "anthropic cache_creation");
    assert_eq!(u.cache_read, 60, "anthropic cache_read");
    assert_eq!(
        s.finish_actual_model().as_deref(),
        Some("claude-sonnet-real"),
        "anthropic actual model"
    );

    // Anthropic：缓存字段按需省略时保持 0（不出现字段的场景）。
    let mut s = StreamState::new(WireProtocol::Anthropic);
    s.feed(&json!({ "type": "message_start", "message": { "usage": { "input_tokens": 50 } } }));
    s.feed(&json!({ "type": "message_delta", "usage": { "output_tokens": 10 } }));
    let u = s.finish_usage().expect("anthropic no-cache usage");
    assert_eq!(u.cache_read, 0, "anthropic cache_read omitted -> 0");
    assert_eq!(u.cache_creation, 0, "anthropic cache_creation omitted -> 0");

    // Responses：缓存读取 + 实际模型。
    let mut s = StreamState::new(WireProtocol::Responses);
    s.feed(&json!({
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
    }));
    let u = s.finish_usage().expect("responses usage");
    assert_eq!(u.cache_read, 30, "responses cache_read");
    assert_eq!(u.cache_creation, 0, "responses cache_creation default 0");
    assert_eq!(
        s.finish_actual_model().as_deref(),
        Some("o4-mini-real"),
        "responses actual model"
    );

    // 无 usage 的流（纯文本/无 usage 末包）：finish_usage 为 None，模型仍可取。
    let mut s = StreamState::new(WireProtocol::OpenAIChat);
    s.feed(&json!({ "choices": [{ "delta": { "content": "hi" } }] }));
    assert!(s.finish_usage().is_none(), "no usage -> None");
    assert!(s.finish_actual_model().is_none(), "no model -> None");

    if failures > 0 {
        eprintln!("{} 项断言失败", failures);
        std::process::exit(1);
    }
    println!("simple_ai_protocol usage/cache/model 解析验证通过 (7 组)");
}
