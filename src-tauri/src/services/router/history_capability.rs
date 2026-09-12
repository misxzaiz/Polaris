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
//! - `list_claude_sessions`   `{ "workDir"? }` → ClaudeSessionMeta[]
//! - `get_claude_history`     `{ "sessionId", "projectPath"? }` → ClaudeHistoryMessage[]

use crate::services::ai_history_core as hist;
use crate::contracts::{Capability, CapabilityId, Context, Value};
use std::sync::Arc;

/// cap.history —— 会话历史能力（唯一实现）
pub struct HistoryCapability {
    state: Arc<crate::AppState>,
}

impl HistoryCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self { state }
    }
}

impl Capability for HistoryCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.history".into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
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
                        let result = hist::get_session_history(
                            get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
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
                        hist::delete_session(
                            get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "list_claude_sessions" => {
                        let result = hist::list_claude_code_sessions()
                            .await
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "get_claude_history" => {
                        let result = hist::get_claude_code_session_history(
                            get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            opt_str("projectPath"),
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    other => Err(format!("cap.history 不支持动作: {}", other)),
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}
