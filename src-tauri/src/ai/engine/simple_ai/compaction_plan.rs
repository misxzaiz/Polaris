/*! 压缩核心逻辑（Phase 1b）
 *
 * 定义压缩的数据模型和分析逻辑：
 * - `MessageClass`: 消息分类（Pinned / Compactable / RecentTail）
 * - `TurnGroup`: 工具调用回合分组（保证 tool_calls → tool_results 配对完整）
 * - `CompactionPlan`: 压缩计划（pinned 边界、可压缩区间、最近回合）
 * - `TokenEstimator`: 请求大小估算器
 * - `render_message_for_compaction`: 结构化消息序列化
 *
 * 这些逻辑是 Phase 2 `CompactionCoordinator` 的基础。
 */

use serde_json::Value;

use crate::ai::engine::simple_ai_protocol::{build_request_body, WireProtocol};

// ============================================================================
// 常量
// ============================================================================

/// 默认上下文窗口（token）
pub const DEFAULT_CONTEXT_WINDOW: u64 = 1_000_000;
/// 压缩触发软阈值比例（可用输入预算的 75%）
const COMPACT_SOFT_RATIO: f64 = 0.75;
/// 压缩触发硬阈值比例（可用输入预算的 90%）
const COMPACT_HARD_RATIO: f64 = 0.90;
/// 压缩目标回落到可用输入预算的比例
const COMPACT_TARGET_RATIO: f64 = 0.50;
/// 最小安全余量（token）
const SAFETY_MARGIN_TOKENS: u64 = 1000;
/// 输出预留（token）
const RESERVED_OUTPUT_TOKENS: u64 = 8192;
/// 触发压缩所需的最少完整回合数（含将被归档和保留的回合）。
/// 低于此值视为历史过短，不可压缩。
pub const MIN_TURNS_FOR_COMPACT: usize = 3;
/// 自动压缩时尾部至少保留的回合数（保守，避免频繁触发）。
pub(super) const AUTO_MIN_TAIL_TURNS: usize = 2;
/// 手动压缩时尾部至少保留的回合数（激进，用户显式请求即可压缩短历史）。
pub(super) const MANUAL_MIN_TAIL_TURNS: usize = 2;

// ============================================================================
// 消息分类
// ============================================================================

/// 消息在压缩上下文中的分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageClass {
    /// Pinned 上下文（bootstrap_end 之前）：永不被压缩
    Pinned,
    /// 可压缩的普通历史
    Compactable,
    /// 最近保留的回合（recent_tail）
    RecentTail,
}

// ============================================================================
// TurnGroup：工具调用回合分组
// ============================================================================

/// 一个完整的用户回合，保证 tool_calls → tool_results 配对完整。
///
/// 一个 TurnGroup 覆盖：
/// - user 消息
/// - assistant 消息（含 tool_calls）
/// - 对应的 tool_results（一条或多条）
/// - assistant 最终回复（如果有）
#[derive(Debug, Clone)]
pub struct TurnGroup {
    /// 回合在消息数组中的起始索引（含）
    pub start_index: usize,
    /// 回合在消息数组中的结束索引（不含）
    pub end_index: usize,
    /// 该回合内的工具调用数量
    pub tool_call_count: usize,
    /// 该回合的估算 token 数
    pub estimated_tokens: usize,
}

impl TurnGroup {
    pub fn new(start_index: usize, end_index: usize, tool_call_count: usize) -> Self {
        Self {
            start_index,
            end_index,
            tool_call_count,
            estimated_tokens: 0, // 由外部设置
        }
    }

    pub fn len(&self) -> usize {
        self.end_index - self.start_index
    }
}

/// 压缩计划：分析消息后的输出
#[derive(Debug)]
pub struct CompactionPlan {
    /// 所属会话 ID
    pub session_id: String,
    /// 稳定对话 ID
    pub stable_conversation_id: String,
    /// Pinned 上下文结束边界（bootstrap_end）
    pub bootstrap_end: usize,
    /// 可压缩的回合分组
    pub compactable_turns: Vec<TurnGroup>,
    /// 最近保留回合在 messages 中的起始索引
    pub recent_tail_start: usize,
    /// 最近保留的完整回合数量
    pub recent_tail_turn_count: usize,
    /// 压缩前估算的总 token 数
    pub estimated_before: usize,
    /// 压缩后估算的总 token 数
    pub estimated_after: usize,
    /// 可用输入预算
    pub usable_input_budget: u64,
    /// 当前是否达到压缩阈值
    pub should_compact: bool,
}

impl CompactionPlan {
    /// 当总回合数不足 `MIN_TURNS_FOR_COMPACT` 时返回空计划。
    /// `should_compact` 为 false，`compactable_turns` 为空。
    fn new_inadequate(
        session_id: String,
        stable_conversation_id: String,
        bootstrap_end: usize,
        _total_turns: usize,
    ) -> Self {
        Self {
            session_id,
            stable_conversation_id,
            bootstrap_end,
            compactable_turns: Vec::new(),
            recent_tail_start: 0,
            recent_tail_turn_count: 0,
            estimated_before: 0,
            estimated_after: 0,
            usable_input_budget: 0,
            should_compact: false,
        }
    }
}

// ============================================================================
// TokenEstimator：请求大小估算器
// ============================================================================

/// 请求大小估算器（替代旧的 UsageAccumulator）
#[derive(Debug, Default)]
pub struct TokenEstimator {
    /// provider 返回的最近一次 input_tokens（用于校准估算系数）
    pub recent_provider_input: Option<u64>,
    /// 最近一次实际输入大小（用于校准）
    pub recent_estimated_input: Option<usize>,
}

impl TokenEstimator {
    pub fn new() -> Self {
        Self {
            recent_provider_input: None,
            recent_estimated_input: None,
        }
    }

    /// 校准估算系数：用 provider 返回的实际 usage 校准估算
    pub fn calibrate(&mut self, provider_input: u64, estimated_input: usize) {
        if estimated_input > 0 {
            self.recent_provider_input = Some(provider_input);
            self.recent_estimated_input = Some(estimated_input);
        }
    }

    /// 获取估算校准系数（默认 1.0）
    pub fn calibration_factor(&self) -> f64 {
        if let (Some(actual), Some(est)) = (self.recent_provider_input, self.recent_estimated_input)
        {
            if est > 0 {
                ((actual as f64) / (est as f64)).clamp(0.75, 2.5)
            } else {
                1.0
            }
        } else {
            1.0 // 默认保守估算
        }
    }

    /// 估算最终 wire request 的 token 大小
    pub fn estimate_request_size(
        &self,
        messages: &[Value],
        tools: &[Value],
        _context_window: u64,
        wire_protocol: WireProtocol,
    ) -> usize {
        // 先执行与真实请求完全相同的协议转换，再估算最终 wire JSON；因此 system 提取、
        // Anthropic 相邻 user 合并、tool schema 变换、Responses function items 和固定请求字段
        // 都只按真实形态计一次。输出 token 预留由 usable_budget_with_output 单独扣除。
        let wire_body = build_request_body(
            wire_protocol,
            "token-estimation-model",
            messages,
            tools,
            None,
        );
        let wire_estimate = estimate_wire_body_tokens(&wire_body);
        ((wire_estimate as f64) * self.calibration_factor()).ceil() as usize
    }

    /// 计算可用输入预算
    pub fn usable_budget(&self, context_window: u64) -> u64 {
        self.usable_budget_with_output(context_window, RESERVED_OUTPUT_TOKENS)
    }

    pub fn usable_budget_with_output(&self, context_window: u64, reserved_output: u64) -> u64 {
        (((context_window as f64) * 0.95) as u64)
            .saturating_sub(reserved_output)
            .saturating_sub(SAFETY_MARGIN_TOKENS)
    }

    pub fn target_budget(&self, usable_budget: u64) -> usize {
        ((usable_budget as f64) * COMPACT_TARGET_RATIO) as usize
    }

    pub fn soft_threshold(&self, usable_budget: u64) -> usize {
        ((usable_budget as f64) * COMPACT_SOFT_RATIO) as usize
    }

    pub fn hard_threshold(&self, usable_budget: u64) -> usize {
        ((usable_budget as f64) * COMPACT_HARD_RATIO) as usize
    }

    /// 判断是否应触发压缩（软阈值）
    pub fn should_compact_soft(&self, estimated_size: usize, usable_budget: u64) -> bool {
        if usable_budget == 0 {
            return false;
        }
        let threshold = (usable_budget as f64) * COMPACT_SOFT_RATIO;
        (estimated_size as f64) >= threshold
    }

    /// 判断是否应强制压缩（硬阈值）
    pub fn should_compact_hard(&self, estimated_size: usize, usable_budget: u64) -> bool {
        if usable_budget == 0 {
            return false;
        }
        let threshold = (usable_budget as f64) * COMPACT_HARD_RATIO;
        (estimated_size as f64) >= threshold
    }
}

pub(super) fn estimate_wire_body_tokens(body: &Value) -> usize {
    let wire_json = serde_json::to_string(body).unwrap_or_default();
    approximate_text_tokens(&wire_json)
}

// ============================================================================
// 辅助估算函数
// ============================================================================

/// 估算单条消息的 token 大小（粗略估算：4 字符/token）
fn estimate_message_size(msg: &Value) -> usize {
    approximate_text_tokens(&serde_json::to_string(msg).unwrap_or_default())
}

fn approximate_text_tokens(value: &str) -> usize {
    let weight = value
        .chars()
        .map(|ch| if ch.is_ascii() { 1usize } else { 4usize })
        .sum();
    approximate_text_tokens_from_weight(weight)
}

fn approximate_text_tokens_from_weight(weight: usize) -> usize {
    (weight + 3) / 4
}

// ============================================================================
// TurnGroup 分组器
// ============================================================================

/// 分析消息并返回压缩计划。
///
/// `min_tail_turns` 控制尾部至少保留的回合数：
/// - 自动压缩建议用 `AUTO_MIN_TAIL_TURNS`（保守）
/// - 手动压缩建议用 `MANUAL_MIN_TAIL_TURNS`（激进）
pub fn build_compaction_plan(
    messages: &[Value],
    session_id: &str,
    stable_conversation_id: &str,
    context_window: u64,
    wire_protocol: WireProtocol,
    tools: &[Value],
    bootstrap_end: usize,
    recent_tail_budget: usize, // 保留的最近 token 预算
    min_tail_turns: usize,     // 尾部至少保留的回合数
) -> CompactionPlan {
    let estimator = TokenEstimator::new();
    let estimated_size =
        estimator.estimate_request_size(messages, tools, context_window, wire_protocol);
    let usable_budget = estimator.usable_budget(context_window);

    // 2. 分组消息为 TurnGroup
    let turns = group_into_turns(messages, bootstrap_end);

    // 2.5 回合数不足时直接返回空计划，避免后续计算浪费。
    let total_turns = turns.len();
    if total_turns < MIN_TURNS_FOR_COMPACT {
        return CompactionPlan::new_inadequate(
            session_id.to_string(),
            stable_conversation_id.to_string(),
            bootstrap_end,
            total_turns,
        );
    }

    // 3. 计算每个回合的估算 token 数
    let turns_with_tokens: Vec<TurnGroup> = turns
        .into_iter()
        .map(|mut turn| {
            turn.estimated_tokens = messages[turn.start_index..turn.end_index]
                .iter()
                .map(estimate_message_size)
                .sum();
            turn
        })
        .collect();

    // 4. 从尾部保留完整回合。至少保留 min_tail_turns 个；在此基础上尽量填满预算。
    let mut tail_turn_start = turns_with_tokens.len();
    let mut tail_tokens = 0usize;
    for index in (0..turns_with_tokens.len()).rev() {
        let turn = &turns_with_tokens[index];
        let must_keep = turns_with_tokens.len() - index <= min_tail_turns;
        if must_keep || tail_tokens.saturating_add(turn.estimated_tokens) <= recent_tail_budget {
            tail_turn_start = index;
            tail_tokens = tail_tokens.saturating_add(turn.estimated_tokens);
        } else {
            break;
        }
    }
    // 强制同时保留至少一个完整尾部回合、归档至少一个完整旧回合。
    // 大 context window 下 recent_tail_budget 可能容纳全部历史；若不收紧，手动压缩会
    // 得到 compactable_turns=[]，与“至少三个回合即可压缩”的契约冲突。
    let tail_turn_start = tail_turn_start.clamp(1, turns_with_tokens.len() - 1);

    let recent_tail_start = turns_with_tokens
        .get(tail_turn_start)
        .map(|turn| turn.start_index)
        .unwrap_or(messages.len());

    // 5. 只有尾部之前的完整回合可归档。
    let compactable_turns: Vec<TurnGroup> = turns_with_tokens
        .iter()
        .take(tail_turn_start)
        .cloned()
        .collect();

    // 6. 估算压缩后的大小（briefing 的实际大小由协调器提交前二次检查）。
    let estimated_after = estimated_size.saturating_sub(
        compactable_turns
            .iter()
            .map(|t| t.estimated_tokens)
            .sum::<usize>(),
    );

    // 7. 判断是否应触发压缩
    let should_compact = estimator.should_compact_soft(estimated_size, usable_budget);

    CompactionPlan {
        session_id: session_id.to_string(),
        stable_conversation_id: stable_conversation_id.to_string(),
        bootstrap_end,
        compactable_turns,
        recent_tail_start,
        recent_tail_turn_count: turns_with_tokens.len().saturating_sub(tail_turn_start),
        estimated_before: estimated_size,
        estimated_after,
        usable_input_budget: usable_budget,
        should_compact,
    }
}

/// 将消息分组为 TurnGroup
fn group_into_turns(messages: &[Value], bootstrap_end: usize) -> Vec<TurnGroup> {
    let mut turns = Vec::new();
    let start = if bootstrap_end > 0 { bootstrap_end } else { 1 };

    let mut i = start;
    while i < messages.len() {
        let Some(user_role) = messages[i].get("role").and_then(|r| r.as_str()) else {
            i += 1;
            continue;
        };

        if user_role != "user" {
            i += 1;
            continue;
        }

        // 找到了 user 消息，开始分组
        let turn_start = i;

        // 查找该回合的结束位置
        i += 1; // 跳过 user
        let mut tool_call_count = 0;

        while i < messages.len() {
            let role = messages[i]
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("");

            if role == "assistant" {
                // 检查是否有 tool_calls
                if let Some(tc) = messages[i].get("tool_calls").and_then(|tc| tc.as_array()) {
                    tool_call_count += tc.len();
                }
                i += 1;
            } else if role == "tool" {
                // 对应 tool_calls 的工具结果
                i += 1;
            } else if role == "user" {
                // 遇到下一个 user 消息，回合结束
                break;
            } else if role == "system" {
                // 系统消息在中间出现，跳过
                i += 1;
            } else {
                i += 1;
            }
        }

        if i > turn_start {
            turns.push(TurnGroup::new(turn_start, i, tool_call_count));
        }
    }

    turns
}

// ============================================================================
// 结构化消息序列化（用于 compaction 摘要输入）
// ============================================================================

/// 将消息序列化为结构化文本（保留工具名、参数、call_id、结果状态）
pub fn render_message_for_compaction(messages: &[Value], start: usize, end: usize) -> String {
    let mut lines = Vec::new();

    for msg in &messages[start..end] {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("?");

        match role {
            "user" => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    lines.push(format!("[user]: {}", content));
                }
            }
            "assistant" => {
                let mut parts = Vec::new();
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        parts.push(format!("[assistant text]: {}", content));
                    }
                }
                if let Some(tc_array) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                    for tc in tc_array {
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown");
                        let args = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                            .unwrap_or("{}");
                        let call_id = tc.get("id").and_then(|id| id.as_str()).unwrap_or("");
                        parts.push(format!(
                            "[assistant tool_call]: {}(id={}, args={})",
                            name, call_id, args
                        ));
                    }
                }
                if parts.is_empty() {
                    parts.push("[assistant]:".to_string());
                }
                lines.extend(parts);
            }
            "tool" => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    let call_id = msg
                        .get("tool_call_id")
                        .and_then(|id| id.as_str())
                        .unwrap_or("");
                    let name = msg.get("name").and_then(Value::as_str).unwrap_or("unknown");
                    let success = msg.get("success").and_then(Value::as_bool);
                    lines.push(format!(
                        "[tool result]: name={}, id={}, success={}, content={}",
                        name,
                        call_id,
                        success
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string()),
                        content
                    ));
                }
            }
            "system" => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    lines.push(format!("[system]: {}", content));
                }
            }
            _ => {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    lines.push(format!("[{}]: {}", role, content));
                }
            }
        }
    }

    lines.join("\n\n")
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_estimator_calibrates_correctly() {
        let mut estimator = TokenEstimator::new();
        assert_eq!(estimator.calibration_factor(), 1.0);

        estimator.calibrate(1000, 1000);
        assert!((estimator.calibration_factor() - 1.0).abs() < 0.01);

        estimator.calibrate(1200, 1000);
        assert!((estimator.calibration_factor() - 1.2).abs() < 0.01);
    }

    #[test]
    fn build_compaction_plan_with_short_history() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "system prompt"}),
            serde_json::json!({"role": "user", "content": "hello"}),
        ];
        let plan = build_compaction_plan(
            &messages,
            "session-1",
            "stable-1",
            DEFAULT_CONTEXT_WINDOW,
            WireProtocol::OpenAIChat,
            &[],
            1,
            DEFAULT_CONTEXT_WINDOW as usize / 10,
            MANUAL_MIN_TAIL_TURNS,
        );

        // 历史太短，不应该触发压缩
        assert!(!plan.should_compact);
        assert!(plan.compactable_turns.is_empty());
    }

    #[test]
    fn build_compaction_plan_with_exactly_min_turns() {
        // MIN_TURNS_FOR_COMPACT = 3，测试恰好 3 个回合
        let messages = vec![
            serde_json::json!({"role": "system", "content": "sys"}),
            serde_json::json!({"role": "user", "content": "u1"}),
            serde_json::json!({"role": "assistant", "content": "a1"}),
            serde_json::json!({"role": "user", "content": "u2"}),
            serde_json::json!({"role": "assistant", "content": "a2"}),
            serde_json::json!({"role": "user", "content": "u3"}),
            serde_json::json!({"role": "assistant", "content": "a3"}),
        ];
        let plan = build_compaction_plan(
            &messages,
            "session-1",
            "stable-1",
            DEFAULT_CONTEXT_WINDOW,
            WireProtocol::OpenAIChat,
            &[],
            1,
            DEFAULT_CONTEXT_WINDOW as usize / 10,
            MANUAL_MIN_TAIL_TURNS,
        );

        // 恰好 3 回合，至少保留 2 个尾部回合 → 1 个可压缩
        assert!(!plan.compactable_turns.is_empty());
        assert_eq!(plan.compactable_turns.len(), 1);
        assert_eq!(plan.recent_tail_turn_count, 2);
    }

    #[test]
    fn group_into_turns_handles_tool_calls() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "sys"}),
            serde_json::json!({"role": "user", "content": "u1"}),
            serde_json::json!({"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]}),
            serde_json::json!({"role": "tool", "content": "r1"}),
            serde_json::json!({"role": "assistant", "content": "done"}),
            serde_json::json!({"role": "user", "content": "u2"}),
        ];

        let turns = group_into_turns(&messages, 1);
        assert_eq!(turns.len(), 2); // 两个 user 回合
        assert_eq!(turns[0].start_index, 1); // user: u1
        assert_eq!(turns[0].end_index, 5); // 完整覆盖 tool_call/result/final assistant
        assert_eq!(turns[0].tool_call_count, 1);
    }

    #[test]
    fn bootstrap_messages_are_never_grouped_or_compacted() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "persona"}),
            serde_json::json!({"role": "user", "content": "environment bootstrap"}),
            serde_json::json!({"role": "user", "content": "u1"}),
            serde_json::json!({"role": "assistant", "content": "a1"}),
            serde_json::json!({"role": "user", "content": "u2"}),
            serde_json::json!({"role": "assistant", "content": "a2"}),
            serde_json::json!({"role": "user", "content": "u3"}),
            serde_json::json!({"role": "assistant", "content": "a3"}),
        ];
        let plan = build_compaction_plan(
            &messages,
            "runtime",
            "stable",
            DEFAULT_CONTEXT_WINDOW,
            WireProtocol::OpenAIChat,
            &[],
            2,
            usize::MAX,
            MANUAL_MIN_TAIL_TURNS,
        );
        assert!(plan
            .compactable_turns
            .iter()
            .all(|turn| turn.start_index >= 2));
        assert!(plan.recent_tail_start >= 2);
    }

    #[test]
    fn render_message_for_compaction_preserves_structure() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "list files"}),
            serde_json::json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_1", "function": {"name": "bash", "arguments": "{}"}}
                ]
            }),
            serde_json::json!({"role": "tool", "tool_call_id": "call_1", "name": "bash", "success": true, "content": "file1\nfile2"}),
        ];

        let rendered = render_message_for_compaction(&messages, 0, 3);
        assert!(rendered.contains("[user]: list files"));
        assert!(rendered.contains("[assistant tool_call]: bash"));
        assert!(rendered.contains("[tool result]: name=bash, id=call_1, success=true"));
    }
}
