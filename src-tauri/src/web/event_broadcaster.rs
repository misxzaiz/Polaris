//! WebSocket 事件广播器 — 带全局序号与重放缓冲。
//!
//! 在原 `tokio::sync::broadcast::Sender<String>` 之上封装：
//! 1. 每条事件分配单调递增的 `seq`，并注入到 JSON 顶层（`{"seq":N,...}`）。
//! 2. 最近事件保存在环形缓冲中（按条数 + 字节双上限），供断线重连的
//!    WebSocket 客户端通过 `resume` 协议补发错过的事件。
//!
//! 典型场景：手机浏览器锁屏后 WS 被系统断开，解锁重连时客户端上报
//! `lastSeq`，服务端从缓冲补发 `seq > lastSeq` 的事件；若缓冲已被淘汰
//! （缺口），返回 gap 标记，客户端转而走全量历史恢复。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

/// 重放缓冲最大事件条数。
const REPLAY_BUFFER_MAX_EVENTS: usize = 2000;
/// 重放缓冲最大总字节数（流式 delta 较多时优先按字节淘汰）。
const REPLAY_BUFFER_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 重放缓冲（环形）。
struct ReplayBuffer {
    /// (seq, 已注入 seq 的完整 JSON 字符串)
    events: VecDeque<(u64, String)>,
    /// 当前缓冲总字节数。
    total_bytes: usize,
    /// 已被淘汰（不再可补发）的最大 seq。0 表示尚未淘汰任何事件。
    evicted_through: u64,
}

impl ReplayBuffer {
    fn new() -> Self {
        Self {
            events: VecDeque::new(),
            total_bytes: 0,
            evicted_through: 0,
        }
    }

    fn push(&mut self, seq: u64, payload: String) {
        self.total_bytes += payload.len();
        self.events.push_back((seq, payload));

        while self.events.len() > REPLAY_BUFFER_MAX_EVENTS
            || self.total_bytes > REPLAY_BUFFER_MAX_BYTES
        {
            if let Some((evicted_seq, evicted)) = self.events.pop_front() {
                self.total_bytes -= evicted.len();
                self.evicted_through = evicted_seq;
            } else {
                break;
            }
        }
    }
}

/// 事件补发结果。
pub struct ReplayResult {
    /// 按 seq 升序排列、待补发的事件（完整 JSON 字符串，已含 seq）。
    pub events: Vec<String>,
    /// 是否存在缺口：客户端的 lastSeq 之后有事件已被缓冲淘汰，
    /// 补发不完整，客户端应触发全量状态恢复。
    pub gap: bool,
}

/// 带序号与重放缓冲的事件广播器。
///
/// `Clone` 后共享同一序号计数器、缓冲与底层 broadcast channel，
/// 可直接替换原 `broadcast::Sender<String>` 的用法（`send` / `subscribe`）。
#[derive(Clone)]
pub struct EventBroadcaster {
    tx: broadcast::Sender<String>,
    seq: Arc<AtomicU64>,
    buffer: Arc<Mutex<ReplayBuffer>>,
}

impl EventBroadcaster {
    pub fn new(channel_capacity: usize) -> Self {
        Self {
            tx: broadcast::channel(channel_capacity).0,
            seq: Arc::new(AtomicU64::new(0)),
            buffer: Arc::new(Mutex::new(ReplayBuffer::new())),
        }
    }

    /// 分配 seq、注入 JSON、写入重放缓冲并广播。
    ///
    /// 与 `broadcast::Sender::send` 不同：即使当前没有任何订阅者
    /// （返回 `Err(SendError)`），事件也已写入重放缓冲——断线的客户端
    /// 重连后仍可补回这段时间的事件。这正是锁屏场景的核心诉求。
    pub fn send(
        &self,
        msg: String,
    ) -> Result<usize, broadcast::error::SendError<String>> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let stamped = inject_seq(&msg, seq);

        if let Ok(mut buf) = self.buffer.lock() {
            buf.push(seq, stamped.clone());
        }

        self.tx.send(stamped)
    }

    /// 订阅实时事件流（语义同 `broadcast::Sender::subscribe`）。
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// 当前已分配的最大 seq。
    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// 取出 `seq > last_seq` 的缓冲事件用于补发。
    ///
    /// `gap = true` 表示 last_seq 之后存在已被淘汰的事件，补发不完整。
    pub fn replay_after(&self, last_seq: u64) -> ReplayResult {
        let Ok(buf) = self.buffer.lock() else {
            return ReplayResult { events: Vec::new(), gap: true };
        };

        let gap = last_seq < buf.evicted_through;
        let events = buf
            .events
            .iter()
            .filter(|(seq, _)| *seq > last_seq)
            .map(|(_, payload)| payload.clone())
            .collect();

        ReplayResult { events, gap }
    }
}

/// 将 `"seq":N` 注入 JSON 对象字符串顶层（紧跟首个 `{`）。
///
/// 所有广播消息均为 `{"event":...,"payload":...}` 形态的对象字符串，
/// 字符串拼接避免了对大体积流式事件做完整 parse/serialize 往返。
/// 非对象形态（防御性兜底）原样返回，不注入 seq。
fn inject_seq(msg: &str, seq: u64) -> String {
    let trimmed = msg.trim_start();
    if let Some(rest) = trimmed.strip_prefix('{') {
        if rest.trim_start().starts_with('}') {
            // 空对象 {}
            format!("{{\"seq\":{}}}", seq)
        } else {
            format!("{{\"seq\":{},{}", seq, rest)
        }
    } else {
        msg.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_seq_basic() {
        let out = inject_seq(r#"{"event":"chat-event","payload":{}}"#, 7);
        assert_eq!(out, r#"{"seq":7,"event":"chat-event","payload":{}}"#);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["seq"], 7);
        assert_eq!(parsed["event"], "chat-event");
    }

    #[test]
    fn inject_seq_empty_object() {
        let out = inject_seq("{}", 3);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["seq"], 3);
    }

    #[test]
    fn inject_seq_non_object_passthrough() {
        assert_eq!(inject_seq("not json", 1), "not json");
    }

    #[test]
    fn send_buffers_even_without_subscribers() {
        let b = EventBroadcaster::new(16);
        // 没有订阅者，send 返回 Err，但事件必须进入缓冲
        let _ = b.send(r#"{"event":"chat-event","payload":1}"#.to_string());
        let _ = b.send(r#"{"event":"chat-event","payload":2}"#.to_string());

        let replay = b.replay_after(0);
        assert!(!replay.gap);
        assert_eq!(replay.events.len(), 2);
        assert!(replay.events[0].contains(r#""seq":1"#));
        assert!(replay.events[1].contains(r#""seq":2"#));
    }

    #[test]
    fn replay_after_partial() {
        let b = EventBroadcaster::new(16);
        for i in 0..5 {
            let _ = b.send(format!(r#"{{"event":"e","payload":{}}}"#, i));
        }
        let replay = b.replay_after(3);
        assert!(!replay.gap);
        assert_eq!(replay.events.len(), 2);
        assert!(replay.events[0].contains(r#""seq":4"#));
        assert!(replay.events[1].contains(r#""seq":5"#));
    }

    #[test]
    fn replay_detects_gap_after_eviction() {
        let b = EventBroadcaster::new(16);
        // 用超大 payload 触发字节上限淘汰
        let big = "x".repeat(REPLAY_BUFFER_MAX_BYTES / 2);
        for _ in 0..4 {
            let _ = b.send(format!(r#"{{"event":"e","payload":"{}"}}"#, big));
        }
        // seq=1 一定已被淘汰
        let replay = b.replay_after(0);
        assert!(replay.gap);
        // lastSeq 在缓冲范围内则无缺口
        let newest = b.current_seq();
        let ok = b.replay_after(newest);
        assert!(!ok.gap);
        assert!(ok.events.is_empty());
    }

    #[test]
    fn count_limit_eviction() {
        let b = EventBroadcaster::new(16);
        for i in 0..(REPLAY_BUFFER_MAX_EVENTS + 10) {
            let _ = b.send(format!(r#"{{"event":"e","payload":{}}}"#, i));
        }
        let replay = b.replay_after(0);
        assert!(replay.gap);
        assert_eq!(replay.events.len(), REPLAY_BUFFER_MAX_EVENTS);
    }
}
