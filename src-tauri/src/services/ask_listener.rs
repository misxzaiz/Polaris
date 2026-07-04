//! Ask User Question — TCP Listener
//!
//! Bound on 127.0.0.1:0 at startup. The `polaris-ask-mcp` companion process
//! connects here when Claude CLI invokes `ask_user_question`; this listener:
//!
//!   1. Reads the `ask` frame (length-prefixed JSON)
//!   2. Registers a `PendingQuestionEntry { answer_tx, … }` in AppState
//!   3. Emits a `question` chat-event so the UI renders the card
//!   4. Awaits the oneshot from `answer_question` Tauri command / HTTP handler
//!   5. Writes the `answer` frame back to the companion → CLI tool_result
//!
//! See `services::ask_mcp_server` for the client side and the frame protocol.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::state::{AppState, PendingQuestion, QuestionItem, QuestionOption, QuestionStatus, SubAnswer};

/// Maximum frame size we accept on the wire (1 MiB).
const MAX_FRAME_SIZE: usize = 1_048_576;

/// Final answer payload that goes back to the companion → CLI tool_result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOutcome {
    /// Frame type discriminator on the wire.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// True when the user dismissed without answering.
    pub declined: bool,
    /// Per-question answer, ordered the same as the input questions.
    pub answers: Vec<QuestionAnswerPayload>,
}

impl QuestionOutcome {
    pub fn answer(answers: Vec<QuestionAnswerPayload>) -> Self {
        Self {
            kind: "answer",
            declined: false,
            answers,
        }
    }

    pub fn declined() -> Self {
        Self {
            kind: "answer",
            declined: true,
            answers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerPayload {
    pub question: String,
    pub header: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

/// Handle returned by [`spawn_ask_listener`]; carries the bound port + auth
/// token that must be injected as args to the `polaris-ask-mcp` companion.
#[derive(Debug, Clone)]
pub struct AskListenerHandle {
    pub port: u16,
    pub token: String,
}

/// Bind a TCP socket on 127.0.0.1:0 and spawn the accept loop.
///
/// The loop runs for the app's lifetime — no graceful-shutdown signal is
/// wired here because connections are short-lived (one request/response per
/// connection) and Tokio drops the task at process exit.
pub async fn spawn_ask_listener(state: Arc<AppState>) -> Result<AskListenerHandle> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::ProcessError(format!("ask_listener bind 失败: {}", e)))?;
    let local = listener
        .local_addr()
        .map_err(|e| AppError::ProcessError(format!("ask_listener local_addr: {}", e)))?;
    let port = local.port();
    let token = Uuid::new_v4().to_string();

    tracing::info!("[AskListener] 绑定 127.0.0.1:{}", port);

    let token_for_loop = token.clone();
    tokio::spawn(async move {
        accept_loop(listener, state, token_for_loop).await;
    });

    Ok(AskListenerHandle { port, token })
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
        "cancel" => {
            // Cancel frames arrive when the CLI sends notifications/cancelled
            // to the companion. We simply remove any matching pending entry
            // so the awaiting oneshot is dropped (sending will error and the
            // companion returns a declined outcome).
            handle_cancel_frame(frame, state, &expected_token);
            Ok(())
        }
        other => Err(AppError::ValidationError(format!(
            "未知帧类型: {}",
            other
        ))),
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
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
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

    let questions_value = frame
        .get("questions")
        .cloned()
        .unwrap_or_else(|| json!([]));
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

fn handle_cancel_frame(frame: Value, state: Arc<AppState>, expected_token: &str) {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        tracing::warn!("[AskListener] cancel token 不匹配");
        return;
    }
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return;
    }
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let _ = entry.sender.send(QuestionOutcome::declined());
    }
    if let Ok(mut pending) = state.pending_questions.lock() {
        pending.remove(&call_id);
    }
}

/// Parsed `questions[i]` for internal use.
#[derive(Debug, Clone)]
pub struct ParsedQuestion {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<ParsedOption>,
}

#[derive(Debug, Clone)]
pub struct ParsedOption {
    pub label: String,
    pub description: Option<String>,
}

fn parsed_to_item(q: &ParsedQuestion) -> QuestionItem {
    QuestionItem {
        question: q.question.clone(),
        header: q.header.clone(),
        multi_select: q.multi_select,
        options: q
            .options
            .iter()
            .map(|o| QuestionOption {
                value: o.label.clone(),
                label: Some(o.label.clone()),
                description: o.description.clone(),
            })
            .collect(),
        allow_custom_input: true,
    }
}

fn parse_questions(value: &Value) -> Result<Vec<ParsedQuestion>> {
    let arr = value
        .as_array()
        .ok_or_else(|| AppError::ValidationError("questions 必须是数组".into()))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let question = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let header = item
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let multi_select = item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .map(|o| ParsedOption {
                        label: o
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(ParsedQuestion {
            question,
            header,
            multi_select,
            options,
        });
    }
    Ok(out)
}

fn emit_question_event(
    state: &AppState,
    session_id: &str,
    call_id: &str,
    questions: &[ParsedQuestion],
) {
    // 单事件携带全部 questions（即使只有 1 题，也走数组形态以统一前端处理）。
    // 顶层仍带摘要字段（第一题的 header / options 等）便于旧消费方兼容。
    let questions_payload: Vec<Value> = questions
        .iter()
        .map(|q| {
            let options: Vec<Value> = q
                .options
                .iter()
                .map(|o| {
                    // 前端 QuestionOption 要求 `value`；用 label 同时作为
                    // 标识符与显示文本。
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect();
            // MCP question 是正文，前端 header 字段承载正文；
            // MCP header 是短标签，映射到 categoryLabel。
            let body = if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            };
            let mut item = json!({
                "question": body,
                "header": q.header,        // 短标签
                "multiSelect": q.multi_select,
                "options": options,
                "allowCustomInput": true,
            });
            if !q.question.is_empty() && !q.header.is_empty() {
                item["categoryLabel"] = Value::String(q.header.clone());
            }
            item
        })
        .collect();

    // 顶层摘要：第一题的字段，便于旧消费方
    let first_body = questions
        .first()
        .map(|q| {
            if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            }
        })
        .unwrap_or_default();
    let first_options = questions
        .first()
        .map(|q| {
            q.options
                .iter()
                .map(|o| {
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let first_multi = questions.first().map(|q| q.multi_select).unwrap_or(false);
    let first_category = questions.first().and_then(|q| {
        if !q.question.is_empty() && !q.header.is_empty() {
            Some(q.header.clone())
        } else {
            None
        }
    });

    let mut payload = json!({
        "type": "question",
        "sessionId": session_id,
        "questionId": call_id,
        "questions": questions_payload,
        // 兼容字段：填充第一题
        "header": first_body,
        "options": first_options,
        "multiSelect": first_multi,
        "allowCustomInput": true,
    });
    if let Some(category) = first_category {
        payload["categoryLabel"] = Value::String(category);
    }

    let event = wrap_question_route_event(session_id, payload.clone());

    // Web/WebSocket broadcast — wrap in envelope for event routing.
    // Frontend httpTransport filters messages without "event" field.
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }

    // Tauri webview emission — only when tauri-app feature is on.
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("chat-event", &event) {
            tracing::warn!("[AskListener] emit chat-event 失败: {}", error);
        }
    }
}

fn wrap_question_route_event(session_id: &str, payload: Value) -> Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
    }
}

// ============================================================================
// Frame I/O (u32 LE length prefix + UTF-8 JSON body)
// ============================================================================

async fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧长度: {}", e)))?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_SIZE {
        return Err(AppError::ProcessError(format!("非法帧长度: {}", len)));
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧体: {}", e)))?;
    let value: Value = serde_json::from_slice(&body)?;
    Ok(value)
}

async fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len())
        .map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream
        .write_all(&len.to_le_bytes())
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧长度: {}", e)))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧体: {}", e)))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::ProcessError(format!("flush 帧: {}", e)))?;
    Ok(())
}

// ============================================================================
// AppState integration — answer sender bookkeeping
// ============================================================================

/// Internal entry stored in `AppState.ask_answer_senders`.
pub struct AskAnswerEntry {
    pub questions: Vec<ParsedQuestion>,
    pub sender: oneshot::Sender<QuestionOutcome>,
}

impl AppState {
    /// Register a oneshot answer sender keyed by call_id.
    pub(crate) fn register_ask_answer_sender(
        &self,
        call_id: &str,
        questions: Vec<ParsedQuestion>,
        sender: oneshot::Sender<QuestionOutcome>,
    ) {
        if let Ok(mut map) = self.ask_answer_senders.lock() {
            map.insert(call_id.to_string(), AskAnswerEntry { questions, sender });
        }
    }

    /// Remove and return the answer entry for a call_id, if present.
    pub fn take_ask_answer_sender(&self, call_id: &str) -> Option<AskAnswerEntry> {
        self.ask_answer_senders.lock().ok()?.remove(call_id)
    }
}

/// Build a `QuestionOutcome` from the user-submitted multi-answer payload.
/// Length-aligns `answers` to `entry.questions` (missing slots get empty
/// SubAnswer; extra slots are dropped). If `declined == true` the outcome
/// is reported as a full decline regardless of `answers` content.
pub fn build_outcome_for_multiple_answers(
    entry: &AskAnswerEntry,
    answers: Vec<SubAnswer>,
    declined: bool,
) -> QuestionOutcome {
    if declined {
        return QuestionOutcome::declined();
    }
    let mut out = Vec::with_capacity(entry.questions.len());
    for (idx, q) in entry.questions.iter().enumerate() {
        let sub = answers.get(idx).cloned().unwrap_or_default();
        out.push(QuestionAnswerPayload {
            question: q.question.clone(),
            header: q.header.clone(),
            selected: sub.selected,
            custom_input: sub.custom_input,
        });
    }
    QuestionOutcome::answer(out)
}
