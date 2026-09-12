//! cap.stream.echo —— 流式骨架 demo 能力（第六步阶段 B）
//!
//! 对应 `dev/docs/sky/step6-ai-streaming.md` §2.B：验证 dispatch_stream 全链路
//! （invoke_stream → RouterBus 泵任务 → EventAdapter → WS + in-proc 订阅），
//! 及 borrow 约束下的正确 spawn 模式（能力不捕获 ctx，自持计数器）。
//!
//! # 动作协议
//!
//! `{ "count": N?, "intervalMs": M?, "prefix": "..."? }`
//! → 按间隔发 N 条 `Event{kind:"stream.echo", payload:{i,total,prefix}}` 后关闭
//! （sender drop → RouterBus 泵任务广播 dispatch.end）。
//!
//! 实现取 std::thread + `try_send` 重试：不要求调用方处于 tokio 运行时
//! （路由泵任务才需要），对齐契约"能力内部 spawn 任务逐 token 发送"。

use crate::contracts::{Capability, CapabilityId, Context, Event, StreamingCapability, TraceId, Value};
use tokio::sync::mpsc;

/// cap.stream.echo —— 流式回显 demo
pub struct StreamEchoCapability;

impl StreamEchoCapability {
    /// 带重试的 try_send（通道满时退避，关闭时静默退出）
    fn send_with_retry(tx: &mpsc::Sender<Event>, event: Event) -> bool {
        for _ in 0..250 {
            match tx.try_send(event.clone()) {
                Ok(()) => return true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return false,
            }
        }
        false
    }
}

impl Capability for StreamEchoCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.stream.echo".into())
    }

    fn invoke(&self, _params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        Err("cap.stream.echo 是流式能力，请走 dispatch_stream".into())
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

impl StreamingCapability for StreamEchoCapability {
    fn invoke_stream(
        &self,
        params: Value,
        _ctx: &dyn Context,
    ) -> Result<tokio::sync::mpsc::Receiver<Event>, String> {
        let count = params
            .get("count")
            .and_then(|c| c.as_u64())
            .unwrap_or(3)
            .clamp(1, 100) as usize;
        let interval_ms = params
            .get("intervalMs")
            .and_then(|c| c.as_u64())
            .unwrap_or(20)
            .clamp(0, 1000);
        let prefix = params
            .get("prefix")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();

        let (tx, rx) = mpsc::channel(64);
        std::thread::spawn(move || {
            for i in 0..count {
                if interval_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(interval_ms));
                }
                let event = Event {
                    seq: 0,
                    kind: "stream.echo".into(),
                    payload: serde_json::json!({ "i": i, "total": count, "prefix": prefix }),
                    trace: TraceId("cap.stream.echo".into()),
                };
                if !Self::send_with_retry(&tx, event) {
                    return;
                }
            }
        });
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestCtx;
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &crate::contracts::Source {
            static S: crate::contracts::Source = crate::contracts::Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            static C: crate::contracts::PluginId = crate::contracts::PluginId(String::new());
            &C
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_ctx() -> TestCtx {
        use std::sync::atomic::AtomicU64 as A;
        static C: A = A::new(0);
        C.fetch_add(1, Ordering::SeqCst);
        TestCtx
    }

    #[test]
    fn invoke_sync_returns_hint() {
        let cap = StreamEchoCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("dispatch_stream"));
    }

    #[tokio::test]
    async fn stream_emits_count_events_then_closes() {
        let cap = StreamEchoCapability;
        let ctx = make_ctx();
        let mut rx = cap
            .invoke_stream(
                serde_json::json!({ "count": 3, "intervalMs": 1 }),
                &ctx,
            )
            .unwrap();
        let mut got = Vec::new();
        while let Some(ev) = rx.recv().await {
            got.push(ev);
        }
        assert_eq!(got.len(), 3);
        for (i, ev) in got.iter().enumerate() {
            assert_eq!(ev.kind, "stream.echo");
            assert_eq!(ev.payload["i"], i as u64);
            assert_eq!(ev.payload["total"], 3);
        }
    }

    #[test]
    fn count_is_clamped() {
        let cap = StreamEchoCapability;
        let ctx = make_ctx();
        let mut rx = cap
            .invoke_stream(serde_json::json!({ "count": 100000, "intervalMs": 0 }), &ctx)
            .unwrap();
        // 通道容量 64 + 重试上限 250：不消费的话发送方会退出，但不会发满 10 万条
        let mut n = 0usize;
        while let Some(_ev) = rx.try_recv().ok() {
            n += 1;
            if n > 5000 {
                break;
            }
        }
        assert!(n <= 100, "count 应被 clamp 到 100，实际 {}", n);
    }
}
