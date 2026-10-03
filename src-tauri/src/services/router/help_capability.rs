//! cap.help —— 总线能力索引（AI 发现全部 cap.* 的入口）
//!
//! 定位：`cap_dispatch {target:"cap.help", payload:{action:"index"}}` 一次拿到
//! 主进程总线已注册的全部能力（同步 + 流式并集）及其自描述协议。数据源
//! 是各能力自身的 `describe()`（见 contracts::Capability::describe），本能力
//! 只做聚合，不手写任何协议 —— 与 bus_help 的静态 JSON 不同，索引随注册表
//! 与能力演进自动更新，杜绝漂移与"幽灵能力"（文档写了但没注册）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `index` `{}` → `{ "capabilities": [ { id, streaming, describe } ] }`
//!   （describe 缺省为 null；仅聚合静态自描述，无副作用）
//! - `show`  `{ "target": "cap.fs" }` → `{ "capability": { id, streaming, describe } | null }`

use crate::contracts::{Capability, CapabilityId, Context, Value};
use crate::services::router::RouterBus;

const CAP_ID: &str = "cap.help";

/// cap.help —— 总线能力索引能力（无状态）
pub struct HelpCapability {
    router: std::sync::Arc<RouterBus>,
}

impl HelpCapability {
    pub fn new(router: std::sync::Arc<RouterBus>) -> Self {
        Self { router }
    }
}

impl Capability for HelpCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.help 需要 action 参数（index/show）".to_string())?;

        match action {
            "index" => Ok(serde_json::json!({
                "capabilities": self.router.described_capabilities(),
            })),
            "show" => {
                let target = params
                    .get("target")
                    .and_then(|t| t.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "cap.help show 需要 target 参数（cap.* 能力 id）".to_string())?;
                let found = self
                    .router
                    .described_capabilities()
                    .into_iter()
                    .find(|c| c["id"].as_str() == Some(target))
                    .unwrap_or(Value::Null);
                Ok(serde_json::json!({ "capability": found }))
            }
            other => Err(format!("cap.help 不支持动作: {}", other)),
        }
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "总线能力索引：列出全部已注册 cap.* 及其自描述协议（AI 发现能力的入口）",
            "actions": {
                "index": {
                    "params": {},
                    "returns": "{ capabilities: [{ id, streaming, describe }] }（describe 为各能力 describe()，缺省 null）"
                },
                "show": {
                    "params": { "target": "string（必填，cap.* 能力 id）" },
                    "returns": "{ capability: { id, streaming, describe } | null }"
                }
            }
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::contracts::{Source, StreamingCapability};
    use crate::services::router::event_adapter::EventAdapter;
    use crate::services::router::policy_permission::PolicyPermission;
    use crate::services::router::stream_echo_capability::StreamEchoCapability;
    use crate::services::router::KvCapability;
    use crate::services::router::Router;
    use crate::services::router::StaticPermission;

    fn make_router() -> std::sync::Arc<RouterBus> {
        let adapter = Arc::new(EventAdapter::new(64));
        let permission = Box::new(PolicyPermission::new());
        let router = Arc::new(RouterBus::new(adapter, permission, None, None));
        let _ = router.register_handle(Box::new(KvCapability));
        let _ = router.register_streaming(Arc::new(StreamEchoCapability));
        router
    }

    fn ctx() -> impl Context {
        struct Ctx;
        impl Context for Ctx {
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
            fn source(&self) -> &Source {
                static S: Source = Source::Bootstrap;
                &S
            }
            fn caller_id(&self) -> &crate::contracts::PluginId {
                static P: crate::contracts::PluginId = crate::contracts::PluginId(String::new());
                &P
            }
            fn plugin_config(&self) -> Result<Value, String> {
                Ok(Value::Null)
            }
        }
        Ctx
    }

    #[test]
    fn index_lists_sync_and_streaming() {
        let router = make_router();
        let cap = HelpCapability::new(router.clone());
        let v = cap.invoke(serde_json::json!({ "action": "index" }), &ctx()).unwrap();
        let caps = v["capabilities"].as_array().unwrap();
        let ids: Vec<&str> = caps.iter().filter_map(|c| c["id"].as_str()).collect();
        assert!(ids.contains(&"cap.kv"), "同步能力应在索引中");
        assert!(ids.contains(&"cap.stream.echo"), "流式能力应在索引中");
        // 已排序
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn show_returns_single_or_null() {
        let router = make_router();
        let cap = HelpCapability::new(router.clone());
        let v = cap
            .invoke(serde_json::json!({ "action": "show", "target": "cap.kv" }), &ctx())
            .unwrap();
        assert_eq!(v["capability"]["id"], "cap.kv");

        let v = cap
            .invoke(serde_json::json!({ "action": "show", "target": "cap.nope" }), &ctx())
            .unwrap();
        assert_eq!(v["capability"], Value::Null);
    }

    #[test]
    fn missing_action_rejected() {
        let router = make_router();
        let cap = HelpCapability::new(router.clone());
        assert!(cap.invoke(serde_json::json!({}), &ctx()).is_err());
        assert!(
            cap.invoke(serde_json::json!({ "action": "show" }), &ctx()).is_err(),
            "show 缺 target 应报错"
        );
        assert!(
            cap.invoke(serde_json::json!({ "action": "wat" }), &ctx()).is_err()
        );
    }
}
