/*! 统一上下文压缩协调器（Phase 2）
 *
 * 正常压缩绝不原地删除或替换旧 session 的 messages：
 *
 * `plan → checkpoint → briefing → validate → create new runtime session → handoff event`
 *
 * 旧 runtime session 会标记为 archived 并继续保留完整历史；前端将同一可视对话
 * 的后续请求路由到新 runtime session。
 */

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::watch;

use crate::ai::engine::simple_ai_protocol::WireProtocol;
use crate::error::{AppError, Result};
use crate::models::ai_event::{CompactionFailedEvent, ProgressEvent, SessionHandoffEvent};
use crate::models::AIEvent;

use super::checkpoint_store::{ContextCheckpoint, ContextCheckpointStore};
use super::compact::request_summary;
use super::compaction_plan::{build_compaction_plan, render_message_for_compaction, AUTO_MIN_TAIL_TURNS, MANUAL_MIN_TAIL_TURNS, TokenEstimator};
use super::session::{CompactionStatus, SimpleAISession};

/// 压缩来源。第一版仅暴露 Manual，Auto/Recovery 由后续 Phase 3 触发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionTrigger {
    Manual,
    Auto,
    Recovery,
}

impl CompactionTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::Recovery => "recovery",
        }
    }
}

/// 传给异步协调器、不持有 session mutex 的输入快照。
pub(super) struct CompactionInput {
    old_session_id: String,
    new_session_id: String,
    stable_conversation_id: String,
    work_dir: String,
    messages: Vec<Value>,
    bootstrap_end: usize,
    compaction_generation: u64,
    turn_generation: u64,
}

pub(super) fn auto_compaction_enabled(profile: &crate::models::config::ModelProfile) -> bool {
    profile
        .custom_env
        .as_ref()
        .and_then(|env| env.get("SIMPLE_AI_AUTO_COMPACT"))
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

/// Shadow/auto trigger preflight. Does not mutate session state.
pub(super) async fn should_auto_compact(
    sessions: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    session_id: &str,
    profile: &crate::models::config::ModelProfile,
) -> Result<bool> {
    if !auto_compaction_enabled(profile) {
        return Ok(false);
    }
    let (messages, bootstrap_end, stable_id, status, archived) = {
        let guard = sessions.lock().await;
        let session = guard
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        (
            session.messages.clone(),
            session.bootstrap_end,
            session.stable_conversation_id.clone(),
            session.compaction_state.status.clone(),
            session.is_archived,
        )
    };
    if archived || status != CompactionStatus::Idle {
        return Ok(false);
    }
    let window = context_window(profile);
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    let plan = build_compaction_plan(
        &messages,
        session_id,
        &stable_id,
        window,
        protocol,
        &[],
        bootstrap_end,
        ((window as f64) * 0.20) as usize,
        AUTO_MIN_TAIL_TURNS,
    );
    let reclaim = plan.estimated_before.saturating_sub(plan.estimated_after);
    let minimum_reclaim = ((plan.usable_input_budget as f64) * 0.10) as usize;
    Ok(plan.should_compact
        && !plan.compactable_turns.is_empty()
        && reclaim >= minimum_reclaim)
}

pub(super) async fn auto_compact_after_turn(
    sessions: Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    session_id: String,
    profile: crate::models::config::ModelProfile,
    event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
) {
    let should_run = match should_auto_compact(&sessions, &session_id, &profile).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("[SimpleAI] auto compaction preflight failed: {}", error);
            return;
        }
    };
    if !should_run {
        return;
    }

    let new_session_id = format!("simple-ai-{}", uuid::Uuid::new_v4());
    let input = match begin_compaction(&sessions, &session_id, new_session_id, None).await {
        Ok(input) => input,
        Err(error) => {
            tracing::warn!("[SimpleAI] auto compaction begin failed: {}", error);
            return;
        }
    };
    if let Err(error) = compact_and_handoff(
        Arc::clone(&sessions),
        input,
        profile,
        Arc::clone(&event_callback),
        CompactionTrigger::Auto,
    )
    .await
    {
        fail_compaction(&sessions, &session_id, &error, &event_callback).await;
    }
}

/// 从最近完整 checkpoint 恢复一个新的 runtime session。
pub(super) async fn restore_runtime_from_checkpoint(
    sessions: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    missing_session_id: &str,
    new_session_id: String,
    stable_conversation_id: &str,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
) -> Result<String> {
    let checkpoint = ContextCheckpointStore::from_data_root()
        .load_latest_complete(stable_conversation_id)?;
    let briefing = checkpoint
        .briefing
        .clone()
        .ok_or_else(|| AppError::StateError("checkpoint 缺少交接简报".to_string()))?;
    let recent_tail_start = checkpoint
        .recent_tail_start
        .ok_or_else(|| AppError::StateError("checkpoint 缺少 recent-tail 边界".to_string()))?;
    if checkpoint.bootstrap_end > checkpoint.archived_messages.len()
        || recent_tail_start > checkpoint.archived_messages.len()
        || recent_tail_start < checkpoint.bootstrap_end
    {
        return Err(AppError::StateError("checkpoint 消息边界无效".to_string()));
    }

    let mut messages = checkpoint.archived_messages[..checkpoint.bootstrap_end].to_vec();
    messages.push(json!({ "role": "user", "content": briefing }));
    messages.extend_from_slice(&checkpoint.archived_messages[recent_tail_start..]);
    let work_dir = checkpoint.work_dir.clone();

    let (abort_tx, abort_rx) = watch::channel(false);
    let restored = SimpleAISession {
        messages,
        work_dir,
        abort_tx,
        abort_rx,
        is_running: false,
        is_archived: false,
        stable_conversation_id: stable_conversation_id.to_string(),
        bootstrap_end: checkpoint.bootstrap_end,
        latest_request_tokens: None,
        compaction_state: super::session::CompactionState {
            generation: checkpoint.generation,
            status: CompactionStatus::Idle,
            active_checkpoint: Some(checkpoint.generation),
            pending_manual_request: false,
            last_compacted_at_ms: Some(checkpoint.created_at_ms),
            consecutive_failures: 0,
        },
        turn_generation: 0,
    };
    sessions.lock().await.insert(new_session_id.clone(), restored);
    let _ = event_callback(AIEvent::SessionHandoff(
        SessionHandoffEvent::runtime_recovery(
            missing_session_id,
            &new_session_id,
            stable_conversation_id,
            checkpoint.generation,
        ),
    ));
    Ok(new_session_id)
}

/// 将 session 置为压缩准备状态，返回其不可变快照。
#[allow(clippy::too_many_arguments)]
pub(super) async fn begin_compaction(
    sessions: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    old_session_id: &str,
    new_session_id: String,
    requested_stable_id: Option<&str>,
) -> Result<CompactionInput> {
    let mut guard = sessions.lock().await;
    let session = guard
        .get_mut(old_session_id)
        .ok_or_else(|| AppError::SessionNotFound(old_session_id.to_string()))?;

    if session.is_archived {
        return Err(AppError::SessionArchived(old_session_id.to_string()));
    }
    if session.is_running {
        return Err(AppError::SessionAlreadyRunning(old_session_id.to_string()));
    }
    if !matches!(
        session.compaction_state.status,
        CompactionStatus::Idle | CompactionStatus::Cooldown
    ) {
        return Err(AppError::StateError("会话正在处理上下文压缩".to_string()));
    }

    let stable_conversation_id = requested_stable_id
        .filter(|value| !value.is_empty())
        .unwrap_or(&session.stable_conversation_id)
        .to_string();
    if stable_conversation_id.is_empty() {
        return Err(AppError::StateError("会话缺少稳定对话 ID".to_string()));
    }

    session.compaction_state.generation = session.compaction_state.generation.saturating_add(1);
    session.compaction_state.status = CompactionStatus::Preparing;
    let compaction_generation = session.compaction_state.generation;

    Ok(CompactionInput {
        old_session_id: old_session_id.to_string(),
        new_session_id,
        stable_conversation_id,
        work_dir: session.work_dir.clone(),
        messages: session.messages.clone(),
        bootstrap_end: session.bootstrap_end,
        compaction_generation,
        turn_generation: session.turn_generation,
    })
}

#[derive(Debug, Clone)]
pub(super) struct HandoffResult {
    pub(super) new_session_id: String,
}

/// 运行完整压缩交接。调用者必须先调用 begin_compaction。
#[allow(clippy::too_many_arguments)]
pub(super) async fn compact_and_handoff(
    sessions: Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    input: CompactionInput,
    profile: crate::models::config::ModelProfile,
    event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    trigger: CompactionTrigger,
) -> Result<HandoffResult> {
    let context_window = context_window(&profile);
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    let recent_tail_budget = ((context_window as f64) * 0.20) as usize;
    let min_tail = match trigger {
        CompactionTrigger::Manual => MANUAL_MIN_TAIL_TURNS,
        CompactionTrigger::Auto | CompactionTrigger::Recovery => AUTO_MIN_TAIL_TURNS,
    };
    let plan = build_compaction_plan(
        &input.messages,
        &input.old_session_id,
        &input.stable_conversation_id,
        context_window,
        protocol,
        &[],
        input.bootstrap_end,
        recent_tail_budget,
        min_tail,
    );

    if plan.compactable_turns.is_empty() {
        return Err(AppError::StateError("当前可压缩历史不足；对话至少需要3个完整用户回合才能压缩".to_string()));
    }

    let compact_start = plan.compactable_turns.first().expect("checked nonempty").start_index;
    let compact_end = plan.recent_tail_start;
    if compact_end <= compact_start {
        return Err(AppError::StateError("无法确定安全的上下文交接边界".to_string()));
    }

    let store = ContextCheckpointStore::from_data_root();
    let checkpoint_generation = store.next_generation(&input.stable_conversation_id)?;
    let mut checkpoint = ContextCheckpoint::new(
        input.stable_conversation_id.clone(),
        input.old_session_id.clone(),
        input.work_dir.clone(),
        checkpoint_generation,
        None,
        profile.model.clone(),
        protocol.as_str().to_string(),
        input.bootstrap_end,
        // checkpoint 保存交接前完整内部历史；归档区间由 recent_tail_start 描述。
        input.messages.clone(),
        None,
        Some(plan.recent_tail_start),
    );

    // 非破坏性第一步：完整原始消息先落盘。失败时旧 session 完全不变。
    store.write(&checkpoint)?;
    set_phase(&sessions, &input, CompactionStatus::Summarizing, Some(checkpoint_generation)).await?;
    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
        &input.old_session_id,
        "正在生成上下文交接简报…",
    )));

    let evidence = render_message_for_compaction(&input.messages, compact_start, compact_end);
    let briefing = request_summary(&profile, &evidence).await?;
    let briefing = validate_briefing(&briefing, checkpoint_generation)?;

    // 将 briefing 补回 checkpoint，供运行时恢复使用。
    checkpoint.briefing = Some(briefing.clone());
    store.write(&checkpoint)?;
    set_phase(&sessions, &input, CompactionStatus::Committing, Some(checkpoint_generation)).await?;

    let handoff_message = json!({
        "role": "user",
        "content": briefing,
    });
    let mut new_messages = input.messages[..input.bootstrap_end].to_vec();
    new_messages.push(handoff_message);
    new_messages.extend_from_slice(&input.messages[plan.recent_tail_start..]);

    // 提交前二次估算；若压缩后仍处于硬阈值，保留旧 session 并显式失败。
    let estimator = TokenEstimator::new();
    let after = estimator.estimate_request_size(&new_messages, &[], context_window, protocol);
    let budget = estimator.usable_budget(context_window);
    if estimator.should_compact_hard(after, budget) {
        return Err(AppError::StateError("交接简报和最近回合仍超过安全上下文预算".to_string()));
    }

    // 原子交接：只在旧 session 仍是本次准备的 generation、且未开始新 turn 时提交。
    {
        let mut guard = sessions.lock().await;
        let old = guard
            .get_mut(&input.old_session_id)
            .ok_or_else(|| AppError::SessionNotFound(input.old_session_id.clone()))?;
        if old.is_running
            || old.is_archived
            || old.turn_generation != input.turn_generation
            || old.compaction_state.generation != input.compaction_generation
        {
            return Err(AppError::StateError("会话状态在压缩期间已变化，已取消交接".to_string()));
        }
        old.is_archived = true;
        old.compaction_state.status = CompactionStatus::Idle;
        old.compaction_state.active_checkpoint = Some(checkpoint_generation);
        old.compaction_state.last_compacted_at_ms = Some(chrono::Utc::now().timestamp_millis());
        old.compaction_state.consecutive_failures = 0;

        let (abort_tx, abort_rx) = watch::channel(false);
        let new_session = SimpleAISession {
            messages: new_messages,
            work_dir: input.work_dir.clone(),
            abort_tx,
            abort_rx,
            is_running: false,
            is_archived: false,
            stable_conversation_id: input.stable_conversation_id.clone(),
            bootstrap_end: input.bootstrap_end,
            latest_request_tokens: Some(after),
            compaction_state: super::session::CompactionState {
                generation: checkpoint_generation,
                status: CompactionStatus::Idle,
                active_checkpoint: Some(checkpoint_generation),
                pending_manual_request: false,
                last_compacted_at_ms: Some(chrono::Utc::now().timestamp_millis()),
                consecutive_failures: 0,
            },
            turn_generation: 0,
        };
        guard.insert(input.new_session_id.clone(), new_session);
    }

    tracing::info!(
        "[SimpleAI] context handoff committed: trigger={}, stable={}, old={}, new={}, checkpoint={}, turns={}, tokens={}→{}",
        trigger.as_str(),
        input.stable_conversation_id,
        input.old_session_id,
        input.new_session_id,
        checkpoint_generation,
        plan.compactable_turns.len(),
        plan.estimated_before,
        after,
    );
    let _ = event_callback(AIEvent::SessionHandoff(SessionHandoffEvent::new(
        &input.old_session_id,
        &input.new_session_id,
        &input.stable_conversation_id,
        checkpoint_generation,
        plan.estimated_before,
        after,
        plan.compactable_turns.len(),
    )));
    Ok(HandoffResult {
        new_session_id: input.new_session_id,
    })
}

/// 将一次失败收束到旧 session：不改 messages、不 archive；连续失败进入 cooldown。
pub(super) async fn fail_compaction(
    sessions: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    old_session_id: &str,
    error: &AppError,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
) {
    let mut guard = sessions.lock().await;
    if let Some(session) = guard.get_mut(old_session_id) {
        session.compaction_state.active_checkpoint = None;
        session.compaction_state.consecutive_failures = session.compaction_state.consecutive_failures.saturating_add(1);
        session.compaction_state.status = if session.compaction_state.consecutive_failures >= 2 {
            CompactionStatus::Cooldown
        } else {
            CompactionStatus::Idle
        };
    }
    drop(guard);
    let _ = event_callback(AIEvent::CompactionFailed(CompactionFailedEvent::new(
        old_session_id,
        error.to_message(),
    )));
}

async fn set_phase(
    sessions: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, SimpleAISession>>>,
    input: &CompactionInput,
    status: CompactionStatus,
    active_checkpoint: Option<u64>,
) -> Result<()> {
    let mut guard = sessions.lock().await;
    let session = guard
        .get_mut(&input.old_session_id)
        .ok_or_else(|| AppError::SessionNotFound(input.old_session_id.clone()))?;
    if session.is_archived
        || session.is_running
        || session.turn_generation != input.turn_generation
        || session.compaction_state.generation != input.compaction_generation
    {
        return Err(AppError::StateError("压缩期间会话状态已变化".to_string()));
    }
    session.compaction_state.status = status;
    session.compaction_state.active_checkpoint = active_checkpoint;
    Ok(())
}

fn context_window(profile: &crate::models::config::ModelProfile) -> u64 {
    profile
        .custom_env
        .as_ref()
        .and_then(|env| env.get("SIMPLE_AI_CONTEXT_WINDOW"))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(super::compaction_plan::DEFAULT_CONTEXT_WINDOW)
}

fn validate_briefing(raw: &str, generation: u64) -> Result<String> {
    let content = raw.trim();
    if content.is_empty() {
        return Err(AppError::StateError("压缩简报为空".to_string()));
    }
    // 防止 provider 无视输出上限导致新 session 立即再次超限。
    if content.chars().count() > 16_000 {
        return Err(AppError::StateError("压缩简报超过 16k 字符安全上限".to_string()));
    }
    if content.contains("<conversation_handoff") {
        Ok(content.to_string())
    } else {
        Ok(format!(
            "<conversation_handoff version=\"1\" generation=\"{generation}\">\n{content}\n</conversation_handoff>"
        ))
    }
}
