//! Polaris 核心契约定义（对齐 sky `do/sky/src/contracts/mod.rs`，第一步契约冻结）
//!
//! 定位：本模块是 Polaris 重构的地基层。后续能力（存储/转发/AI）全部依赖此处的
//! `Source` / `CapabilityId` / trait 冻结。本层不依赖任何现有业务模块。
//!
//! 来源：sky 契约（Phase 0a 冻结版，经 8 项复审打磨）。sky 的预审 7 项在此继承：
//! 1. Context 定为 trait（第 7 契约），签名不返回 Arc/Rc
//! 2. 所有参数类型已定义且 WIT-compatible
//! 3. 依赖声明权威源 = manifest requires（单源）
//! 4. Local 来源证明 = LocalSecret（非 HTTP 通道注入）
//! 5. 审计矛盾消解 = domain_audit 内嵌各域 DB + AuditSink 由 Bootstrap 直管
//! 6. invoke 取消，所有调用走 dispatch（权限/审计天然统一）
//! 7. trait→WIT 映射校验：root→String，resolve→CapabilityHandle，subscribe 异步
//!
//! 双契约面：Rust trait = 宿主内契约(Phase 0-1)，WIT = WASM 边界契约(Phase 2，后置)

// ============================================================================
// 基础类型（全部 WIT-compatible：仅可序列化字段，无 Arc/trait object/lifetime）
// ============================================================================

/// 能力唯一标识（路由键，非插件名）
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct CapabilityId(pub String);

/// 插件唯一标识
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct PluginId(pub String);

/// 消息唯一标识（用于 trace 贯通）
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct MsgId(pub String);

/// 追踪标识（全链路可追溯）
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct TraceId(pub String);

/// 通用值类型（跨 WASM 边界可序列化）
pub type Value = serde_json::Value;

/// 存储项标识
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Id(pub String);

/// 存储项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Item {
    pub id: Id,
    pub data: Value,
}

/// 存储查询
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Query {
    pub filter: Value,
    pub limit: Option<usize>,
}

/// 能力句柄（u64，跨 WASM 边界可传；对齐 Polaris 原稿 §3 result<capability-handle>）
pub type CapabilityHandle = u64;

// ============================================================================
// 来源与权限（预审 4：Local 证明机制）
// ============================================================================

/// 请求来源（由传输层注入，调用方不可自填）
///
/// 铁律：无任何 Shell 请求路径获得 Source::Local。
/// HTTP/WS adapter → Remote；in-proc → Plugin(caller_id)。
/// LocalSecret 证明：Core 启动生成一次性 secret，经非 HTTP 通道传给本地 Shell。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Source {
    /// Bootstrap/Core 内部调用（如 fallback 存储读取）。Shell 永不获得此值。
    Bootstrap,
    /// 远程来源（经 HTTP/WS），必须携带有效 token
    Remote { token: String },
    /// 插件间调用（经 Router.dispatch），caller_id 由 ctx 注入
    Plugin { caller: PluginId },
}

/// 权限请求（镜像 sky WIT record request）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PermissionRequest {
    pub capability: CapabilityId,
    pub resource: String,
    pub source: Source,
}

/// 权限裁决结果
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PermissionVerdict {
    Allow,
    Deny,
    /// 需用户审批（经 PromptChannel 推送到 Shell）。Phase 0 无 Shell 时直接 Deny。
    Prompt,
}

// ============================================================================
// 信封与事件（转发骨干）
// ============================================================================

/// 统一信封（所有来源标准化成此结构）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Envelope {
    pub id: MsgId,
    pub source: Source,
    pub target: CapabilityId,
    pub payload: Value,
    pub trace: TraceId,
}

/// 路由回复
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Reply {
    pub msg_id: MsgId,
    pub result: Result<Value, String>,
    pub trace: TraceId,
}

/// 事件（经 WS adapter 广播，含 seq 由传输层分配）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Event {
    pub seq: u64, // 由 EventBroadcaster 分配，从第一行就存在
    pub kind: String,
    pub payload: Value,
    pub trace: TraceId,
}

/// 事件订阅过滤
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Filter {
    pub kind: Option<String>,
    pub trace: Option<TraceId>,
}

// ============================================================================
// 核心契约 1：Context（预审 1：第 7 个核心契约）
// ============================================================================

/// 上下文（由 Bootstrap 注入实现，插件只依赖 trait）
///
/// 铁律：方法签名不得返回任何含 Arc/Rc 的类型。
/// 所有返回值必须可跨 WASM 边界序列化。
pub trait Context: Send + Sync {
    /// 解析能力（返回 Value，不返回 Capability 引用）
    fn resolve_cap(&self, id: &CapabilityId) -> Result<Value, String>;

    /// 获取存储（返回 trait object，不暴露具体实现）
    fn storage(&self) -> Result<&dyn Storage, String>;

    /// 权限校验
    fn check_permission(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String>;

    /// 当前来源
    fn source(&self) -> &Source;

    /// 调用方插件 id（供 dispatch 回填 source）
    fn caller_id(&self) -> &PluginId;

    /// 获取当前插件的配置（从 config.json 的 plugins[id] 命名空间）
    fn plugin_config(&self) -> Result<Value, String>;
}

// ============================================================================
// 核心契约 2：Plugin
// ============================================================================

/// 插件（实现契约的可替换单元）
///
/// 注：dependencies() 删除（预审 3：依赖权威源 = manifest requires）。
/// shutdown 给默认空实现（状态化插件 opt-in override）。
pub trait Plugin: Send + Sync {
    fn init(&mut self, ctx: &dyn Context) -> Result<(), String>;
    fn name(&self) -> &str;
    fn version(&self) -> &str;
    fn capabilities(&self) -> Vec<CapabilityId>;
    fn required_permissions(&self) -> Vec<PermissionRequest>;

    /// 优雅停止（默认空实现，状态化插件 override）
    fn shutdown(&mut self, _ctx: &dyn Context) -> Result<(), String> {
        Ok(())
    }
}

// ============================================================================
// 核心契约 3：Capability
// ============================================================================

/// 能力（插件提供的一个可调用单元）
///
/// 注：dependencies() 保留为只读镜像，MUST 与 manifest requires 一致。
/// drain 给默认空实现（Phase 0 无状态插件；Phase 2 WASM/进程插件 override）。
pub trait Capability: Send + Sync {
    fn id(&self) -> CapabilityId;
    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String>;

    /// 依赖的能力（只读镜像，MUST 与 manifest requires 一致）
    fn dependencies(&self) -> Vec<CapabilityId>;

    /// drain 在途请求（swap 前调用，默认空实现）
    fn drain(&self) -> Result<(), String> {
        Ok(())
    }
}

/// 流式能力（可选 trait，不破坏 Capability 冻结契约）
///
/// Router dispatch 检测能力是否实现此 trait：
/// - 是 -> invoke_stream -> 逐 token EventBroadcaster.broadcast -> WS 推送
/// - 否 -> 走原有 invoke 同步路径
///
/// 返回 Receiver<Event>，能力内部 spawn 异步任务逐 token 发送。
/// seq 由 EventBroadcaster 分配（能力发 seq:0）。
pub trait StreamingCapability: Capability {
    fn invoke_stream(
        &self,
        params: Value,
        ctx: &dyn Context,
    ) -> Result<tokio::sync::mpsc::Receiver<Event>, String>;
}

// ============================================================================
// 核心契约 4：Storage（预审 5：审计内嵌各域 DB）
// ============================================================================

/// 统一持久化（插件可替换后端）
///
/// 设计红线：
/// - DataRoot 第一天唯一根
/// - FTS5 可丢弃可重建（绝不做增量索引）
/// - 审计表 domain_audit 内嵌各域 DB（同库同事务天然原子）
/// - root() 返回 String（WIT-compatible，非 &Path）
pub trait Storage: Send + Sync {
    /// 数据根路径（String，WIT-compatible）
    fn root(&self) -> Result<String, String>;

    fn store(&self, domain: &str, item: &Item) -> Result<Id, String>;
    fn load(&self, domain: &str, id: &Id) -> Result<Item, String>;
    fn query(&self, domain: &str, q: &Query) -> Result<Vec<Item>, String>;
    fn delete(&self, domain: &str, id: &Id) -> Result<(), String>;

    /// 事务支持（预审 medium#8："同事务"红线需要）
    fn begin(&self) -> Result<Box<dyn Transaction + '_>, String>;
}

/// 存储事务（审计与业务写同库同事务）
pub trait Transaction: Send {
    fn commit(&mut self) -> Result<(), String>;
    fn rollback(&mut self) -> Result<(), String>;
    /// 在事务内追加审计（写入 domain_audit 表）
    fn append_audit(&mut self, domain: &str, entry: &AuditEntry) -> Result<(), String>;

    /// 事务内业务写（INSERT OR REPLACE，同事务连接）
    ///
    /// 契约红线「审计与业务写同库同事务」：业务写务必与 append_audit 在同一
    /// 事务连接上执行，commit 落库 / rollback 全回滚（含审计）。
    /// 默认实现返回未实现，旧实现直接生效（向后兼容）；生产实现应覆盖。
    fn store(&mut self, _domain: &str, _item: &Item) -> Result<Id, String> {
        Err("Transaction::store 未实现：请使用连接池 Storage::store 或覆盖本方法".into())
    }

    /// 事务内业务删（同事务连接）
    fn delete(&mut self, _domain: &str, _id: &Id) -> Result<(), String> {
        Err("Transaction::delete 未实现：请使用连接池 Storage::delete 或覆盖本方法".into())
    }
}

/// 审计条目
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub timestamp_ms: u64,
    pub capability: CapabilityId,
    pub source: Source,
    pub action: String,
    pub prev_hash: String, // tamper-evident 链
}

// ============================================================================
// 核心契约 5：Router（预审 6：取消 invoke，一律走 dispatch）
// ============================================================================

/// 转发骨干（一条总线，非四套）
///
/// 设计原则：
/// - 路由键是能力 id，不是插件名
/// - Source 由传输层注入，调用方不可自填
/// - token 默认开
/// - 取消 invoke：所有调用一律构造 Envelope 走 dispatch（权限/审计天然统一）
/// - 0e 验证后若开销不可接受再引入 invoke 快路径
pub trait Router: Send + Sync {
    /// 请求/响应（唯一调用入口）
    fn dispatch(&self, env: Envelope) -> Result<Reply, String>;

    /// 事件订阅（返回纯 in-proc channel；seq/replay 是传输层职责）
    fn subscribe(&self, filter: Filter) -> tokio::sync::mpsc::Receiver<Event>;

    /// 注册能力句柄（返回 u64 handle，跨 WASM 边界可传）
    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String>;
}

// 注：resolve_handle 从 Router trait 移除，改为 RouterBus 的 pub(crate) 内部方法。
// 原因：返回 &dyn Capability 借用 RwLockGuard，生命周期无法跨 trait 对象安全。
// 防旁路直调的保证：resolve_handle 不在公开 trait 上，插件拿不到。

// ============================================================================
// 核心契约 6：Permission
// ============================================================================

/// 权限裁决（信任根在 Bootstrap，策略执行可替换）
///
/// 决策者：
/// - 静态授权 = AssemblyManifest 作者(操作员)，装载时校验，缺权限拒载
/// - 动态授权 = 终端用户(经 PromptChannel 回填)
///
/// Phase 0 可仅实现静态；动态请求直接 Deny（安全失败）。
pub trait Permission: Send + Sync {
    fn check(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String>;
}

// ============================================================================
// 核心契约 7：Session（预审 2：加 on_orphan/grace_timeout）
// ============================================================================

/// 会话生命周期（引擎无关）
///
/// on_orphan/grace_timeout 钩子用于进程生命周期：
/// Shell 全断后 Core 对孤立会话设 TTL 超时清理。
pub trait Session: Send + Sync {
    fn start(&mut self, id: &str) -> Result<(), String>;
    fn end(&mut self, id: &str) -> Result<(), String>;

    /// Shell 全断时调用（启动 grace 计时）
    fn on_orphan(&mut self, id: &str) -> Result<(), String>;

    /// grace 超时后调用（清理孤立会话）
    fn grace_timeout(&mut self, id: &str) -> Result<(), String>;
}

// ============================================================================
// 核心契约 8：Scheduler
// ============================================================================

/// 任务调度
pub trait Scheduler: Send + Sync {
    fn schedule(&self, task: &ScheduledTask) -> Result<String, String>;
    fn cancel(&self, id: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub capability: CapabilityId,
    pub params: Value,
    pub cron: Option<String>,
}

// ============================================================================
// Bootstrap 直管（不暴露给插件，非核心契约）
// ============================================================================

/// 审计通道（由 Bootstrap 持有独立文件句柄，不经 Storage trait）
///
/// 仅追加 O_APPEND|O_WRONLY；每条含前条哈希形成 tamper-evident 链。
/// 换 storage 插件不影响审计通道。
pub trait AuditSink: Send + Sync {
    fn append(&self, entry: &AuditEntry) -> Result<(), String>;
}

/// LocalSecret 证明（Core 启动生成，经非 HTTP 通道注入本地 Shell）
pub trait LocalSecretProvider: Send + Sync {
    /// 生成一次性 secret（写入 0600 权限文件）
    fn generate(&self) -> Result<String, String>;

    /// 校验 Shell 携带的 secret
    fn verify(&self, secret: &str) -> Result<bool, String>;
}

// ============================================================================
// Assembly 错误模型（预审 medium#5：循环依赖处置）
// ============================================================================

/// Assembly 装配错误
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum AssemblyError {
    /// 循环依赖（含环路上的能力序列，供归因）
    CircularDependency { cycle: Vec<CapabilityId> },
    /// 声明了依赖但无人 provides
    MissingProvider { required: CapabilityId, requester: PluginId },
    /// 插件初始化失败
    InitFailed { plugin: PluginId, cause: String },
}

/// 装配清单（声明式 manifest）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AssemblyManifest {
    pub plugins: Vec<PluginRef>,
    pub profile: Profile,
}

/// 插件引用（预审 medium#6：加 active_capabilities）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginRef {
    pub id: PluginId,
    pub path: String,
    pub provides: Vec<CapabilityId>,
    pub requires: Vec<CapabilityId>, // 唯一权威源（预审 3）
    pub active_capabilities: Option<Vec<CapabilityId>>, // None=全部, Some=子集
    pub api_version: String,
    /// 插件贡献的视图（VSCode contributes.views 模式）
    #[serde(default)]
    pub views: Vec<PluginView>,
}

/// 插件视图声明
///
/// 插件不控制路由，只声明期望路径。Shell 动态生成导航。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginView {
    pub id: String,
    pub title: String,
    pub icon: String,     // 文字名，Shell 映射到 SVG（非 emoji）
    pub route: String,    // 期望路径，如 "/storage"
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Profile {
    Dev,
    Prod,
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_id_serialize_roundtrip() {
        let id = CapabilityId("cap.echo".into());
        let s = serde_json::to_string(&id).unwrap();
        assert_eq!(s, "\"cap.echo\"");
        let back: CapabilityId = serde_json::from_str(&s).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn source_three_variants_roundtrip() {
        let bootstrap = Source::Bootstrap;
        assert_eq!(
            serde_json::to_string(&bootstrap).unwrap(),
            "\"Bootstrap\""
        );

        let remote = Source::Remote { token: "tok-123".into() };
        let s = serde_json::to_string(&remote).unwrap();
        let back: Source = serde_json::from_str(&s).unwrap();
        assert_eq!(back, remote);
        if let Source::Remote { token } = &back {
            assert_eq!(token, "tok-123");
        } else {
            panic!("expected Remote");
        }

        let plugin = Source::Plugin { caller: PluginId("cap.ai".into()) };
        let s = serde_json::to_string(&plugin).unwrap();
        let back: Source = serde_json::from_str(&s).unwrap();
        assert_eq!(back, plugin);
        if let Source::Plugin { caller } = &back {
            assert_eq!(caller, &PluginId("cap.ai".into()));
        } else {
            panic!("expected Plugin");
        }
    }

    #[test]
    fn source_has_no_local_variant() {
        // 铁律：Source 枚举无 local 变体——本地 Shell 永不获得 Source::Local。
        // 编译期保证：此处不匹配 local，仅确认枚举三态可穷举。
        fn exhaust(s: Source) -> &'static str {
            match s {
                Source::Bootstrap => "bootstrap",
                Source::Remote { .. } => "remote",
                Source::Plugin { .. } => "plugin",
            }
        }
        assert_eq!(exhaust(Source::Bootstrap), "bootstrap");
        assert!(std::mem::size_of::<Source>() <= 32);
    }

    #[test]
    fn envelope_serialize_roundtrip() {
        let env = Envelope {
            id: MsgId("msg-1".into()),
            source: Source::Plugin { caller: PluginId("cap.ai".into()) },
            target: CapabilityId("cap.kv".into()),
            payload: serde_json::json!({"key": "foo", "value": 42}),
            trace: TraceId("trace-1".into()),
        };
        let s = serde_json::to_string(&env).unwrap();
        let back: Envelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, env.id);
        assert_eq!(back.target, env.target);
        assert_eq!(back.trace, env.trace);
        assert_eq!(back.payload, env.payload);
    }

    #[test]
    fn reply_result_variants_roundtrip() {
        let ok = Reply {
            msg_id: MsgId("msg-1".into()),
            result: Ok(serde_json::json!({"ok": true})),
            trace: TraceId("t".into()),
        };
        let s = serde_json::to_string(&ok).unwrap();
        let back: Reply = serde_json::from_str(&s).unwrap();
        assert!(back.result.is_ok());

        let err = Reply {
            msg_id: MsgId("msg-2".into()),
            result: Err("boom".into()),
            trace: TraceId("t".into()),
        };
        let s = serde_json::to_string(&err).unwrap();
        let back: Reply = serde_json::from_str(&s).unwrap();
        assert_eq!(back.result.unwrap_err(), "boom");
    }

    #[test]
    fn event_has_seq_and_filter_defaults() {
        let ev = Event {
            seq: 3,
            kind: "echo".into(),
            payload: serde_json::json!("hi"),
            trace: TraceId("t".into()),
        };
        assert_eq!(ev.seq, 3);

        // Filter 默认空 = 订阅全部
        let f = Filter { kind: None, trace: None };
        assert!(f.kind.is_none());
        assert!(f.trace.is_none());
    }

    #[test]
    fn item_query_roundtrip() {
        let item = Item {
            id: Id("k1".into()),
            data: serde_json::json!({"v": 1}),
        };
        let s = serde_json::to_string(&item).unwrap();
        let back: Item = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, item.id);

        let q = Query { filter: serde_json::json!({}), limit: Some(10) };
        assert_eq!(q.limit, Some(10));
    }

    #[test]
    fn audit_entry_has_prev_hash_chain() {
        let entry = AuditEntry {
            timestamp_ms: 1_700_000_000_000,
            capability: CapabilityId("cap.kv".into()),
            source: Source::Plugin { caller: PluginId("cap.ai".into()) },
            action: "store".into(),
            prev_hash: "abc123".into(),
        };
        let s = serde_json::to_string(&entry).unwrap();
        let back: AuditEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back.prev_hash, "abc123");
    }

    #[test]
    fn assembly_manifest_and_error_roundtrip() {
        let manifest = AssemblyManifest {
            plugins: vec![PluginRef {
                id: PluginId("echo".into()),
                path: "plugins/echo".into(),
                provides: vec![CapabilityId("cap.echo".into())],
                requires: vec![],
                active_capabilities: None,
                api_version: "0.1.0".into(),
                views: vec![],
            }],
            profile: Profile::Dev,
        };
        let s = serde_json::to_string(&manifest).unwrap();
        let back: AssemblyManifest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.plugins[0].id, PluginId("echo".into()));
        assert_eq!(back.profile, Profile::Dev);

        let err = AssemblyError::MissingProvider {
            required: CapabilityId("cap.storage".into()),
            requester: PluginId("kv".into()),
        };
        let s = serde_json::to_string(&err).unwrap();
        let back: AssemblyError = serde_json::from_str(&s).unwrap();
        match back {
            AssemblyError::MissingProvider { required, requester } => {
                assert_eq!(required, CapabilityId("cap.storage".into()));
                assert_eq!(requester, PluginId("kv".into()));
            }
            _ => panic!("expected MissingProvider"),
        }
    }
}
