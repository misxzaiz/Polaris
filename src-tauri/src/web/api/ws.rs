use std::sync::Arc;

use axum::extract::{State, ws::{WebSocket, WebSocketUpgrade, Message}};
use axum::response::IntoResponse;
use futures_util::StreamExt;
use tokio::sync::broadcast;

use crate::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.event_broadcast.subscribe();

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if &*text == r#"{"type":"ping"}"# {
                            if socket.send(Message::Text(
                                r#"{"type":"pong"}"#.into(),
                            )).await.is_err() {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("WS client lagged behind by {} messages, continuing", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }
}
