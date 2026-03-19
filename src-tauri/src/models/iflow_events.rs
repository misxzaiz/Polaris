//! IFlow JSONL 事件模型
//!
//! IFlow CLI 将会话保存为 JSONL 格式文件
//! 文件位置: ~/.iflow/projects/[编码项目路径]/session-[id].jsonl

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// IFlow JSONL 事件（顶层结构）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowJsonlEvent {
    /// 消息唯一 ID
    pub uuid: String,
    /// 父消息 ID
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    /// 会话 ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// 时间戳
    pub timestamp: String,
    /// 事件类型: user, assistant, tool_result, error 等
    #[serde(rename = "type")]
    pub event_type: String,
    /// 是否为侧链
    #[serde(rename = "isSidechain")]
    pub is_sidechain: bool,
    /// 用户类型
    #[serde(rename = "userType")]
    pub user_type: String,
    /// 消息内容
    pub message: Option<IFlowMessage>,
    /// 当前工作目录
    pub cwd: Option<String>,
    /// Git 分支
    #[serde(rename = "gitBranch")]
    pub git_branch: Option<String>,
    /// 版本
    pub version: Option<String>,
    /// 工具调用结果
    #[serde(rename = "toolUseResult")]
    pub tool_use_result: Option<IFlowToolUseResult>,
}

/// IFlow 消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowMessage {
    /// 消息 ID（仅 assistant 类型）
    pub id: Option<String>,
    /// 消息类型
    #[serde(rename = "type")]
    pub message_type: Option<String>,
    /// 角色: user, assistant
    pub role: String,
    /// 内容数组
    pub content: serde_json::Value,
    /// 模型名称
    pub model: Option<String>,
    /// 停止原因
    #[serde(rename = "stop_reason")]
    pub stop_reason: Option<String>,
    /// Token 使用情况
    pub usage: Option<IFlowUsage>,
}

/// IFlow Token 使用情况
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowUsage {
    /// 输入 Token 数
    #[serde(rename = "input_tokens")]
    pub input_tokens: u32,
    /// 输出 Token 数
    #[serde(rename = "output_tokens")]
    pub output_tokens: u32,
}

/// IFlow 工具调用结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowToolUseResult {
    /// 工具名称
    #[serde(rename = "toolName")]
    pub tool_name: String,
    /// 状态
    pub status: String,
    /// 时间戳
    pub timestamp: u64,
}

impl IFlowJsonlEvent {
    /// 解析 JSONL 行
    pub fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        serde_json::from_str(line).ok()
    }

    /// 转换为统一的 StreamEvent（复用 Claude Code 的事件类型）
    /// 返回多个事件，因为一个 IFlow 事件可能包含多个 StreamEvent
    pub fn to_stream_events(&self) -> Vec<crate::models::events::StreamEvent> {
        let mut events = Vec::new();

        match self.event_type.as_str() {
            "user" => {
                // 用户消息可能包含工具结果
                if let Some(ref message) = self.message {
                    if let Some(tool_results) = self.extract_tool_results(message) {
                        events.extend(tool_results);
                    }
                }
            }
            "assistant" => {
                // assistant 消息可能包含文本和工具调用
                if let Some(ref message) = self.message {
                    // 只添加 assistant 消息（包含 tool_use 块），不额外添加 tool_start 事件
                    // 这样与 Claude Code 的行为一致，避免前端重复添加工具调用
                    if let Some(assistant_event) = self.to_assistant_event(message) {
                        events.push(assistant_event);
                    }
                    // 检查是否会话结束
                    if message.stop_reason.is_some() {
                        events.push(crate::models::events::StreamEvent::SessionEnd);
                    }
                }
            }
            _ => {
                eprintln!("[IFlow] 未知事件类型: {}", self.event_type);
            }
        }

        events
    }

    /// 转换为 assistant 事件
    fn to_assistant_event(&self, message: &IFlowMessage) -> Option<crate::models::events::StreamEvent> {
        // 解析 content - 可能是字符串或数组
        let content_blocks = match &message.content {
            serde_json::Value::String(s) => {
                vec![serde_json::json!({
                    "type": "text",
                    "text": s
                })]
            }
            serde_json::Value::Array(arr) => {
                let mut blocks = Vec::new();
                for item in arr {
                    if let Some(obj) = item.as_object() {
                        let block_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                        match block_type {
                            "text" => {
                                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                                    blocks.push(serde_json::json!({
                                        "type": "text",
                                        "text": text
                                    }));
                                }
                            }
                            "tool_use" => {
                                // 工具调用也作为内容的一部分
                                blocks.push(serde_json::json!({
                                    "type": "tool_use",
                                    "id": obj.get("id"),
                                    "name": obj.get("name"),
                                    "input": obj.get("input")
                                }));
                            }
                            _ => {}
                        }
                    }
                }
                blocks
            }
            _ => Vec::new(),
        };

        if content_blocks.is_empty() {
            return None;
        }

        Some(crate::models::events::StreamEvent::Assistant {
            message: serde_json::json!({
                "content": content_blocks,
                "model": message.model,
                "id": message.id,
                "stop_reason": message.stop_reason,
            }),
        })
    }

    /// 从用户消息中提取工具结果事件
    fn extract_tool_results(&self, message: &IFlowMessage) -> Option<Vec<crate::models::events::StreamEvent>> {
        let mut events = Vec::new();

        // content 可能是字符串或数组
        let content_array = match &message.content {
            serde_json::Value::Array(arr) => arr,
            serde_json::Value::String(_) => return None,
            _ => return None,
        };

        for item in content_array {
            if let Some(obj) = item.as_object() {
                if let Some(result_type) = obj.get("type").and_then(|v| v.as_str()) {
                    if result_type == "tool_result" {
                        let tool_use_id = obj.get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        // 尝试从 content 中提取实际输出
                        let output = self.extract_tool_output(obj);

                        events.push(crate::models::events::StreamEvent::ToolEnd {
                            tool_use_id: tool_use_id.to_string(),
                            tool_name: None,
                            output: Some(output),
                        });
                    }
                }
            }
        }

        if events.is_empty() {
            None
        } else {
            Some(events)
        }
    }

    /// 从 tool_result 对象中提取实际输出
    fn extract_tool_output(&self, obj: &serde_json::Map<String, serde_json::Value>) -> String {
        // 优先使用 resultDisplay
        if let Some(display) = obj.get("resultDisplay").and_then(|v| v.as_str()) {
            return display.to_string();
        }

        // 尝试从 content.functionResponse.response.output 提取
        if let Some(content) = obj.get("content") {
            if let Some(func_resp) = content.get("functionResponse") {
                if let Some(response) = func_resp.get("response") {
                    if let Some(output) = response.get("output").and_then(|v| v.as_str()) {
                        return output.to_string();
                    }
                    // 如果 output 不是字符串，尝试整个 response
                    if let Ok(response_str) = serde_json::to_string(response) {
                        return response_str;
                    }
                }
            }
        }

        // 默认返回空字符串
        String::new()
    }

    /// 是否为会话结束事件
    pub fn is_session_end(&self) -> bool {
        // IFlow 没有明确的 session_end 事件
        // 我们通过检查是否有 stop_reason 来判断
        if let Some(ref message) = self.message {
            if let Some(ref stop_reason) = message.stop_reason {
                return stop_reason == "STOP" || stop_reason == "max_tokens" || stop_reason == "end_turn";
            }
        }
        false
    }

    /// 提取消息的文本内容
    pub fn extract_text_content(&self) -> String {
        if let Some(ref message) = self.message {
            return Self::extract_text_from_value(&message.content);
        }
        String::new()
    }

    /// 从 JSON Value 中提取文本内容
    fn extract_text_from_value(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(arr) => {
                let mut texts = Vec::new();
                for item in arr {
                    if let Some(obj) = item.as_object() {
                        if let Some(block_type) = obj.get("type").and_then(|v| v.as_str()) {
                            if block_type == "text" {
                                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                                    texts.push(text.to_string());
                                }
                            }
                        }
                    }
                }
                texts.join("\n")
            }
            _ => String::new(),
        }
    }
}

// ============================================================================
// 会话历史相关数据结构
// ============================================================================

/// IFlow 会话元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IFlowSessionMeta {
    /// 会话 ID
    pub session_id: String,
    /// 会话标题（从第一条用户消息提取）
    pub title: String,
    /// 消息数量
    pub message_count: u32,
    /// 文件大小（字节）
    pub file_size: u64,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
    /// 输入 Token 总数
    pub input_tokens: u32,
    /// 输出 Token 总数
    pub output_tokens: u32,
}

/// IFlow 简化消息（用于历史展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IFlowHistoryMessage {
    /// 消息 UUID
    pub uuid: String,
    /// 父消息 UUID
    pub parent_uuid: Option<String>,
    /// 时间戳
    pub timestamp: String,
    /// 消息类型: user, assistant
    pub r#type: String,
    /// 文本内容
    pub content: String,
    /// 模型名称（仅 assistant）
    pub model: Option<String>,
    /// 停止原因（仅 assistant）
    pub stop_reason: Option<String>,
    /// 输入 Token 数
    pub input_tokens: Option<u32>,
    /// 输出 Token 数
    pub output_tokens: Option<u32>,
    /// 工具调用列表（仅 assistant）
    pub tool_calls: Vec<IFlowToolCall>,
}

/// IFlow 工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowToolCall {
    /// 工具调用 ID
    pub id: String,
    /// 工具名称
    pub name: String,
    /// 工具输入参数
    pub input: serde_json::Value,
}

/// IFlow 文件上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IFlowFileContext {
    /// 文件路径
    pub path: String,
    /// 文件类型
    pub file_type: String,  // "file", "directory", "image"
    /// 访问次数
    pub access_count: u32,
    /// 首次访问时间
    pub first_accessed: String,
    /// 最后访问时间
    pub last_accessed: String,
}

/// IFlow Token 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IFlowTokenStats {
    /// 输入 Token 总数
    pub total_input_tokens: u32,
    /// 输出 Token 总数
    pub total_output_tokens: u32,
    /// 总 Token 数
    pub total_tokens: u32,
    /// 消息数量
    pub message_count: u32,
    /// 用户消息数量
    pub user_message_count: u32,
    /// 助手消息数量
    pub assistant_message_count: u32,
}

/// IFlow 项目配置（从 projects.json 读取）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowProjectConfig {
    /// 项目名称
    pub name: String,
    /// 项目路径（编码后）
    pub path: String,
    /// 会话 ID 列表
    pub sessions: Vec<String>,
    /// 创建时间
    pub created_at: Option<String>,
    /// 最后活动时间
    pub last_activity: Option<String>,
}

/// IFlow projects.json 根结构（预留功能）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IFlowProjectsConfig {
    #[serde(flatten)]
    pub projects: HashMap<String, IFlowProjectConfig>,
}
