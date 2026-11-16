//! build_request_body 与 thinking/cache 注入（K-R1 拆分）

use std::collections::HashMap;
use super::openai::build_openai_chat_body;
use super::anthropic::build_anthropic_body;
use super::responses::build_responses_body;
use serde_json::{json, Value};
use super::wire::WireProtocol;

/// 默认 max_tokens（Anthropic 必填、Responses 建议填）。
pub const DEFAULT_MAX_TOKENS: u64 = 8192;

/// 本方案实际放置的断点数量上限。Anthropic 硬性上限为 4，留 1 个余量。
pub const CACHE_BREAKPOINT_LIMIT: usize = 3;
// ============================================================================
// 请求体构建（内部 OpenAI messages → 目标协议请求体）
// ============================================================================

/// 构建流式请求体（`stream` 字段已内置为 `true`）。
///
/// `max_tokens`：单次输出上限（来自 ModelProfile.max_tokens 或调用方显式指定）。
/// - `None`：OpenAIChat 不发该字段（供应商默认）；Anthropic/Responses 回退 `DEFAULT_MAX_TOKENS`。
/// - `Some(v)`：三协议均显式携带（OpenAIChat=`max_tokens`，Responses=`max_output_tokens`）。
///
/// `effort`：思考努力级别（来自前端状态栏 effort 选择，经 SessionOptions.effort 透传）。
/// - `None` / 空串：不发思考参数，使用供应商/模型默认。
/// - `Some(v)`：按线路协议映射——
///   - OpenAIChat → 顶层 `reasoning_effort`
///   - Anthropic → `thinking: { type: "enabled", budget_tokens: N }`（budget 随级别缩放）
///   - Responses → `reasoning: { effort }`
pub fn build_request_body(
    protocol: WireProtocol,
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
    max_tokens: Option<u64>,
    effort: Option<&str>,
) -> Value {
    match protocol {
        WireProtocol::OpenAIChat => build_openai_chat_body(model, messages, openai_tools, max_tokens, effort),
        WireProtocol::Anthropic => build_anthropic_body(model, messages, openai_tools, max_tokens, effort),
        WireProtocol::Responses => build_responses_body(model, messages, openai_tools, max_tokens, effort),
    }
}

/// 生产路径专用入口：构建请求体后附加 Anthropic 提示词缓存断点。
///
/// 与 [`build_request_body`] 的区别仅在缓存断点。保留后者原签名是为避免
/// 波及既有的 15 处单元测试调用点（测试验证的是协议映射本身，不需要断点）。
/// `custom_env` 同时承载 `SIMPLE_AI_CACHE_CONTROL` 开关，供不兼容网关关闭。
pub fn build_request_body_with_env(
    protocol: WireProtocol,
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
    max_tokens: Option<u64>,
    effort: Option<&str>,
    custom_env: &Option<HashMap<String, String>>,
) -> Value {
    let mut body = build_request_body(protocol, model, messages, openai_tools, max_tokens, effort);
    apply_cache_breakpoints(&mut body, protocol, custom_env);
    body
}

/// Anthropic `thinking.budget_tokens` 随努力级别的建议值。
/// 参考 Claude Code 的 --effort 语义：xhigh/max 更深入，low 更轻量。
pub fn thinking_budget_for_effort(effort: &str) -> u64 {
    match effort {
        "max" | "xhigh" => 32000,
        "high" => 16000,
        "medium" => 8000,
        "low" => 2048,
        _ => 8000, // 未知级别回退中等预算
    }
}

/// 提示词缓存断点开关（`custom_env.SIMPLE_AI_CACHE_CONTROL`）。
///
/// 默认开启。`cache_control` 是 Anthropic 专有字段，而本项目的
/// `wireApi=anthropic-messages` 同时用于对接 DeepSeek / GLM 等国产网关
/// （响应侧已有 `prompt_tokens_details` 兼容层）。若某网关对请求侧的
/// `cache_control` 返回 400，会让整个 profile 全挂——比命中率下降严重得多，
/// 故保留显式关闭入口，沿用 `SIMPLE_AI_DISABLE_SUBAGENT` 的既有写法。
///
/// 不做「失败后自动重试去掉断点」这类自愈：那属于用重试掩盖兼容性问题。
fn cache_control_enabled(custom_env: &Option<HashMap<String, String>>) -> bool {
    custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_CACHE_CONTROL"))
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(true)
}

/// 统计请求体中 `cache_control` 断点的实际数量（防御性上限检查用）。
fn count_cache_breakpoints(body: &Value) -> usize {
    let mut n = 0usize;
    if let Some(sys) = body.get("system").and_then(Value::as_array) {
        n += sys.iter().filter(|b| b.get("cache_control").is_some()).count();
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        n += tools.iter().filter(|b| b.get("cache_control").is_some()).count();
    }
    if let Some(msgs) = body.get("messages").and_then(Value::as_array) {
        for m in msgs {
            if let Some(arr) = m.get("content").and_then(Value::as_array) {
                n += arr.iter().filter(|b| b.get("cache_control").is_some()).count();
            }
        }
    }
    n
}

/// 为 Anthropic 请求体放置 `cache_control` 断点（提示词缓存命中率修复）。
///
/// 实测根因：无断点时依赖网关自动前缀缓存，该缓存在网关 LRU 池中被并发请求
/// 驱逐，单次命中率在 0% 与 ~100% 间随机切换，均值收敛到 ~50%。加断点等于
/// 强制保留条目、不被驱逐，同请求体重放从 0%/94%/4%/99% 跳动变为稳定 99%。
///
/// 三处断点角色不同：
/// - `system`：最大且最稳定的块（persona + 首轮注入的环境/项目指令，continue 不重建）。
///   注意必须转成 block 数组形态——字符串形态在 Anthropic 协议上无法挂断点，
///   这是原本的结构性障碍。
/// - `tools` 末尾：schema 体量大且会话内不变（内置定序 + MCP `cached_specs`）。
/// - 最后一条 `user`：缓存是前缀式的，在「稳定前缀尾部」打断点 → 下一轮更长的
///   前缀保证命中。这对 agent 工作负载尤为关键：单 turn 内多轮工具调用，
///   只靠 system + tools，增长中的历史段仍落回可驱逐的自动缓存，还是会抖。
///
/// 幂等保护：已存在断点的块不重复挂载，避免二次注入（如 compact 路径反复
/// 经过转换）导致数量翻倍。断点总数因此确定为 ≤3（system / tools / 末尾 user
/// 各一），下方 `CACHE_BREAKPOINT_LIMIT` 检查仅作防御性告警，不做裁剪——
/// 裁剪会静默破坏协议语义，告警更利于暴露调用方拼装错误。
fn apply_cache_breakpoints(body: &mut Value, protocol: WireProtocol, custom_env: &Option<HashMap<String, String>>) {
    if protocol != WireProtocol::Anthropic {
        return;
    }
    if !cache_control_enabled(custom_env) {
        return;
    }

    // 1. system：字符串 → block 数组 + 断点。
    if let Some(Value::String(text)) = body.get("system").cloned() {
        if !text.is_empty() {
            body["system"] = json!([
                {
                    "type": "text",
                    "text": text,
                    "cache_control": json!({ "type": "ephemeral" }),
                }
            ]);
        }
    } else if let Some(sys) = body.get_mut("system").and_then(Value::as_array_mut) {
        // 已是数组形态（如上游已是 block 数组）：只给尚无断点的块挂载。
        for b in sys.iter_mut() {
            if b.get("type").and_then(Value::as_str) == Some("text") && b.get("cache_control").is_none() {
                b["cache_control"] = json!({ "type": "ephemeral" });
                break;
            }
        }
    }

    // 2. tools 末尾：会话内稳定，是第二大稳定块。
    if let Some(last) = body.get_mut("tools").and_then(Value::as_array_mut).and_then(|a| a.last_mut()) {
        if last.get("cache_control").is_none() {
            last["cache_control"] = json!({ "type": "ephemeral" });
        }
    }

    // 3. 最后一条 user：稳定前缀尾部。
    //    content 两种形态都要处理——纯字符串（普通 user 消息）与 block 数组
    //    （tool_result 合并后的形态，见 build_anthropic_body 的 tool 合并逻辑）。
    let last_is_user = body
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|m| m.last())
        .is_some_and(|m| m.get("role").and_then(Value::as_str) == Some("user"));
    if last_is_user {
        let last = body.get_mut("messages").and_then(Value::as_array_mut).and_then(|m| m.last_mut()).unwrap();
        match last.get_mut("content") {
            Some(Value::String(s)) if !s.is_empty() => {
                let text = std::mem::take(s);
                last["content"] = json!([
                    {
                        "type": "text",
                        "text": text,
                        "cache_control": json!({ "type": "ephemeral" }),
                    }
                ]);
            }
            Some(Value::Array(arr)) if !arr.is_empty() => {
                if let Some(b) = arr.last_mut() {
                    if b.get("cache_control").is_none() {
                        b["cache_control"] = json!({ "type": "ephemeral" });
                    }
                }
            }
            _ => {}
        }
    }

    // 上限防御：断点超限会导致 Anthropic 直接 400。
    let used = count_cache_breakpoints(body);
    if used > CACHE_BREAKPOINT_LIMIT {
        let model_name = body["model"].as_str().unwrap_or("?");
        tracing::warn!(
            "[SimpleAI] cache_control 断点数 {used} 超过预期上限 {CACHE_BREAKPOINT_LIMIT}，\
             可能导致上游 400（model={model_name}）"
        );
    }
}