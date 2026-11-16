//! 插件卡帧处理（K-R3 拆分）

use super::types::PluginCardOutcome;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use crate::error::{AppError, Result};
use crate::state::{PendingPluginCard, PluginCardStatus};
use super::emit::*;
use super::frames::{read_frame, write_frame};
use super::types::{MAX_FRAME_SIZE, PLUGIN_CARD_TIMEOUT};
use super::parsed::parse_questions;

use serde_json::{json, Value};
use uuid::Uuid;
use std::sync::Arc;
use crate::state::AppState;

pub async fn handle_card_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let interaction_id = frame
        .get("interactionId")
        .or_else(|| frame.get("callId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let plugin_id = frame
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let card_id = frame
        .get("cardId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_name = frame
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);

    if plugin_id.trim().is_empty() {
        return Err(AppError::ValidationError("card 帧缺少 pluginId".into()));
    }
    if card_id.trim().is_empty() {
        return Err(AppError::ValidationError("card 帧缺少 cardId".into()));
    }

    let (tx, rx) = oneshot::channel::<PluginCardOutcome>();
    {
        let mut pending = state
            .pending_plugin_cards
            .lock()
            .map_err(|e| AppError::ProcessError(format!("pending_plugin_cards 锁: {}", e)))?;
        pending.insert(
            interaction_id.clone(),
            PendingPluginCard {
                interaction_id: interaction_id.clone(),
                session_id: session_id.clone(),
                call_id,
                plugin_id: plugin_id.clone(),
                card_id: card_id.clone(),
                tool_name: tool_name.clone(),
                payload: payload.clone(),
                status: PluginCardStatus::Pending,
                source: None,
            },
        );
    }
    state.register_plugin_card_answer_sender(&interaction_id, tx);

    emit_plugin_card_event(
        &state,
        &session_id,
        &interaction_id,
        &plugin_id,
        &card_id,
        &tool_name,
        payload,
    );

    let outcome = match tokio::time::timeout(PLUGIN_CARD_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_recv_err)) => {
            tracing::info!(
                "[AskListener] interaction_id={} oneshot 被丢弃，按 declined 处理",
                interaction_id
            );
            PluginCardOutcome::declined()
        }
        Err(_elapsed) => {
            tracing::info!(
                "[AskListener] interaction_id={} 超时，按 declined 处理",
                interaction_id
            );
            emit_plugin_card_answered_event(
                &state,
                &session_id,
                &interaction_id,
                true,
                Value::Null,
            );
            PluginCardOutcome::declined()
        }
    };

    write_frame(stream, &serde_json::to_value(&outcome)?).await?;
    let _ = stream.shutdown().await;

    if let Ok(mut pending) = state.pending_plugin_cards.lock() {
        pending.remove(&interaction_id);
    }
    state.take_plugin_card_answer_sender(&interaction_id);

    Ok(())
}

/// 解析来源会话的派发深度：`dispatch-{depth}-{id}` → depth，普通会话 → 0。
pub fn parse_dispatch_depth(source_session_id: &str) -> u32 {
    source_session_id
        .strip_prefix("dispatch-")
        .and_then(|rest| rest.split('-').next())
        .and_then(|seg| seg.parse::<u32>().ok())
        .unwrap_or(if source_session_id.starts_with("dispatch-") {
            1
        } else {
            0
        })
}
