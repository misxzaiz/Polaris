//! AskUserQuestion TCP Listener
//!
//! Listens for TCP connections from polaris-ask-mcp companion process,
//! forwards questions to the frontend via Tauri events, and blocks until the user answers.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use tauri::Emitter;

use crate::error::Result;
use crate::state::{PendingQuestion, QuestionOption, QuestionStatus};

/// Pending question entry with oneshot sender for answer
pub struct PendingAskEntry {
    pub session_id: String,
    pub questions: Value,
    pub answer_tx: oneshot::Sender<Value>,
}

/// Shared state for pending ask questions
pub type PendingAskMap = Arc<Mutex<HashMap<String, PendingAskEntry>>>;

/// Create a new shared pending ask map
pub fn new_pending_ask_map() -> PendingAskMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Single-instance listener handle held in `AppState` so that we don't leak
/// listeners on every chat start. Token is randomly generated once and reused
/// by every MCP injection — companion processes that present a wrong token
/// are dropped without further processing.
pub struct AskListenerHandle {
    pub port: u16,
    pub token: String,
    /// Owning JoinHandle for the accept loop. Aborted on drop.
    join: tokio::task::JoinHandle<()>,
}

impl Drop for AskListenerHandle {
    fn drop(&mut self) {
        self.join.abort();
    }
}

/// TCP frame: u32 LE length prefix + UTF-8 JSON payload
async fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await?;

    let value: Value = serde_json::from_slice(&payload)?;
    Ok(value)
}

async fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    let len = (payload.len() as u32).to_le_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&payload).await?;
    stream.flush().await?;
    Ok(())
}

/// Spawn the TCP listener. The returned `AskListenerHandle` owns the accept
/// loop and aborts it on drop. Callers should keep the handle alive in
/// `AppState`. Token is captured into the handle and validated on every frame.
pub async fn spawn_ask_listener(
    pending_ask: PendingAskMap,
    pending_questions: Arc<std::sync::Mutex<HashMap<String, PendingQuestion>>>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<AskListenerHandle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;
    let port = local_addr.port();
    let token = Uuid::new_v4().to_string();

    tracing::info!(
        "AskUserQuestion TCP listener started on {} (token=...{})",
        local_addr,
        &token[token.len().saturating_sub(6)..]
    );

    let token_for_loop = token.clone();
    let join = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let pending = pending_ask.clone();
                    let pending_q = pending_questions.clone();
                    let handle = app_handle.clone();
                    let expected_token = token_for_loop.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(
                            stream,
                            addr,
                            pending,
                            pending_q,
                            handle,
                            &expected_token,
                        )
                        .await
                        {
                            tracing::error!("Error handling ask connection from {}: {}", addr, e);
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("Failed to accept ask connection: {}", e);
                }
            }
        }
    });

    Ok(AskListenerHandle { port, token, join })
}

async fn handle_connection(
    mut stream: TcpStream,
    addr: SocketAddr,
    pending_ask: PendingAskMap,
    pending_questions: Arc<std::sync::Mutex<HashMap<String, PendingQuestion>>>,
    app_handle: Option<tauri::AppHandle>,
    expected_token: &str,
) -> Result<()> {
    let request = read_frame(&mut stream).await?;

    // Reject any frame that does not carry the expected token. We do this
    // before dispatching on type so cancel/ask both go through the gate.
    let supplied_token = request
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("");
    if supplied_token != expected_token {
        tracing::warn!(
            "Rejecting ask frame from {} (token mismatch)",
            addr
        );
        let _ = write_frame(
            &mut stream,
            &json!({
                "type": "answer",
                "declined": true,
                "answers": [],
                "error": "token mismatch"
            }),
        )
        .await;
        return Ok(());
    }

    let msg_type = request
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");

    match msg_type {
        "ask" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let questions = request
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([]));

            // Generate question ID — same id is used as the call_id mirror
            // entry so that the existing `answer_question` Tauri command can
            // route the answer back regardless of which map it consults.
            let question_id = Uuid::new_v4().to_string();

            let (tx, rx) = oneshot::channel();

            // 1) MCP-side pending map (carries the oneshot)
            {
                let mut map = pending_ask.lock().await;
                map.insert(
                    question_id.clone(),
                    PendingAskEntry {
                        session_id: session_id.clone(),
                        questions: questions.clone(),
                        answer_tx: tx,
                    },
                );
            }

            // 2) Mirror into the legacy pending_questions map so that
            //    UI state tracking (and any code that consults it) keeps
            //    working with the MCP-originated question id as call_id.
            if let Some(mirror) = build_pending_question_mirror(
                &question_id,
                &session_id,
                &questions,
            ) {
                if let Ok(mut pq) = pending_questions.lock() {
                    pq.insert(question_id.clone(), mirror);
                }
            }

            // Emit event to frontend
            if let Some(ref handle) = app_handle {
                let event_payload = json!({
                    "type": "question",
                    "questionId": question_id,
                    "callId": question_id,
                    "sessionId": session_id,
                    "questions": questions,
                    "source": "mcp",
                });
                if let Err(e) = handle.emit("chat-event", &event_payload) {
                    tracing::error!("Failed to emit question event: {}", e);
                }
            }

            // Wait for answer (blocking)
            let answer = match rx.await {
                Ok(answer) => answer,
                Err(_) => {
                    // Channel closed, user might have disconnected
                    json!({
                        "type": "answer",
                        "declined": true,
                        "answers": []
                    })
                }
            };

            // Send answer back to companion
            write_frame(&mut stream, &answer).await?;
        }
        "cancel" => {
            let question_id = request
                .get("questionId")
                .and_then(Value::as_str)
                .unwrap_or("");

            let mut map = pending_ask.lock().await;
            if let Some(entry) = map.remove(question_id) {
                drop(entry.answer_tx);
                if let Ok(mut pq) = pending_questions.lock() {
                    pq.remove(question_id);
                }
                if let Some(ref handle) = app_handle {
                    let event_payload = json!({
                        "type": "question_cancelled",
                        "questionId": question_id,
                    });
                    let _ = handle.emit("chat-event", &event_payload);
                }
            }
        }
        _ => {
            tracing::warn!("Unknown ask message type from {}: {}", addr, msg_type);
        }
    }

    Ok(())
}

/// Build a `PendingQuestion` mirror entry from the first question in the
/// MCP `questions` array. We collapse the multi-question MCP shape to the
/// single-question legacy shape — UI uses this only for status tracking,
/// the authoritative payload is the `chat-event` we emit alongside.
fn build_pending_question_mirror(
    question_id: &str,
    session_id: &str,
    questions: &Value,
) -> Option<PendingQuestion> {
    let first = questions.as_array()?.first()?;
    let header = first
        .get("header")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let multi_select = first
        .get("multiSelect")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let options = first
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|opt| QuestionOption {
                    value: opt
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    label: opt
                        .get("label")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    Some(PendingQuestion {
        call_id: question_id.to_string(),
        session_id: session_id.to_string(),
        header,
        multi_select,
        options,
        allow_custom_input: true,
        status: QuestionStatus::Pending,
    })
}

/// Answer a pending question (called from Tauri command). The caller passes
/// the user's selections (and optional custom input) — we fold them back
/// into a per-question answer array using the original `questions` payload
/// captured at ask-time so the companion can return a sensible structured
/// result to Claude.
pub async fn answer_pending_question(
    pending_ask: &PendingAskMap,
    question_id: &str,
    selected: Vec<String>,
    custom_input: Option<String>,
) -> Result<()> {
    let entry = {
        let mut map = pending_ask.lock().await;
        map.remove(question_id)
    };

    let entry = match entry {
        Some(e) => e,
        None => {
            return Err(crate::error::AppError::ValidationError(
                "Question not found or already answered".to_string(),
            ));
        }
    };

    // Build per-question answers. Polaris UI today only renders a single
    // composite question; we attribute the user's selection to the first
    // MCP question and leave the rest with empty selections (rare case —
    // the spec allows up to 4 but Polaris currently treats them as one).
    let mut answers: Vec<Value> = Vec::new();
    if let Some(arr) = entry.questions.as_array() {
        for (idx, q) in arr.iter().enumerate() {
            let header = q.get("header").cloned().unwrap_or(Value::Null);
            let question = q.get("question").cloned().unwrap_or(Value::Null);
            let mut selected_for_q: Vec<Value> = if idx == 0 {
                selected.iter().map(|s| Value::String(s.clone())).collect()
            } else {
                Vec::new()
            };
            if idx == 0 {
                if let Some(ref custom) = custom_input {
                    if !custom.is_empty() {
                        selected_for_q.push(Value::String(custom.clone()));
                    }
                }
            }
            answers.push(json!({
                "question": question,
                "header": header,
                "selected": selected_for_q,
            }));
        }
    }

    let payload = json!({
        "type": "answer",
        "declined": false,
        "answers": answers,
    });

    let _ = entry.answer_tx.send(payload);
    Ok(())
}
