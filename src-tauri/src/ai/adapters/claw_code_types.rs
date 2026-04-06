/*! claw-code 类型适配层
 *
 * 从 claw-code 项目提取的类型定义，用于与 Polaris AI 模块对接。
 *
 * 来源：claw-code/rust/crates/api/src/types.rs
 *
 * 设计决策：
 * - 仅保留纯数据类型，不引入 runtime 依赖
 * - 去除 Usage 的 cost 计算功能（依赖 runtime::pricing_for_model）
 * - 保留与 Anthropic API 兼容的序列化格式
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 消息请求（发送给 API 的完整请求）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageRequest {
    /// 模型名称
    pub model: String,
    /// 最大输出 token 数
    pub max_tokens: u32,
    /// 消息列表
    pub messages: Vec<InputMessage>,
    /// 系统提示词
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// 工具定义列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    /// 工具选择策略
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
    /// 是否启用流式输出
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stream: bool,
}

impl MessageRequest {
    /// 启用流式输出
    #[must_use]
    pub fn with_streaming(mut self) -> Self {
        self.stream = true;
        self
    }
}

/// 输入消息
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputMessage {
    /// 角色：user / assistant
    pub role: String,
    /// 内容块列表
    pub content: Vec<InputContentBlock>,
}

impl InputMessage {
    /// 创建用户文本消息
    #[must_use]
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: vec![InputContentBlock::Text { text: text.into() }],
        }
    }

    /// 创建助手消息（包含内容块）
    #[must_use]
    pub fn assistant_with_blocks(blocks: Vec<InputContentBlock>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: blocks,
        }
    }

    /// 创建助手文本消息
    #[must_use]
    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: vec![InputContentBlock::Text { text: text.into() }],
        }
    }

    /// 创建工具调用消息（助手发起）
    #[must_use]
    pub fn assistant_tool_use(
        tool_id: impl Into<String>,
        tool_name: impl Into<String>,
        input: Value,
    ) -> Self {
        Self {
            role: "assistant".to_string(),
            content: vec![InputContentBlock::ToolUse {
                id: tool_id.into(),
                name: tool_name.into(),
                input,
            }],
        }
    }

    /// 创建工具结果消息
    #[must_use]
    pub fn user_tool_result(
        tool_use_id: impl Into<String>,
        content: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: "user".to_string(),
            content: vec![InputContentBlock::ToolResult {
                tool_use_id: tool_use_id.into(),
                content: vec![ToolResultContentBlock::Text {
                    text: content.into(),
                }],
                is_error,
            }],
        }
    }

    /// 创建工具结果消息（简化版本）
    #[must_use]
    pub fn tool_result(tool_use_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self::user_tool_result(tool_use_id, content, false)
    }
}

/// 输入内容块
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputContentBlock {
    /// 文本内容
    Text {
        text: String,
    },
    /// 工具调用（助手发起）
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// 工具结果（用户返回）
    ToolResult {
        tool_use_id: String,
        content: Vec<ToolResultContentBlock>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
}

/// 工具结果内容块
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolResultContentBlock {
    /// 文本结果
    Text { text: String },
    /// JSON 结果
    Json { value: Value },
}

/// 工具定义
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// 工具名称
    pub name: String,
    /// 工具描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 输入参数 JSON Schema
    pub input_schema: Value,
}

/// 工具选择策略
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolChoice {
    /// 自动选择（模型决定）
    Auto,
    /// 必须调用工具
    Any,
    /// 指定工具
    Tool { name: String },
}

/// 消息响应（API 返回的完整响应）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageResponse {
    /// 消息 ID
    pub id: String,
    /// 类型（通常为 "message"）
    #[serde(rename = "type")]
    pub kind: String,
    /// 角色（通常为 "assistant"）
    pub role: String,
    /// 内容块列表
    pub content: Vec<OutputContentBlock>,
    /// 使用的模型
    pub model: String,
    /// 停止原因
    #[serde(default)]
    pub stop_reason: Option<String>,
    /// 停止序列
    #[serde(default)]
    pub stop_sequence: Option<String>,
    /// Token 使用量
    pub usage: Usage,
    /// 请求 ID
    #[serde(default)]
    pub request_id: Option<String>,
}

impl MessageResponse {
    /// 计算总 token 数
    #[must_use]
    pub fn total_tokens(&self) -> u32 {
        self.usage.total_tokens()
    }
}

/// 输出内容块
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputContentBlock {
    /// 文本内容
    Text {
        text: String,
    },
    /// 工具调用
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// 思考过程（扩展思维）
    Thinking {
        #[serde(default)]
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// 已脱敏的思考内容
    RedactedThinking {
        data: Value,
    },
}

/// Token 使用量
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// 输入 token 数
    pub input_tokens: u32,
    /// 缓存创建 token 数
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    /// 缓存读取 token 数
    #[serde(default)]
    pub cache_read_input_tokens: u32,
    /// 输出 token 数
    pub output_tokens: u32,
}

impl Usage {
    /// 计算总 token 数
    #[must_use]
    pub const fn total_tokens(&self) -> u32 {
        self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
    }
}

/// 消息开始事件（流式）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageStartEvent {
    pub message: MessageResponse,
}

/// 消息增量事件（流式）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageDeltaEvent {
    pub delta: MessageDelta,
    pub usage: Usage,
}

/// 消息增量
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageDelta {
    /// 停止原因
    #[serde(default)]
    pub stop_reason: Option<String>,
    /// 停止序列
    #[serde(default)]
    pub stop_sequence: Option<String>,
}

/// 内容块开始事件（流式）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentBlockStartEvent {
    /// 内容块索引
    pub index: u32,
    /// 内容块
    pub content_block: OutputContentBlock,
}

/// 内容块增量事件（流式）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentBlockDeltaEvent {
    /// 内容块索引
    pub index: u32,
    /// 增量内容
    pub delta: ContentBlockDelta,
}

/// 内容块增量
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlockDelta {
    /// 文本增量
    TextDelta { text: String },
    /// JSON 输入增量
    InputJsonDelta { partial_json: String },
    /// 思考增量
    ThinkingDelta { thinking: String },
    /// 签名增量
    SignatureDelta { signature: String },
}

/// 内容块结束事件（流式）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentBlockStopEvent {
    /// 内容块索引
    pub index: u32,
}

/// 消息结束事件（流式）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageStopEvent {}

/// 流事件（流式响应的顶层事件）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// 消息开始
    MessageStart(MessageStartEvent),
    /// 消息增量
    MessageDelta(MessageDeltaEvent),
    /// 内容块开始
    ContentBlockStart(ContentBlockStartEvent),
    /// 内容块增量
    ContentBlockDelta(ContentBlockDeltaEvent),
    /// 内容块结束
    ContentBlockStop(ContentBlockStopEvent),
    /// 消息结束
    MessageStop(MessageStopEvent),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_usage_total_tokens() {
        let usage = Usage {
            input_tokens: 10,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
        };

        assert_eq!(usage.total_tokens(), 19);
    }

    #[test]
    fn test_input_message_user_text() {
        let msg = InputMessage::user_text("Hello");
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            InputContentBlock::Text { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Text block"),
        }
    }

    #[test]
    fn test_tool_choice_serialization() {
        let choice = ToolChoice::Auto;
        let json = serde_json::to_string(&choice).unwrap();
        assert_eq!(json, r#"{"type":"auto"}"#);

        let choice = ToolChoice::Tool {
            name: "bash".to_string(),
        };
        let json = serde_json::to_string(&choice).unwrap();
        assert_eq!(json, r#"{"type":"tool","name":"bash"}"#);
    }

    #[test]
    fn test_stream_event_deserialization() {
        let json = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        match event {
            StreamEvent::ContentBlockDelta(e) => {
                assert_eq!(e.index, 0);
                match e.delta {
                    ContentBlockDelta::TextDelta { text } => assert_eq!(text, "Hello"),
                    _ => panic!("Expected TextDelta"),
                }
            }
            _ => panic!("Expected ContentBlockDelta"),
        }
    }
}
