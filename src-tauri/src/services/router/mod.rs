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

mod ai_chat_capability;
pub mod audit_sink;
pub mod bash_capability;
mod config_capability;
mod context_capability;
mod data_root_capability;
pub mod fs_capability;
mod http_capability;
mod plugin_discovery_capability;
mod plugin_service_manager_capability;
mod history_capability;
mod demo_capability;
mod event_adapter;
mod voice_capability;
#[cfg(feature = "git")]
mod git_capability;
mod kv_capability;
mod policy_permission;
pub mod permission_prompt;
pub mod prompt_snippet_capability;
mod stream_echo_capability;
mod todo_capability;
mod help_capability;
pub mod ui_theme_capability;
pub mod ui_chat_capability;
mod dynamic_capability;
pub(crate) mod registry_capability;
mod ui_input_capability;
mod self_capability;
mod self_mutate_capability;
mod mcp_capability;
mod hook_capability;
mod ui_render_capability;

pub use ai_chat_capability::AiChatCapability;
pub use audit_sink::FileAuditSink;
pub use bash_capability::BashCapability;
pub(crate) use bash_capability::detect_shell;
pub use config_capability::ConfigCapability;
pub use context_capability::ContextCapability;
pub use data_root_capability::DataRootCapability;
pub use fs_capability::FsCapability;
#[cfg(feature = "git")]
pub use git_capability::{GitCapability, GIT_CAP_ID};
pub use http_capability::HttpCapability;
pub use plugin_discovery_capability::PluginDiscoveryCapability;
pub use plugin_service_manager_capability::PluginServiceManagerCapability;
pub use history_capability::HistoryCapability;
pub use demo_capability::{EchoCapability, FaultyCapability};
pub use event_adapter::{EventAdapter, static_perm::StaticPermission};
pub use kv_capability::KvCapability;
pub use policy_permission::PolicyPermission;
pub use permission_prompt::PermissionPromptRegistry;
pub use prompt_snippet_capability::PromptSnippetCapability;
pub use stream_echo_capability::StreamEchoCapability;
pub use help_capability::HelpCapability;
pub use todo_capability::TodoCapability;
pub use ui_theme_capability::UiThemeCapability;
pub use ui_chat_capability::UiChatCapability;
pub use ui_input_capability::UiInputCapability;
pub use self_capability::{SelfInspectCapability, mark_boot as mark_self_boot};
pub use self_mutate_capability::SelfMutateCapability;
pub use dynamic_capability::{DynamicCapability, DynamicCapabilityConfig, DynamicHandler};
pub use registry_capability::RegistryCapability;
pub(crate) use registry_capability::check_override_permission;
pub use mcp_capability::{McpCapability, MCP_CAP_ID};
pub use voice_capability::{VoiceCapability, VOICE_CAP_ID};
pub use hook_capability::HookCapability;
pub use ui_render_capability::UiRenderCapability;

use crate::contracts::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// X5 护栏：同步 dispatch 单次调用上限（入口层 tokio::time::timeout 包裹）。
///
/// 取 900s —— 必须大于能力层最长合法阻塞（cap.bash 内建默认 600s），只兜
/// 「能力 handler 永不返回」的挂死（占满 spawn_blocking 池），不截断任何
/// 合法长操作。这不是同步 bug 的遮羞布：超时有显式错误串 + 告警日志。
/// v1 常量；配置化（config.router.*）留给后续梯队。
pub const DISPATCH_SYNC_TIMEOUT: Duration = Duration::from_secs(900);

/// X5 护栏：流式泵 idle 上限——超过该时长无任何事件且通道未关，视为能力侧
/// 挂死，泵任务强制广播 dispatch.end(error) 收场。取 300s：容忍慢供应商的
/// 长思考间隔，只拦「永不发事件也永不关闭」的泄漏流。
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// 流式应答（dispatch_stream 立即返回；事件经 EventAdapter 通道推送）
///
/// 对齐 sky 的 stream 语义（`do/sky/src/router.rs:451` 流式分支返回
/// `{stream:true, stream_id, trace}` 立即应答）：本骨架以 `{msgId, trace}` 应答，
/// 事件流以 `dispatch.end` 收尾。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAck {
    pub msg_id: MsgId,
    pub trace: TraceId,
}

/// RouterBus 实现
///
/// - handles: 能力注册表（CapabilityHandle → Arc<dyn Capability>）
///
///   统一为 Arc：`dispatch` 在 invoke 前必须释放读锁（否则动态转发重入 dispatch 会
///   死锁）；Arc 允许「读锁内 clone 强引用 → 释放 → invoke」。register_handle 对外仍
///   收 Box，内部 Arc::from 转换。
/// - streaming_caps: 流式能力平行表（CapabilityId → Arc<dyn StreamingCapability>）。
/// - broadcaster: 事件适配层（复用现有生产级广播器 + in-proc 订阅）
/// - permission: 权限裁决（dispatch 是唯一入口，所有调用统一过 gate）
/// - storage: 契约 Storage（阶段 A 可 None，阶段 B 置 Some）
/// - audit: AuditSink（Bootstrap 直管，dispatch 落审计）
/// 覆盖链槽位（P2-c）：同一 cap id 的覆盖栈——末位为 active handler。
#[derive(Clone)]
pub struct OverrideSlot {
    pub cap: Arc<dyn Capability>,
    pub mode: ReplaceMode,
    pub registered_at_ms: u64,
}

pub struct RouterBus {
    handles: RwLock<HashMap<CapabilityHandle, Arc<dyn Capability>>>,
    streaming_caps: RwLock<HashMap<CapabilityId, Arc<dyn StreamingCapability>>>,
    next_handle: AtomicU64,
    broadcaster: Arc<EventAdapter>,
    permission: Arc<dyn Permission>,
    storage: Option<Arc<dyn Storage>>,
    audit: Option<Arc<dyn AuditSink>>,
    plugin_configs: Arc<RwLock<HashMap<String, Value>>>,
    /// Prompt 裁决的用户审批出口（P1-g）。None → Prompt 维持 Phase 0 安全失败。
    prompt_sink: RwLock<Option<Arc<dyn PermissionPromptSink>>>,
    /// 覆盖链（P2-c）：cap id → 覆盖栈（末位 active；fallback 失败下探，栈空回 base）
    overrides: RwLock<HashMap<CapabilityId, Vec<OverrideSlot>>>,
    /// L2 级覆盖白名单（config.capOverride.allow；装配注入）
    override_allowlist: RwLock<std::collections::HashSet<String>>,
}

impl RouterBus {
    /// 创建总线
    ///
    /// - `broadcaster`: 事件适配层（包住现有生产级广播器）
    /// - `permission`: 权限裁决（Arc 共享：dispatch 注入 RealContext 供能力内二次裁决）
    /// - `storage`: 契约 Storage（阶段 A 可 None；阶段 B 接 SqliteStorage）
    /// - `audit`: AuditSink（阶段 A 可 None；由 Bootstrap 直管注入）
    pub fn new(
        broadcaster: Arc<EventAdapter>,
        permission: Arc<dyn Permission>,
        storage: Option<Arc<dyn Storage>>,
        audit: Option<Arc<dyn AuditSink>>,
    ) -> Self {
        Self {
            handles: RwLock::new(HashMap::new()),
            streaming_caps: RwLock::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
            broadcaster,
            permission,
            storage,
            audit,
            plugin_configs: Arc::new(RwLock::new(HashMap::new())),
            prompt_sink: RwLock::new(None),
            overrides: RwLock::new(HashMap::new()),
            override_allowlist: RwLock::new(std::collections::HashSet::new()),
        }
    }

    // ===== 覆盖链（P2-c，cap 自由度 L3）=====

    /// 注入 L2 覆盖白名单（config.capOverride.allow，装配时）
    pub fn set_override_allowlist(&self, ids: Vec<String>) {
        *self.override_allowlist.write().unwrap() = ids.into_iter().collect();
    }

    /// 目标 id 是否在 L2 白名单内
    pub fn override_allowed(&self, id: &str) -> bool {
        self.override_allowlist.read().unwrap().contains(id)
    }

    /// 目标是否被覆盖（describe/cap_list 可观测）
    pub fn is_overridden(&self, id: &CapabilityId) -> bool {
        self.overrides
            .read()
            .unwrap()
            .get(id)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    /// 注册覆盖 handler：目标必须已注册（同步表/流式表/既有覆盖栈）。
    /// 覆盖栈末位为 active；Fallback 模式失败下探，栈空回 base handle。
    pub fn register_override(
        &self,
        id: CapabilityId,
        cap: Arc<dyn Capability>,
        mode: ReplaceMode,
    ) -> Result<(), String> {
        {
            let handles = self.handles.read().unwrap();
            let has_base = handles.values().any(|c| c.id() == id);
            let has_stream = self.streaming_caps.read().unwrap().contains_key(&id);
            let has_override = self
                .overrides
                .read()
                .unwrap()
                .get(&id)
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if !has_base && !has_stream && !has_override {
                return Err(format!(
                    "覆盖目标 {} 未注册（覆盖只能作用于既有能力；注册全新能力请去掉 replace）",
                    id.0
                ));
            }
        }
        self.overrides
            .write()
            .unwrap()
            .entry(id)
            .or_default()
            .push(OverrideSlot {
                cap,
                mode,
                registered_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            });
        Ok(())
    }

    /// 卸载一层覆盖（栈顶弹出；栈空自动移除键，base handler 恢复响应）。
    /// 返回是否弹出了覆盖（false = 目标本无覆盖）。
    pub fn unregister_override(&self, id: &CapabilityId) -> bool {
        let mut map = self.overrides.write().unwrap();
        if let Some(stack) = map.get_mut(id) {
            stack.pop();
            if stack.is_empty() {
                map.remove(id);
            }
            return true;
        }
        false
    }

    /// 目标 id 的覆盖链快照（describe/透视用）
    pub fn override_chain_of(&self, id: &CapabilityId) -> Vec<(String, ReplaceMode, u64)> {
        self.overrides
            .read()
            .unwrap()
            .get(id)
            .map(|stack| {
                stack
                    .iter()
                    .map(|s| (s.cap.id().0.clone(), s.mode, s.registered_at_ms))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 注入用户审批出口（装配时；P1-g）
    pub fn set_prompt_sink(&self, sink: Arc<dyn PermissionPromptSink>) {
        *self.prompt_sink.write().unwrap() = Some(sink);
    }

    /// 注销能力（按 cap.id 精确匹配，同步表与流式平行表分别处理）。
    ///
    /// 动态能力注册表（cap.registry）用它卸载运行期注册的 cap；对启动期静态装配
    /// 的内置能力同样可卸载（调用方负责安全边界）。不存在时返回 false（幂等）。
    pub fn unregister(&self, id: &CapabilityId) -> bool {
        let mut removed = false;
        {
            let mut handles = self.handles.write().unwrap();
            handles.retain(|_, cap| {
                if cap.id() == *id {
                    removed = true;
                    false
                } else {
                    true
                }
            });
        }
        if self.streaming_caps.write().unwrap().remove(id).is_some() {
            removed = true;
        }
        removed
    }

    /// 注册流式能力（平行表；与同步表同 id 冲突拒绝）
    pub fn register_streaming(&self, cap: Arc<dyn StreamingCapability>) -> Result<(), String> {
        let id = cap.id();
        let sync_conflict = self.handles.read().unwrap().values().any(|c| c.id() == id);
        if sync_conflict {
            return Err(format!("能力 {} 已注册为同步能力，不可重复注册为流式", id.0));
        }
        let mut table = self.streaming_caps.write().unwrap();
        if table.contains_key(&id) {
            return Ok(()); // 幂等：多入口（桌面/独立 Web）重复注册无害
        }
        table.insert(id, cap);
        Ok(())
    }

    /// 目标是否为已注册的流式能力
    pub fn is_streaming(&self, target: &CapabilityId) -> bool {
        self.streaming_caps.read().unwrap().contains_key(target)
    }

    /// 大容量订阅（桌面 chat-event 中继用：高频 token 流防丢）
    pub fn subscribe_with_capacity(
        &self,
        capacity: usize,
        filter: Filter,
    ) -> tokio::sync::mpsc::Receiver<Event> {
        self.broadcaster.subscribe_with_capacity(capacity, filter)
    }

    /// 流式 dispatch（第六步：事件经 EventAdapter 推送，立即返回 StreamAck）
    ///
    /// 全链路：广播 dispatch.start(stream) → 权限 gate → 查流式平行表 →
    /// invoke_stream 拿 Receiver → spawn 泵任务逐 Event 转播（trace 覆写为
    /// env.trace）→ sender 关闭后广播 dispatch.end(stream) → 立即返回 StreamAck。
    ///
    /// 泵任务要求调用方处于 tokio 运行时（Tauri 命令 / axum handler 均满足）。
    pub fn dispatch_stream(&self, env: Envelope) -> Result<StreamAck, String> {
        // 0. 广播 dispatch.start（stream 标记）
        self.broadcaster.broadcast(Event {
            seq: 0,
            kind: "dispatch.start".into(),
            payload: serde_json::json!({
                "msg_id": env.id.0,
                "target": env.target.0,
                "source": format!("{:?}", env.source),
                "stream": true,
            }),
            trace: env.trace.clone(),
        });

        // 1. 权限裁决（与同步 dispatch 同一 gate）
        let perm_req = PermissionRequest {
            capability: env.target.clone(),
            resource: env.target.0.clone(),
            source: env.source.clone(),
            action: payload_action(&env.payload),
        };
        match self.permission.check(&perm_req)? {
            PermissionVerdict::Deny => {
                self.audit_deny(&env, "permission");
                self.broadcaster.broadcast(Event {
                    seq: 0,
                    kind: "dispatch.deny".into(),
                    payload: serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "reason": "permission denied",
                        "stream": true,
                    }),
                    trace: env.trace.clone(),
                });
                return Err("权限拒绝".into());
            }
            PermissionVerdict::Prompt => {
                self.audit_deny(&env, "prompt");
                return Err("需用户审批，Phase 0 暂不支持".into());
            }
            PermissionVerdict::Allow => {}
        }

        // 2. 查流式平行表
        let cap = self.streaming_caps.read().unwrap().get(&env.target).cloned();
        let Some(cap) = cap else {
            return Err(format!("流式能力未注册: {}", env.target.0));
        };

        // 3. 注入 ctx（Source 由传输层注入，invoke_stream 调用期间有效）
        let plugin_config = self.plugin_config_for(&env.target);
        let ctx = RealContext::with_permission(
            env.source.clone(),
            self.storage.clone(),
            plugin_config,
            Some(self.broadcaster.clone()),
            self.permission.clone(),
        );

        // 4. 拿事件流
        let mut rx = match cap.invoke_stream(env.payload.clone(), &ctx) {
            Ok(rx) => rx,
            Err(e) => {
                self.broadcaster.broadcast(Event {
                    seq: 0,
                    kind: "dispatch.end".into(),
                    payload: serde_json::json!({
                        "msg_id": env.id.0,
                        "target": env.target.0,
                        "status": "error",
                        "error": e,
                        "stream": true,
                    }),
                    trace: env.trace.clone(),
                });
                return Err(e);
            }
        };

        // 5. 审计（接受即记，事件本身不逐条落审计）
        if let Some(audit) = self.audit.as_ref() {
            audit_append(
                audit.as_ref(),
                &AuditEntry {
                    timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                    capability: env.target.clone(),
                    source: env.source.clone(),
                    action: "dispatch.stream.start".into(),
                    prev_hash: String::new(),
                    detail: payload_action_detail(&env.payload),
                    duration_ms: None,
                },
            );
        }

        // 6. 泵任务：Receiver → EventAdapter（trace 统一覆写；sender 全关后收尾）。
        // X5 护栏：idle watchdog——能力侧若因故障/泄漏永不发事件也永不关通道，
        // 泵任务会无限挂起且不广播 dispatch.end（前端 lifecycle 挂起）。超过
        // STREAM_IDLE_TIMEOUT 无事件即强制收场（广播 error 终态 + 落审计）。
        let adapter = self.broadcaster.clone();
        let trace = env.trace.clone();
        let msg_id = env.id.clone();
        let target = env.target.0.clone();
        let audit = self.audit.clone();
        tokio::spawn(async move {
            loop {
                let recv = tokio::time::timeout(STREAM_IDLE_TIMEOUT, rx.recv()).await;
                match recv {
                    Ok(Some(mut ev)) => {
                        ev.trace = trace.clone();
                        adapter.broadcast(ev);
                    }
                    // 通道关闭：正常收尾
                    Ok(None) => break,
                    // idle 超时：强制收场，防 dispatch.end 永不到达
                    Err(_) => {
                        tracing::error!(
                            target = %target,
                            idle_secs = STREAM_IDLE_TIMEOUT.as_secs(),
                            "流式泵 idle 超时，强制广播 dispatch.end(error)"
                        );
                        if let Some(audit) = audit.as_ref() {
                            audit_append(
                                audit.as_ref(),
                                &AuditEntry {
                                    timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                                    capability: CapabilityId(target.clone()),
                                    source: Source::Bootstrap, // 泵任务宿主侧，无调用方可引用
                                    action: "dispatch.stream.timeout".into(),
                                    prev_hash: String::new(),
                                    detail: Some(format!("streamIdleTimeout={}s", STREAM_IDLE_TIMEOUT.as_secs())),
                                    duration_ms: None,
                                },
                            );
                        }
                        adapter.broadcast(Event {
                            seq: 0,
                            kind: "dispatch.end".into(),
                            payload: serde_json::json!({
                                "msg_id": msg_id.0,
                                "target": target,
                                "status": "error",
                                "error": format!(
                                    "stream idle timeout ({}s)",
                                    STREAM_IDLE_TIMEOUT.as_secs()
                                ),
                                "stream": true,
                            }),
                            trace: trace.clone(),
                        });
                        return; // drop rx：能力侧后续 send 失败自止
                    }
                }
            }
            adapter.broadcast(Event {
                seq: 0,
                kind: "dispatch.end".into(),
                payload: serde_json::json!({
                    "msg_id": msg_id.0,
                    "target": target,
                    "status": "ok",
                    "stream": true,
                }),
                trace,
            });
        });

        Ok(StreamAck {
            msg_id: env.id,
            trace: env.trace,
        })
    }

    /// 宿主侧直接广播事件（kind 直达前端 transport.listen 通道）。
    ///
    /// 用途：非 dispatch 链路的状态回推（如插件服务状态 `plugin.service.status`，
    /// P1-3）。与 RealContext::emit 同通道，但无需 ctx。
    pub fn emit_event(&self, kind: &str, payload: Value) {
        self.broadcaster.broadcast(Event {
            seq: 0,
            kind: kind.into(),
            payload,
            trace: TraceId(format!("trace-{}", uuid::Uuid::new_v4())),
        });
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

    /// 全量能力自描述索引（cap.help index 数据源）
    ///
    /// 同步表（handles）与流式平行表（streaming_caps）并集 —— 补上
    /// `list_capabilities()` 漏掉流式能力（cap.ai.chat / cap.stream.echo）的盲区。
    /// 每项四键：`{ "id", "streaming", "overridden", "describe" }`，describe 缺省
    /// 为 null；流式分支恒 `overridden: false`（流式 dispatch 直查平行表、不消费
    /// 覆盖链，见 `dispatch_stream`），与同步分支键集对齐 —— AI 统一按四键解析
    /// 不再落空。
    /// 仅聚合静态 describe()，不触达 invoke（无副作用，可安全用于 help 索引）。
    /// 聚合时对每项 describe 跑 validate_describe 契约校验：违例仅
    /// `warn_describe_violations` 日志告警，不阻断条目输出（协议保守；静态能力
    /// 已全部迁移 standard_describe，告警保留为回归巡逻）。
    pub fn described_capabilities(&self) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        {
            let handles = self.handles.read().unwrap();
            let overrides = self.overrides.read().unwrap();
            for cap in handles.values() {
                let id = cap.id();
                let describe = cap.describe();
                warn_describe_violations(&id.0, &describe);
                let overridden = overrides
                    .get(&id)
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                out.push(serde_json::json!({
                    "id": id.0,
                    "streaming": false,
                    "overridden": overridden,
                    "describe": describe,
                }));
            }
        }
        {
            let streaming = self.streaming_caps.read().unwrap();
            for cap in streaming.values() {
                let id = cap.id();
                let describe = cap.describe();
                warn_describe_violations(&id.0, &describe);
                out.push(serde_json::json!({
                    "id": id.0,
                    "streaming": true,
                    "overridden": false,
                    "describe": describe,
                }));
            }
        }
        out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        out
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
            action: payload_action(&env.payload),
        };
        match self.permission.check(&perm_req)? {
            PermissionVerdict::Deny => {
                self.audit_deny(&env, "permission");
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
                    error_detail: None,
                });
            }
            PermissionVerdict::Prompt => {
                // P1-g：有审批出口且已有有效批准 → 放行（批准 + 重试模式）
                let sink_opt = self.prompt_sink.read().unwrap().clone();
                let already_approved = sink_opt
                    .as_ref()
                    .map(|s| s.has_approval(&perm_req))
                    .unwrap_or(false);
                if already_approved {
                    // 已批准，继续后续流程
                } else if let Some(sink) = sink_opt {
                    // 无批准：登记审批请求（非阻塞）+ 广播 permission.prompt 事件，
                    // 返回待审批错误（AI 在用户批准后重试即放行）
                    match sink.request_approval(&perm_req) {
                        Ok(request_id) => {
                            self.audit_deny(&env, "prompt_pending");
                            self.broadcaster.broadcast(Event {
                                seq: 0,
                                kind: "dispatch.deny".into(),
                                payload: serde_json::json!({
                                    "msg_id": env.id.0,
                                    "target": env.target.0,
                                    "reason": "permission prompt pending",
                                    "requestId": request_id,
                                }),
                                trace: env.trace.clone(),
                            });
                            return Ok(Reply {
                                msg_id: env.id,
                                result: Err(format!(
                                    "需用户审批：已发起确认请求 {}（前端确认后请重试本调用）",
                                    request_id
                                )),
                                trace: env.trace,
                                error_detail: None,
                            });
                        }
                        Err(e) => {
                            self.audit_deny(&env, "prompt_sink_error");
                            return Ok(Reply {
                                msg_id: env.id,
                                result: Err(format!("审批通道异常: {}", e)),
                                trace: env.trace,
                                error_detail: None,
                            });
                        }
                    }
                } else {
                    // 无审批出口：维持 Phase 0 安全失败
                    self.audit_deny(&env, "prompt");
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
                        // 本进程未接审批出口（bus MCP 进程形态）：指路主进程通道——
                        // 主进程 cap_dispatch 有 PermissionPromptSink，返回确认请求 id。
                        result: Err(
                            "需用户审批，本进程未接审批出口（Phase 0 形态）：bus 进程请改经主进程 cap_dispatch 调用（可返回确认请求 id，前端批准后重试即放行）".into(),
                        ),
                        trace: env.trace,
                        error_detail: None,
                    });
                }
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
                // 3. 构造候选链（P2-c 覆盖链）：覆盖栈栈顶优先，base handler 恒在
                // 末位兜底。override 模式失败即刻返回（不触达 base）；fallback 模式
                // 失败下探下一个候选。
                // 关键：先在读锁内取出 Arc 强引用，**释放锁后再 invoke**。
                // 否则 DynamicCapability::invoke（转发重入 dispatch）会在持有读锁时
                // 再次取同一把 handles 读锁 —— std RwLock 是写者优先，只要任一 register/
                // unregister 写者在队列等待，就触发读-读重试死锁（持锁等锁）。
                let base = {
                    let handles = self.handles.read().unwrap();
                    handles.get(&h).cloned()
                }
                .ok_or("句柄不存在")?;
                let chain: Vec<OverrideSlot> = self
                    .overrides
                    .read()
                    .unwrap()
                    .get(&env.target)
                    .cloned()
                    .unwrap_or_default();
                let mut candidates: Vec<(Arc<dyn Capability>, ReplaceMode)> = chain
                    .iter()
                    .rev()
                    .map(|slot| (slot.cap.clone(), slot.mode))
                    .collect();
                candidates.push((base, ReplaceMode::Override));

                // 依次尝试候选；候选全部失败时取最后一个错误
                let mut started = std::time::Instant::now();
                let mut final_outcome: Option<(
                    Result<Value, String>,
                    Option<crate::contracts::ReplyErrorDetail>,
                )> = None;
                for (cap, mode) in &candidates {
                    let plugin_config = self.plugin_config_for(&env.target);
                    let ctx = RealContext::with_permission(
                        env.source.clone(),
                        self.storage.clone(),
                        plugin_config,
                        Some(self.broadcaster.clone()),
                        self.permission.clone(),
                    );
                    let outcome = match cap.invoke(env.payload.clone(), &ctx) {
                        Err(e) => {
                            let (clean, detail) = crate::contracts::Reply::split_error_detail(e);
                            (Err(clean), detail)
                        }
                        Ok(v) => (Ok(v), None),
                    };
                    let ok = outcome.0.is_ok();
                    final_outcome = Some(outcome);
                    if ok || *mode == ReplaceMode::Override {
                        break;
                    }
                    tracing::warn!(
                        capability = %env.target.0,
                        handler = %cap.id().0,
                        "覆盖 handler 失败，fallback 下探"
                    );
                }
                let (result, error_detail) =
                    final_outcome.expect("候选链非空（base handler 恒在）");
                let duration_ms = started.elapsed().as_millis() as u64;

                // 4. 广播 dispatch.end 追踪事件（一次 dispatch 恰一个终态）
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

                // 审计（X4：成败分别记 action；detail 记动作名，不落参数明文）
                if let Some(audit) = self.audit.as_ref() {
                    audit_append(
                        audit.as_ref(),
                        &AuditEntry {
                            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                            capability: env.target.clone(),
                            source: env.source.clone(),
                            action: if result.is_ok() {
                                "dispatch.ok".into()
                            } else {
                                "dispatch.error".into()
                            },
                            prev_hash: String::new(),
                            detail: payload_action_detail(&env.payload),
                            duration_ms: Some(duration_ms),
                        },
                    );
                }

                Ok(Reply {
                    msg_id: env.id,
                    result,
                    trace: env.trace,
                    error_detail,
                })
            }
            None => {
                // 流式平行表回退：混合型能力（cap.ai.chat 有同步动作）走 invoke
                let stream_cap = self.streaming_caps.read().unwrap().get(&env.target).cloned();
                if let Some(cap) = stream_cap {
                    let plugin_config = self.plugin_config_for(&env.target);
                    let ctx = RealContext::with_permission(
                        env.source.clone(),
                        self.storage.clone(),
                        plugin_config,
                        Some(self.broadcaster.clone()),
                        self.permission.clone(),
                    );
                    let started = std::time::Instant::now();
                    let payload = env.payload.clone();
                    let result = cap.invoke(payload.clone(), &ctx);
                    // 阶段 1.3：一次 dispatch 恰一个终态事件 —— 此前的重复
                    // dispatch.end 广播已删除（双终态会让前端 lifecycleSubscriber
                    // 对同一 msg_id 状态翻转两次）
                    let (result, error_detail) = match result {
                        Err(e) => {
                            let (clean, detail) = crate::contracts::Reply::split_error_detail(e);
                            (Err(clean), detail)
                        }
                        Ok(v) => (Ok(v), None),
                    };
                    // X4：回退分支补审计——这是 cap.ai.chat 同步动作的高频路径，
                    // 历史版本整段零审计（2026-10-24 审计 X4-①）
                    if let Some(audit) = self.audit.as_ref() {
                        audit_append(
                            audit.as_ref(),
                            &AuditEntry {
                                timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                                capability: env.target.clone(),
                                source: env.source.clone(),
                                action: if result.is_ok() {
                                    "dispatch.ok".into()
                                } else {
                                    "dispatch.error".into()
                                },
                                prev_hash: String::new(),
                                detail: payload_action_detail(&payload),
                                duration_ms: Some(started.elapsed().as_millis() as u64),
                            },
                        );
                    }
                    self.broadcaster.broadcast(Event {
                        seq: 0,
                        kind: "dispatch.end".into(),
                        payload: serde_json::json!({
                            "msg_id": env.id.0,
                            "target": env.target.0,
                            "status": if result.is_ok() { "ok" } else { "error" },
                            "sync": true,
                        }),
                        trace: env.trace.clone(),
                    });
                    return Ok(Reply {
                        msg_id: env.id,
                        result,
                        trace: env.trace,
                        error_detail,
                    });
                }
                Ok(Reply {
                    msg_id: env.id,
                    result: Err(format!("能力未注册: {}", env.target.0)),
                    trace: env.trace,
                    error_detail: None,
                })
            }
        }
    }

    fn subscribe(&self, filter: Filter) -> tokio::sync::mpsc::Receiver<Event> {
        self.broadcaster.subscribe(filter)
    }

    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String> {
        // X12（2026-10-24 审计）：拒绝同 id 重复注册——双注册后 dispatch 遍历
        // HashMap 取序不定，分派不可预测。装配点全部 `let _ =` 忽略错误，
        // 重复注册静默变为「保留先注册者」，无行为回归。
        let id = cap.id();
        {
            let handles = self.handles.read().unwrap();
            if handles.values().any(|c| c.id() == id) {
                tracing::warn!(capability = %id.0, "register_handle: 能力 id 已注册，拒绝重复注册");
                return Err(format!("能力 {} 已注册，不可重复注册", id.0));
            }
        }
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, Arc::from(cap));
        Ok(handle)
    }
}

impl RouterBus {
    /// 注册能力（Arc 版本）：调用方保留同一 Arc 强引用。
    ///
    /// 用途：cap.voice 委托 cap.mcp 时复用**同一能力实例**（不复制 McpClient 注册表、
    /// 不第二次拉起插件进程——AGENTS.md「唯一权威，禁止多写路径」）。
    pub fn register_handle_arc(&self, cap: Arc<dyn Capability>) -> Result<CapabilityHandle, String> {
        // X12：同 register_handle——同 id 拒绝（幂等注册走 register_streaming 语义）
        let id = cap.id();
        {
            let handles = self.handles.read().unwrap();
            if handles.values().any(|c| c.id() == id) {
                tracing::warn!(capability = %id.0, "register_handle_arc: 能力 id 已注册，拒绝重复注册");
                return Err(format!("能力 {} 已注册，不可重复注册", id.0));
            }
        }
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        let mut handles = self.handles.write().unwrap();
        handles.insert(handle, cap);
        Ok(handle)
    }

    /// 审计 deny（Deny 与 Prompt 安全失败共用；拒绝原因编码进 action 后缀，
    /// 沿用本模块既有 `dispatch.deny:<reason>` 编码风格）
    fn audit_deny(&self, env: &Envelope, reason: &str) {
        if let Some(audit) = self.audit.as_ref() {
            audit_append(
                audit.as_ref(),
                &AuditEntry {
                    timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
                    capability: env.target.clone(),
                    source: env.source.clone(),
                    action: format!("dispatch.deny:{}", reason),
                    prev_hash: String::new(),
                    detail: payload_action_detail(&env.payload),
                    duration_ms: None,
                },
            );
        }
    }
}

/// 审计 append 失败告警（X4：原三处 `let _ =` 静默吞错，磁盘满/IO 故障时
/// 审计链无声断流）。行为保持 fail-open——dispatch 结果不因审计故障被丢弃
/// （fail-closed 会让一次磁盘满挂掉全部能力调用）——但绝不无声。
fn audit_append(audit: &dyn AuditSink, entry: &AuditEntry) {
    if let Err(e) = audit.append(entry) {
        tracing::error!(
            capability = %entry.capability.0,
            action = %entry.action,
            error = %e,
            "审计写入失败（fail-open，dispatch 结果不受影响）"
        );
    }
}

/// payload 动作名提取（P1-g 权限 action 粒度用）
fn payload_action(payload: &Value) -> Option<String> {
    payload
        .get("action")
        .and_then(|a| a.as_str())
        .map(|a| a.chars().take(64).collect())
}

/// payload 动作摘要（审计 detail 用）：只记动作名，不落参数明文——
/// 参数可能携带 token 等敏感值；字符级截断防超长动作名污染审计行。
fn payload_action_detail(payload: &Value) -> Option<String> {
    let action = payload.get("action")?.as_str()?;
    Some(format!("action={}", action).chars().take(64).collect())
}

/// describe 契约校验告警（described_capabilities 聚合点用）：违例仅日志，
/// 不阻断聚合——协议保守，cap_list 每项键形状与 describe 内容不变。
/// 静态能力已全部迁移 standard_describe（2026-10-25），本告警保留为回归巡逻：
/// 防未来新能力手写异形顶层键 / 动态注册能力（describe 缺省 Null，校验视为
/// 「未声明」不告警）注入非对象 describe。
fn warn_describe_violations(id: &str, describe: &Value) {
    let problems = validate_describe(id, describe);
    if !problems.is_empty() {
        tracing::warn!(
            capability = id,
            "describe 契约违例（不阻断，构造请走 contracts::standard_describe）: {}",
            problems.join("; ")
        );
    }
}

/// 真实上下文（dispatch 内部调用能力时注入）
///
/// - source: 由传输层注入（env.source，调用方不可自填）
/// - storage: 契约 Storage（阶段 A 可 None）
/// - plugin_config: 当前目标能力对应插件的配置
/// - broadcaster: 事件适配层（能力 `emit` 的通道 —— 契约 `Context::emit` 落地）
/// - caller_id: 调用方插件 id（dispatch 内部调用时为 Core 自身）
pub struct RealContext {
    source: Source,
    storage: Option<Arc<dyn Storage>>,
    plugin_config: Value,
    broadcaster: Option<Arc<EventAdapter>>,
    caller_id: PluginId,
    /// 与 dispatch 同源的权限策略（2026-10-24 审计：check_permission 此前恒
    /// Allow——能力内二次裁决拿不到策略）。dispatch 经 with_permission 注入。
    permission: Option<Arc<dyn Permission>>,
}

impl RealContext {
    pub fn new(
        source: Source,
        storage: Option<Arc<dyn Storage>>,
        plugin_config: Value,
        broadcaster: Option<Arc<EventAdapter>>,
    ) -> Self {
        Self {
            caller_id: derive_caller_id(&source),
            source,
            storage,
            plugin_config,
            broadcaster,
            permission: None,
        }
    }

    /// dispatch 用构造：附加与主 gate 同源的权限策略（能力内二次裁决）
    pub fn with_permission(
        source: Source,
        storage: Option<Arc<dyn Storage>>,
        plugin_config: Value,
        broadcaster: Option<Arc<EventAdapter>>,
        permission: Arc<dyn Permission>,
    ) -> Self {
        Self {
            caller_id: derive_caller_id(&source),
            source,
            storage,
            plugin_config,
            broadcaster,
            permission: Some(permission),
        }
    }
}

/// 调用方插件 id：Plugin 来源取 caller；Bootstrap/Remote（非插件进程）为 core
fn derive_caller_id(source: &Source) -> PluginId {
    match source {
        Source::Plugin { caller } => caller.clone(),
        _ => PluginId("core".into()),
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

    fn check_permission(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        match &self.permission {
            Some(p) => p.check(req),
            // 无策略上下文（测试/独立构造）：保持历史 Allow 语义
            None => Ok(PermissionVerdict::Allow),
        }
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

    fn emit(&self, event: &str, payload: Value) -> Result<(), String> {
        match &self.broadcaster {
            Some(b) => {
                b.broadcast(Event {
                    seq: 0,
                    kind: event.to_string(),
                    payload,
                    trace: TraceId(format!("trace-{}", uuid::Uuid::new_v4())),
                });
                Ok(())
            }
            None => Err("RealContext: 无广播通道（broadcaster = None）".into()),
        }
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
        permission: Arc<dyn Permission>,
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
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);
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
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);

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
        let (router, _) = make_router(Arc::new(DenyRemotePermission), None);
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

    /// 仅对指定 capability 拒绝 Remote（X1 回归测试用）
    struct DenyRemoteForCap(String);
    impl Permission for DenyRemoteForCap {
        fn check(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            if req.capability.0 == self.0 && matches!(req.source, Source::Remote { .. }) {
                Ok(PermissionVerdict::Deny)
            } else {
                Ok(PermissionVerdict::Allow)
            }
        }
    }

    /// X1 回归（2026-10-24 审计）：动态别名转发不得提权——Remote 调用方经
    /// forward 别名访问被 Remote-deny 的目标 cap，必须在转发后的 gate 被拒
    /// （历史 bug：转发改写为 Plugin 身份，整条 Remote deny 基线被洗白）。
    #[test]
    fn dynamic_forward_preserves_remote_source() {
        let (router, _) = make_router(Arc::new(DenyRemoteForCap("cap.echo".into())), None);
        router.register_handle(Box::new(EchoCapability)).unwrap();

        let dyn_cap = DynamicCapability::new(
            DynamicCapabilityConfig {
                id: "cap.dyn.echo".into(),
                summary: "cap.echo 别名（回归测试）".into(),
                description: None,
                handler: DynamicHandler::Forward {
                    target: "cap.echo".into(),
                    defaults: None,
                },
                persist: false,
            },
            router.clone(),
        );
        router.register_handle(Box::new(dyn_cap)).unwrap();

        // 对照 1：Bootstrap 直接调目标 cap → 放行
        let reply = router
            .dispatch(Envelope {
                id: MsgId("x1-a".into()),
                source: Source::Bootstrap,
                target: CapabilityId("cap.echo".into()),
                payload: Value::Null,
                trace: TraceId("t".into()),
            })
            .unwrap();
        assert!(reply.result.is_ok());

        // 对照 2：Remote 直接调目标 cap → 拒绝（deny 基线生效）
        let reply = router
            .dispatch(Envelope {
                id: MsgId("x1-b".into()),
                source: Source::Remote { token: "t".into() },
                target: CapabilityId("cap.echo".into()),
                payload: Value::Null,
                trace: TraceId("t".into()),
            })
            .unwrap();
        assert!(reply.result.is_err());

        // 主断言：Remote 经动态别名调目标 cap → 同样拒绝（转发保留原始 source）
        let reply = router
            .dispatch(Envelope {
                id: MsgId("x1-c".into()),
                source: Source::Remote { token: "t".into() },
                target: CapabilityId("cap.dyn.echo".into()),
                payload: Value::Null,
                trace: TraceId("t".into()),
            })
            .unwrap();
        let err = reply.result.unwrap_err();
        assert!(
            err.contains("权限拒绝"),
            "转发应保留原始 source 并被目标 gate 拒绝: {}",
            err
        );
    }

    #[test]
    fn dispatch_prompt_denied_safely() {
        let (router, _) = make_router(
            Arc::new(ProgrammablePermission(Mutex::new(PermissionVerdict::Prompt))),
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
        let (router, _) = make_router(Arc::new(AllowAllPermission), Some(audit.clone()));
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
        let (router, _) = make_router(Arc::new(DenyRemotePermission), Some(audit.clone()));
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
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);
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
        let (router, broadcaster) = make_router(Arc::new(AllowAllPermission), None);
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

    // =========================================================================
    // 第六步：流式骨架（dispatch_stream / 平行表 / 防误用）
    // =========================================================================

    use crate::services::router::stream_echo_capability::StreamEchoCapability;

    #[tokio::test]
    async fn dispatch_stream_pumps_events_and_ends() {
        let (router, broadcaster) = make_router(Arc::new(AllowAllPermission), None);
        router
            .register_streaming(Arc::new(StreamEchoCapability))
            .unwrap();

        let mut rx = broadcaster.subscribe(Filter { kind: None, trace: None });

        let ack = router
            .dispatch_stream(Envelope {
                id: MsgId("s1".into()),
                source: Source::Bootstrap,
                target: CapabilityId("cap.stream.echo".into()),
                payload: serde_json::json!({ "count": 3, "intervalMs": 1 }),
                trace: TraceId("trace-stream".into()),
            })
            .unwrap();
        assert_eq!(ack.msg_id.0, "s1");

        // 收事件流：3 条 stream.echo + dispatch.end（泵任务异步，轮询收集）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut kinds = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(ev) => {
                    assert_eq!(ev.trace.0, "trace-stream", "泵任务应统一覆写 trace");
                    kinds.push(ev.kind.clone());
                    if kinds.iter().filter(|k| **k == "dispatch.end".to_string()).count() >= 1
                        && kinds.iter().filter(|k| **k == "stream.echo".to_string()).count() >= 3
                    {
                        break;
                    }
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            }
        }
        assert_eq!(
            kinds.iter().filter(|k| **k == "stream.echo".to_string()).count(),
            3
        );
        assert!(kinds.contains(&"dispatch.end".to_string()), "流结束应有 dispatch.end");
        assert!(kinds.contains(&"dispatch.start".to_string()));
    }

    #[tokio::test]
    async fn sync_dispatch_on_streaming_target_is_rejected() {
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);
        router
            .register_streaming(Arc::new(StreamEchoCapability))
            .unwrap();

        let reply = router
            .dispatch(Envelope {
                id: MsgId("s2".into()),
                source: Source::Bootstrap,
                target: CapabilityId("cap.stream.echo".into()),
                payload: Value::Null,
                trace: TraceId("t".into()),
            })
            .unwrap();
        let err = reply.result.unwrap_err();
        assert!(err.contains("dispatch_stream"), "防误用提示: {}", err);
    }

    #[tokio::test]
    async fn dispatch_stream_unregistered_returns_err() {
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);
        let r = router.dispatch_stream(Envelope {
            id: MsgId("s3".into()),
            source: Source::Bootstrap,
            target: CapabilityId("cap.nope".into()),
            payload: Value::Null,
            trace: TraceId("t".into()),
        });
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("流式能力未注册"));
    }

    #[tokio::test]
    async fn dispatch_stream_denied_by_permission_audits() {
        let audit = Arc::new(crate::services::router::event_adapter::tests_support::RecordingAudit(
            Mutex::new(Vec::new()),
        ));
        let (router, _) = make_router(Arc::new(DenyRemotePermission), Some(audit.clone()));
        router
            .register_streaming(Arc::new(StreamEchoCapability))
            .unwrap();

        let r = router.dispatch_stream(Envelope {
            id: MsgId("s4".into()),
            source: Source::Remote { token: "x".into() },
            target: CapabilityId("cap.stream.echo".into()),
            payload: Value::Null,
            trace: TraceId("t".into()),
        });
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("权限拒绝"));
        assert!(
            audit.0.lock().unwrap().iter().any(|s| s.contains("dispatch.deny")),
            "流式 deny 应落审计"
        );
    }

    #[tokio::test]
    async fn register_streaming_conflicts_with_sync_handle() {
        let (router, _) = make_router(Arc::new(AllowAllPermission), None);
        router.register_handle(Box::new(EchoCapability)).unwrap();
        let r = router.register_streaming(Arc::new(StreamEchoCapability));
        // cap.stream.echo 与 cap.echo 不同 id —— 注册成功
        assert!(r.is_ok());
        // 幂等：同 id 重复注册（桌面/独立 Web 双入口）返回 Ok
        let r2 = router.register_streaming(Arc::new(StreamEchoCapability));
        assert!(r2.is_ok(), "重复注册同 id 流式能力应幂等");
    }
}