//! RouterBus — 统一转发总线
//!
//! 对应 `dev/docs/sky/step3-dispatch.md`：
//! - 阶段 A（mod.rs 主体）：RouterBus 实现契约 `Router` trait，dispatch 全链路
//!   （广播 dispatch.start → 权限 gate → 找句柄 → invoke → 广播 dispatch.end）
//! - 阶段 B（event_adapter / demo_capability）：事件适配层（契约 `Event` ↔ 现有
//!   广播器字符串格式）+ demo capability（cap.echo）
//!
//! 设计取舍：
//! - 复用 Polaris 生产级 `web/EventBroadcaster`（2000 条 / 8MB 双上限 + gap 检测），
//!   `EventAdapter` 在其上做契约转换与 in-proc 订阅，不重造广播器。
//! - Source 由传输层注入（调用方不可自填），Permission gate 是 dispatch 唯一入口。
//! - 审计：deny/allow 均经 `AuditSink`（阶段 A 可 None，Bootstrap 直管注入）。
//! - resolve_handle 保持 pub(crate)，防插件旁路直调（契约注释铁律）。

mod demo_capability;
mod event_adapter;

pub use demo_capability::{EchoCapability, FaultyCapability};
pub use event_adapter::{EventAdapter, static_perm::StaticPermission};

use crate::contracts::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

/// RouterBus 实现
///
/// - handles: 能力注册表（CapabilityHandle → Box<dyn Capability>）
/// - broadcaster: 事件适配层（复用现有生产级广播器 + in-proc 订阅）
/// - permission: 权限裁决（dispatch 是唯一入口，所有调用统一过 gate）
/// - storage: 契约 Storage（阶段 A 可 None，阶段 B 置 Some）
/// - audit: AuditSink（Bootstrap 直管，dispatch 落审计）
pub struct RouterBus {
    handles: RwLock<HashMap<CapabilityHandle, Box<dyn Capability>>>,
    next_handle: AtomicU64,
    broadcaster: Arc<EventAdapter>,
    permission: Box<dyn Permission>,
    storage: Option<Arc<dyn Storage>>,
    audit: Option<Arc<dyn AuditSink>>,
    plugin_configs: Arc<RwLock<HashMap<String, Value>>>,
}

impl RouterBus {
    /// 创建总线
    ///
    /// - `broadcaster`: 事件适配层（包住现有生产级广播器）
    /// - `permission`: 权限裁决（可用 `StaticPermission`）
    /// - `storage`: 契约 Storage（阶段 A 可 None；阶段 B 接 SqliteStorage）
    /// - `audit`: AuditSink（阶段 A 可 None；由 Bootstrap 直管注入）
    pub fn new(
        broadcaster: Arc<EventAdapter>,
        permission: Box<dyn Permission>,
        storage: Option<Arc<dyn Storage>>,
        audit: Option<Arc<dyn AuditSink>>,
    ) -> Self {
        Self {
            handles: RwLock::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
            broadcaster,
            permission,
            storage,
            audit,
            plugin_configs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 设置插件配置（供 dispatch 内 ctx 读取，键为插件 id）
    pub fn set_plugin_config(&self, plugin_id: &str, config: Value) {
        self.plugin_configs
            .write()
            .unwrap()
            .insert(plugin_id.to_string(), config);
    }

    /// 查找能力对应的插件配置（同 sky 三段匹配：精确 → 剥 cap. → 逐段缩短）
    pub fn plugin_config_for(&self, target: &CapabilityId) -> Value {
        let configs = self.plugin_configs.read().unwrap();
        if let Some(v) = configs.get(&target.0) {
            return v.clone();
        }
        if let Some(rest) = target.0.strip_prefix("cap.") {
            let mut segments: Vec<&str> = rest.split('.').collect();
            while !segments.is_empty() {
                let candidate = segments.join(".");
                if let Some(v) = configs.get(&candidate) {
                    return v.clone();
                }
                segments.pop();
            }
        }
        Value::Null
    }

    /// 列出已注册的能力 id（面板阶段 B 用）
    pub fn list_capabilities(&self) -> Vec<CapabilityId> {
        self.handles
            .read()
            .unwrap()
            .values()
            .map(|c| c.id())
            .collect()
    }
}

/// 实现契约 `Router` trait
impl Router for RouterBus {
    fn dispatch(&self, env: Envelope) -> Result<Reply, String> {
        // 0. 广播 dispatch.start 追踪事件（全链路可观测）
        self.broadcaster.broadcast(Event {
            seq: 0,
            kind: "dispatch.start".into(),
            payload: serde_json::json!({
                "msg_id": env.id.0,
                "target": env.target.0,
                "source": format!("{:?}", env.source),
            }),
            trace: env.trace.clone(),
        });

        // 1. 权限裁决（dispatch 是唯一入口，所有调用都过 gate）
        let perm_req = PermissionRequest {
            capability: env.target.clone(),
            resource: env.target.0.clone(),
            source: env.source.clone(),
        };
        match self.permission.check(&perm_req)? {
            PermissionVerdict::Deny => {
                self.audit_deny(&env);
                self.broadcaster.broadcast(Event {
                    seq: 0,
                    kind: "dispatch.deny".into(),
                    payload: serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "reason": "permission denied",
                    }),
                    trace: env.trace.clone(),
                });
                return Ok(Reply {
                    msg_id: env.id,
                    result: Err("权限拒绝".into()),
                    trace: env.trace,
                });
            }
            PermissionVerdict::Prompt => {
                // Phase 0 无 Shell，动态请求直接 Deny（安全失败）
                self.audit_deny(&env);
                self.broadcaster.broadcast(Event {
                    seq: 0,
                    kind: "dispatch.deny".into(),
                    payload: serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "reason": "prompt not supported in phase 0",
                    }),
                    trace: env.trace.clone(),
                });
                return Ok(Reply {
                    msg_id: env.id,
                    result: Err("需用户审批，Phase 0 暂不支持".into()),
                    trace: env.trace,
                });
            }
            PermissionVerdict::Allow => {}
        }

        // 2. 查找能力句柄（按 cap.id() 匹配）
        let handle = {
            let handles = self.handles.read().unwrap();
            handles
                .iter()
                .find(|(_, cap)| cap.id() == env.target)
                .map(|(h, _)| *h)
        };

        match handle {
            Some(h) => {
                // 3. 调用能力
                let handles = self.handles.read().unwrap();
                let cap = handles.get(&h).ok_or("句柄不存在")?;

                // 注入 ctx：Source 由传输层已注入 env（调用方不可自填）
                let plugin_config = self.plugin_config_for(&env.target);
                let ctx = RealContext::new(env.source.clone(), self.storage.clone(), plugin_config);

                let result = cap.invoke(env.payload.clone(), &ctx);

                // 4. 广播 dispatch.end 追踪事件
                let end_payload = match &result {
                    Ok(_) => serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "status": "ok",
                    }),
                    Err(e) => serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "status": "error",
                        "error": e,
                    }),
                };
                self.broadcaster.broadcast(Event {
                    seq: 0,
                    kind: "dispatch.end".into(),
                    payload: end_payload,
                    trace: env.trace.clone(),
                });

                // 审计 allow（dispatch 成功）
                if let Some(audit) = self.audit.as_ref() {
                    let _ = audit.append(&AuditEntry {
                        timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                        capability: env.target.clone(),
                        source: env.source.clone(),
                        action: "dispatch.ok".into(),
                        prev_hash: String::new(),
                    });
                }

                Ok(Reply {
                    msg_id: env.id,
                    result,
                    trace: env.trace,
                })
            }
            None => Ok(Reply {
                msg_id: env.id,
                result: Err(format!("能力未注册: {}", env.target.0)),
                trace: env.trace,
            }),
        }
    }

    fn subscribe(&self, filter: Filter) -> tokio::sync::mpsc::Receiver<Event> {
        self.broadcaster.subscribe(filter)
    }

    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String> {
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, cap);
        Ok(handle)
    }
}

impl RouterBus {
    /// 审计 deny（Deny 与 Prompt 安全失败共用）
    fn audit_deny(&self, env: &Envelope) {
        if let Some(audit) = self.audit.as_ref() {
            let _ = audit.append(&AuditEntry {
                timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                capability: env.target.clone(),
                source: env.source.clone(),
                action: "dispatch.deny".into(),
                prev_hash: String::new(),
            });
        }
    }
}

/// 真实上下文（dispatch 内部调用能力时注入）
///
/// - source: 由传输层注入（env.source，调用方不可自填）
/// - storage: 契约 Storage（阶段 A 可 None）
/// - caller_id: 调用方插件 id（dispatch 内部调用时为 Core 自身）
pub struct RealContext {
    source: Source,
    storage: Option<Arc<dyn Storage>>,
    plugin_config: Value,
    caller_id: PluginId,
}

impl RealContext {
    pub fn new(source: Source, storage: Option<Arc<dyn Storage>>, plugin_config: Value) -> Self {
        Self {
            source,
            storage,
            plugin_config,
            caller_id: PluginId("core".into()),
        }
    }
}

impl Context for RealContext {
    fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
        Err("RealContext 不实现 resolve_cap".into())
    }

    fn storage(&self) -> Result<&dyn Storage, String> {
        match &self.storage {
            Some(s) => Ok(s.as_ref()),
            None => Err("阶段 A 未接入存储（storage = None）".into()),
        }
    }

    fn check_permission(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        Ok(PermissionVerdict::Allow)
    }

    fn source(&self) -> &Source {
        &self.source
    }

    fn caller_id(&self) -> &PluginId {
        &self.caller_id
    }

    fn plugin_config(&self) -> Result<Value, String> {
        Ok(self.plugin_config.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::router::event_adapter::tests_support::{DenyRemotePermission, RecordingAudit};
    use crate::services::router::demo_capability::EchoCapability;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    /// 全放行权限（测试用）
    pub struct AllowAllPermission;
    impl Permission for AllowAllPermission {
        fn check(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            Ok(PermissionVerdict::Allow)
        }
    }

    /// 可编程权限（测试 deny/prompt 分支）
    pub struct ProgrammablePermission(Mutex<PermissionVerdict>);
    impl Permission for ProgrammablePermission {
        fn check(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    fn make_router(
        permission: Box<dyn Permission>,
        audit: Option<Arc<dyn AuditSink>>,
    ) -> (Arc<RouterBus>, Arc<EventAdapter>) {
        let broadcaster = Arc::new(EventAdapter::new(64));
        let router = Arc::new(RouterBus::new(
            broadcaster.clone(),
            permission,
            None,
            audit,
        ));
        (router, broadcaster)
    }

    #[test]
    fn dispatch_echo_returns_payload() {
        let (router, _) = make_router(Box::new(AllowAllPermission), None);
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let env = Envelope {
            id: MsgId("m1".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.echo".into()),
            payload: Value::String("hello polaris".into()),
            trace: TraceId("t1".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_ok());
        assert_eq!(
            reply.result.unwrap(),
            Value::String("hello polaris".into())
        );
    }

    #[test]
    fn dispatch_unregistered_returns_err() {
        let (router, _) = make_router(Box::new(AllowAllPermission), None);

        let env = Envelope {
            id: MsgId("m2".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.nonexistent".into()),
            payload: Value::Null,
            trace: TraceId("t2".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_err());
        assert!(reply.result.unwrap_err().contains("能力未注册"));
    }

    #[test]
    fn dispatch_remote_denied_by_permission() {
        let (router, _) = make_router(Box::new(DenyRemotePermission), None);
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let env = Envelope {
            id: MsgId("m3".into()),
            source: Source::Remote { token: "any".into() },
            target: CapabilityId("cap.echo".into()),
            payload: Value::Null,
            trace: TraceId("t3".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_err());
        assert!(reply.result.unwrap_err().contains("权限拒绝"));
    }

    #[test]
    fn dispatch_prompt_denied_safely() {
        let (router, _) = make_router(
            Box::new(ProgrammablePermission(Mutex::new(PermissionVerdict::Prompt))),
            None,
        );
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let env = Envelope {
            id: MsgId("m4".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.echo".into()),
            payload: Value::Null,
            trace: TraceId("t4".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_err());
        assert!(reply.result.unwrap_err().contains("审批"));
    }

    #[test]
    fn dispatch_allow_records_audit() {
        let audit = Arc::new(RecordingAudit(Mutex::new(Vec::new())));
        let (router, _) = make_router(Box::new(AllowAllPermission), Some(audit.clone()));
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let env = Envelope {
            id: MsgId("m5".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.echo".into()),
            payload: Value::Null,
            trace: TraceId("t5".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_ok());

        let out = audit.0.lock().unwrap();
        assert!(out.iter().any(|s| s.contains("dispatch.ok")));
    }

    #[test]
    fn dispatch_deny_records_audit() {
        let audit = Arc::new(RecordingAudit(Mutex::new(Vec::new())));
        let (router, _) = make_router(Box::new(DenyRemotePermission), Some(audit.clone()));
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let env = Envelope {
            id: MsgId("m6".into()),
            source: Source::Remote { token: "x".into() },
            target: CapabilityId("cap.echo".into()),
            payload: Value::Null,
            trace: TraceId("t6".into()),
        };
        let reply = router.dispatch(env).unwrap();
        assert!(reply.result.is_err());

        let out = audit.0.lock().unwrap();
        assert!(out.iter().any(|s| s.contains("dispatch.deny")));
    }

    #[test]
    fn plugin_config_fallback() {
        let (router, _) = make_router(Box::new(AllowAllPermission), None);
        router.set_plugin_config("cap.ai", serde_json::json!({"exact": true}));
        router.set_plugin_config("ai", serde_json::json!({"plugin": true}));

        assert_eq!(
            router.plugin_config_for(&CapabilityId("cap.ai".into())),
            serde_json::json!({"exact": true})
        );
        assert_eq!(
            router.plugin_config_for(&CapabilityId("cap.ai.engine.simple-ai".into())),
            serde_json::json!({"plugin": true})
        );
        assert_eq!(
            router.plugin_config_for(&CapabilityId("cap.nothing".into())),
            Value::Null
        );
    }

    /// 验证 dispatch 广播了 dispatch.start / dispatch.end（trace 匹配）
    #[test]
    fn dispatch_broadcasts_start_and_end() {
        let (router, broadcaster) = make_router(Box::new(AllowAllPermission), None);
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let mut rx = broadcaster.subscribe(Filter {
            kind: None,
            trace: None,
        });

        let env = Envelope {
            id: MsgId("m7".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.echo".into()),
            payload: Value::Null,
            trace: TraceId("trace-xyz".into()),
        };
        let _ = router.dispatch(env).unwrap();

        // 应收到 dispatch.start 和 dispatch.end（其他事件按序）
        let mut kinds = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while kinds.len() < 2 && std::time::Instant::now() < deadline {
            // mpsc recv 需要 async；用 try_recv 轮询（同步测试）
            match rx.try_recv() {
                Ok(ev) => {
                    if ev.kind.starts_with("dispatch.") {
                        kinds.push(ev.kind.clone());
                    }
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
        assert!(kinds.contains(&"dispatch.start".to_string()));
        assert!(kinds.contains(&"dispatch.end".to_string()));
    }

    /// 验证 subscribe(filter) 只收到匹配 kind 的事件（契约测试）
    #[test]
    fn subscribe_filters_by_kind() {
        let broadcaster = Arc::new(EventAdapter::new(64));
        let mut rx = broadcaster.subscribe(Filter {
            kind: Some("ai.token".to_string()),
            trace: None,
        });

        broadcaster.broadcast(Event {
            seq: 0,
            kind: "ai.token".into(),
            payload: serde_json::json!({"text": "你好"}),
            trace: TraceId("t1".into()),
        });
        broadcaster.broadcast(Event {
            seq: 0,
            kind: "chat.event".into(),
            payload: serde_json::json!({}),
            trace: TraceId("t1".into()),
        });

        // 等 ai.token 到达
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let mut got = None;
        while got.is_none() && std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(ev) => got = Some(ev),
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }

        let ev = got.expect("应收到匹配的 ai.token 事件");
        assert_eq!(ev.kind, "ai.token");
        assert_eq!(ev.payload["text"], "你好");

        // chat.event 不应到达
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(rx.try_recv().is_err());
    }
}