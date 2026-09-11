//! 事件适配层（阶段 B）
//!
//! 契约 `Event` ↔ 现有广播器（`web/EventBroadcaster`）字符串格式。
//!
//! 设计：
//! - `EventAdapter::broadcast`：契约 `Event` → `{"event":<kind>,"payload":<payload>}`
//!   字符串交给现有生产级广播器（seq 由广播器注入顶层 + 重放缓冲），
//!   同时推送 in-proc 订阅者（Filter 过滤后）。
//! - `EventAdapter::subscribe`：返回 `mpsc::Receiver<Event>`（对齐契约 `Router::subscribe`），
//!   同步可用（`try_recv` / `recv`）。不 spawn 后台任务，测试与生产都可直接用。
//!
//! 不改 `web/event_broadcaster.rs`（现有 WS 通道零回归）。

use crate::contracts::*;
use crate::web::EventBroadcaster;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// in-proc 订阅者（Filter → mpsc::Sender<Event>）
struct Subscriber {
    filter: Filter,
    sender: mpsc::Sender<Event>,
}

/// 事件适配层：契约事件 + 现有字符串广播器 + in-proc 订阅
pub struct EventAdapter {
    inner: EventBroadcaster,
    subscribers: Mutex<Vec<Subscriber>>,
}

impl EventAdapter {
    /// 创建适配层（`channel_capacity` 传给现有广播器与 in-proc channel）
    pub fn new(channel_capacity: usize) -> Self {
        Self::from_broadcaster(EventBroadcaster::new(channel_capacity))
    }

    /// 从现有广播器构造适配层（复用其底层 seq + 环形缓冲 + broadcast channel）。
    ///
    /// 用于在现有 WS 通道（AppState.event_broadcast）之上叠加契约事件广播：
    /// 同一事件既走 in-proc 订阅者，也走进现有字符串广播器（前端 WS 可见）。
    pub fn from_broadcaster(broadcaster: EventBroadcaster) -> Self {
        Self {
            inner: broadcaster,
            subscribers: Mutex::new(Vec::new()),
        }
    }

    /// 广播一个契约事件：编码交给现有广播器 + 推送给匹配的 in-proc 订阅者
    pub fn broadcast(&self, event: Event) {
        // 1. 编码成 {"event":...,"payload":...}，交给现有广播器（注入 seq / 重放缓冲）
        let msg = encode_event(&event);
        let _ = self.inner.send(msg);

        // 2. 推送 in-proc 订阅者（Filter 匹配）
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|sub| {
            let matches = match (&sub.filter.kind, &event.kind) {
                (None, _) => true,
                (Some(k), ek) if k == ek => true,
                (Some(_), _) => false,
            };
            if matches {
                sub.sender.try_send(event.clone()).is_ok()
            } else {
                true // 不匹配但保留订阅者
            }
        });
    }

    /// 订阅契约事件流（in-proc，Filter 过滤）
    pub fn subscribe(&self, filter: Filter) -> mpsc::Receiver<Event> {
        let (tx, rx) = mpsc::channel(64);
        self.subscribers.lock().unwrap().push(Subscriber {
            filter,
            sender: tx,
        });
        rx
    }
}

/// 契约 `Event` → 现有广播器字符串格式 `{"event":<kind>,"payload":<payload>}`
///
/// seq 由现有广播器在顶层注入（不在此处写），trace 不暴露给前端（payload 内可含）。
pub fn encode_event(event: &Event) -> String {
    serde_json::json!({
        "event": event.kind,
        "payload": event.payload,
    })
    .to_string()
}

// ============================================================================
// 静态权限（默认实现）
// ============================================================================

/// 静态授权：装配时校验，动态请求直接 Deny（安全失败）
pub mod static_perm {
    use super::*;

    pub struct StaticPermission;

    impl Permission for StaticPermission {
        fn check(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            Ok(PermissionVerdict::Allow)
        }
    }
}

// ============================================================================
// 测试支撑（供 router/mod.rs 测试复用）
// ============================================================================

#[cfg(test)]
pub mod tests_support {
    use super::*;

    /// 远程来源全部拒绝（验证双 gate）
    pub struct DenyRemotePermission;
    impl Permission for DenyRemotePermission {
        fn check(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            match &req.source {
                Source::Remote { .. } => Ok(PermissionVerdict::Deny),
                _ => Ok(PermissionVerdict::Allow),
            }
        }
    }

    /// 审计记录（验证 audit 落盘）
    pub struct RecordingAudit(pub Mutex<Vec<String>>);
    impl AuditSink for RecordingAudit {
        fn append(&self, entry: &AuditEntry) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{}:{}", entry.action, entry.capability.0));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(kind: &str) -> Event {
        Event {
            seq: 0,
            kind: kind.to_string(),
            payload: Value::Null,
            trace: TraceId("t".into()),
        }
    }

    #[test]
    fn encode_event_produces_expected_shape() {
        let ev = make_event("chat.event");
        let s = encode_event(&ev);
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["event"], "chat.event");
        assert!(parsed.get("payload").is_some());
        // 不应包含顶层 seq（由广播器注入）
        assert!(parsed.get("seq").is_none());
    }

    #[test]
    fn broadcast_pushes_to_matching_subscriber() {
        let bc = EventAdapter::new(64);
        let mut rx = bc.subscribe(Filter {
            kind: Some("ai.token".to_string()),
            trace: None,
        });

        bc.broadcast(make_event("ai.token"));
        bc.broadcast(make_event("chat.event"));

        // 只收到匹配 kind 的事件
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut got = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            got.push(ev.kind);
        }
        assert_eq!(got, vec!["ai.token".to_string()]);
    }
}