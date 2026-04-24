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

/// Maximum allowed WebSocket frame size (1 MB).
const MAX_FRAME_SIZE: usize = 1024 * 1024;
/// Maximum allowed total WebSocket message size (4 MB).
const MAX_MESSAGE_SIZE: usize = 4 * 1024 * 1024;

/// WebSocket upgrade handler — initiates the bidirectional event stream.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.max_frame_size(MAX_FRAME_SIZE)
        .max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.event_broadcast.subscribe();
    // Empty set = receive all events (backward compatible default)
    let mut subscriptions: HashSet<String> = HashSet::new();
    let mut last_activity = Instant::now();
    let mut heartbeat_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    // First tick completes immediately; skip it.
    heartbeat_interval.tick().await;

    tracing::info!("WS client connected");

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
                                let count = events.len();
                                for event in &events {
                                    subscriptions.insert(event.clone());
                                }
                                tracing::info!(count, total = subscriptions.len(), "WS client subscribed to events");
                            }
                            Ok(ClientMessage::Unsubscribe { events }) => {
                                let count = events.len();
                                for event in &events {
                                    subscriptions.remove(event);
                                }
                                tracing::info!(count, total = subscriptions.len(), "WS client unsubscribed from events");
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
                        tracing::info!("WS client disconnected: broadcast channel closed");
                        break;
                    }
                }
            }
            _ = heartbeat_interval.tick() => {
                // Check idle timeout first
                if last_activity.elapsed() > IDLE_TIMEOUT {
                    tracing::info!("WS client disconnected: idle timeout");
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
    // Fast path: extract "event" field via string scan, avoiding full JSON parse.
    match extract_event_type(event_json) {
        Some(event_type) => subscriptions.contains(event_type),
        None => true, // Unparseable → send anyway to avoid dropping messages
    }
}

/// Extract the value of the top-level `"event"` field without full JSON deserialization.
/// Event names are simple ASCII identifiers (e.g. "chat-event") so escaped quotes
/// are not a concern.
fn extract_event_type(json: &str) -> Option<&str> {
    let marker = r#""event":"#;
    let pos = json.find(marker)?;
    let rest = json[pos + marker.len()..].trim_start();
    if !rest.starts_with('"') { return None; }
    let value = &rest[1..];
    let end = value.find('"')?;
    Some(&value[..end])
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
    fn test_extract_event_type_basic() {
        assert_eq!(extract_event_type(r#"{"event":"chat-event","payload":{}}"#), Some("chat-event"));
    }

    #[test]
    fn test_extract_event_type_with_spaces() {
        assert_eq!(extract_event_type(r#"{"event" : "session-event" ,"payload":{}}"#), Some("session-event"));
    }

    #[test]
    fn test_extract_event_type_missing() {
        assert_eq!(extract_event_type(r#"{"payload":{}}"#), None);
    }

    #[test]
    fn test_extract_event_type_non_string_value() {
        assert_eq!(extract_event_type(r#"{"event":123}"#), None);
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
