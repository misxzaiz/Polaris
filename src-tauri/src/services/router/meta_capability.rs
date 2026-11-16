//! cap.meta —— 引擎/CLI/Agent/模型 Profile 元数据与工具能力（K-R5 批E3）
//!
//! 收口原 commands/{engine_metadata,cli_info,agent_corpus,model_profile}.rs 的
//! tauri command：全部为「元数据只读查询 + agent/roster 配置 CRUD + Profile
//! 连接测试」，统一走 RouterBus（权限 gate + 审计）；实现体复用既有 inner /
//! services（McpManagerService 同范式）。AppState 经 with_state 注入。
//!
//! # 动作协议（payload `{ "action": ... }`，camelCase 参数）
//!
//! 引擎：`engine_metadata_list`
//! CLI：`cli_version` / `cli_version_for` / `cli_agents` / `cli_auth_status` /
//!      `cli_check_installed` / `cli_find_paths`
//! Agent：`agent_rosters` / `agent_custom_list` / `agent_custom_save` /
//!        `agent_custom_delete` / `agent_simple_list` / `roster_save` /
//!        `roster_delete`
//! Profile：`model_test_connection` / `model_fetch_models`

use crate::contracts::{standard_describe, unsupported_action, Capability, CapabilityId, Context, Value};
use std::sync::Arc;

const CAP_ID: &str = "cap.meta";

pub const META_ACTIONS: &[&str] = &[
    "engine_metadata_list",
    "claude_read_settings",
    "claude_write_settings",
    "claude_settings_path",
    "claude_add_permission_rules",
    "cli_version",
    "cli_version_for",
    "cli_agents",
    "cli_auth_status",
    "cli_check_installed",
    "cli_find_paths",
    "agent_rosters",
    "agent_custom_list",
    "agent_custom_save",
    "agent_custom_delete",
    "agent_simple_list",
    "roster_save",
    "roster_delete",
    "model_test_connection",
    "model_fetch_models",
];

pub struct MetaCapability {
    config_store: Arc<std::sync::Mutex<crate::services::config_store::ConfigStore>>,
    engine_registry: Arc<tokio::sync::Mutex<crate::ai::EngineRegistry>>,
}

impl MetaCapability {
    pub fn new(
        config_store: Arc<std::sync::Mutex<crate::services::config_store::ConfigStore>>,
        engine_registry: Arc<tokio::sync::Mutex<crate::ai::EngineRegistry>>,
    ) -> Self {
        Self { config_store, engine_registry }
    }

    fn claude_path(&self) -> Result<String, String> {
        let store = self
            .config_store
            .lock()
            .map_err(|e| e.to_string())?;
        Ok(store.get().resolve_claude_cmd())
    }

    fn dispatch_action(&self, params: &Value) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.meta 需要 action 参数（{:?}）", META_ACTIONS))?;
        let get = |k: &str| params.get(k);
        let req_str = |k: &str| -> Result<String, String> {
            get(k)
                .and_then(|v| v.as_str())
                .map(String::from)
                .ok_or_else(|| format!("cap.meta {action} 需要字符串参数 {k}"))
        };
        match action {
            "engine_metadata_list" => {
                let registry = self.engine_registry.blocking_lock();
                let metas = registry.list_all_metadata();
                serde_json::to_value(metas).map_err(|e| e.to_string())
            }
            "cli_version" => {
                let svc = crate::services::cli_info_service::CliInfoService::new(self.claude_path()?);
                svc.get_version()
                    .map(|v| serde_json::json!(v))
                    .map_err(|e| e.to_string())
            }
            "cli_version_for" => {
                let cli = req_str("cliName")?;
                crate::services::cli_info_service::get_cli_version(&cli)
                    .map(|v| serde_json::json!(v))
                    .map_err(|e| e.to_string())
            }
            "cli_agents" => {
                let svc = crate::services::cli_info_service::CliInfoService::new(self.claude_path()?);
                svc.get_agents()
                    .map(|v| serde_json::json!(v))
                    .map_err(|e| e.to_string())
            }
            "cli_auth_status" => {
                let svc = crate::services::cli_info_service::CliInfoService::new(self.claude_path()?);
                svc.get_auth_status()
                    .map(|v| serde_json::json!(v))
                    .map_err(|e| e.to_string())
            }
            "cli_check_installed" => {
                let cli = req_str("cliName")?;
                Ok(serde_json::json!({ "installed": crate::services::cli_info_service::check_cli_installed(&cli) }))
            }
            "cli_find_paths" => {
                let cli = req_str("cliName")?;
                Ok(serde_json::json!(crate::services::cli_info_service::find_cli_paths(&cli)))
            }
            "claude_read_settings" => {
                let r = block_on_async(async {
                    crate::commands::claude_settings::read_claude_settings()
                        .await
                        .map_err(|e| e.to_string())
                })?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "claude_write_settings" => {
                let settings: crate::commands::claude_settings::ClaudeSettings = get("settings")
                    .cloned()
                    .ok_or_else(|| "cap.meta claude_write_settings 需要参数 settings".to_string())
                    .and_then(|v| serde_json::from_value(v).map_err(|e| format!("settings 解析失败: {e}")))?;
                block_on_async(async {
                    crate::commands::claude_settings::write_claude_settings(settings)
                        .await
                        .map_err(|e| e.to_string())
                })?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "claude_settings_path" => {
                let r = block_on_async(async {
                    crate::commands::claude_settings::get_claude_settings_path()
                        .await
                        .map_err(|e| e.to_string())
                })?;
                Ok(serde_json::json!(r))
            }
            "claude_add_permission_rules" => {
                let rules: Vec<String> = get("rules")
                    .cloned()
                    .ok_or_else(|| "cap.meta claude_add_permission_rules 需要参数 rules".to_string())
                    .and_then(|v| serde_json::from_value(v).map_err(|e| format!("rules 解析失败: {e}")))?;
                let kind = get("kind").and_then(|v| v.as_str()).unwrap_or("allow").to_string();
                let r = block_on_async(async {
                    crate::commands::claude_settings::add_claude_permission_rules(rules, kind)
                        .await
                        .map_err(|e| e.to_string())
                })?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "agent_rosters" => {
                let v = crate::commands::agent_corpus::corpus_rosters_inner()
                    .map_err(|e| e.to_string())?;
                Ok(v)
            }
            "agent_custom_list" => {
                Ok(serde_json::json!(crate::commands::agent_corpus::custom_agent_list_inner()))
            }
            "agent_custom_save" => {
                let slug = req_str("slug")?;
                let name = req_str("name")?;
                let description = get("description").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let emoji = get("emoji").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let system_prompt = get("systemPrompt").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let tools: Vec<String> = get("tools")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let p = crate::commands::agent_corpus::custom_agent_save_inner(
                    &slug, &name, &description, &emoji, &system_prompt, &tools,
                )
                .map_err(|e| e.to_string())?;
                Ok(serde_json::json!(p.to_string_lossy().to_string()))
            }
            "agent_custom_delete" => {
                let slug = req_str("slug")?;
                crate::commands::agent_corpus::custom_agent_delete_inner(&slug)
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "agent_simple_list" => {
                Ok(serde_json::json!(crate::commands::agent_corpus::simple_ai_list_agents_inner()))
            }
            "roster_save" => {
                let slug = req_str("slug")?;
                let title = req_str("title")?;
                let summary = get("summary").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let members: Vec<String> = get("members")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                crate::commands::agent_corpus::user_roster_save_inner(&slug, &title, &summary, members)
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "roster_delete" => {
                let slug = req_str("slug")?;
                crate::commands::agent_corpus::user_roster_delete_inner(&slug)
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "model_test_connection" => {
                let profile: crate::models::config::ModelProfile = get("profile")
                    .cloned()
                    .ok_or_else(|| "cap.meta model_test_connection 需要参数 profile".to_string())
                    .and_then(|v| serde_json::from_value(v).map_err(|e| format!("profile 解析失败: {e}")))?;
                let r = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::try_current()
                        .map_err(|e| format!("block_on 需 tokio 运行时: {e}"))
                        .and_then(|h| h.block_on(crate::services::ModelProfileService::test_connection(&profile)).map_err(|e| e.to_string()))
                })?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "model_fetch_models" => {
                let profile: crate::models::config::ModelProfile = get("profile")
                    .cloned()
                    .ok_or_else(|| "cap.meta model_fetch_models 需要参数 profile".to_string())
                    .and_then(|v| serde_json::from_value(v).map_err(|e| format!("profile 解析失败: {e}")))?;
                let r = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::try_current()
                        .map_err(|e| format!("block_on 需 tokio 运行时: {e}"))
                        .and_then(|h| h.block_on(crate::services::ModelProfileService::fetch_models(&profile)).map_err(|e| e.to_string()))
                })?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            other => Err(unsupported_action(CAP_ID, other, META_ACTIONS)),
        }
    }
}

/// 同步 capability 里驱动 async（对齐 fs_capability::async_drive 范式）
fn block_on_async<F, T>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::try_current()
            .map_err(|e| format!("block_on 需 tokio 运行时: {e}"))?
            .block_on(fut)
    })
}

impl Capability for MetaCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        standard_describe(
            CAP_ID,
            "元数据与配置工具",
            "引擎元数据 / CLI 信息 / Agent 语料 / 模型 Profile 连接测试（K-R5 批E3 收口）",
            None,
            serde_json::json!({
                "engine_metadata_list": { "params": {}, "returns": "EngineMetadata[]" },
                "cli_version": { "params": {}, "returns": "string" },
                "cli_agents": { "params": {}, "returns": "CliAgentInfo[]" },
                "cli_auth_status": { "params": {}, "returns": "CliAuthStatus" },
                "agent_rosters": { "params": {}, "returns": "{ rosters }" },
                "agent_custom_list": { "params": {}, "returns": "CustomAgentItem[]" },
                "model_test_connection": { "params": { "profile": "ModelProfile" }, "returns": "ConnectionTestResult" },
                "model_fetch_models": { "params": { "profile": "ModelProfile" }, "returns": "string[]" },
            }),
        )
    }

    fn invoke(&self, payload: Value, _ctx: &dyn Context) -> Result<Value, String> {
        self.dispatch_action(&payload)
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}
