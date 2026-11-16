//! TCP listener：spawn / accept 循环 / ask 帧处理（K-R3 拆分）

use crate::error::{AppError, Result};
use tokio::net::{TcpListener, TcpStream};
use crate::services::ask_listener_meta::{self, AskListenerMeta};
use super::parsed::{emit_question_event, parse_questions, parsed_to_item, ParsedQuestion};
use super::emit::*;
use super::form::handle_form_frame;
use super::cancel::{handle_cancel_frame, handle_card_cancel_frame};
use super::plugin_card::handle_card_frame;
use super::types::*;

use serde_json::{json, Value};
use uuid::Uuid;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use crate::state::{AppState, PendingQuestion, QuestionItem, QuestionOption, QuestionStatus};
use crate::services::form_flow;
use super::frames::{read_frame, write_frame};

/// Bind a TCP socket on 127.0.0.1 (port pool first, random fallback) and spawn
/// the accept loop.
///
/// The loop runs for the app's lifetime — no graceful-shutdown signal is
/// wired here because connections are short-lived (one request/response per
/// connection) and Tokio drops the task at process exit.
pub async fn spawn_ask_listener(state: Arc<AppState>) -> Result<AskListenerHandle> {
    // 优先从固定端口池里挑一个空闲端口；全占用才回落系统随机。
    let mut bound: Option<(TcpListener, u16)> = None;
    for port in ASK_LISTENER_PORT_POOL {
        match TcpListener::bind(("127.0.0.1", *port)).await {
            Ok(listener) => {
                bound = Some((listener, *port));
                break;
            }
            Err(_) => continue, // 端口被占用，尝试下一个
        }
    }
    let (listener, port) = match bound {
        Some(pair) => pair,
        None => {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| AppError::ProcessError(format!("ask_listener bind 失败: {}", e)))?;
            let local = listener
                .local_addr()
                .map_err(|e| AppError::ProcessError(format!("ask_listener local_addr: {}", e)))?;
            (listener, local.port())
        }
    };

    let token = Uuid::new_v4().to_string();

    tracing::info!("[AskListener] 绑定 127.0.0.1:{}", port);

    // 把当前真实 port/token/pid 原子落盘，供 Bridge MCP 失联时自愈重连。
    let pid = std::process::id();
    if let Err(e) = ask_listener_meta::write_meta(&AskListenerMeta::new(port, token.clone(), pid))
    {
        // 落盘失败不致命：只影响 Bridge 侧自愈能力，主进程仍正常监听。
        tracing::warn!("[AskListener] 元数据落盘失败: {}", e);
    } else {
        tracing::debug!(
            "[AskListener] 元数据已落盘 port={} pid={} path={}",
            port,
            pid,
            ask_listener_meta::meta_path().display()
        );
    }

    let token_for_loop = token.clone();
    let state_for_sweeper = state.clone();
    tokio::spawn(async move {
        accept_loop(listener, state, token_for_loop).await;
    });

    // 表单超时清扫：后台周期扫描超时 hold，广播 form-skipped(timeout) 事件并
    // 唤醒挂起的 form 工具调用。这是表单"超时自动跳过"的驱动源——不依赖 AI
    // 再次调用 form 工具才触发清理，超时后前端面板也能同步关闭。
    spawn_form_timeout_sweeper(state_for_sweeper);

    Ok(AskListenerHandle { port, token })
}

/// 周期清扫超时表单。超时 hold 被移除时：
/// 1. 广播 `form-skipped`（reason=timeout）chat-event → 前端 FormCard 置 skipped
/// 2. 唤醒挂起的 form 工具调用（handle_form_frame 等一个 oneshot），回写超时回执
///
/// 间隔取超时窗口的 1/10，既保证及时性又不至于高频空扫。
fn spawn_form_timeout_sweeper(state: Arc<AppState>) {
    const SWEEP_INTERVAL_SECS: u64 = 10;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
        loop {
            ticker.tick().await;
            let expired: Vec<(String, form_flow::FormHold)> = {
                let Ok(mut holds) = state.form_holds.lock() else {
                    continue;
                };
                let now = std::time::Instant::now();
                let mut gone: Vec<(String, form_flow::FormHold)> = Vec::new();
                holds.retain(|id, h| {
                    if now.duration_since(h.created_at)
                        >= std::time::Duration::from_secs(form_flow::FORM_WAIT_TIMEOUT_SECS)
                    {
                        gone.push((id.clone(), h.clone()));
                        false
                    } else {
                        true
                    }
                });
                gone
            };
            for (form_id, hold) in expired {
                tracing::info!(
                    "[Form] 后台清扫超时表单 formId={} target={} action={} sessionId={}",
                    form_id,
                    hold.target,
                    hold.action,
                    hold.session_id
                );
                // 广播 form-skipped(timeout) → 前端关闭面板
                let inner = serde_json::json!({
                    "type": "form-skipped",
                    "formId": form_id,
                    "sessionId": hold.session_id.clone(),
                    "reason": "timeout",
                });
                let event = wrap_question_route_event(&hold.session_id, inner);
                emit_chat_event(&state, &event);
                // 唤醒挂起的 form 工具调用（等 600s 的循环立即拿超时回执）
                if let Some(entry) = state.take_form_answer_sender(&form_id) {
                    let receipt = form_flow::build_skip_receipt(&hold, "timeout");
                    let _ = entry.sender.send(receipt);
                }
            }
        }
    });
}

async fn accept_loop(listener: TcpListener, state: Arc<AppState>, expected_token: String) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!("[AskListener] accept 失败: {}", error);
                continue;
            }
        };
        tracing::debug!("[AskListener] 接受连接 {}", peer);

        let state = state.clone();
        let expected_token = expected_token.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, state, expected_token).await {
                tracing::warn!("[AskListener] 连接处理失败: {}", error);
            }
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    state: Arc<AppState>,
    expected_token: String,
) -> Result<()> {
    let frame = read_frame(&mut stream).await?;
    let kind = frame
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "ask" => handle_ask_frame(&mut stream, frame, state, &expected_token).await,
        "form" => handle_form_frame(&mut stream, frame, state, &expected_token).await,
        "card" => handle_card_frame(&mut stream, frame, state, &expected_token).await,
        // browser 帧已退役：内置浏览器出仓为 browser-desk 插件，AI 经插件 MCP
        // （desk_* 工具面，stdio 直连插件 server）交互，不再经 AskListener 中转。
        "browser" => Err(AppError::ValidationError(
            "browser 帧已退役：浏览器能力由 browser-desk 插件 MCP 提供".into(),
        )),
        "cancel" => {
            // Cancel frames arrive when the CLI sends notifications/cancelled
            // to the companion. We simply remove any matching pending entry
            // so the awaiting oneshot is dropped (sending will error and the
            // companion returns a declined outcome).
            handle_cancel_frame(frame, state, &expected_token);
            Ok(())
        }
        "card_cancel" => {
            handle_card_cancel_frame(frame, state, &expected_token);
            Ok(())
        }
        // polaris-dispatch MCP 桥的 12 类帧（dispatch/cap/cap_list/dispatch_status/
        // find_expert/dispatch_roster/dispatch_continue/dispatch_targets/agent_*/roster_save）
        // 已随该 server 移除（2026-11）：唯一发送方是 dispatch_mcp_server；
        // 派发继续经 commands/dispatch.rs（invoke）与 nexus_pipeline（内部调用）。
        other => Err(AppError::ValidationError(format!("未知帧类型: {}", other))),
    }
}

async fn handle_ask_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    // Auth.
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
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return Err(AppError::ValidationError("ask 帧缺少 callId".into()));
    }

    let questions_value = frame.get("questions").cloned().unwrap_or_else(|| json!([]));
    let questions = parse_questions(&questions_value)?;
    if questions.is_empty() {
        return Err(AppError::ValidationError("ask 帧 questions 为空".into()));
    }

    // Register pending entry + oneshot.
    let (tx, rx) = oneshot::channel::<QuestionOutcome>();
    {
        let mut pending = state
            .pending_questions
            .lock()
            .map_err(|e| AppError::ProcessError(format!("pending_questions 锁: {}", e)))?;
        pending.insert(
            call_id.clone(),
            PendingQuestion {
                call_id: call_id.clone(),
                session_id: session_id.clone(),
                questions: questions.iter().map(parsed_to_item).collect(),
                status: QuestionStatus::Pending,
            },
        );
    }
    state.register_ask_answer_sender(&call_id, questions.clone(), tx);

    // Emit chat-event to render the UI card.
    emit_question_event(&state, &session_id, &call_id, &questions);

    // Block until the user answers (or oneshot is dropped → declined).
    let outcome = match rx.await {
        Ok(outcome) => outcome,
        Err(_recv_err) => {
            tracing::info!(
                "[AskListener] call_id={} oneshot 被丢弃，按 declined 处理",
                call_id
            );
            QuestionOutcome::declined()
        }
    };

    // Write answer frame back to companion.
    write_frame(stream, &serde_json::to_value(&outcome)?).await?;
    let _ = stream.shutdown().await;

    // Cleanup — answer_question handler may already have removed it.
    {
        if let Ok(mut pending) = state.pending_questions.lock() {
            pending.remove(&call_id);
        }
    }
    state.take_ask_answer_sender(&call_id);

    Ok(())
}
