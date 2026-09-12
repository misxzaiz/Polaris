//! cap.kv —— 第一个真实能力（经契约 Storage 读写）
//!
//! 对应 `dev/docs/sky/step3-dispatch.md` 阶段 C/P2：把 demo（cap.echo）换成
//! 第一个真实 capability，验证 dispatch 全链路 + `ctx.storage()` 在真实业务上跑通。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `get`   `{ "action": "get", "key": "k" }`         → `{ "value": <V> | null }`
//! - `set`   `{ "action": "set", "key": "k", "value": V }` → `{ "id": "k" }`
//! - `delete` `{ "action": "delete", "key": "k" }`     → `{ "deleted": true }`
//! - `list`  `{ "action": "list" }`                    → `{ "keys": [...] }`
//!
//! 底层：经 `ctx.storage()` 访问契约 `Storage`（接线为 SqliteStorage，domain=`kv`），
//! 数据落在 `<DataRoot>/stores/kv.db`。`Source`/权限/审计由 RouterBus dispatch 统一把关。

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Id, Item, Query, Value};

/// cap.kv —— 键值存储能力（真实业务，非 demo）
pub struct KvCapability;

const DOMAIN: &str = "kv";

impl KvCapability {
    fn do_get(ctx: &dyn Context, key: &str) -> Result<Value, String> {
        let storage = ctx.storage()?;
        match storage.load(DOMAIN, &Id(key.to_string())) {
            Ok(item) => Ok(serde_json::json!({ "value": item.data })),
            Err(e) if e.contains("不存在") => Ok(serde_json::json!({ "value": Value::Null })),
            Err(e) => Err(e),
        }
    }

    /// 构造域审计条目（第五步阶段 D：业务写与审计同库同事务）
    fn audit_entry(ctx: &dyn Context, action: &str) -> AuditEntry {
        AuditEntry {
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            capability: CapabilityId("cap.kv".into()),
            source: ctx.source().clone(),
            action: action.to_string(),
            // 哈希链由 FileAuditSink（Bootstrap 直管）维护；domain_audit 是域内轨迹
            prev_hash: String::new(),
        }
    }

    /// 事务写：业务写 + 域审计同库同事务
    fn do_set(ctx: &dyn Context, key: &str, value: Value) -> Result<Value, String> {
        let storage = ctx.storage()?;
        let item = Item {
            id: Id(key.to_string()),
            data: value,
        };
        let mut txn = storage.begin().map_err(|e| format!("cap.kv 开启事务失败: {}", e))?;
        txn.store(DOMAIN, &item)
            .map_err(|e| format!("cap.kv 写入失败: {}", e))?;
        txn.append_audit(DOMAIN, &Self::audit_entry(ctx, "kv.set"))
            .map_err(|e| format!("cap.kv 审计写入失败: {}", e))?;
        txn.commit().map_err(|e| format!("cap.kv 事务提交失败: {}", e))?;
        Ok(serde_json::json!({ "id": item.id.0 }))
    }

    /// 事务删：业务删 + 域审计同库同事务
    fn do_delete(ctx: &dyn Context, key: &str) -> Result<Value, String> {
        let storage = ctx.storage()?;
        let mut txn = storage.begin().map_err(|e| format!("cap.kv 开启事务失败: {}", e))?;
        txn.delete(DOMAIN, &Id(key.to_string()))
            .map_err(|e| format!("cap.kv 删除失败: {}", e))?;
        txn.append_audit(DOMAIN, &Self::audit_entry(ctx, "kv.delete"))
            .map_err(|e| format!("cap.kv 审计写入失败: {}", e))?;
        txn.commit().map_err(|e| format!("cap.kv 事务提交失败: {}", e))?;
        Ok(serde_json::json!({ "deleted": true }))
    }

    fn do_list(ctx: &dyn Context) -> Result<Value, String> {
        let storage = ctx.storage()?;
        let items = storage.query(
            DOMAIN,
            &Query {
                filter: Value::Null,
                limit: None,
            },
        )?;
        let keys: Vec<String> = items.into_iter().map(|i| i.id.0).collect();
        Ok(serde_json::json!({ "keys": keys }))
    }
}

impl Capability for KvCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.kv".into())
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.kv 需要 action 参数（get/set/delete/list）".to_string())?;

        match action {
            "get" => {
                let key = params
                    .get("key")
                    .and_then(|k| k.as_str())
                    .ok_or_else(|| "get 需要 key 参数".to_string())?;
                Self::do_get(ctx, key)
            }
            "set" => {
                let key = params
                    .get("key")
                    .and_then(|k| k.as_str())
                    .ok_or_else(|| "set 需要 key 参数".to_string())?;
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                Self::do_set(ctx, key, value)
            }
            "delete" => {
                let key = params
                    .get("key")
                    .and_then(|k| k.as_str())
                    .ok_or_else(|| "delete 需要 key 参数".to_string())?;
                Self::do_delete(ctx, key)
            }
            "list" => Self::do_list(ctx),
            other => Err(format!("cap.kv 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Storage;
    use crate::services::storage::SqliteStorage;
    use std::sync::Arc;

    /// 用临时目录建 SqliteStorage，构造一个提供 storage 的测试 Context
    struct TestCtx {
        storage: Arc<SqliteStorage>,
        caller: crate::contracts::PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn Storage, String> {
            Ok(self.storage.as_ref())
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
            &self.caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_ctx() -> TestCtx {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!("polaris-kv-cap-test-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let storage = Arc::new(SqliteStorage::new(&tmp).unwrap());
        TestCtx {
            storage,
            caller: crate::contracts::PluginId("cap.kv".into()),
        }
    }

    #[test]
    fn set_get_roundtrip() {
        let cap = KvCapability;
        let ctx = make_ctx();
        let set = cap
            .invoke(serde_json::json!({"action": "set", "key": "greeting", "value": "你好"}), &ctx)
            .unwrap();
        assert_eq!(set["id"], "greeting");

        let get = cap
            .invoke(serde_json::json!({"action": "get", "key": "greeting"}), &ctx)
            .unwrap();
        assert_eq!(get["value"], "你好");
    }

    #[test]
    fn get_missing_returns_null() {
        let cap = KvCapability;
        let ctx = make_ctx();
        let get = cap
            .invoke(serde_json::json!({"action": "get", "key": "nope"}), &ctx)
            .unwrap();
        assert_eq!(get["value"], Value::Null);
    }

    #[test]
    fn delete_removes() {
        let cap = KvCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "set", "key": "k", "value": 1}), &ctx).unwrap();
        let del = cap.invoke(serde_json::json!({"action": "delete", "key": "k"}), &ctx).unwrap();
        assert_eq!(del["deleted"], true);
        let get = cap.invoke(serde_json::json!({"action": "get", "key": "k"}), &ctx).unwrap();
        assert_eq!(get["value"], Value::Null);
    }

    #[test]
    fn list_returns_keys() {
        let cap = KvCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "set", "key": "a", "value": 1}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "set", "key": "b", "value": 2}), &ctx).unwrap();
        let list = cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        let keys: Vec<_> = list["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert!(keys.contains(&"a"));
        assert!(keys.contains(&"b"));
    }

    #[test]
    fn set_and_delete_write_domain_audit() {
        // 第五步阶段 D：写路径与域审计同库同事务
        let cap = KvCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "set", "key": "k", "value": 1}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "delete", "key": "k"}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("kv").unwrap(), 2, "set+delete 各应落一条域审计");
        // 读路径不落审计
        cap.invoke(serde_json::json!({"action": "get", "key": "k"}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("kv").unwrap(), 2);
    }

    #[test]
    fn missing_action_returns_err() {
        let cap = KvCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("action"));
    }

    #[test]
    fn unknown_action_returns_err() {
        let cap = KvCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({"action": "explode"}), &ctx);
        assert!(r.is_err());
    }
}
