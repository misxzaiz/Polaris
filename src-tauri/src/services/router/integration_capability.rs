//! cap.integration —— IM 平台集成能力（`integrations::IntegrationManager` 的总线入口）
//!
//! 定位（plans/im-integration-extraction-spec.md L0）：IM 集成域出仓前的 cap 化
//! 收敛——旧 `commands/integration.rs` 的 16 个 Tauri 命令与 web 桥 4 个 dispatch
//! 分支全部改走本能力（前端 `integrationService.ts` 同步切 `router_dispatch`），
//! 获得统一权限 gate + 审计；后续 L2 阶段随插件化整体删除。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `init`                  `{ qqbotConfig?, feishuConfig?, dingtalkConfig? }` → `{}`
//! - `start`                 `{ platform }` → `{}`
//! - `stop`                  `{ platform }` → `{}`
//! - `status`                `{ platform }` → `{ status: IntegrationStatus | null }`
//! - `status_all`            `{}` → `{ statuses: Record<platform, IntegrationStatus> }`
//! - `send`                  `{ platform, target, content }` → `{}`
//! - `sessions`              `{}` → `{ sessions: IntegrationSession[] }`
//! - `add_instance`          `{ instance }` → `{ instanceId }`
//! - `remove_instance`       `{ instanceId }` → `{ instance: PlatformInstance | null }`
//! - `list_instances`        `{}` → `{ instances: PlatformInstance[] }`
//! - `list_instances_by_platform` `{ platform }` → `{ instances: PlatformInstance[] }`
//! - `get_active_instance`   `{ platform }` → `{ instance: PlatformInstance | null }`
//! - `switch_instance`       `{ instanceId }` → `{}`
//! - `disconnect_instance`   `{ platform }` → `{}`
//! - `update_instance`       `{ instance }` → `{}`
//!
//! # 事件流（沿用既有事件名，负载不变；由 manager 内部 emit，不经本能力）
//!
//! - `integration:message` / `integration:state_change` / `integration:ai:delta`
//!   / `integration:ai:complete` / `integration:ai:error`
//!
//! # 权限
//!
//! 不设内置 Remote deny（同 cap.terminal 先例）：旧 HTTP 桥对已鉴权 Remote 本就
//! 暴露等价只读面；`init`/`start`/`stop` 等写动作依赖传输层 token 鉴权。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::{standard_describe, unsupported_action, Capability, CapabilityId, Context};
use crate::integrations::types::Platform;
use crate::AppState;

const CAP_ID: &str = "cap.integration";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const INTEGRATION_CAP_ACTIONS: &[&str] = &[
    "init",
    "start",
    "stop",
    "status",
    "status_all",
    "send",
    "sessions",
    "add_instance",
    "remove_instance",
    "list_instances",
    "list_instances_by_platform",
    "get_active_instance",
    "switch_instance",
    "disconnect_instance",
    "update_instance",
];

/// cap.integration —— IM 平台集成能力
pub struct IntegrationCapability {
    state: Arc<AppState>,
}

impl IntegrationCapability {
    pub fn with_state(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "IM 集成",
            "外部 IM 平台（QQ Bot / 飞书 / 钉钉）接入：连接管理、实例配置、消息收发与状态查询",
            Some("init/start/stop 等写动作影响常驻连接；web-only 构建下 init 为 no-op"),
            json!({
                "init": { "params": { "qqbotConfig": "object|null", "feishuConfig": "object|null", "dingtalkConfig": "object|null" }, "returns": "{}" },
                "start": { "params": { "platform": "qqbot|feishu|dingtalk" }, "returns": "{}" },
                "stop": { "params": { "platform": "string" }, "returns": "{}" },
                "status": { "params": { "platform": "string" }, "returns": "{ status: IntegrationStatus|null }" },
                "status_all": { "params": {}, "returns": "{ statuses: Record<string, IntegrationStatus> }" },
                "send": { "params": { "platform": "string", "target": "SendTarget", "content": "MessageContent" }, "returns": "{}" },
                "sessions": { "params": {}, "returns": "{ sessions: IntegrationSession[] }" },
                "add_instance": { "params": { "instance": "PlatformInstance" }, "returns": "{ instanceId: string }" },
                "remove_instance": { "params": { "instanceId": "string" }, "returns": "{ instance: PlatformInstance|null }" },
                "list_instances": { "params": {}, "returns": "{ instances: PlatformInstance[] }" },
                "list_instances_by_platform": { "params": { "platform": "string" }, "returns": "{ instances: PlatformInstance[] }" },
                "get_active_instance": { "params": { "platform": "string" }, "returns": "{ instance: PlatformInstance|null }" },
                "switch_instance": { "params": { "instanceId": "string" }, "returns": "{}" },
                "disconnect_instance": { "params": { "platform": "string" }, "returns": "{}" },
                "update_instance": { "params": { "instance": "PlatformInstance" }, "returns": "{}" },
            }),
        )
    }

    fn parse_platform(params: &Value, key: &str) -> Result<Platform, String> {
        let s = params
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("缺少参数: {key}"))?;
        s.parse::<Platform>()
            .map_err(|e: String| format!("platform 参数非法: {e}"))
    }

    /// 同步 invoke 包装异步 manager 调用（同 plugin_service_manager 的 block_on 模式：
    /// dispatch 已在 blocking 线程池，block_in_place + handle.block_on 安全）
    fn block_on_async<F>(f: F) -> Result<Value, String>
    where
        F: std::future::Future<Output = Result<Value, String>>,
    {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.integration 异步动作需在 tokio 运行时内调用".to_string())?;
        tokio::task::block_in_place(move || handle.block_on(f))
    }
}

impl Capability for IntegrationCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.integration 需要 action 参数（{INTEGRATION_CAP_ACTIONS:?}）"))?;

        // 读写分离：只读动作拿不可变锁；写动作拿可变锁（manager 方法签名决定）
        match action {
            "status" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    let status = manager.status(platform).await;
                    Ok(json!({ "status": status }))
                })
            }
            "status_all" => Self::block_on_async(async move {
                let manager = self.state.integration_manager.lock().await;
                let statuses = manager.all_status().await;
                let map: serde_json::Map<String, Value> = statuses
                    .into_iter()
                    .filter_map(|(p, s)| {
                        serde_json::to_value(s)
                            .ok()
                            .map(|v| (p.to_string(), v))
                    })
                    .collect();
                Ok(json!({ "statuses": map }))
            }),
            "sessions" => Self::block_on_async(async move {
                let manager = self.state.integration_manager.lock().await;
                let sessions = manager.sessions();
                let sessions = serde_json::to_value(sessions)
                    .map_err(|e| format!("cap.integration 会话序列化失败: {e}"))?;
                Ok(json!({ "sessions": sessions }))
            }),
            "list_instances" => Self::block_on_async(async move {
                let manager = self.state.integration_manager.lock().await;
                let instances = manager.list_instances().await;
                let instances = serde_json::to_value(instances)
                    .map_err(|e| format!("cap.integration 实例序列化失败: {e}"))?;
                Ok(json!({ "instances": instances }))
            }),
            "list_instances_by_platform" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    let instances = manager.list_instances_by_platform(platform).await;
                    let instances = serde_json::to_value(instances)
                        .map_err(|e| format!("cap.integration 实例序列化失败: {e}"))?;
                    Ok(json!({ "instances": instances }))
                })
            }
            "get_active_instance" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    let instance = manager.get_active_instance(platform).await;
                    let instance = serde_json::to_value(instance)
                        .map_err(|e| format!("cap.integration 实例序列化失败: {e}"))?;
                    Ok(json!({ "instance": instance }))
                })
            }
            "init" => {
                #[cfg(feature = "tauri-app")]
                {
                    let qqbot_config = params.get("qqbotConfig").cloned().and_then(|v| {
                        serde_json::from_value(v).ok()
                    });
                    let feishu_config = params.get("feishuConfig").cloned().and_then(|v| {
                        serde_json::from_value(v).ok()
                    });
                    let dingtalk_config = params.get("dingtalkConfig").cloned().and_then(|v| {
                        serde_json::from_value(v).ok()
                    });
                    let app_handle = self.state.app_handle.get().cloned().ok_or_else(|| {
                        "cap.integration init: AppHandle 未注入（web-only 构建不支持）".to_string()
                    })?;
                    Self::block_on_async(async move {
                        let mut manager = self.state.integration_manager.lock().await;
                        manager
                            .init(qqbot_config, feishu_config, dingtalk_config, app_handle)
                            .await;
                        Ok(json!({}))
                    })
                }
                #[cfg(not(feature = "tauri-app"))]
                {
                    // web-only 构建：无 AppHandle，init 是 no-op（与旧 HTTP 桥语义一致）
                    let _ = &params;
                    Ok(json!({}))
                }
            }
            "start" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    let mut manager = self.state.integration_manager.lock().await;
                    manager.start(platform).await.map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            "stop" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    let mut manager = self.state.integration_manager.lock().await;
                    manager.stop(platform).await.map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            "send" => {
                let platform = Self::parse_platform(&params, "platform")?;
                let target = params.get("target").cloned().ok_or_else(|| "缺少参数: target".to_string())?;
                let target: crate::integrations::types::SendTarget =
                    serde_json::from_value(target)
                        .map_err(|e| format!("target 参数非法: {e}"))?;
                let content = params.get("content").cloned().ok_or_else(|| "缺少参数: content".to_string())?;
                let content: crate::integrations::types::MessageContent =
                    serde_json::from_value(content)
                        .map_err(|e| format!("content 参数非法: {e}"))?;
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    manager
                        .send(platform, target, content)
                        .await
                        .map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            "add_instance" => {
                let instance = params.get("instance").cloned().ok_or_else(|| "缺少参数: instance".to_string())?;
                let instance: crate::integrations::instance_registry::PlatformInstance =
                    serde_json::from_value(instance)
                        .map_err(|e| format!("instance 参数非法: {e}"))?;
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    let id = manager.add_instance(instance).await;
                    drop(manager);
                    // 实例写后同步 config.json（与旧 tauri 命令层同一持久化语义）
                    crate::commands::integration::sync_instances_to_config(&self.state)
                        .await
                        .map_err(|e| e.to_message())?;
                    Ok(json!({ "instanceId": id }))
                })
            }
            "remove_instance" => {
                let instance_id = params
                    .get("instanceId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "缺少参数: instanceId".to_string())?
                    .to_string();
                Self::block_on_async(async move {
                    let manager = self.state.integration_manager.lock().await;
                    let removed = manager.remove_instance(&instance_id).await;
                    drop(manager);
                    crate::commands::integration::sync_instances_to_config(&self.state)
                        .await
                        .map_err(|e| e.to_message())?;
                    let removed = serde_json::to_value(removed)
                        .map_err(|e| format!("cap.integration 实例序列化失败: {e}"))?;
                    Ok(json!({ "instance": removed }))
                })
            }
            "switch_instance" => {
                let instance_id = params
                    .get("instanceId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "缺少参数: instanceId".to_string())?
                    .to_string();
                Self::block_on_async(async move {
                    {
                        let mut manager = self.state.integration_manager.lock().await;
                        manager
                            .switch_instance(&instance_id)
                            .await
                            .map_err(|e| e.to_message())?;
                    }
                    crate::commands::integration::sync_instances_to_config(&self.state)
                        .await
                        .map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            "disconnect_instance" => {
                let platform = Self::parse_platform(&params, "platform")?;
                Self::block_on_async(async move {
                    {
                        let mut manager = self.state.integration_manager.lock().await;
                        manager
                            .disconnect_instance(platform)
                            .await
                            .map_err(|e| e.to_message())?;
                    }
                    crate::commands::integration::sync_instances_to_config(&self.state)
                        .await
                        .map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            "update_instance" => {
                let instance = params.get("instance").cloned().ok_or_else(|| "缺少参数: instance".to_string())?;
                let instance: crate::integrations::instance_registry::PlatformInstance =
                    serde_json::from_value(instance)
                        .map_err(|e| format!("instance 参数非法: {e}"))?;
                Self::block_on_async(async move {
                    {
                        let mut manager = self.state.integration_manager.lock().await;
                        manager
                            .update_instance(instance)
                            .await
                            .map_err(|e| e.to_message())?;
                    }
                    crate::commands::integration::sync_instances_to_config(&self.state)
                        .await
                        .map_err(|e| e.to_message())?;
                    Ok(json!({}))
                })
            }
            other => Err(unsupported_action(CAP_ID, other, INTEGRATION_CAP_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小测试 Context（对齐 terminal_capability tests 范式）
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
            Err("not implemented".into())
        }
    }

    #[test]
    fn describe_contract() {
        let doc = IntegrationCapability::describe_doc();
        assert_eq!(doc["id"], CAP_ID);
        let actions = doc["actions"].as_object().expect("actions 应为对象");
        for key in INTEGRATION_CAP_ACTIONS {
            assert!(actions.contains_key(*key), "describe 缺 action: {key}");
        }
    }

    #[test]
    fn missing_action_errors() {
        let cap = IntegrationCapability {
            state: unimplemented_state(),
        };
        let err = cap
            .invoke(serde_json::json!({}), &TestCtx)
            .expect_err("缺 action 应报错");
        assert!(err.contains("action"));
    }

    #[test]
    fn unknown_action_lists_supported() {
        let cap = IntegrationCapability {
            state: unimplemented_state(),
        };
        let err = cap
            .invoke(serde_json::json!({ "action": "nope" }), &TestCtx)
            .expect_err("未知 action 应报错");
        assert!(err.contains("cap.integration"));
    }

    #[test]
    fn invalid_platform_rejected() {
        let cap = IntegrationCapability {
            state: unimplemented_state(),
        };
        let err = cap
            .invoke(
                serde_json::json!({ "action": "status", "platform": "weixin" }),
                &TestCtx,
            )
            .expect_err("非法平台应报错");
        assert!(err.contains("platform"), "错误应指向 platform 参数: {err}");
    }

    /// 未触达真实 AppState 的动作路径用此占位（测试只验证参数校验分支，
    /// 不会真正解引用 state）。
    #[allow(unreachable_code)]
    fn unimplemented_state() -> Arc<AppState> {
        unreachable!("参数校验先于 state 解引用，不应到达此处")
    }
}
