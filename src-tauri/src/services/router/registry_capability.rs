//! cap.registry —— 运行时动态能力注册表（AI/插件自拓展能力的入口）
//!
//! 让 AI（经 cap_dispatch / bus_dispatch）与任意调用方在**运行时注册/卸载新 cap**，
//! 无需重启、无需编译期代码。注册的能力被立即纳入总线：`cap_list` / `cap.help`
//! 可见、`cap_dispatch` 可调。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `register` `{ "id": "cap.user.xxx", "summary": "...", "description": "...",
//!     "handler": { "type": "forward", "target": "cap.todo", "defaults": { "action": "list" } },
//!     "persist": true }`
//!   → `{ "registered": true, "id": "...", "dynamic": true }`
//! - `unregister` `{ "id": "cap.user.xxx" }` → `{ "unregistered": true, "id": "..." }`
//! - `list` `{}` → `{ "dynamic": [{ "id", "summary", "handler_target" }], "builtin": ["cap.kv", ...] }`
//! - `exists` `{ "id": "cap.user.xxx" }` → `{ "exists": true, "dynamic": true }`
//!
//! # 设计要点
//!
//! - 动态能力 = `DynamicCapability`（forward 转发），注册即入总线（RouterBus）。
//! - **拒绝覆盖**既有已注册 cap（含内置）；重名动态 cap 也拒绝（先 unregister 再 register）。
//! - id 必须 `cap.*`；handler.target 必须 `cap.*`。
//! - `persist=true` 时写入 kv 域（domain=`cap.registry`），Bootstrap 启动时自动重建；
//!   `persist=false` 仅内存态，重启丢失。
//! - 调用方经 `Source::Plugin` 身份注入 → 过 PolicyPermission gate（同其它 cap）。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::*;
use crate::services::router::{DynamicCapability, DynamicCapabilityConfig, RouterBus};

/// cap.registry 使用的 kv 存储域（与 cap.kv 隔离，避免污染用户键空间）
const REGISTRY_DOMAIN: &str = "cap.registry";

/// 禁止被动态转发到的敏感能力（防自递归 / 防绕过白名单的特权放大）
///
/// - `cap.ai.chat`：AI 自递归（动态转发会把任意调用变成一次新的 AI 对话）
/// - `cap.registry`：注册表自身，禁止再包一层转发（防环/混淆归属）
/// - `cap.help` / `cap.context`：元能力，无业务 forward 价值
const SENSITIVE_TARGETS: &[&str] = &["cap.ai.chat", "cap.registry", "cap.help", "cap.context"];

/// cap.registry —— 动态能力注册表
///
/// 需要 `Arc<RouterBus>` 引用以注册/卸载动态能力。
pub struct RegistryCapability {
    router: Arc<RouterBus>,
}

impl RegistryCapability {
    pub fn new(router: Arc<RouterBus>) -> Self {
        Self { router }
    }

    /// 校验 id 合法性 + 不覆盖既有 cap（含内置与已注册动态）。
    fn check_id_available(&self, id: &str) -> Result<(), String> {
        if !id.starts_with("cap.") || id.len() <= "cap.".len() {
            return Err(format!("动态能力 id 必须以 `cap.` 开头且非空: {}", id));
        }
        if self.router.is_registered(&CapabilityId(id.into())) {
            return Err(format!("能力已注册，不可覆盖: {}", id));
        }
        Ok(())
    }

    /// 把动态能力配置持久化到 kv 域（persist=true 时）。
    fn persist(&self, ctx: &dyn Context, config: &DynamicCapabilityConfig) -> Result<(), String> {
        if !config.persist {
            return Ok(());
        }
        let storage = ctx.storage().map_err(|e| format!("cap.registry 无存储: {}", e))?;
        let mut txn = storage.begin().map_err(|e| format!("cap.registry 开启事务失败: {}", e))?;
        let item = Item {
            id: Id(config.id.clone()),
            data: serde_json::to_value(config).map_err(|e| format!("配置序列化失败: {}", e))?,
        };
        txn.store(REGISTRY_DOMAIN, &item)
            .map_err(|e| format!("cap.registry 持久化失败: {}", e))?;
        txn.commit().map_err(|e| format!("cap.registry 事务提交失败: {}", e))?;
        Ok(())
    }

    /// 删除持久化的动态能力条目。
    fn depersist(&self, ctx: &dyn Context, id: &str) -> Result<(), String> {
        let storage = ctx.storage().map_err(|e| format!("cap.registry 无存储: {}", e))?;
        let mut txn = storage.begin().map_err(|e| format!("cap.registry 开启事务失败: {}", e))?;
        let _ = txn.delete(REGISTRY_DOMAIN, &Id(id.to_string()));
        let _ = txn.commit();
        Ok(())
    }

    /// 从 kv 域读取全部持久化的动态能力配置。
    pub fn load_persisted(&self, ctx: &dyn Context) -> Vec<DynamicCapabilityConfig> {
        let Ok(storage) = ctx.storage() else {
            return Vec::new();
        };
        let Ok(items) = storage.query(
            REGISTRY_DOMAIN,
            &Query {
                filter: Value::Null,
                limit: None,
            },
        ) else {
            return Vec::new();
        };
        items
            .into_iter()
            .filter_map(|i| serde_json::from_value::<DynamicCapabilityConfig>(i.data).ok())
            .collect()
    }

    /// 注册一个动态能力（核心动作）。
    fn do_register(&self, ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "cap.registry register 需要 id".to_string())?;
        let summary = params
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "cap.registry register 需要 summary".to_string())?;
        let handler_type = params
            .pointer("/handler/type")
            .and_then(Value::as_str)
            .unwrap_or("forward");
        if handler_type != "forward" {
            return Err(format!("cap.registry 暂只支持 handler.type=forward，收到 {}", handler_type));
        }
        let target = params
            .pointer("/handler/target")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "cap.registry register 需要 handler.target".to_string())?;
        if !target.starts_with("cap.") {
            return Err(format!("handler.target 必须以 `cap.` 开头: {}", target));
        }
        if SENSITIVE_TARGETS.contains(&target) {
            return Err(format!(
                "handler.target {} 属于敏感能力，禁止动态转发（防自递归/特权放大）",
                target
            ));
        }
        // 拒绝覆盖既有 cap（含内置与已注册动态）
        self.check_id_available(id)?;
        // 拒绝覆盖要转发的底层能力自身（防止自引用环）
        if id == target {
            return Err(format!("动态能力 id 不能等于转发目标: {}", id));
        }

        let defaults = params.get("handler").and_then(|h| h.get("defaults")).cloned();
        let persist = params.get("persist").and_then(Value::as_bool).unwrap_or(true);

        let config = DynamicCapabilityConfig {
            id: id.to_string(),
            summary: summary.to_string(),
            description: params.get("description").and_then(Value::as_str).map(str::to_string),
            handler: crate::services::router::DynamicHandler::Forward {
                target: target.to_string(),
                defaults,
            },
            persist,
        };

        // 注册进总线（立即生效）
        self.router.register_handle(Box::new(DynamicCapability::new(
            config.clone(),
            self.router.clone(),
        )))?;

        // 持久化（persist=true）
        if let Err(e) = self.persist(ctx, &config) {
            // 持久化失败 → 回滚内存注册，避免「内存有/重启无」不一致
            let _ = self.router.unregister(&CapabilityId(config.id.clone()));
            return Err(format!("cap.registry 持久化失败，已回滚：{}", e));
        }

        Ok(json!({
            "registered": true,
            "id": config.id,
            "dynamic": true,
            "handler": { "type": "forward", "target": target },
            "persisted": persist,
        }))
    }

    fn do_unregister(&self, ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "cap.registry unregister 需要 id".to_string())?;
        if !id.starts_with("cap.") {
            return Err(format!("非法能力 id: {}", id));
        }
        // 只允许卸载动态能力 —— 通过「是否在持久化域或由本注册器标记」判断：
        // 内置能力不在动态域，unregister 内置是危险操作，拒绝。
        let was_dynamic = self.router.is_dynamic(&CapabilityId(id.into()));
        if !was_dynamic {
            return Err(format!("{} 不是已注册的动态能力（内置能力不可经此卸载）", id));
        }
        let removed = self.router.unregister(&CapabilityId(id.into()));
        let _ = self.depersist(ctx, id);
        Ok(json!({
            "unregistered": true,
            "id": id,
            "removed": removed,
        }))
    }
}

impl Capability for RegistryCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.registry".into())
    }

    fn describe(&self) -> Value {
        json!({
            "summary": "运行时动态能力注册表：AI 可注册/卸载新 cap（forward 转发既有能力），立即生效并可持久化",
            "actions": {
                "register": { "params": { "id": "cap.*（唯一，不可与已有能力重名）", "summary": "能力描述", "description": "动作协议说明（可选）", "handler": { "type": "forward", "target": "cap.* 底层能力", "defaults": "默认 payload（可选）" }, "persist": "bool（默认 true）" }, "returns": "{ registered, id, handler }" },
                "unregister": { "params": { "id": "cap.* 动态能力 id" }, "returns": "{ unregistered }" },
                "list": { "params": {}, "returns": "{ dynamic: [...], builtin: [...] }" },
                "exists": { "params": { "id": "cap.*" }, "returns": "{ exists, dynamic }" }
            },
            "note": "动态能力 = forward 转发（invoke 时把 payload 发给 handler.target，默认回退 defaults）。注册后 cap_list/cap.help 立即可见、cap_dispatch 可调。注册/卸载均过统一权限 gate + 审计。持久化存 kv 域，重启自动重建。"
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "cap.registry 需要 action".to_string())?;
        match action {
            "register" => self.do_register(ctx, &params),
            "unregister" => self.do_unregister(ctx, &params),
            "list" => Ok(self.do_list()),
            "exists" => {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                Ok(json!({
                    "exists": !id.is_empty() && self.router.is_registered(&CapabilityId(id.into())),
                    "dynamic": !id.is_empty() && self.router.is_dynamic(&CapabilityId(id.into())),
                }))
            }
            other => Err(format!("cap.registry 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

impl RegistryCapability {
    fn do_list(&self) -> Value {
        let dynamic: Vec<Value> = self
            .router
            .list_capabilities()
            .iter()
            .filter(|c| self.router.is_dynamic(c))
            .map(|c| json!({ "id": c.0, "summary": self.router.summary_for(c) }))
            .collect();
        let builtin: Vec<String> = self
            .router
            .list_capabilities()
            .iter()
            .filter(|c| !self.router.is_dynamic(c))
            .map(|c| c.0.clone())
            .collect();
        json!({
            "dynamic": dynamic,
            "builtin": builtin,
        })
    }
}

// ============================================================================
// RouterBus 扩展：is_registered / is_dynamic / summary_for
// ============================================================================

impl RouterBus {
    /// 目标 cap 是否已注册（同步表或流式平行表）。
    pub fn is_registered(&self, id: &CapabilityId) -> bool {
        self.handles
            .read()
            .unwrap()
            .values()
            .any(|c| c.id() == *id)
            || self.streaming_caps.read().unwrap().contains_key(id)
    }

    /// 目标 cap 是否为动态能力（is_dynamic = 实现了转发标记）。
    ///
    /// 判断方式：DynamicCapability 的 describe() 带 `"dynamic": true`；遍历查询
    /// 也可以。为 O(1) 与不构造 Value 开销，用显式类型检测：`as_dynamic()`。
    pub fn is_dynamic(&self, id: &CapabilityId) -> bool {
        use crate::contracts::Capability as _;
        self.handles
            .read()
            .unwrap()
            .values()
            .find(|c| c.id() == *id)
            .is_some_and(|c| c.describe().get("dynamic").and_then(Value::as_bool) == Some(true))
    }

    /// 返回某 cap 的 summary（describe().summary）。
    pub fn summary_for(&self, id: &CapabilityId) -> String {
        use crate::contracts::Capability as _;
        let desc = self
            .handles
            .read()
            .unwrap()
            .values()
            .find(|c| c.id() == *id)
            .map(|c| c.describe());
        desc.and_then(|d| d.get("summary").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CapabilityId as CId, Source};
    use crate::services::router::{EchoCapability, EventAdapter, PolicyPermission};
    use std::sync::Arc;

    // ---- 测试 Context：storage 可切换（None / Some） ----
    struct TestCtx {
        storage: Option<Arc<dyn crate::contracts::Storage>>,
        _caller: PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            match &self.storage {
                Some(s) => Ok(s.as_ref()),
                None => Err("no storage in test".into()),
            }
        }
        fn check_permission(&self, _req: &crate::contracts::PermissionRequest) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            static S: Source = Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &PluginId {
            &self._caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn ctx() -> TestCtx {
        TestCtx {
            storage: None,
            _caller: PluginId("cap.registry".into()),
        }
    }

    /// 带真实 SqliteStorage 的测试上下文 + 临时数据根
    fn ctx_with_storage() -> (TestCtx, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("polaris-registry-test-{}", uuid::Uuid::new_v4()));
        let storage: Arc<dyn crate::contracts::Storage> = Arc::new(
            crate::services::storage::sqlite::SqliteStorage::new(&dir).expect("创建临时存储失败"),
        );
        let ctx = TestCtx {
            storage: Some(storage),
            _caller: PluginId("cap.registry".into()),
        };
        (ctx, dir)
    }

    /// 构建带 EchoCapability 转发目标的 RouterBus（可带 storage）。
    fn make_bus(storage: Option<Arc<dyn crate::contracts::Storage>>) -> Arc<RouterBus> {
        let adapter = Arc::new(EventAdapter::new(64));
        let permission = Box::new(PolicyPermission::default());
        let bus = Arc::new(RouterBus::new(adapter, permission, storage, None));
        let _ = bus.register_handle(Box::new(EchoCapability));
        bus
    }

    #[test]
    fn register_lists_and_invokes_dynamic_cap() {
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());
        let config = json!({
            "action": "register",
            "id": "cap.user.greet",
            "summary": "问候 echo",
            "handler": {
                "type": "forward",
                "target": "cap.echo",
                "defaults": { "greeting": "默认你好" }
            },
            "persist": false,
        });
        let r = cap.invoke(config, &ctx()).unwrap();
        assert_eq!(r["registered"], true);
        assert_eq!(r["id"], "cap.user.greet");

        // 立即可见（总线 / exists / list）
        assert!(bus.is_registered(&CId("cap.user.greet".into())));
        assert!(bus.is_dynamic(&CId("cap.user.greet".into())));
        let exists = cap.invoke(json!({ "action": "exists", "id": "cap.user.greet" }), &ctx()).unwrap();
        assert_eq!(exists["exists"], true);
        assert_eq!(exists["dynamic"], true);

        let list = cap.invoke(json!({ "action": "list" }), &ctx()).unwrap();
        let dynamic_ids: Vec<String> = list["dynamic"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        assert!(dynamic_ids.contains(&"cap.user.greet".to_string()));
        // builtin 含既有 cap.echo
        let builtin: Vec<&str> = list["builtin"].as_array().unwrap().iter()
            .filter_map(|v| v.as_str()).collect();
        assert!(builtin.contains(&"cap.echo"));
    }

    #[test]
    fn dynamic_cap_forwards_to_underlying_with_defaults_and_override() {
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());
        let _ = cap.invoke(json!({
            "action": "register",
            "id": "cap.user.greet",
            "summary": "问候",
            "handler": { "type": "forward", "target": "cap.echo", "defaults": { "d": 1 } },
            "persist": false,
        }), &ctx()).unwrap();

        // 调用方给了 payload → 覆盖 defaults
        let replied = bus.dispatch(Envelope {
            id: MsgId("m1".into()),
            source: Source::Bootstrap,
            target: CId("cap.user.greet".into()),
            payload: json!({ "user_payload": true }),
            trace: TraceId("t1".into()),
        }).unwrap();
        assert_eq!(replied.result.unwrap()["user_payload"], true);

        // 未给 payload → 回退 defaults
        let replied2 = bus.dispatch(Envelope {
            id: MsgId("m2".into()),
            source: Source::Bootstrap,
            target: CId("cap.user.greet".into()),
            payload: Value::Null,
            trace: TraceId("t2".into()),
        }).unwrap();
        assert_eq!(replied2.result.unwrap().is_object(), true);
    }

    #[test]
    fn register_rejects_overwrite_builtin_and_duplicate() {
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());

        // 覆盖内置 cap.echo → 拒绝
        let r = cap.invoke(json!({
            "action": "register", "id": "cap.echo", "summary": "x",
            "handler": { "type": "forward", "target": "cap.kv" }, "persist": false
        }), &ctx());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("已注册"));

        // 正常注册一次
        let _ = cap.invoke(json!({
            "action": "register", "id": "cap.user.a", "summary": "a",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": false
        }), &ctx()).unwrap();
        // 重复注册同名 → 拒绝
        let r2 = cap.invoke(json!({
            "action": "register", "id": "cap.user.a", "summary": "a2",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": false
        }), &ctx());
        assert!(r2.is_err());
    }

    #[test]
    fn unregister_removes_dynamic_but_rejects_builtin() {
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());
        let _ = cap.invoke(json!({
            "action": "register", "id": "cap.user.x", "summary": "x",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": false
        }), &ctx()).unwrap();
        assert!(bus.is_registered(&CId("cap.user.x".into())));

        // 卸载内置 → 拒绝
        assert!(cap.invoke(json!({ "action": "unregister", "id": "cap.echo" }), &ctx()).is_err());
        // 卸载动态 → 成功
        let r = cap.invoke(json!({ "action": "unregister", "id": "cap.user.x" }), &ctx()).unwrap();
        assert_eq!(r["unregistered"], true);
        assert!(!bus.is_registered(&CId("cap.user.x".into())));
    }

    #[test]
    fn invalid_registrations_rejected() {
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());
        // 非 cap.* id
        assert!(cap.invoke(json!({
            "action": "register", "id": "evil", "summary": "x",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": false
        }), &ctx()).is_err());
        // target 非 cap.*
        assert!(cap.invoke(json!({
            "action": "register", "id": "cap.user.y", "summary": "x",
            "handler": { "type": "forward", "target": "http://evil" }, "persist": false
        }), &ctx()).is_err());
        // 缺 summary
        assert!(cap.invoke(json!({
            "action": "register", "id": "cap.user.z",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": false
        }), &ctx()).is_err());
        // 转发到敏感能力 → 拒绝（防自递归/特权放大）
        let r4 = cap.invoke(json!({
            "action": "register", "id": "cap.user.chat", "summary": "x",
            "handler": { "type": "forward", "target": "cap.ai.chat" }, "persist": false
        }), &ctx());
        assert!(r4.is_err());
        assert!(r4.unwrap_err().contains("敏感能力"));
    }

    #[test]
    fn persist_failure_rolls_back_registration() {
        // storage=None → persist=true 会失败 → 注册回滚，总线无此 cap
        let bus = make_bus(None);
        let cap = RegistryCapability::new(bus.clone());
        let r = cap.invoke(json!({
            "action": "register", "id": "cap.user.persist", "summary": "p",
            "handler": { "type": "forward", "target": "cap.echo" }, "persist": true
        }), &ctx());
        assert!(r.is_err());
        assert!(!bus.is_registered(&CId("cap.user.persist".into())));
    }

    #[test]
    fn persist_then_rebuild_on_restart() {
        // 端到端：persist=true 注册 → 用同一 storage 新建 RegistryCapability
        // load_persisted 重建 → 断言配置还原（模拟重启后重装配）。
        let (ctx, dir) = ctx_with_storage();
        let bus = make_bus(Some(ctx.storage.clone().unwrap()));
        let cap = RegistryCapability::new(bus.clone());

        let r = cap.invoke(json!({
            "action": "register", "id": "cap.user.report", "summary": "周报",
            "description": "生成待办周报",
            "handler": { "type": "forward", "target": "cap.echo", "defaults": { "scope": "weekly" } },
            "persist": true,
        }), &ctx).unwrap();
        assert_eq!(r["persisted"], true);

        // 模拟重启：新 bus + 新 registry，load_persisted 从 kv 域读出配置
        let bus2 = make_bus(Some(ctx.storage.clone().unwrap()));
        let cap2 = RegistryCapability::new(bus2.clone());
        let persisted = cap2.load_persisted(&ctx);
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].id, "cap.user.report");
        assert_eq!(persisted[0].summary, "周报");
        assert_eq!(persisted[0].description.as_deref(), Some("周报"));

        // 重建后的 DynamicCapability 可注册并调用
        for config in persisted {
            bus2
                .register_handle(Box::new(crate::services::router::DynamicCapability::new(
                    config.clone(),
                    bus2.clone(),
                )))
                .unwrap();
        }
        assert!(bus2.is_registered(&CId("cap.user.report".into())));
        assert!(bus2.is_dynamic(&CId("cap.user.report".into())));

        // unregister 同时清除持久化 → 再次 load_persisted 为空
        cap2.invoke(json!({ "action": "unregister", "id": "cap.user.report" }), &ctx).unwrap();
        assert!(cap2.load_persisted(&ctx).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}