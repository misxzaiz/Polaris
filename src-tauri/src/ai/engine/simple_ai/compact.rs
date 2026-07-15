/*! 上下文压缩（Phase 3.3，2026-07 重构）

以**最近一轮**请求的 `usage.input_tokens`（≈ 当前上下文大小）对比窗口阈值（默认
75%）触发；触发后把 `system` 之后、尾部保留区之前的历史连同交接摘要指令发一次
**非流式**请求，得 summary 替换被压缩区间。

设计要点（对齐 codex-rs / Claude Code 惯例）：
- 触发指标是最近一轮 input（`UsageAccumulator.last_input`），不是跨轮累计值；
  累计值 `total_input` 仅作花费统计。无 usage 时以字符估算兜底。
- 压缩范围 = `[1, len - keep_recent)` 按工具配对边界对齐：单 user 的长 agentic
  任务（最常见爆窗场景）也能压到；user 任务描述可入摘要（摘要指令保留 task state）。
- 区间过小 → 直接跳过（不发请求、不丢消息）；仅摘要请求失败才走
  `fallback_drop_oldest` 兜底。
- 摘要请求显式 `max_tokens`；被 reasoning 耗尽预算截断时（实测 ding 网关此时
  message 只有 `reasoning` 字段、无 `content`）自动加大预算重试一次。
- 纯逻辑（`should_compact` / `select_compact_range` / `serialize_message` /
  `extract_summary_text` / `fallback_drop_oldest`）单测覆盖。
 */

use std::sync::Arc;

use serde_json::{json, Value};

use crate::ai::engine::simple_ai_protocol::{self, WireProtocol};
use crate::error::{AppError, Result};
use crate::models::ai_event::ProgressEvent;
use crate::models::AIEvent;

use super::retry;

/// 默认上下文窗口（token）。优先级：`ModelProfile.context_window` > custom_env
/// `SIMPLE_AI_CONTEXT_WINDOW` > 本值。
///
/// ⚠️ 窗口错配陷阱：默认值已从 1M 调整为 180K，更贴合多数第三方供应商的真实窗口。
/// 若通过中转站/聚合代理/自部署网关使用模型，上游真实窗口可能远小于此（如 256K
/// 甚至 128K），此时必须在 Model Profile 中显式设置 contextWindow 为真实窗口，否则
/// 压缩阈值（window × 0.75）估算不准 → 压缩请求可能被上游 400 拒绝。
pub(super) const DEFAULT_CONTEXT_WINDOW: u64 = 180_000;
/// 触发压缩的阈值比例（最近一轮 input / window）。
const COMPACT_THRESHOLD: f64 = 0.75;
/// 压缩请求超时（秒）。摘要请求应比对话快。
const COMPACT_TIMEOUT_SECS: u64 = 60;
/// 压缩时尾部保留的消息条数（约 2-3 组工具交互）。custom_env
/// `SIMPLE_AI_COMPACT_KEEP_RECENT` 可覆盖（最小 1）。
pub(super) const DEFAULT_COMPACT_KEEP_RECENT: usize = 6;
/// 待压缩区间的最小消息数；低于此规模压缩收益不抵成本（也天然挡住
/// "仅剩上次 summary 反复自摘要"的退化）。
const COMPACT_MIN_RANGE: usize = 4;
/// 单段摘要输入的 token 预算（占窗口比例）。待压区间估算超过 window×此值时
/// 启用滚动分段摘要，避免把整段超窗历史一次性发给模型（压缩请求自身 400）。
const SEGMENT_INPUT_BUDGET_RATIO: f64 = 0.5;
/// 分段数量硬上限（防极端长历史产生过多摘要请求）。超过则余下并入最后一段并 log。
const MAX_SEGMENTS: usize = 12;
/// 摘要请求输出预算；截断时以重试预算再试一次。
const SUMMARY_MAX_TOKENS: u64 = 2048;
const SUMMARY_RETRY_MAX_TOKENS: u64 = 4096;
/// 字符估算 token 的除数（中英混合的保守近似）。
const CHARS_PER_TOKEN: usize = 4;
/// 摘要输入序列化时的截断上限（字符）。
const SERIALIZE_TOOL_RESULT_CAP: usize = 1000;
const SERIALIZE_TOOL_ARGS_CAP: usize = 200;

/// 每轮 token 使用量记录。
///
/// `last_input`（最近一轮请求的 input_tokens ≈ 当前上下文大小）驱动压缩触发；
/// `total_input` 单调累计，仅作花费统计与日志，不参与触发。
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct UsageAccumulator {
    pub total_input: u64,
    pub last_input: u64,
}

impl UsageAccumulator {
    pub fn add(&mut self, input_tokens: u64) {
        self.total_input = self.total_input.saturating_add(input_tokens);
        self.last_input = input_tokens;
    }

    /// 压缩后清零：下一轮真实 usage 重新填充前落到字符估算兜底
    /// （压缩后的 messages 已显著变小），天然形成一轮冷却。
    pub fn reset_last(&mut self) {
        self.last_input = 0;
    }

    /// 最近一轮 input 达窗口的 `COMPACT_THRESHOLD` 时触发。
    /// 尚无 usage（首轮或供应商不回 usage）时以消息字符估算兜底。
    pub fn should_compact(&self, window: u64, messages: &[Value]) -> bool {
        let current = if self.last_input > 0 {
            self.last_input
        } else {
            estimate_tokens(messages)
        };
        let threshold = ((window as f64) * COMPACT_THRESHOLD) as u64;
        current >= threshold
    }
}

/// 粗粒度 token 估算：全部消息 content / tool_calls 字符数 ÷ CHARS_PER_TOKEN。
fn estimate_tokens(messages: &[Value]) -> u64 {
    let chars: usize = messages.iter().map(message_chars).sum();
    (chars / CHARS_PER_TOKEN) as u64
}

/// 单条消息计入估算的字符数（content 文本 + tool_calls JSON）。
fn message_chars(m: &Value) -> usize {
    let content_len = match m.get("content") {
        Some(Value::String(s)) => s.len(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .map(|t| t.len())
            .sum(),
        _ => 0,
    };
    let tool_calls_len = m
        .get("tool_calls")
        .map(|tc| tc.to_string().len())
        .unwrap_or(0);
    content_len + tool_calls_len
}

/// 单条消息的粗粒度 token 估算（用于分段预算累计）。
fn estimate_message_tokens(m: &Value) -> u64 {
    (message_chars(m) / CHARS_PER_TOKEN) as u64
}

fn role(m: &Value) -> &str {
    m.get("role").and_then(|r| r.as_str()).unwrap_or("")
}

fn is_assistant_with_tool_calls(m: &Value) -> bool {
    role(m) == "assistant" && m.get("tool_calls").is_some()
}

/// 选取待压缩区间 `[start, end)`：
/// - `start = 1`：system 永不入摘要；上次 `[compacted summary]` 与其后的新历史
///   合并再摘要属于信息演进（非自摘要退化，退化由 `COMPACT_MIN_RANGE` 拦截）。
/// - `end = len - keep_recent`（尾部保留最近交互），再按工具配对边界对齐
///   （OpenAI 协议硬约束，切断配对会 400）：
///   - 保留区首条不能是孤儿 tool（其 assistant(tool_calls) 被压走）→ 整组回退进保留区；
///   - 摘要区间尾不能是孤儿 assistant(tool_calls)（其 tool 结果留在保留区）。
/// - 区间小于 `COMPACT_MIN_RANGE` → None（跳过本轮，不值得压/防退化）。
pub(super) fn select_compact_range(
    messages: &[Value],
    keep_recent: usize,
) -> Option<(usize, usize)> {
    let len = messages.len();
    let mut end = len.saturating_sub(keep_recent.max(1));
    // a) 保留区首条若是孤儿 tool，把整组（tool* + 所属 assistant）回退进保留区。
    while end > 1 && end < len && role(&messages[end]) == "tool" {
        end -= 1;
    }
    // b) 摘要区间尾若是孤儿 assistant(tool_calls)，回退到它之前。
    while end > 1 && is_assistant_with_tool_calls(&messages[end - 1]) {
        end -= 1;
    }
    if end <= 1 || (end - 1) < COMPACT_MIN_RANGE {
        return None;
    }
    Some((1, end))
}

/// 把待压缩区间 `[start, end)` 按 token 预算切成若干段，**只在 user 消息前切**
/// （turn 边界），保证永不切断 assistant.tool_calls 与其后的 tool result 配对。
///
/// - 单个自身超预算的 turn 自成一段（可接受：仍远小于整段历史，且不切配对）；
/// - 段数达到 `MAX_SEGMENTS` 前一段时停止再切，余下并入最后一段（防请求爆炸）；
/// - 返回相对 `messages` 的绝对索引区间 `[(s, e), ...]`，至少 1 段。
///   `[start, end)` 为空时返回空 vec（调用方保证非空）。
fn segment_compact_range(
    messages: &[Value],
    start: usize,
    end: usize,
    per_segment_budget: u64,
) -> Vec<(usize, usize)> {
    let mut segments = Vec::new();
    if start >= end {
        return segments;
    }
    let budget = per_segment_budget.max(1);
    let mut seg_start = start;
    let mut acc: u64 = 0;
    for i in start..end {
        acc = acc.saturating_add(estimate_message_tokens(&messages[i]));
        let at_user_boundary = i + 1 < end && role(&messages[i + 1]) == "user";
        // 段数封顶前一段就停切，剩余合并进最后一段。
        let under_cap = segments.len() + 1 < MAX_SEGMENTS;
        if acc >= budget && at_user_boundary && under_cap {
            segments.push((seg_start, i + 1));
            seg_start = i + 1;
            acc = 0;
        }
    }
    segments.push((seg_start, end));
    segments
}

/// 交接摘要指令（仿 codex compact prompt 语义）。
const COMPACT_INSTRUCTION: &str = "You are compacting a conversation history. Summarize the \
following messages into a concise handoff summary: key decisions, established facts, file paths \
touched, outstanding errors, and the current task state. Reply with ONLY the summary, no preamble.";

/// 截断重试时追加的指令（reasoning 模型把预算耗在思考上时）。
const COMPACT_RETRY_SUFFIX: &str = "\nOutput the summary directly. Do NOT show any thinking or \
reasoning process.";

/// 滚动分段合并指令：把「已有摘要」与「新对话片段」合并为更新后的完整摘要。
/// 用于超窗历史的分段压缩，逐段滚动带入上一段摘要，保证跨段决策链连续。
const COMPACT_ROLLING_INSTRUCTION: &str = "You are incrementally compacting a long conversation. \
You are given an existing summary and a new segment of raw conversation. Merge them into a single \
updated handoff summary that preserves all key decisions, established facts, file paths touched, \
outstanding errors, and the current task state from BOTH the existing summary and the new segment. \
Reply with ONLY the merged summary, no preamble.";

/// 摘要请求失败原因（决定是否值得加大预算重试）。
#[derive(Debug)]
enum SummaryFailure {
    /// 输出被 max_tokens 截断（finish=length，或 content 空但 reasoning 系字段存在）。
    Truncated,
    /// 其他错误（网络 / 解析 / 空响应）。
    Other(AppError),
}

/// 发起一次非流式摘要请求。
async fn request_summary_once(
    profile: &crate::models::config::ModelProfile,
    base_instruction: &str,
    history_text: &str,
    max_tokens: u64,
    extra_instruction: &str,
) -> std::result::Result<String, SummaryFailure> {
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    let instruction = format!("{}{}", base_instruction, extra_instruction);
    let messages = vec![
        json!({ "role": "system", "content": instruction }),
        json!({ "role": "user", "content": history_text }),
    ];
    let mut body = simple_ai_protocol::build_request_body(
        protocol,
        &profile.model,
        &messages,
        &[],
        Some(max_tokens),
    );
    // 非流式：去掉 stream/tools 相关字段。
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), json!(false));
        obj.remove("stream_options");
        obj.remove("tools");
        obj.remove("tool_choice");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(COMPACT_TIMEOUT_SECS))
        .build()
        .map_err(|e| SummaryFailure::Other(AppError::ProcessError(format!("HTTP client error: {}", e))))?;
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
    // 摘要请求也走重试（2 次，基数 500ms）。
    let response = retry::send_with_retry(req, 2, 500)
        .await
        .map_err(SummaryFailure::Other)?;
    let json: Value = response
        .json()
        .await
        .map_err(|e| SummaryFailure::Other(AppError::ProcessError(format!("parse compact response: {}", e))))?;
    extract_summary_text(protocol, &json)
}

/// 发起摘要请求；被截断时加大预算 + 抑制思考指令重试一次。
async fn request_summary(
    profile: &crate::models::config::ModelProfile,
    base_instruction: &str,
    history_text: &str,
) -> Result<String> {
    match request_summary_once(profile, base_instruction, history_text, SUMMARY_MAX_TOKENS, "").await {
        Ok(s) => Ok(s),
        Err(SummaryFailure::Truncated) => {
            tracing::warn!(
                "[SimpleAI] 摘要输出被截断（思考耗尽预算），以 max_tokens={} 重试",
                SUMMARY_RETRY_MAX_TOKENS
            );
            match request_summary_once(
                profile,
                base_instruction,
                history_text,
                SUMMARY_RETRY_MAX_TOKENS,
                COMPACT_RETRY_SUFFIX,
            )
            .await
            {
                Ok(s) => Ok(s),
                Err(SummaryFailure::Truncated) => Err(AppError::ProcessError(
                    "compact summary truncated twice".to_string(),
                )),
                Err(SummaryFailure::Other(e)) => Err(e),
            }
        }
        Err(SummaryFailure::Other(e)) => Err(e),
    }
}

/// 滚动分段摘要：区间估算不超预算 → 单次摘要（与现状一致）；超预算 → 按 turn
/// 边界分段，逐段摘要并滚动带入上一段摘要合并，每次请求只发一段（永不撞窗口）。
async fn summarize_range_rolling(
    messages: &[Value],
    start: usize,
    end: usize,
    window: u64,
    profile: &crate::models::config::ModelProfile,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    session_id: &str,
) -> Result<String> {
    let per_segment_budget = ((window as f64) * SEGMENT_INPUT_BUDGET_RATIO) as u64;
    let segments = segment_compact_range(messages, start, end, per_segment_budget);

    let serialize_seg = |s: usize, e: usize| -> String {
        messages[s..e]
            .iter()
            .map(serialize_message)
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    // 不超预算（或退化为单段）→ 与现状完全一致的单次摘要路径。
    if segments.len() <= 1 {
        let (s, e) = segments.first().copied().unwrap_or((start, end));
        return request_summary(profile, COMPACT_INSTRUCTION, &serialize_seg(s, e)).await;
    }

    tracing::info!(
        "[SimpleAI] 待压区间超预算，启用滚动分段摘要：{} 段（每段预算 ~{} token）",
        segments.len(),
        per_segment_budget
    );

    let total = segments.len();
    let mut running = String::new();
    for (idx, (s, e)) in segments.into_iter().enumerate() {
        let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
            session_id,
            format!("正在压缩上下文…（第 {}/{} 段）", idx + 1, total),
        )));
        let seg_text = serialize_seg(s, e);
        running = if running.is_empty() {
            // 首段：普通摘要。
            request_summary(profile, COMPACT_INSTRUCTION, &seg_text).await?
        } else {
            // 后续段：把已有摘要与新片段一起交给模型合并。
            let merged_input = format!(
                "<existing_summary>\n{}\n</existing_summary>\n\n<new_segment>\n{}\n</new_segment>",
                running, seg_text
            );
            request_summary(profile, COMPACT_ROLLING_INSTRUCTION, &merged_input).await?
        };
    }
    Ok(running)
}

/// 从非流式响应提取 summary 文本（三协议），并区分"截断"与其他失败。
fn extract_summary_text(
    protocol: WireProtocol,
    json: &Value,
) -> std::result::Result<String, SummaryFailure> {
    match protocol {
        WireProtocol::OpenAIChat => {
            let msg = json.pointer("/choices/0/message");
            let text = match msg.and_then(|m| m.get("content")) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            if !text.trim().is_empty() {
                return Ok(text);
            }
            // 截断态（实测）：finish=length 时 message 可能只有 reasoning 字段、无 content key。
            let finish = json
                .pointer("/choices/0/finish_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let has_reasoning = msg
                .map(|m| m.get("reasoning").is_some() || m.get("reasoning_content").is_some())
                .unwrap_or(false);
            if finish == "length" || has_reasoning {
                Err(SummaryFailure::Truncated)
            } else {
                Err(SummaryFailure::Other(AppError::ProcessError(
                    "openai compact response missing content".to_string(),
                )))
            }
        }
        WireProtocol::Anthropic => {
            // content[] 中的 text block 拼接。
            let mut s = String::new();
            if let Some(arr) = json.get("content").and_then(|v| v.as_array()) {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            s.push_str(t);
                        }
                    }
                }
            }
            if !s.trim().is_empty() {
                return Ok(s);
            }
            if json.get("stop_reason").and_then(|v| v.as_str()) == Some("max_tokens") {
                Err(SummaryFailure::Truncated)
            } else {
                Err(SummaryFailure::Other(AppError::ProcessError(
                    "anthropic compact response missing text content".to_string(),
                )))
            }
        }
        WireProtocol::Responses => {
            // output[] 中找 message item 的 content[].text 拼接。
            let mut s = String::new();
            if let Some(arr) = json.get("output").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(contents) = item.get("content").and_then(|c| c.as_array()) {
                        for c in contents {
                            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                s.push_str(t);
                            }
                        }
                    }
                }
            }
            if !s.trim().is_empty() {
                return Ok(s);
            }
            if json.get("status").and_then(|v| v.as_str()) == Some("incomplete") {
                Err(SummaryFailure::Truncated)
            } else {
                Err(SummaryFailure::Other(AppError::ProcessError(
                    "responses compact response missing output text".to_string(),
                )))
            }
        }
    }
}

/// 按字符截断（多字节安全），超限追加标记。
fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let head: String = s.chars().take(cap).collect();
    format!("{}…[truncated]", head)
}

/// 序列化单条消息为摘要输入行：保留 tool_calls 名称+参数（截断）、
/// tool 结果（截断）、数组型 content 的 text parts。
fn serialize_message(m: &Value) -> String {
    let r = role(m);
    let mut parts: Vec<String> = Vec::new();
    let text = match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    if !text.is_empty() {
        if r == "tool" {
            parts.push(truncate_chars(&text, SERIALIZE_TOOL_RESULT_CAP));
        } else {
            parts.push(text);
        }
    }
    if let Some(tcs) = m.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let name = tc
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let args = tc
                .pointer("/function/arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            parts.push(format!(
                "调用工具 {}({})",
                name,
                truncate_chars(args, SERIALIZE_TOOL_ARGS_CAP)
            ));
        }
    }
    format!("[{}]: {}", r, parts.join(" "))
}

/// 压缩历史：把 `[start, end)` 区间替换为单条 summary user 消息。
///
/// 返回 `true` = 实际改变了 messages（摘要替换或 fallback），调用方应重置触发基准；
/// 返回 `false` = 区间过小跳过，messages 未变。
pub(super) async fn compact_history(
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    window: u64,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    session_id: &str,
) -> Result<bool> {
    // keep_recent 可经 custom_env 覆盖（最小 1，防止全压光/越界）。
    let keep_recent = profile
        .custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_COMPACT_KEEP_RECENT"))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_COMPACT_KEEP_RECENT)
        .max(1);

    let (start, end) = match select_compact_range(messages, keep_recent) {
        Some(r) => r,
        None => {
            tracing::info!("[SimpleAI] 可压缩区间过小，跳过本轮压缩");
            return Ok(false);
        }
    };

    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
        session_id,
        "正在压缩上下文…".to_string(),
    )));

    // 摘要：区间不超预算走单次；超预算（本身超窗，原本必 400）走滚动分段。
    match summarize_range_rolling(messages, start, end, window, profile, event_callback, session_id).await {
        Ok(summary) if !summary.trim().is_empty() => {
            let compressed_count = end - start;
            messages.drain(start..end);
            messages.insert(
                start,
                json!({ "role": "user", "content": format!("[compacted summary]\n{}", summary.trim()) }),
            );
            tracing::info!(
                "[SimpleAI] 上下文已压缩：{} 条消息 → 1 条 summary",
                compressed_count
            );
        }
        Ok(_) => {
            tracing::warn!("[SimpleAI] 摘要为空，回退到移除最早 turn");
            fallback_drop_oldest(messages);
        }
        Err(e) => {
            tracing::warn!("[SimpleAI] 上下文压缩失败（{}），回退到移除最早 turn", e);
            fallback_drop_oldest(messages);
        }
    }
    Ok(true)
}

/// 兜底：移除最早一个完整 turn（user + assistant + tool*），保留 system 与后续 turns。
/// 若仅有一个 user turn（移除会丢最近上下文）则不动。
fn fallback_drop_oldest(messages: &mut Vec<Value>) {
    if messages.len() < 3 {
        return;
    }
    // 第一个 user（index >= 1）。
    let first_user = match messages
        .iter()
        .skip(1)
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
    {
        Some(p) => p + 1,
        None => return,
    };
    // 下一个 user（turn 边界）。
    let next_user = messages
        .iter()
        .skip(first_user + 1)
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
    let end = match next_user {
        Some(p) => first_user + 1 + p,
        None => return, // 只有一个 turn，不移除。
    };
    messages.drain(first_user..end);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulator_triggers_on_last_input_not_total() {
        let mut acc = UsageAccumulator::default();
        acc.add(50_000);
        acc.add(50_000);
        // 旧实现按累计 100k > 96k 会误触发；新实现按最近一轮 50k 不触发。
        assert_eq!(acc.total_input, 100_000);
        assert!(!acc.should_compact(128_000, &[]));
        acc.add(100_000);
        assert!(acc.should_compact(128_000, &[]));
    }

    #[test]
    fn accumulator_reset_prevents_immediate_retrigger() {
        let mut acc = UsageAccumulator::default();
        acc.add(100_000);
        assert!(acc.should_compact(128_000, &[]));
        acc.reset_last();
        // 压缩后 messages 已变小，估算兜底不触发。
        let small = vec![json!({"role":"user","content":"short"})];
        assert!(!acc.should_compact(128_000, &small));
    }

    #[test]
    fn accumulator_estimates_when_no_usage() {
        let acc = UsageAccumulator::default();
        // 500k 字符 ≈ 125k token ≥ 96k 阈值。
        let big = vec![json!({"role":"user","content":"x".repeat(500_000)})];
        assert!(acc.should_compact(128_000, &big));
        let small = vec![json!({"role":"user","content":"x".repeat(1000)})];
        assert!(!acc.should_compact(128_000, &small));
    }

    #[test]
    fn accumulator_saturates() {
        let mut acc = UsageAccumulator::default();
        acc.add(u64::MAX);
        acc.add(10);
        assert_eq!(acc.total_input, u64::MAX);
    }

    fn a_tc() -> Value {
        json!({"role":"assistant","content":"","tool_calls":[{"id":"x","function":{"name":"bash","arguments":"{}"}}]})
    }
    fn tool() -> Value {
        json!({"role":"tool","tool_call_id":"x","content":"r"})
    }

    #[test]
    fn select_range_single_user_agentic_history() {
        // system + user + 5×(assistant(tc) + tool)：旧实现 last_user=1 返回 None，
        // 新实现应压 [1, 6)、保留最近 6 条。
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"task"}),
        ];
        for _ in 0..5 {
            msgs.push(a_tc());
            msgs.push(tool());
        }
        let (start, end) = select_compact_range(&msgs, 6).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 6); // [user, a(tc), tool, a(tc), tool]，以 tool 结尾配对完整
        assert_eq!(role(&msgs[end]), "assistant"); // 保留区首条是组开头
    }

    #[test]
    fn select_range_pushes_orphan_tool_into_keep_zone() {
        // 边界恰好落在 tool 上：保留区首条不能是孤儿 tool，应整组回退。
        // 0=sys 1=u 2=a 3=u 4=a 5=a(tc) 6=t 7=a 8=u 9=a 10=u 11=a，keep=6 → end=6 落在 t。
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
            json!({"role":"assistant","content":"a2"}),
            a_tc(),
            tool(),
            json!({"role":"assistant","content":"a3"}),
            json!({"role":"user","content":"u3"}),
            json!({"role":"assistant","content":"a4"}),
            json!({"role":"user","content":"u4"}),
            json!({"role":"assistant","content":"a5"}),
        ];
        let (start, end) = select_compact_range(&msgs, 6).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 5); // 回退到 a(tc) 之前，a(tc)+tool 整组进保留区
    }

    #[test]
    fn select_range_returns_none_for_short_history() {
        let msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u"}),
            json!({"role":"assistant","content":"a"}),
        ];
        assert!(select_compact_range(&msgs, 6).is_none());
        // len=8, keep=6 → end=2，区间 1 条 < MIN_RANGE。
        let mut msgs = vec![json!({"role":"system","content":"s"})];
        for i in 0..7 {
            msgs.push(json!({"role":"user","content":format!("m{}", i)}));
        }
        assert!(select_compact_range(&msgs, 6).is_none());
    }

    #[test]
    fn select_range_keep_recent_zero_is_clamped() {
        // keep_recent=0 被钳为 1，不越界、不全压光。
        let mut msgs = vec![json!({"role":"system","content":"s"})];
        for i in 0..8 {
            msgs.push(json!({"role":"user","content":format!("m{}", i)}));
        }
        let (start, end) = select_compact_range(&msgs, 0).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, msgs.len() - 1);
    }

    // ---- segment_compact_range ----

    /// 造一条约 n 字符的 user / assistant 消息（用于分段预算测试）。
    fn msg_of(role: &str, n: usize) -> Value {
        json!({"role": role, "content": "x".repeat(n)})
    }

    #[test]
    fn segment_single_when_under_budget() {
        // 区间小于预算 → 单段（走现状单次摘要路径）。
        let msgs = vec![
            msg_of("user", 40),
            msg_of("assistant", 40),
            msg_of("user", 40),
        ];
        // 预算 1000 token ≫ 区间 ~30 token。
        let segs = segment_compact_range(&msgs, 0, msgs.len(), 1000);
        assert_eq!(segs, vec![(0, 3)]);
    }

    #[test]
    fn segment_cuts_only_before_user() {
        // 预算很小，应在每个 user 边界切；tool 配对不被切断。
        // 0=u 1=a(tc) 2=tool 3=u 4=a 5=u 6=a
        let msgs = vec![
            msg_of("user", 400),
            a_tc(),
            tool(),
            msg_of("user", 400),
            msg_of("assistant", 400),
            msg_of("user", 400),
            msg_of("assistant", 400),
        ];
        // 每条 ~100 token，预算 100 → 每到 user 前就切。
        let segs = segment_compact_range(&msgs, 0, msgs.len(), 100);
        // 段边界只可能在 index 3、5（user 前），不会落在 tool(2) 上。
        for (_, e) in &segs {
            if *e < msgs.len() {
                assert_eq!(role(&msgs[*e]), "user", "切点必须在 user 前");
            }
        }
        // 首段包含 [u, a(tc), tool] 完整配对。
        assert_eq!(segs[0], (0, 3));
    }

    #[test]
    fn segment_oversized_turn_stays_whole() {
        // 单个 turn 自身超预算：不切断，自成一段。
        // 0=u(巨大) 1=a(tc) 2=tool 3=u
        let msgs = vec![
            msg_of("user", 4000),
            a_tc(),
            tool(),
            msg_of("user", 40),
        ];
        let segs = segment_compact_range(&msgs, 0, msgs.len(), 100);
        assert_eq!(segs[0], (0, 3)); // 超预算的首 turn 整体成段，未切断 tool 配对
    }

    #[test]
    fn segment_respects_max_segments_cap() {
        // 大量 user 消息 + 极小预算：段数不超过 MAX_SEGMENTS。
        let mut msgs = Vec::new();
        for _ in 0..40 {
            msgs.push(msg_of("user", 400)); // 每条 ~100 token
        }
        let segs = segment_compact_range(&msgs, 0, msgs.len(), 1);
        assert!(segs.len() <= MAX_SEGMENTS, "段数 {} 超过封顶 {}", segs.len(), MAX_SEGMENTS);
        // 覆盖完整、无空洞、无重叠。
        assert_eq!(segs.first().unwrap().0, 0);
        assert_eq!(segs.last().unwrap().1, msgs.len());
        for w in segs.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
    }

    #[test]
    fn segment_empty_range_is_empty() {
        let msgs = vec![msg_of("user", 10)];
        assert!(segment_compact_range(&msgs, 1, 1, 100).is_empty());
    }

    #[test]
    fn fallback_drops_oldest_complete_turn() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
            json!({"role":"user","content":"u2"}),
            json!({"role":"assistant","content":"a2"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "u2");
    }

    #[test]
    fn fallback_drops_assistant_with_tool_results() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"x"}]}),
            json!({"role":"tool","content":"r"}),
            json!({"role":"user","content":"u2"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "u2");
    }

    #[test]
    fn fallback_preserves_single_turn() {
        let mut msgs = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"u1"}),
            json!({"role":"assistant","content":"a1"}),
        ];
        fallback_drop_oldest(&mut msgs);
        assert_eq!(msgs.len(), 3); // 不动
    }

    #[test]
    fn serialize_keeps_tool_calls_and_truncates_results() {
        let m = json!({
            "role": "assistant",
            "content": "before",
            "tool_calls": [{
                "id": "c1",
                "function": { "name": "bash", "arguments": "{\"command\":\"ls -la\"}" }
            }]
        });
        let s = serialize_message(&m);
        assert!(s.contains("[assistant]"));
        assert!(s.contains("before"));
        assert!(s.contains("调用工具 bash"));
        assert!(s.contains("ls -la"));

        let long = "y".repeat(SERIALIZE_TOOL_RESULT_CAP + 100);
        let t = json!({"role":"tool","content": long});
        let s = serialize_message(&t);
        assert!(s.contains("[truncated]"));
        assert!(s.chars().count() < SERIALIZE_TOOL_RESULT_CAP + 60);
    }

    #[test]
    fn extract_summary_openai_chat() {
        let json = json!({
            "choices": [{ "message": { "content": "summary text" } }]
        });
        let s = extract_summary_text(WireProtocol::OpenAIChat, &json).unwrap();
        assert_eq!(s, "summary text");
    }

    #[test]
    fn extract_summary_openai_content_parts_array() {
        let json = json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "part1 " },
                { "type": "text", "text": "part2" }
            ] } }]
        });
        let s = extract_summary_text(WireProtocol::OpenAIChat, &json).unwrap();
        assert_eq!(s, "part1 part2");
    }

    #[test]
    fn extract_summary_openai_truncated_reasoning_only() {
        // 实测 ding 网关截断态：message 只有 reasoning 字段、无 content key。
        let json = json!({
            "choices": [{
                "finish_reason": "length",
                "message": { "role": "assistant", "reasoning": "thinking..." }
            }]
        });
        assert!(matches!(
            extract_summary_text(WireProtocol::OpenAIChat, &json),
            Err(SummaryFailure::Truncated)
        ));
        // 无 reasoning 也无 content → Other。
        let json = json!({ "choices": [{ "message": { "role": "assistant" } }] });
        assert!(matches!(
            extract_summary_text(WireProtocol::OpenAIChat, &json),
            Err(SummaryFailure::Other(_))
        ));
    }

    #[test]
    fn extract_summary_anthropic_concatenates_text_blocks() {
        let json = json!({
            "content": [
                { "type": "text", "text": "part1 " },
                { "type": "text", "text": "part2" }
            ]
        });
        let s = extract_summary_text(WireProtocol::Anthropic, &json).unwrap();
        assert_eq!(s, "part1 part2");
    }

    #[test]
    fn extract_summary_anthropic_max_tokens_is_truncated() {
        let json = json!({
            "content": [{ "type": "thinking", "thinking": "..." }],
            "stop_reason": "max_tokens"
        });
        assert!(matches!(
            extract_summary_text(WireProtocol::Anthropic, &json),
            Err(SummaryFailure::Truncated)
        ));
    }

    #[test]
    fn extract_summary_responses_picks_output_text() {
        let json = json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "resp summary" }
                    ]
                }
            ]
        });
        let s = extract_summary_text(WireProtocol::Responses, &json).unwrap();
        assert_eq!(s, "resp summary");
    }

    #[test]
    fn extract_summary_responses_incomplete_is_truncated() {
        let json = json!({ "output": [], "status": "incomplete" });
        assert!(matches!(
            extract_summary_text(WireProtocol::Responses, &json),
            Err(SummaryFailure::Truncated)
        ));
    }
}
