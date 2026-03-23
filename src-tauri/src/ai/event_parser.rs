/*! 事件解析器 - 将 CLI 原始输出转换为统一的 AIEvent
 *
 * 所有引擎的原始输出都在后端转换为标准 AIEvent 后发送给前端。
 * 前端无需再做任何解析工作，直接消费 AIEvent 即可。
 */

use crate::models::events::StreamEvent;
use crate::models::{
    AIEvent, AssistantMessageEvent, ErrorEvent, ProgressEvent,
    SessionEndEvent, SessionEndReason, ThinkingEvent,
    ToolCallEndEvent, ToolCallInfo, ToolCallStartEvent, ToolCallStatus, UserMessageEvent,
    PermissionDenial, PermissionRequestEvent,
};
use std::collections::HashMap;

/// 工具调用状态管理器
///
/// 跟踪工具调用的完整生命周期：pending -> running -> completed/failed
#[derive(Default)]
pub struct ToolCallManager {
    tool_calls: HashMap<String, ToolCallInfo>,
}

impl ToolCallManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开始一个新的工具调用
    pub fn start_tool_call(
        &mut self,
        tool_name: String,
        tool_id: String,
        args: HashMap<String, serde_json::Value>,
    ) -> ToolCallInfo {
        let tool_call = ToolCallInfo {
            id: tool_id.clone(),
            name: tool_name,
            args,
            status: ToolCallStatus::Running,
            result: None,
        };
        self.tool_calls.insert(tool_id, tool_call.clone());
        tool_call
    }

    /// 结束工具调用
    pub fn end_tool_call(
        &mut self,
        tool_id: &str,
        result: Option<serde_json::Value>,
        success: bool,
    ) -> Option<ToolCallInfo> {
        if let Some(tool_call) = self.tool_calls.get_mut(tool_id) {
            tool_call.status = if success {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Failed
            };
            tool_call.result = result;
            return Some(tool_call.clone());
        }
        None
    }

    /// 根据工具名称查找正在运行的工具调用
    pub fn find_running_by_name(&self, tool_name: &str) -> Option<&ToolCallInfo> {
        self.tool_calls
            .values()
            .find(|tc| tc.name == tool_name && tc.status == ToolCallStatus::Running)
    }

    /// 获取所有工具调用（预留功能）
    #[allow(dead_code)]
    pub fn get_tool_calls(&self) -> Vec<ToolCallInfo> {
        self.tool_calls.values().cloned().collect()
    }

    /// 清空所有工具调用
    pub fn clear(&mut self) {
        self.tool_calls.clear();
    }
}

/// 事件解析器
///
/// 将 CLI 原始事件转换为统一的 AIEvent。
pub struct EventParser {
    session_id: String,
    tool_call_manager: ToolCallManager,
}

impl EventParser {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            tool_call_manager: ToolCallManager::new(),
        }
    }

    /// 设置会话 ID
    pub fn set_session_id(&mut self, session_id: impl Into<String>) {
        self.session_id = session_id.into();
    }

    /// 解析原始事件为 AIEvent 数组
    ///
    /// 一个原始事件可能产生多个 AIEvent（如 assistant 消息包含工具调用）
    pub fn parse(&mut self, event: StreamEvent) -> Vec<AIEvent> {
        match event {
            StreamEvent::System { subtype, extra } => {
                self.parse_system_event(subtype, extra)
            }
            StreamEvent::Assistant { message } => {
                self.parse_assistant_event(message)
            }
            StreamEvent::User { message } => {
                self.parse_user_event(message)
            }
            StreamEvent::TextDelta { text } => {
                vec![AIEvent::AssistantMessage(AssistantMessageEvent::new(text, true))]
            }
            StreamEvent::ToolStart { tool_use_id, tool_name, input } => {
                self.parse_tool_start(tool_use_id, tool_name, input)
            }
            StreamEvent::Thinking { thinking, .. } => {
                // 思考过程发送独立的 Thinking 事件
                vec![AIEvent::Thinking(ThinkingEvent::new(thinking))]
            }
            StreamEvent::ToolEnd { tool_use_id, tool_name, output } => {
                self.parse_tool_end(tool_use_id, tool_name, output)
            }
            StreamEvent::PermissionRequest { session_id, denials } => {
                // 将 StreamEvent 的 PermissionDenial 转换为 AIEvent 的 PermissionDenial
                let permission_denials: Vec<PermissionDenial> = denials
                    .into_iter()
                    .map(|d| {
                        PermissionDenial::new(d.tool_name, d.reason)
                            .with_extra(d.extra)
                    })
                    .collect();

                vec![AIEvent::PermissionRequest(
                    PermissionRequestEvent::new(session_id, permission_denials)
                )]
            }
            StreamEvent::Result { subtype, extra } => {
                self.parse_result_event(subtype, extra)
            }
            StreamEvent::Error { error } => {
                vec![AIEvent::Error(ErrorEvent::new(error))]
            }
            StreamEvent::SessionEnd => {
                vec![AIEvent::SessionEnd(
                    SessionEndEvent::new(&self.session_id)
                        .with_reason(SessionEndReason::Completed)
                )]
            }
        }
    }

    /// 解析系统事件
    fn parse_system_event(
        &self,
        subtype: Option<String>,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let message = if let Some(ref subtype) = subtype {
            // 使用表情替代文字，更简洁直观
            let message_map = HashMap::from([
                ("init", "💬"),        // 初始化会话
                ("reading", "📖"),     // 读取文件
                ("writing", "✏️"),     // 写入文件
                ("thinking", "🤔"),    // 思考中
                ("searching", "🔍"),   // 搜索中
            ]);

            if let Some(&msg) = message_map.get(subtype.as_str()) {
                msg.to_string()
            } else if let Some(msg) = extra.get("message").and_then(|v| v.as_str()) {
                msg.to_string()
            } else {
                subtype.clone()
            }
        } else {
            return vec![];
        };

        vec![AIEvent::Progress(ProgressEvent::new(message))]
    }

    /// 解析助手消息事件
    fn parse_assistant_event(&mut self, message: serde_json::Value) -> Vec<AIEvent> {
        let mut results = Vec::new();

        // 提取文本内容
        let text = self.extract_text_content(&message);

        // 提取思考过程
        let thinking_blocks = self.extract_thinking_blocks(&message);

        // 提取工具调用
        let tool_calls = self.extract_tool_calls(&message);

        // 先发送思考事件（如果有）
        for thinking in &thinking_blocks {
            results.push(AIEvent::Thinking(ThinkingEvent::new(thinking.clone())));
        }

        // 发出 AI 消息事件
        if !text.is_empty() || !tool_calls.is_empty() {
            results.push(AIEvent::AssistantMessage(
                AssistantMessageEvent::new(text, false)
                    .with_tool_calls(tool_calls.clone())
            ));
        }

        // 发出工具调用开始事件
        for tc in &tool_calls {
            results.push(AIEvent::ToolCallStart(
                ToolCallStartEvent::new(tc.name.clone(), tc.args.clone())
                    .with_call_id(tc.id.clone())
            ));
        }

        results
    }

    /// 从消息中提取思考过程块
    fn extract_thinking_blocks(&self, message: &serde_json::Value) -> Vec<String> {
        let mut thinking_blocks = Vec::new();

        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if let Some(obj) = item.as_object() {
                    if obj.get("type").and_then(|t| t.as_str()) == Some("thinking") {
                        if let Some(thinking) = obj.get("thinking").and_then(|t| t.as_str()) {
                            if !thinking.trim().is_empty() {
                                thinking_blocks.push(thinking.to_string());
                            }
                        }
                    }
                }
            }
        }

        thinking_blocks
    }

    /// 解析用户消息事件
    ///
    /// 用户消息可能包含：
    /// 1. 文本内容
    /// 2. tool_result 块（工具执行结果）
    fn parse_user_event(&mut self, message: serde_json::Value) -> Vec<AIEvent> {
        let mut results = Vec::new();

        // 1. 提取 tool_result 块，生成 ToolCallEnd 事件
        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if let Some(obj) = item.as_object() {
                    if obj.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let tool_use_id = obj.get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        // 提取输出内容
                        let output = self.extract_tool_result_content(obj);
                        let success = !output.is_empty();

                        // 更新工具调用状态
                        if let Some(tc) = self.tool_call_manager.end_tool_call(
                            &tool_use_id,
                            Some(serde_json::Value::String(output.clone())),
                            success
                        ) {
                            // 找到了对应的工具调用
                            let status_emoji = if success { "✅" } else { "❌" };
                            results.push(AIEvent::Progress(ProgressEvent::new(
                                format!("{} {}", status_emoji, tc.name)
                            )));
                            results.push(AIEvent::ToolCallEnd(
                                ToolCallEndEvent::new(tc.name, success)
                                    .with_call_id(tool_use_id)
                                    .with_result(serde_json::Value::String(output))
                            ));
                        } else {
                            // 找不到对应的工具调用（可能是 assistant 消息中的 tool_use 未被正确记录）
                            // 仍然发送事件，但工具名称为空
                            tracing::warn!(
                                "[EventParser] tool_result 找不到对应的 tool_use: {}",
                                tool_use_id
                            );
                            let _status_emoji = if success { "✅" } else { "❌" };
                            results.push(AIEvent::ToolCallEnd(
                                ToolCallEndEvent::new("unknown".to_string(), success)
                                    .with_call_id(tool_use_id)
                                    .with_result(serde_json::Value::String(output))
                            ));
                        }
                    }
                }
            }
        }

        // 2. 提取文本内容
        let text = self.extract_text_content(&message);
        if !text.is_empty() {
            results.push(AIEvent::UserMessage(UserMessageEvent::new(text)));
        }

        results
    }

    /// 从 tool_result 对象中提取输出内容
    fn extract_tool_result_content(&self, obj: &serde_json::Map<String, serde_json::Value>) -> String {
        // 1. 尝试直接从 content 字段提取
        if let Some(content) = obj.get("content") {
            if let Some(s) = content.as_str() {
                return s.to_string();
            }
            // content 可能是数组
            if let Some(arr) = content.as_array() {
                let texts: Vec<&str> = arr.iter()
                    .filter_map(|item| {
                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                            item.get("text").and_then(|t| t.as_str())
                        } else {
                            None
                        }
                    })
                    .collect();
                if !texts.is_empty() {
                    return texts.join("\n");
                }
            }
        }

        // 2. 尝试从 result 字段提取
        if let Some(result) = obj.get("result").and_then(|v| v.as_str()) {
            return result.to_string();
        }

        String::new()
    }

    /// 解析工具开始事件
    fn parse_tool_start(
        &mut self,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
    ) -> Vec<AIEvent> {
        let args = if let Some(obj) = input.as_object() {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        } else {
            HashMap::new()
        };

        self.tool_call_manager.start_tool_call(
            tool_name.clone(),
            tool_use_id.clone(),
            args.clone(),
        );

        vec![
            AIEvent::Progress(ProgressEvent::new(format!("🔧 {}", tool_name))),
            AIEvent::ToolCallStart(
                ToolCallStartEvent::new(tool_name, args)
                    .with_call_id(tool_use_id)
            ),
        ]
    }

    /// 解析工具结束事件
    fn parse_tool_end(
        &mut self,
        tool_use_id: String,
        tool_name: Option<String>,
        output: Option<String>,
    ) -> Vec<AIEvent> {
        let success = output.is_some();
        let result = output.map(serde_json::Value::String);

        // 更新工具调用状态
        if let Some(tc) = self.tool_call_manager.end_tool_call(&tool_use_id, result.clone(), success) {
            let status_emoji = if success { "✅" } else { "❌" };
            return vec![
                AIEvent::Progress(ProgressEvent::new(format!("{} {}", status_emoji, tc.name))),
                AIEvent::ToolCallEnd(
                    ToolCallEndEvent::new(tc.name, success)
                        .with_call_id(tool_use_id)
                        .with_result(result.unwrap_or(serde_json::Value::Null))
                ),
            ];
        }

        // 如果找不到 tool_use_id，尝试通过工具名称查找
        if let Some(name) = &tool_name {
            if let Some(tc) = self.tool_call_manager.find_running_by_name(name) {
                let tc_id = tc.id.clone();
                self.tool_call_manager.end_tool_call(&tc_id, result.clone(), success);
                let status_emoji = if success { "✅" } else { "❌" };
                return vec![
                    AIEvent::Progress(ProgressEvent::new(format!("{} {}", status_emoji, name))),
                    AIEvent::ToolCallEnd(
                        ToolCallEndEvent::new(name.clone(), success)
                            .with_call_id(tc_id)
                            .with_result(result.unwrap_or(serde_json::Value::Null))
                    ),
                ];
            }
        }

        // 找不到工具调用信息，仍然发送事件
        if let Some(name) = tool_name {
            let status_emoji = if success { "✅" } else { "❌" };
            vec![
                AIEvent::Progress(ProgressEvent::new(format!("{} {}", status_emoji, name))),
                AIEvent::ToolCallEnd(ToolCallEndEvent::new(name, success)),
            ]
        } else {
            vec![]
        }
    }

    /// 解析结果事件
    fn parse_result_event(
        &self,
        subtype: String,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        // success 类型不发送 Progress 事件，避免显示 "任务完成"
        match subtype.as_str() {
            "success" => {
                // 任务成功完成，只发送 Result 事件（如果有输出）
                if let Some(output) = extra.get("output") {
                    vec![AIEvent::Result(crate::models::ResultEvent::new(output.clone()))]
                } else {
                    vec![]
                }
            }
            "canceled" => {
                // 任务取消，发送提示
                vec![AIEvent::Progress(ProgressEvent::new("⚠️ 任务已取消"))]
            }
            _ => {
                // 其他类型
                if let Some(output) = extra.get("output") {
                    vec![
                        AIEvent::Progress(ProgressEvent::new(&subtype)),
                        AIEvent::Result(crate::models::ResultEvent::new(output.clone())),
                    ]
                } else {
                    vec![AIEvent::Progress(ProgressEvent::new(&subtype))]
                }
            }
        }
    }

    /// 从消息中提取文本内容
    fn extract_text_content(&self, message: &serde_json::Value) -> String {
        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            content
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        } else if let Some(text) = message.as_str() {
            text.to_string()
        } else {
            String::new()
        }
    }

    /// 从消息中提取工具调用
    fn extract_tool_calls(&mut self, message: &serde_json::Value) -> Vec<ToolCallInfo> {
        let mut tool_calls = Vec::new();

        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    let id = item
                        .get("id")
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "unknown".to_string());

                    let args: HashMap<String, serde_json::Value> = item
                        .get("input")
                        .and_then(|i| i.as_object())
                        .map(|obj| {
                            obj.iter()
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect()
                        })
                        .unwrap_or_default();

                    self.tool_call_manager.start_tool_call(name.clone(), id.clone(), args.clone());

                    tool_calls.push(ToolCallInfo {
                        id,
                        name,
                        args,
                        status: ToolCallStatus::Running,
                        result: None,
                    });
                }
            }
        }

        tool_calls
    }

    /// 重置解析器状态
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.tool_call_manager.clear();
    }
}
