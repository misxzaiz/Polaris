use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{State, ws::{WebSocket, WebSocketUpgrade, Message}};
use axum::response::IntoResponse;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::AppState;

/// Server sends a WebSocket ping frame every this interval.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Close the connection if no frame (pong or otherwise) received within this window.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "subscribe")]
    Subscribe { events: Vec<String> },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { events: Vec<String> },
}

/// WebSocket upgrade handler — initiates the bidirectional event stream.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.event_broadcast.subscribe();
    // Empty set = receive all events (backward compatible default)
    let mut subscriptions: HashSet<String> = HashSet::new();
    let mut last_activity = Instant::now();
    let mut heartbeat_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    // First tick completes immediately; skip it.
    heartbeat_interval.tick().await;

    loop {
        tokio::select! {
            msg = socket.recv() => {
                last_activity = Instant::now();
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
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Ping) => {
                                if socket.send(Message::Text(
                                    r#"{"type":"pong"}"#.into(),
                                )).await.is_err() {
                                    break;
                                }
                            }
                            Ok(ClientMessage::Subscribe { events }) => {
                                for event in events {
                                    subscriptions.insert(event);
                                }
                            }
                            Ok(ClientMessage::Unsubscribe { events }) => {
                                for event in events {
                                    subscriptions.remove(&event);
                                }
                            }
                            Err(_) => {
                                // Ignore malformed messages
                            }
                        }
                    }
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(msg) => {
                        if !should_send(&msg, &subscriptions) {
                            continue;
                        }
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
            _ = heartbeat_interval.tick() => {
                // Check idle timeout first
                if last_activity.elapsed() > IDLE_TIMEOUT {
                    tracing::info!("WS client idle timeout, closing connection");
                    break;
                }
                // Send WebSocket ping frame as keep-alive
                if socket.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Check if a broadcast event matches the subscription filter.
/// Empty subscriptions = send everything (backward compatible).
fn should_send(event_json: &str, subscriptions: &HashSet<String>) -> bool {
    if subscriptions.is_empty() {
        return true;
    }
    // Fast path: extract "event" field without full parse
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(event_json) {
        if let Some(event_type) = val.get("event").and_then(|v| v.as_str()) {
            return subscriptions.contains(event_type);
        }
    }
    // If we can't parse, send it anyway to avoid dropping messages
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_send_no_subscriptions() {
        let subs = HashSet::new();
        assert!(should_send(r#"{"event":"chat-event","payload":{}}"#, &subs));
    }

    #[test]
    fn test_should_send_matching_subscription() {
        let mut subs = HashSet::new();
        subs.insert("chat-event".to_string());
        assert!(should_send(r#"{"event":"chat-event","payload":{}}"#, &subs));
    }

    #[test]
    fn test_should_send_non_matching_subscription() {
        let mut subs = HashSet::new();
        subs.insert("chat-event".to_string());
        assert!(!should_send(r#"{"event":"session-event","payload":{}}"#, &subs));
    }

    #[test]
    fn test_should_send_invalid_json() {
        let mut subs = HashSet::new();
        subs.insert("chat-event".to_string());
        assert!(should_send("not json", &subs));
    }

    #[test]
    fn test_should_send_multiple_subscriptions() {
        let mut subs = HashSet::new();
        subs.insert("chat-event".to_string());
        subs.insert("session-event".to_string());
        assert!(should_send(r#"{"event":"session-event","payload":{}}"#, &subs));
        assert!(!should_send(r#"{"event":"unknown-event","payload":{}}"#, &subs));
    }

    #[test]
    fn test_deserialize_subscribe() {
        let msg: ClientMessage = serde_json::from_str(
            r#"{"type":"subscribe","events":["chat-event","session-event"]}"#
        ).unwrap();
        match msg {
            ClientMessage::Subscribe { events } => {
                assert_eq!(events, vec!["chat-event", "session-event"]);
            }
            _ => panic!("Expected Subscribe"),
        }
    }

    #[test]
    fn test_deserialize_unsubscribe() {
        let msg: ClientMessage = serde_json::from_str(
            r#"{"type":"unsubscribe","events":["chat-event"]}"#
        ).unwrap();
        match msg {
            ClientMessage::Unsubscribe { events } => {
                assert_eq!(events, vec!["chat-event"]);
            }
            _ => panic!("Expected Unsubscribe"),
        }
    }

    #[test]
    fn test_deserialize_ping() {
        let msg: ClientMessage = serde_json::from_str(
            r#"{"type":"ping"}"#
        ).unwrap();
        matches!(msg, ClientMessage::Ping);
    }
}
