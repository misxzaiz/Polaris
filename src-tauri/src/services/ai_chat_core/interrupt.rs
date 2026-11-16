//! interrupt_chat_inner（K-R6 自 ai_chat_core.rs 迁入）

use crate::ai::EngineId;
use crate::error::{AppError, Result};
use super::events::append_session_event;

pub async fn interrupt_chat_inner(
    session_id: String,
    engine_id: Option<String>,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[interrupt_chat_inner] 中断会话: {} (engine_id hint: {:?})",
        session_id,
        engine_id
    );
    let engine = engine_id.as_ref().map(|id| EngineId::parse_any(id));
    let mut registry = state.engine_registry.lock().await;

    // 优先按前端给出的 engine_id 路由;失败时回退遍历所有引擎.
    //
    // 背景: per-session 多引擎改造后,前端 metadata.engineId 与后端实际启动会话所用
    // 引擎在边角路径(scheduler 自动创建、history 恢复缺失 engineId、fork)下可能错配.
    // 早期实现仅在 engine_id == None 时才走 try_interrupt_all,导致错配场景下中断
    // 直接报错,前端吞错后 UI 假装已停,但进程实际仍在运行.此处增加兜底:
    //   1. 指定的引擎能找到 session    -> 命中,直接成功
    //   2. 指定的引擎找不到/未注册     -> 降级到 try_interrupt_all,日志记录
    //   3. 所有引擎都找不到             -> 返回 "未找到会话"
    if let Some(engine) = engine {
        match registry.interrupt(&engine, &session_id) {
            Ok(()) => {}
            Err(primary_err) => {
                tracing::warn!(
                    "[interrupt_chat_inner] 指定引擎 {} 中断失败 ({}), 回退到全引擎兜底",
                    engine,
                    primary_err
                );
                if !registry.try_interrupt_all(&session_id) {
                    return Err(AppError::ProcessError(format!(
                        "未找到会话: {} (尝试引擎 {} 失败且全引擎兜底未命中: {})",
                        session_id, engine, primary_err
                    )));
                }
                tracing::info!(
                    "[interrupt_chat_inner] 通过全引擎兜底成功中断 session: {}",
                    session_id
                );
            }
        }
    } else if !registry.try_interrupt_all(&session_id) {
        return Err(AppError::ProcessError(format!(
            "未找到会话: {}",
            session_id
        )));
    }
    // B2.h（审计 3.10）：晚到 stop——对已自然结束的会话，kill 死 PID 也被当
    // 成功（taskkill 非零仍视为已处理），此前无条件补写 aborted 会把事件日志
    // 里的 completed 改写成 aborted。先查权威状态，非 running 不补写。
    let already_ended = crate::commands::session_state_commands::session_get_status_inner(
        session_id.clone(),
    )
    .map(|s| !s.running)
    .unwrap_or(false);
    if already_ended {
        tracing::info!(
            "[interrupt_chat_inner] 会话已结束，跳过 aborted 补写（晚到 stop 不覆盖 completed）: {}",
            session_id
        );
        return Ok(());
    }
    // 阶段 4 批次 4：中断成功 → 写 session_end(reason=aborted)（影子写入，失败不阻断）
    append_session_event(
        &session_id,
        crate::services::session_state::SessionEventType::SessionEnd,
        Some("aborted".to_string()),
        None,
    );
    tracing::info!("[interrupt_chat_inner] 会话已中断: {}", session_id);
    Ok(())
}

