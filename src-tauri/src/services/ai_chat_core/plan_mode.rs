//! PlanMode pending 队列（K-R6 自 ai_chat_core.rs 迁入）

// ============================================================================
// PlanMode 相关命令
// ============================================================================

use crate::models::PlanApprovalResultEvent;
use crate::state::{PendingPlan, PlanApprovalStatus};
use crate::error::{AppError, Result};
use super::events::*;

/// 注册待审批计划
///
/// 当收到 plan_approval_request 事件时调用此函数
pub fn register_pending_plan(
    session_id: String,
    plan_id: String,
    title: Option<String>,
    description: Option<String>,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[register_pending_plan] 注册计划: session={}, plan={}, title={:?}",
        session_id,
        plan_id,
        title
    );

    let plan = PendingPlan {
        plan_id: plan_id.clone(),
        session_id,
        title,
        description,
        status: PlanApprovalStatus::Pending,
        feedback: None,
    };

    let mut pending = state
        .pending_plans
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(plan_id, plan);

    Ok(())
}

/// 批准计划
///
/// 用户批准计划后调用此函数
pub async fn approve_plan(
    session_id: String,
    plan_id: String,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[approve_plan] 批准计划: session={}, plan={}",
        session_id,
        plan_id
    );

    // 更新计划状态并移除已处理的条目（避免内存泄漏）
    {
        let mut pending = state
            .pending_plans
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if pending.remove(&plan_id).is_some() {
            tracing::info!("[approve_plan] 已移除待处理计划: {}", plan_id);
        } else {
            tracing::warn!("[approve_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已批准
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, true);

    // B3（审计 1.3）：此前硬编码 contextId="main"，前端路由必丢（本端靠乐观
    // 更新掩盖，另一端的审批卡永远停在待处理态）。改按引擎 conversationId
    // 寻址，前端按 conversationId 反查投递到发起会话。
    let payload = wrap_session_routed_event(&session_id, serde_json::json!(event));

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &payload);

    tracing::info!("[approve_plan] 计划已批准，事件已发送");

    Ok(())
}

/// 拒绝计划
///
/// 用户拒绝计划后调用此函数
pub async fn reject_plan(
    session_id: String,
    plan_id: String,
    feedback: Option<String>,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[reject_plan] 拒绝计划: session={}, plan={}, feedback={:?}",
        session_id,
        plan_id,
        feedback
    );

    // 更新计划状态并移除已处理的条目（避免内存泄漏）
    {
        let mut pending = state
            .pending_plans
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if pending.remove(&plan_id).is_some() {
            tracing::info!("[reject_plan] 已移除待处理计划: {}", plan_id);
        } else {
            tracing::warn!("[reject_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已拒绝
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, false)
        .with_feedback(feedback.unwrap_or_default());

    // B3（审计 1.3）：同 approve_plan——去硬编码 main，按 conversationId 寻址
    let payload = wrap_session_routed_event(&session_id, serde_json::json!(event));

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &payload);

    tracing::info!("[reject_plan] 计划已拒绝，事件已发送");

    Ok(())
}

/// 获取待审批计划列表
pub fn get_pending_plans(
    session_id: Option<String>,
    state: &crate::AppState,
) -> Result<Vec<PendingPlan>> {
    let pending = state
        .pending_plans
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let plans: Vec<PendingPlan> = pending
        .values()
        .filter(|p| {
            if let Some(ref sid) = session_id {
                &p.session_id == sid
            } else {
                true
            }
        })
        .filter(|p| matches!(p.status, PlanApprovalStatus::Pending))
        .cloned()
        .collect();

    Ok(plans)
}

/// 清除已处理的计划
pub fn clear_processed_plans(state: &crate::AppState) -> Result<usize> {
    let mut pending = state
        .pending_plans
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let initial_count = pending.len();
    pending.retain(|_, p| matches!(p.status, PlanApprovalStatus::Pending));
    let removed = initial_count - pending.len();

    tracing::info!("[clear_processed_plans] 清除了 {} 个已处理计划", removed);

    Ok(removed)
}

