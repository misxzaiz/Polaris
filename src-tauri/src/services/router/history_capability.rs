//! cap.history —— AI 会话历史能力（第七步阶段 B2：壳命令摘除后的唯一实现）
//!
//! 接 `services/ai_history_core.rs` 业务核（会话统一分页接口 + Claude Code
//! 会话树/fork 推断 + 历史消息读取），全部为同步 dispatch 动作（文件系统读取，
//! 无流式语义）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `list_sessions`          `{ "engineId", "page"?, "pageSize"?, "workDir"? }` → PagedResult<SessionMeta>
//! - `get_session_history`    `{ "sessionId", "engineId", "page"?, "pageSize"? }` → PagedResult<HistoryMessage>
//! - `delete_session`         `{ "sessionId", "engineId" }`
//! - `list_claude_sessions`   `{}`（无参数——实现不接收 workDir，勿传）→ ClaudeSessionMeta[]
//! - `get_claude_history`     `{ "sessionId", "projectPath"? }` → ClaudeHistoryMessage[]

use crate::services::ai_history_core as hist;
use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use std::sync::Arc;

const CAP_ID: &str = "cap.history";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const HISTORY_ACTIONS: &[&str] = &[
    "list_sessions",
    "get_session_history",
    "delete_session",
    "list_claude_sessions",
    "get_claude_history",
];

/// cap.history —— 会话历史能力（唯一实现）
pub struct HistoryCapability {
    state: Arc<crate::AppState>,
}

impl HistoryCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self { state }
    }

    /// describe 文档体（状态无关；独立成关联函数便于 describe_contract 测试
    /// 直接调用，无需构造 AppState）。
    ///
    /// 2026-10-25 审计修正：删去 list_claude_sessions 的 workDir——实现完全不
    /// 接收该参数（底层 `list_claude_code_sessions()` 无参），传入被静默忽略，
    /// AI 以过滤意图传参后会拿到全量结果。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "会话历史",
            "AI 会话历史：会话列表/历史消息/删除 + Claude Code 会话树",
            None,
            serde_json::json!({
                "list_sessions": { "params": { "engineId": "string?（默认 claude-code）", "page": "int?", "pageSize": "int?", "workDir": "string?" }, "returns": "PagedResult<SessionMeta>", "example": { "action": "list_sessions" } },
                "get_session_history": { "params": { "sessionId": "string（必填）", "engineId": "string?（默认 claude-code）", "page": "int?", "pageSize": "int?" }, "returns": "PagedResult<HistoryMessage>" },
                "delete_session": { "params": { "sessionId": "string（必填）", "engineId": "string?（默认 claude-code）" }, "returns": "{ ok: true }" },
                "list_claude_sessions": { "params": {}, "returns": "ClaudeSessionMeta[]" },
                "get_claude_history": { "params": { "sessionId": "string（必填）", "projectPath": "string?" }, "returns": "ClaudeHistoryMessage[]" }
            }),
        )
    }
}

impl Capability for HistoryCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        // 缺 action 显式报错并列出五个动作（原 unwrap_or("") 把空串落 unknown
        // 分支，报"不支持动作: "且无候选清单，AI 无法自纠）
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.history 需要 action 参数（{:?}）", HISTORY_ACTIONS))?
            .to_string();
        let state = self.state.clone();
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.history 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let s = state.as_ref();
                let get = |k: &str| params.get(k);
                let opt_str = |k: &str| get(k).and_then(|v| v.as_str()).map(String::from);
                let opt_usize = |k: &str| get(k).and_then(|v| v.as_u64()).map(|v| v as usize);
                // 必填字符串参数：缺失显式报错（原 unwrap_or("") 传空串，下游报
                // "会话不存在: "（尾随空串），不指向漏传参数，AI 易误判为 id 值错误）
                let req_str = |k: &str, act: &str| -> Result<String, String> {
                    get(k)
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .ok_or_else(|| format!("cap.history {act} 需要字符串参数 {k}"))
                };
                match action.as_str() {
                    "list_sessions" => {
                        let result = hist::list_sessions(
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            opt_usize("page"),
                            opt_usize("pageSize"),
                            opt_str("workDir"),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "get_session_history" => {
                        let session_id = req_str("sessionId", "get_session_history")?;
                        let result = hist::get_session_history(
                            session_id,
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            opt_usize("page"),
                            opt_usize("pageSize"),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "delete_session" => {
                        let session_id = req_str("sessionId", "delete_session")?;
                        hist::delete_session(
                            session_id,
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "list_claude_sessions" => {
                        // 无参数动作（实现不接收 workDir，见 describe_doc 注释）
                        let result = hist::list_claude_code_sessions()
                            .await
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "get_claude_history" => {
                        let session_id = req_str("sessionId", "get_claude_history")?;
                        let result = hist::get_claude_code_session_history(
                            session_id,
                            opt_str("projectPath"),
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    // 未知动作文案统一走 contracts::unsupported_action（列出合法
                    // 动作与 cap.help 指路，AI 可自纠）
                    other => Err(unsupported_action(CAP_ID, other, HISTORY_ACTIONS)),
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
        let d = HistoryCapability::describe_doc();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（HISTORY_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), HISTORY_ACTIONS.len());
        for name in HISTORY_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn list_claude_sessions_declares_no_workdir() {
        // 审计漂移回归锚：list_claude_sessions 无 workDir 参数（实现不接收，
        // 传入被静默忽略），describe 不得再声明
        let d = HistoryCapability::describe_doc();
        let params = d["actions"]["list_claude_sessions"]["params"]
            .as_object()
            .unwrap();
        assert!(!params.contains_key("workDir"), "workDir 已删，不得回潮");
    }
}
