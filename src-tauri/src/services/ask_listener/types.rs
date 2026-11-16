//! 类型定义与常量（K-R3 拆分）

use serde_json::Value;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Maximum frame size we accept on the wire. Browser diagnostics may include
/// a clipped PNG screenshot, so this is larger than the original ask-only cap.
pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
pub const PLUGIN_CARD_TIMEOUT: Duration = Duration::from_secs(180);
/// 派发深度上限：普通会话派发为 1，派发会话再派发为 2，2 层封顶（防循环派发）。
pub const MAX_DISPATCH_DEPTH: u32 = 2;
/// 同时处于 pending/running 的派发任务上限（防 AI 一次派发把机器打满）。
pub const MAX_ACTIVE_DISPATCHES: usize = 3;

#[derive(serde::Serialize)]
pub struct QuestionOutcome {
    /// Frame type discriminator on the wire.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// True when the user dismissed without answering.
    pub declined: bool,
    /// Per-question answer, ordered the same as the input questions.
    pub answers: Vec<QuestionAnswerPayload>,
}

impl QuestionOutcome {
    pub fn answer(answers: Vec<QuestionAnswerPayload>) -> Self {
        Self {
            kind: "answer",
            declined: false,
            answers,
        }
    }

    pub fn declined() -> Self {
        Self {
            kind: "answer",
            declined: true,
            answers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerPayload {
    pub question: String,
    pub header: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

/// Final answer payload that goes back to a plugin MCP server waiting for an
/// interaction card response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCardOutcome {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub declined: bool,
    pub result: Value,
}

impl PluginCardOutcome {
    pub fn answer(result: Value) -> Self {
        Self {
            kind: "card_answer",
            declined: false,
            result,
        }
    }

    pub fn declined() -> Self {
        Self {
            kind: "card_answer",
            declined: true,
            result: Value::Null,
        }
    }
}

/// Handle returned by [`spawn_ask_listener`]; carries the bound port + auth
/// token that must be injected as args to the `polaris-ask-mcp` companion.
/// Handle returned by [`spawn_ask_listener`]; carries the bound port + auth
/// token that must be injected as args to the `polaris-ask-mcp` companion.
#[derive(Debug, Clone)]
pub struct AskListenerHandle {
    pub port: u16,
    pub token: String,
}

/// 固定端口池（MCP Bridge 自愈的第一道防线）。
///
/// 语义：端口稳定优先于完全随机——ask_listener 重启时尽可能沿用这些常用端口，
/// mcp.json 里固化的 `--polaris-port` 因而长期有效。并发多开冲突时才 +1 换下一个，
/// 全占用回落随机（此时自愈靠 `.meta/ask-listener.json` 兜底）。
pub const ASK_LISTENER_PORT_POOL: &[u16] = &[56496, 56497, 56498, 60097, 60098];
