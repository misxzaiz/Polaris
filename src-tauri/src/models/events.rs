use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 权限拒绝详情
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDenial {
    pub tool_name: String,
    pub reason: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// 流事件类型 - 对应 Claude CLI stream-json 输出
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    /// 系统事件
    #[serde(rename = "system")]
    System {
        subtype: Option<String>,
        #[serde(flatten)]
        extra: HashMap<String, serde_json::Value>,
    },

    /// 助手消息
    #[serde(rename = "assistant")]
    Assistant {
        message: serde_json::Value,
    },

    /// 用户消息（包含工具结果）
    #[serde(rename = "user")]
    User {
        message: serde_json::Value,
    },

    /// 文本内容
    #[serde(rename = "text_delta")]
    TextDelta { text: String },

    /// 工具调用开始
    #[serde(rename = "tool_start")]
    ToolStart {
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        input: serde_json::Value,
    },

    /// 思考过程（Codex reasoning）
    #[serde(rename = "thinking")]
    Thinking {
        id: String,
        thinking: String,
    },

    /// 工具调用结束
    #[serde(rename = "tool_end")]
    ToolEnd {
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "toolName")]
        tool_name: Option<String>,
        output: Option<String>,
    },

    /// 权限请求（工具调用被拒绝）
    #[serde(rename = "permission_request")]
    PermissionRequest {
        session_id: String,
        denials: Vec<PermissionDenial>,
    },

    /// 结果
    #[serde(rename = "result")]
    Result {
        subtype: String,
        #[serde(flatten)]
        extra: HashMap<String, serde_json::Value>,
    },

    /// 错误
    #[serde(rename = "error")]
    Error { error: String },

    /// 会话结束
    #[serde(rename = "session_end")]
    SessionEnd,

    /// 流式增量事件（--include-partial-messages）
    ///
    /// 包裹 Anthropic Messages API 的原始 SSE 事件
    /// （message_start / content_block_start / content_block_delta / content_block_stop / ...）。
    /// `event` 为原始 SSE 事件对象，由 `EventParser::parse_stream_event_chunk` 进一步解析为增量 AIEvent。
    #[serde(rename = "stream_event")]
    StreamEventChunk { event: serde_json::Value },

    /// 提示建议（--prompt-suggestions）
    ///
    /// CLI 每轮结束后发送，预测下一条用户输入。真实字段名未在本环境验证，
    /// 由 `event_parser::parse_prompt_suggestion` 从 flatten 的 extra 中
    /// 按多个候选字段名（suggestion/text/prompt/content/value）防御性提取。
    #[serde(rename = "prompt_suggestion")]
    PromptSuggestion {
        #[serde(flatten)]
        extra: HashMap<String, serde_json::Value>,
    },
}

impl StreamEvent {
    /// 解析 Claude CLI 的 stream-json 行
    pub fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }

        // 直接使用 serde 解析
        serde_json::from_str(line).ok()
    }
}
