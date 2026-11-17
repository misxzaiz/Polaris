//! cap.storage —— 存储能力路由（kernel-5k 方案 S3：存储插件化）
//!
//! 目标形态：宿主核不再持有 session_db/session_state/turn_persist/dialog_index
//! 实现，改由 storage-sqlite 系统插件经 `register_capability` 反向注册 handler；
//! 本能力只做路由 + 权限 + 审计（「核内 bus 只路由不实现」）。
//!
//! 当前阶段（S3.1 脚手架）：action 协议已定，handler 仍回落到宿主现存实现
//! （`fallback_to_host`），插件接管后逐动作切换，前端契约零改动。
//!
//! # 动作协议（payload `{ "action": ... }`，命名空间对齐现存四库）
//!
//! - `dialog.list` / `dialog.read` / `dialog.list_meta` / `dialog.write` /
//!   `dialog.append` / `dialog.read_page` / `dialog.delete` / `dialog.consolidate`
//! - `state.get` / `state.list` / `state.reconcile`（同 cap.session 读面；写面仍 cap.ai.chat）
//! - `turn.recover_pending`
//! - `index.query` / `index.search` / `index.mark`
//!
//! # 权限
//!
//! storage 写类动作（write/append/delete/consolidate/mark）按「数据变更」分级，
//! 与 cap.kv 写同策略；读类动作默认放行（对齐 cap.kv 读）。

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use std::sync::Arc;

const CAP_ID: &str = "cap.storage";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const STORAGE_ACTIONS: &[&str] = &[
    "dialog.list",
    "dialog.read",
    "dialog.list_meta",
    "dialog.write",
    "dialog.append",
    "dialog.read_page",
    "dialog.delete",
    "dialog.consolidate",
    "state.get",
    "state.list",
    "state.reconcile",
    "turn.recover_pending",
    "index.query",
    "index.search",
    "index.mark",
];

/// cap.storage —— 存储能力路由（S3 脚手架：handler 回落宿主现存实现）
pub struct StorageCapability {
    state: Arc<crate::AppState>,
}

impl StorageCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self { state }
    }

    /// describe 文档体（状态无关）
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "存储",
            "会话/消息/状态/索引存储收口（S3 存储插件化：实现体将迁 storage-sqlite 插件，本能力为唯一路由）",
            None,
            serde_json::json!({
                "dialog.list": { "params": {}, "returns": "string[]（dialog 文件名）" },
                "dialog.read": { "params": { "name": "string" }, "returns": "string | null" },
                "dialog.list_meta": { "params": {}, "returns": "DialogMetaEntry[]" },
                "dialog.write": { "params": { "name": "string", "content": "string" }, "returns": "null" },
                "dialog.append": { "params": { "name": "string", "metaLine": "string?", "lines": "string[]" }, "returns": "null" },
                "dialog.read_page": { "params": { "name": "string", "offset": "int", "limit": "int" }, "returns": "DialogPage" },
                "dialog.delete": { "params": { "name": "string" }, "returns": "null" },
                "dialog.consolidate": { "params": { "name": "string", "metaJson": "string", "messagesJson": "string" }, "returns": "{ total: int }" },
                "state.get": { "params": { "conversationId": "string" }, "returns": "SessionStatus" },
                "state.list": { "params": {}, "returns": "SessionRecord[]" },
                "state.reconcile": { "params": { "conversationId": "string", "clientMessages": "MessageEntry[]", "clientRunning": "bool" }, "returns": "ReconcileResult" },
                "turn.recover_pending": { "params": {}, "returns": "{ recovered: int }" },
                "index.query": { "params": { "query": "HistoryQueryParams" }, "returns": "HistoryQueryResult" },
                "index.search": { "params": { "query": "string", "limit": "int?" }, "returns": "HistorySearchHit[]" },
                "index.mark": { "params": { "id": "string", "marks": "object" }, "returns": "null" },
            }),
        )
    }
}

impl Capability for StorageCapability {
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
            .ok_or_else(|| format!("cap.storage 需要 action 参数（{:?}）", STORAGE_ACTIONS))?
            .to_string();
        let _state = self.state.clone();
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.storage 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let get = |k: &str| params.get(k);
                let req_str = |k: &str, act: &str| -> Result<String, String> {
                    get(k)
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .ok_or_else(|| format!("cap.storage {act} 需要字符串参数 {k}"))
                };
                // S3 脚手架阶段：handler 直呼宿主现存实现（dialog_storage inner）。
                // storage-sqlite 插件接管后，此处改走插件注册的 handler（路由不变）。
                match action.as_str() {
                    "dialog.list" => {
                        let names = crate::commands::dialog_storage::dialog_list_inner()
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(names).map_err(|e| e.to_string())
                    }
                    "dialog.list_meta" => {
                        let entries = crate::commands::dialog_storage::dialog_list_meta_inner()
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(entries).map_err(|e| e.to_string())
                    }
                    "dialog.read" => {
                        let name = req_str("name", "dialog.read")?;
                        let content = crate::commands::dialog_storage::dialog_read_inner(&name)
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(content).map_err(|e| e.to_string())
                    }
                    "dialog.write" => {
                        let name = req_str("name", "dialog.write")?;
                        let content = req_str("content", "dialog.write")?;
                        crate::commands::dialog_storage::dialog_write_inner(&name, &content)
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "dialog.append" => {
                        let name = req_str("name", "dialog.append")?;
                        let meta_line = get("metaLine").and_then(|v| v.as_str()).map(String::from);
                        let lines: Vec<String> = match get("lines") {
                            Some(v) => serde_json::from_value(v.clone())
                                .map_err(|e| format!("lines 解析失败（string[]）: {e}"))?,
                            None => Vec::new(),
                        };
                        crate::commands::dialog_storage::dialog_append_inner(&name, meta_line.as_deref(), &lines)
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "dialog.read_page" => {
                        let name = req_str("name", "dialog.read_page")?;
                        let before_seq = get("beforeSeq").and_then(|v| v.as_i64());
                        let limit = get("limit").and_then(|v| v.as_u64()).unwrap_or(200).clamp(1, 1000) as usize;
                        let page = crate::commands::dialog_storage::dialog_read_page_inner(
                            &name,
                            before_seq,
                            limit,
                        )
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(page).map_err(|e| e.to_string())
                    }
                    "dialog.delete" => {
                        let name = req_str("name", "dialog.delete")?;
                        crate::commands::dialog_storage::dialog_delete_inner(&name)
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "dialog.consolidate" => {
                        let name = req_str("name", "dialog.consolidate")?;
                        let meta_json = req_str("metaJson", "dialog.consolidate")?;
                        let messages_json = req_str("messagesJson", "dialog.consolidate")?;
                        let result = crate::commands::dialog_storage::dialog_consolidate_inner(
                            &name,
                            &meta_json,
                            &messages_json,
                        )
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    // state/turn/index 命名空间在 S3.4 步接入（先走 cap.session/cap.history 既有面）
                    other => Err(unsupported_action(CAP_ID, other, STORAGE_ACTIONS)),
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}
