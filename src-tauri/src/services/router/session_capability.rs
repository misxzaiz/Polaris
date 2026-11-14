//! cap.session —— AI 会话状态/查询/导航能力（ai-chat-plugin-extraction-spec P1.1）
//!
//! 对话域插件化（chat-desk）后的会话读面收口：把散落的 session_* / message_read
//! 命令面收敛为单一总线能力，供插件面板（chat-desk）与宿主 chrome（经
//! sessionDirectory 薄 store）消费。**只做读/查询/导航，不新增写路径**——所有
//! 状态写入仍由 cap.ai.chat / 既有后端服务执行（「日志即真相」不变式）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `state.get`         `{ "conversationId" }` → SessionStatus（权威运行状态，
//!   等价 session_get_status；从事件日志计算）
//! - `state.list`        `{}` → SessionRecord[]（Session Registry 全量）
//! - `state.reconcile`   `{ "conversationId", "clientMessages", "clientRunning" }`
//!   → ReconcileResult（前端快照 ↔ 后端日志对账）
//! - `message.read`      `{ "conversationId", "afterTimestamp"?, "limit"? }`
//!   → MessageEntry[]（后端消息库权威读取；
//!   QuickSwitchPanel 全量导出改走此动作）
//! - `message.read_history` `{ "id" }` → MessageEntry[]（含历史版本）
//! - `index.list`        `{ "workspaceKey" }` → { sessions, currentSeq }
//!   （workspace 级权威投影快照）
//! - `index.list_after`  `{ "workspaceKey", "afterSeq" }` → SessionProjection[]
//!   （投影增量，gap repair / 订阅数据源）
//!
//! # 不做的事（边界）
//!
//! - 不提供 session_start / interrupt 等写动作——执行面在 cap.ai.chat；
//! - 不提供 event append——事件由后端管线写入；
//! - 不做流式——运行状态经 state.get 轮询 / chat-event 事件驱动。

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use std::sync::Arc;

const CAP_ID: &str = "cap.session";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const SESSION_ACTIONS: &[&str] = &[
    "state.get",
    "state.list",
    "state.reconcile",
    "message.read",
    "message.read_history",
    "index.list",
    "index.list_after",
];

/// cap.session —— 会话状态/查询/导航能力（读面收口，唯一实现）
pub struct SessionCapability {
    state: Arc<crate::AppState>,
}

impl SessionCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self { state }
    }

    /// describe 文档体（状态无关；独立成关联函数便于 describe_contract 测试
    /// 直接调用，无需构造 AppState）。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "会话状态",
            "AI 会话读面收口：权威运行状态查询 / 会话注册表 / 消息库读取 / workspace 投影（写面在 cap.ai.chat，本能力只读）",
            None,
            serde_json::json!({
                "state.get": { "params": { "conversationId": "string（必填）" }, "returns": "SessionStatus { conversationId, running, lastEventSeq, error?, startedAt?, endedAt?, startedByDevice? }" },
                "state.list": { "params": {}, "returns": "SessionRecord[]（Session Registry 全量）" },
                "state.reconcile": { "params": { "conversationId": "string（必填）", "clientMessages": "MessageEntry[]（前端快照，camelCase）", "clientRunning": "bool" }, "returns": "ReconcileResult { missing[], extra[], statusMismatch, serverStatus }" },
                "message.read": { "params": { "conversationId": "string（必填）", "afterTimestamp": "int?", "limit": "int?" }, "returns": "MessageEntry[]（后端消息库权威）" },
                "message.read_history": { "params": { "id": "string（必填，conversation id）" }, "returns": "MessageEntry[]（含历史版本）" },
                "index.list": { "params": { "workspaceKey": "string（必填，identity ?? path；'default' 为无工作区）" }, "returns": "{ sessions: SessionProjection[], currentSeq: int }" },
                "index.list_after": { "params": { "workspaceKey": "string（必填）", "afterSeq": "int（必填）" }, "returns": "SessionProjection[]（增量）" },
            }),
        )
    }
}

impl Capability for SessionCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        // 缺 action 显式报错并列出全部动作（对齐 cap.history 范式）
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.session 需要 action 参数（{:?}）", SESSION_ACTIONS))?
            .to_string();
        let _state = self.state.clone();
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.session 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let get = |k: &str| params.get(k);
                let opt_i64 = |k: &str| get(k).and_then(|v| v.as_i64());
                // 必填字符串参数：缺失显式报错（对齐 cap.history req_str）
                let req_str = |k: &str, act: &str| -> Result<String, String> {
                    get(k)
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .ok_or_else(|| format!("cap.session {act} 需要字符串参数 {k}"))
                };
                match action.as_str() {
                    "state.get" => {
                        let conversation_id = req_str("conversationId", "state.get")?;
                        let status =
                            crate::commands::session_state_commands::session_get_status_inner(
                                conversation_id,
                            )
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(status).map_err(|e| e.to_string())
                    }
                    "state.list" => {
                        let records =
                            crate::commands::session_state_commands::session_list_inner()
                                .map_err(|e| e.to_message())?;
                        serde_json::to_value(records).map_err(|e| e.to_string())
                    }
                    "state.reconcile" => {
                        let conversation_id = req_str("conversationId", "state.reconcile")?;
                        let client_running = get("clientRunning").and_then(|v| v.as_bool()).unwrap_or(false);
                        let client_messages: Vec<crate::services::session_db::MessageEntry> =
                            match get("clientMessages") {
                                Some(v) => serde_json::from_value(v.clone())
                                    .map_err(|e| format!("clientMessages 解析失败（MessageEntry[] camelCase）: {e}"))?,
                                None => Vec::new(),
                            };
                        let result =
                            crate::commands::session_state_commands::session_reconcile_inner(
                                conversation_id,
                                client_messages,
                                client_running,
                            )
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "message.read" => {
                        let conversation_id = req_str("conversationId", "message.read")?;
                        let after = opt_i64("afterTimestamp");
                        let limit = opt_i64("limit");
                        let msgs =
                            crate::commands::session_messages::message_read_inner(
                                conversation_id, after, limit,
                            )
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(msgs).map_err(|e| e.to_string())
                    }
                    "message.read_history" => {
                        let id = req_str("id", "message.read_history")?;
                        let msgs =
                            crate::commands::session_messages::message_read_history_inner(id)
                                .map_err(|e| e.to_message())?;
                        serde_json::to_value(msgs).map_err(|e| e.to_string())
                    }
                    "index.list" => {
                        let workspace_key = req_str("workspaceKey", "index.list")?;
                        let (sessions, current_seq) =
                            crate::commands::session_state_commands::session_index_list_inner(
                                workspace_key,
                            )
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "sessions": sessions, "currentSeq": current_seq }))
                    }
                    "index.list_after" => {
                        let workspace_key = req_str("workspaceKey", "index.list_after")?;
                        let after_seq = get("afterSeq")
                            .and_then(|v| v.as_i64())
                            .ok_or_else(|| "cap.session index.list_after 需要整数参数 afterSeq".to_string())?;
                        let sessions =
                            crate::commands::session_state_commands::session_index_list_after_inner(
                                workspace_key, after_seq,
                            )
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(sessions).map_err(|e| e.to_string())
                    }
                    // 未知动作文案统一走 contracts::unsupported_action
                    other => Err(unsupported_action(CAP_ID, other, SESSION_ACTIONS)),
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = SessionCapability::describe_doc();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（SESSION_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), SESSION_ACTIONS.len());
        for name in SESSION_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn read_only_surface() {
        // 边界回归锚：本能力只读——写面动作（start/continue/interrupt/append 等）
        // 不得出现在 describe 中（执行面在 cap.ai.chat）
        let d = SessionCapability::describe_doc();
        let actions = d["actions"].as_object().unwrap();
        for banned in [
            "start", "continue", "interrupt", "send_input", "append", "write", "delete",
            "session.start", "session.interrupt",
        ] {
            assert!(!actions.contains_key(banned), "cap.session 不得声明写动作 {banned}");
        }
    }

    #[test]
    fn missing_action_lists_candidates() {
        // 缺 action → 报错含完整动作清单（AI 可自纠）
        let err = format!(
            "cap.session 需要 action 参数（{:?}）",
            SESSION_ACTIONS
        );
        assert!(err.contains("state.get"));
        assert!(err.contains("index.list_after"));
    }
}
