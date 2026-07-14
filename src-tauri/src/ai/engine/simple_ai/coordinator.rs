/*! SimpleAI 混合式上下文压缩协调器。
 *
 * 正常压缩保持同一 runtime session。协调器只处理不可变快照：
 * plan → checkpoint → summarize → validate。调用方在 generation 校验后提交。
 */

use std::sync::Arc;

use serde_json::{json, Value};

use crate::ai::engine::simple_ai_protocol::WireProtocol;
use crate::error::{AppError, Result};
use crate::models::ai_event::ProgressEvent;
use crate::models::AIEvent;

use super::checkpoint_store::{ContextCheckpoint, ContextCheckpointStore};
use super::compact::request_summary;
use super::compaction_plan::{
    build_compaction_plan, render_message_for_compaction, TokenEstimator, AUTO_MIN_TAIL_TURNS,
    DEFAULT_CONTEXT_WINDOW, MANUAL_MIN_TAIL_TURNS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionTrigger {
    Manual,
    AutoSoft,
    AutoHard,
    ContextLimitRecovery,
}

impl CompactionTrigger {
    fn minimum_tail_turns(self) -> usize {
        match self {
            Self::Manual => MANUAL_MIN_TAIL_TURNS,
            Self::ContextLimitRecovery => 1,
            _ => AUTO_MIN_TAIL_TURNS,
        }
    }
}

pub(super) struct CompactionInput {
    pub(super) runtime_session_id: String,
    pub(super) stable_conversation_id: String,
    pub(super) work_dir: String,
    pub(super) messages: Vec<Value>,
    pub(super) bootstrap_end: usize,
    pub(super) profile_id: Option<String>,
    pub(super) profile: crate::models::config::ModelProfile,
    pub(super) tool_specs: Vec<Value>,
    pub(super) latest_provider_input_tokens: Option<u64>,
    pub(super) latest_local_input_tokens: Option<usize>,
    pub(super) trigger: CompactionTrigger,
}

#[derive(Debug, Clone)]
pub(super) struct CompactionOutcome {
    pub(super) messages: Vec<Value>,
    pub(super) checkpoint_generation: u64,
    pub(super) tokens_before: usize,
    pub(super) tokens_after: usize,
    pub(super) archived_turns: usize,
    pub(super) retained_turns: usize,
}

pub(super) fn context_window(profile: &crate::models::config::ModelProfile) -> u64 {
    profile
        .context_window
        .filter(|value| *value > 0)
        .or_else(|| {
            profile
                .custom_env
                .as_ref()
                .and_then(|env| env.get("SIMPLE_AI_CONTEXT_WINDOW"))
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

fn reserved_output(profile: &crate::models::config::ModelProfile) -> u64 {
    profile.max_tokens.unwrap_or(8192).max(1)
}

pub(super) fn auto_compaction_enabled(profile: &crate::models::config::ModelProfile) -> bool {
    profile
        .custom_env
        .as_ref()
        .and_then(|env| env.get("SIMPLE_AI_AUTO_COMPACT"))
        .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

pub(super) fn estimate_snapshot(input: &CompactionInput) -> (TokenEstimator, usize, u64) {
    let mut estimator = TokenEstimator::new();
    let protocol = WireProtocol::from_wire_api(input.profile.wire_api.as_deref());
    if let (Some(actual), Some(previous_local)) = (
        input.latest_provider_input_tokens,
        input.latest_local_input_tokens,
    ) {
        estimator.calibrate(actual, previous_local);
    }
    let estimated = estimator.estimate_request_size(
        &input.messages,
        &input.tool_specs,
        context_window(&input.profile),
        protocol,
    );
    let usable = estimator.usable_budget_with_output(
        context_window(&input.profile),
        reserved_output(&input.profile),
    );
    (estimator, estimated, usable)
}

pub(super) fn should_auto_compact(input: &CompactionInput) -> bool {
    if !auto_compaction_enabled(&input.profile) {
        return false;
    }
    let (estimator, estimated, usable) = estimate_snapshot(input);
    estimator.should_compact_soft(estimated, usable)
}

pub(super) fn should_force_compact(input: &CompactionInput) -> bool {
    let (estimator, estimated, usable) = estimate_snapshot(input);
    estimator.should_compact_hard(estimated, usable)
}

pub(super) async fn compact_snapshot(
    input: CompactionInput,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
) -> Result<CompactionOutcome> {
    if input.stable_conversation_id.trim().is_empty() {
        return Err(AppError::StateError(
            "SimpleAI 会话缺少稳定对话 ID".to_string(),
        ));
    }
    if input.bootstrap_end == 0 || input.bootstrap_end > input.messages.len() {
        return Err(AppError::StateError(
            "SimpleAI bootstrap 边界无效".to_string(),
        ));
    }

    let protocol = WireProtocol::from_wire_api(input.profile.wire_api.as_deref());
    let window = context_window(&input.profile);
    let (estimator, tokens_before, usable_budget) = estimate_snapshot(&input);
    if usable_budget == 0 {
        return Err(AppError::StateError(
            "模型输出预留超过上下文窗口".to_string(),
        ));
    }

    // Provider 已明确拒绝时采用最激进的安全策略：仅保留当前完整用户回合，
    // 仍绝不拆分其中的 assistant tool_call / tool_result / final assistant 链。
    let recent_tail_budget = if input.trigger == CompactionTrigger::ContextLimitRecovery {
        0
    } else {
        ((usable_budget as f64) * 0.20) as usize
    };
    let plan = build_compaction_plan(
        &input.messages,
        &input.runtime_session_id,
        &input.stable_conversation_id,
        window,
        protocol,
        &input.tool_specs,
        input.bootstrap_end,
        recent_tail_budget,
        input.trigger.minimum_tail_turns(),
    );
    if plan.compactable_turns.is_empty() {
        return Err(AppError::StateError(
            "当前可压缩历史不足，需要至少三个完整用户回合".to_string(),
        ));
    }

    let compact_start = plan
        .compactable_turns
        .first()
        .map(|turn| turn.start_index)
        .ok_or_else(|| AppError::StateError("压缩起始边界不存在".to_string()))?;
    let compact_end = plan.recent_tail_start;
    if compact_start < input.bootstrap_end
        || compact_end <= compact_start
        || compact_end > input.messages.len()
    {
        return Err(AppError::StateError(
            "无法确定安全的完整回合压缩边界".to_string(),
        ));
    }

    let store = ContextCheckpointStore::from_data_root();
    let checkpoint_generation = store.next_generation(&input.stable_conversation_id)?;
    let mut checkpoint = ContextCheckpoint::new(
        input.stable_conversation_id.clone(),
        input.runtime_session_id.clone(),
        input.work_dir.clone(),
        checkpoint_generation,
        input.profile_id.clone(),
        input.profile.model.clone(),
        protocol.as_str().to_string(),
        input.bootstrap_end,
        input.messages.clone(),
        None,
        Some(plan.recent_tail_start),
    );

    // 必须先持久化完整原始消息。此后任意失败都不影响运行中 history。
    store.write(&checkpoint)?;
    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
        &input.runtime_session_id,
        "正在生成上下文交接简报…",
    )));

    let evidence = render_message_for_compaction(&input.messages, compact_start, compact_end);
    let briefing = request_summary(&input.profile, &evidence, checkpoint_generation).await?;
    let briefing = validate_briefing(&briefing, checkpoint_generation)?;

    let mut messages = input.messages[..input.bootstrap_end].to_vec();
    messages.push(json!({
        "role": "user",
        "content": briefing.clone(),
        "_polaris_internal": "context_compaction",
        "generation": checkpoint_generation,
    }));
    messages.extend_from_slice(&input.messages[plan.recent_tail_start..]);

    let tokens_after =
        estimator.estimate_request_size(&messages, &input.tool_specs, window, protocol);
    let hard_limit = estimator.hard_threshold(usable_budget);
    let target_limit = ((usable_budget as f64) * 0.55) as usize;
    if tokens_after >= hard_limit {
        return Err(AppError::StateError(
            "压缩后请求仍超过硬安全阈值，原历史保持不变".to_string(),
        ));
    }
    if tokens_after > target_limit {
        return Err(AppError::StateError(format!(
            "压缩后请求未回落到目标预算：{} > {}",
            tokens_after, target_limit
        )));
    }

    let reclaimed = tokens_before.saturating_sub(tokens_after);
    let minimum_reclaim = ((usable_budget as f64) * 0.10) as usize;
    if reclaimed < minimum_reclaim && input.trigger != CompactionTrigger::ContextLimitRecovery {
        return Err(AppError::StateError(
            "本次压缩预计回收量不足，已跳过提交".to_string(),
        ));
    }

    // 只有所有语义与预算校验均通过后，才把 briefing 标记为可恢复状态。此前留下的
    // checkpoint 始终是完整原历史，不会在 runtime 恢复时误应用被拒绝的摘要。
    checkpoint.briefing = Some(briefing);
    store.write(&checkpoint)?;

    Ok(CompactionOutcome {
        messages,
        checkpoint_generation,
        tokens_before,
        tokens_after,
        archived_turns: plan.compactable_turns.len(),
        retained_turns: plan.recent_tail_turn_count,
    })
}

pub(super) fn restore_messages(checkpoint: &ContextCheckpoint) -> Result<Vec<Value>> {
    if checkpoint.bootstrap_end == 0
        || checkpoint.bootstrap_end > checkpoint.archived_messages.len()
    {
        return Err(AppError::StateError(
            "checkpoint bootstrap 边界无效".to_string(),
        ));
    }
    let Some(briefing) = checkpoint
        .briefing
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        // 准备阶段 checkpoint 仍包含完整原始历史，可以无损恢复后重新压缩。
        return Ok(checkpoint.archived_messages.clone());
    };
    let tail = checkpoint
        .recent_tail_start
        .ok_or_else(|| AppError::StateError("checkpoint 缺少 recent tail".to_string()))?;
    if tail < checkpoint.bootstrap_end || tail > checkpoint.archived_messages.len() {
        return Err(AppError::StateError(
            "checkpoint recent tail 边界无效".to_string(),
        ));
    }

    let mut messages = checkpoint.archived_messages[..checkpoint.bootstrap_end].to_vec();
    messages.push(json!({
        "role": "user",
        "content": briefing,
        "_polaris_internal": "context_compaction",
        "generation": checkpoint.generation,
    }));
    messages.extend_from_slice(&checkpoint.archived_messages[tail..]);
    Ok(messages)
}

pub(super) fn load_latest_checkpoint(stable_conversation_id: &str) -> Result<ContextCheckpoint> {
    ContextCheckpointStore::from_data_root().load_latest(stable_conversation_id)
}

pub(super) fn load_checkpoint(
    stable_conversation_id: &str,
    generation: u64,
) -> Result<ContextCheckpoint> {
    ContextCheckpointStore::from_data_root().load(stable_conversation_id, generation)
}

/// Context-limit recovery summarizes before retrying the provider request. Once that retry
/// succeeds, append the newly generated complete suffix to the checkpoint so both undo and
/// runtime recovery include the successful assistant/tool output. This durable write must
/// finish before the caller commits the compacted messages in memory.
pub(super) fn finalize_recovery_checkpoint(
    stable_conversation_id: &str,
    generation: u64,
    archived_messages: Vec<Value>,
) -> Result<()> {
    let store = ContextCheckpointStore::from_data_root();
    let mut checkpoint = store.load(stable_conversation_id, generation)?;
    checkpoint.archived_messages = archived_messages;
    store.write(&checkpoint)
}

/// Persist an undo marker before changing in-memory history. A later runtime recovery must load
/// the restored full history rather than silently re-applying the briefing that the user undid.
pub(super) fn mark_checkpoint_restored(
    stable_conversation_id: &str,
    generation: u64,
) -> Result<()> {
    let store = ContextCheckpointStore::from_data_root();
    let mut checkpoint = store.load(stable_conversation_id, generation)?;
    checkpoint.briefing = None;
    checkpoint.recent_tail_start = None;
    store.write(&checkpoint)
}

/// A context-limit retry that fails must not become the next runtime-recovery state. Rewrite the
/// known generation as a full, non-compacted snapshot before the caller rolls memory back.
pub(super) fn rollback_recovery_checkpoint(
    stable_conversation_id: &str,
    generation: u64,
    archived_messages: Vec<Value>,
) -> Result<()> {
    let store = ContextCheckpointStore::from_data_root();
    let mut checkpoint = store.load(stable_conversation_id, generation)?;
    checkpoint.archived_messages = archived_messages;
    checkpoint.briefing = None;
    checkpoint.recent_tail_start = None;
    store.write(&checkpoint)
}

pub(super) fn rollback_latest_matching_checkpoint(
    stable_conversation_id: &str,
    runtime_session_id: &str,
    expected_archived_messages: &[Value],
    archived_messages: Vec<Value>,
) -> Result<bool> {
    let store = ContextCheckpointStore::from_data_root();
    let mut checkpoint = match store.load_latest(stable_conversation_id) {
        Ok(checkpoint) => checkpoint,
        Err(AppError::SessionNotFound(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    if checkpoint.runtime_session_id != runtime_session_id
        || checkpoint.archived_messages != expected_archived_messages
    {
        return Ok(false);
    }
    checkpoint.archived_messages = archived_messages;
    checkpoint.briefing = None;
    checkpoint.recent_tail_start = None;
    store.write(&checkpoint)?;
    Ok(true)
}

/// Keep the latest durable snapshot current between compactions. The snapshot may be compacted
/// or a full fallback left by a failed/undone compaction. The suffix must start at a user-turn
/// boundary and is appended only after the turn has fully completed (or was explicitly
/// interrupted with its visible partial assistant text persisted).
pub(super) fn append_latest_checkpoint_tail(
    stable_conversation_id: &str,
    base_messages: &[Value],
    suffix: &[Value],
) -> Result<Option<u64>> {
    if suffix.is_empty() {
        return Ok(None);
    }
    if suffix
        .first()
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        return Err(AppError::StateError(
            "checkpoint 增量后缀未从完整用户回合开始".to_string(),
        ));
    }
    let store = ContextCheckpointStore::from_data_root();
    let mut checkpoint = match store.load_latest(stable_conversation_id) {
        Ok(checkpoint) => checkpoint,
        Err(AppError::SessionNotFound(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    let generation = checkpoint.generation;
    let restored = restore_messages(&checkpoint)?;
    if !checkpoint_tail_needs_append(&restored, base_messages, suffix)? {
        return Ok(Some(generation));
    }
    checkpoint.archived_messages.extend_from_slice(suffix);
    store.write(&checkpoint)?;
    Ok(Some(generation))
}

fn checkpoint_tail_needs_append(
    restored_messages: &[Value],
    base_messages: &[Value],
    suffix: &[Value],
) -> Result<bool> {
    let mut expected_messages = base_messages.to_vec();
    expected_messages.extend_from_slice(suffix);
    if restored_messages == expected_messages {
        return Ok(false);
    }
    if restored_messages == base_messages {
        return Ok(true);
    }
    Err(AppError::StateError(
        "最新 checkpoint 与当前 runtime 基线不一致，拒绝盲目追加".to_string(),
    ))
}

pub(super) fn delete_checkpoints(stable_conversation_id: &str) -> Result<()> {
    ContextCheckpointStore::from_data_root().delete_all(stable_conversation_id)
}

fn validate_briefing(raw: &str, generation: u64) -> Result<String> {
    let content = raw.trim();
    if content.is_empty() {
        return Err(AppError::StateError("压缩简报为空".to_string()));
    }
    if content.chars().count() > 16_000 {
        return Err(AppError::StateError(
            "压缩简报超过 16k 字符安全上限".to_string(),
        ));
    }
    let opening = "<conversation_handoff";
    let closing = "</conversation_handoff>";
    if content.contains(opening) && content.contains(closing) {
        Ok(content.to_string())
    } else {
        Ok(format!(
            "<conversation_handoff version=\"1\" generation=\"{generation}\">\n{content}\n\
<archive_ref checkpoint=\"{generation}\" />\n</conversation_handoff>"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_checkpoint_restores_full_history() {
        let checkpoint = ContextCheckpoint::new(
            "stable".to_string(),
            "runtime".to_string(),
            ".".to_string(),
            1,
            None,
            "model".to_string(),
            "openai-chat-completions".to_string(),
            1,
            vec![
                json!({"role":"system","content":"s"}),
                json!({"role":"user","content":"u"}),
            ],
            None,
            Some(1),
        );
        assert_eq!(
            restore_messages(&checkpoint).unwrap(),
            checkpoint.archived_messages
        );
    }

    #[test]
    fn complete_checkpoint_restores_bootstrap_briefing_and_tail() {
        let checkpoint = ContextCheckpoint::new(
            "stable".to_string(),
            "runtime".to_string(),
            ".".to_string(),
            2,
            None,
            "model".to_string(),
            "openai-chat-completions".to_string(),
            1,
            vec![
                json!({"role":"system","content":"s"}),
                json!({"role":"user","content":"old"}),
                json!({"role":"assistant","content":"old-a"}),
                json!({"role":"user","content":"recent"}),
            ],
            Some("<conversation_handoff>brief</conversation_handoff>".to_string()),
            Some(3),
        );
        let restored = restore_messages(&checkpoint).unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(restored[0]["role"], "system");
        assert_eq!(restored[1]["_polaris_internal"], "context_compaction");
        assert_eq!(restored[2]["content"], "recent");
    }

    #[test]
    fn checkpoint_tail_sync_distinguishes_base_complete_and_divergent_states() {
        let base = vec![
            json!({"role":"system","content":"s"}),
            json!({"role":"user","content":"same"}),
        ];
        let suffix = vec![
            json!({"role":"user","content":"same"}),
            json!({"role":"assistant","content":"same"}),
        ];
        assert!(checkpoint_tail_needs_append(&base, &base, &suffix).unwrap());

        let mut complete = base.clone();
        complete.extend_from_slice(&suffix);
        assert!(!checkpoint_tail_needs_append(&complete, &base, &suffix).unwrap());

        let divergent = vec![json!({"role":"system","content":"other"})];
        assert!(checkpoint_tail_needs_append(&divergent, &base, &suffix).is_err());
    }
}
