//! AskUserQuestion TCP Listener
//!
//! Listens for TCP connections from polaris-ask-mcp companion process,
//! forwards questions to the frontend via Tauri events, and blocks until the user answers.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use tauri::Emitter;

use crate::error::Result;

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

/// Spawn the TCP listener. Returns the bound port.
pub async fn spawn_ask_listener(
    pending_ask: PendingAskMap,
    app_handle: Option<tauri::AppHandle>,
) -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;
    let port = local_addr.port();

    tracing::info!("AskUserQuestion TCP listener started on {}", local_addr);

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let pending = pending_ask.clone();
                    let handle = app_handle.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, addr, pending, handle).await {
                            tracing::error!("Error handling ask connection from {}: {}", addr, e);
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("Failed to accept connection: {}", e);
                }
            }
        }
    });

    Ok(port)
}

async fn handle_connection(
    mut stream: TcpStream,
    addr: SocketAddr,
    pending_ask: PendingAskMap,
    app_handle: Option<tauri::AppHandle>,
) -> Result<()> {
    // Read the ask request
    let request = read_frame(&mut stream).await?;

    let msg_type = request
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");

    match msg_type {
        "ask" => {
            let token = request
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or("");
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let questions = request
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([]));

            // Generate question ID
            let question_id = Uuid::new_v4().to_string();

            // Create oneshot channel
            let (tx, rx) = oneshot::channel();

            // Store in pending map
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

            // Emit event to frontend
            if let Some(ref handle) = app_handle {
                let event_payload = json!({
                    "type": "question",
                    "questionId": question_id,
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
            // Handle cancellation
            let question_id = request
                .get("questionId")
                .and_then(Value::as_str)
                .unwrap_or("");

            let mut map = pending_ask.lock().await;
            if let Some(entry) = map.remove(question_id) {
                // Drop the sender, receiver will get error
                drop(entry.answer_tx);

                // Notify frontend
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
            tracing::warn!("Unknown message type from {}: {}", addr, msg_type);
        }
    }

    Ok(())
}

/// Answer a pending question (called from Tauri command)
pub async fn answer_pending_question(
    pending_ask: &PendingAskMap,
    question_id: &str,
    answer: Value,
) -> Result<()> {
    let entry = {
        let mut map = pending_ask.lock().await;
        map.remove(question_id)
    };

    if let Some(entry) = entry {
        let _ = entry.answer_tx.send(answer);
        Ok(())
    } else {
        Err(crate::error::AppError::ValidationError(
            "Question not found or already answered".to_string(),
        ))
    }
}
