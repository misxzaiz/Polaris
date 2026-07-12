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
    CliInitEvent, McpServerStatus, HookEvent, PromptSuggestionEvent,
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
    // ===== partial messages 增量流式状态（--include-partial-messages）=====
    /// content_block index → 类型（"thinking" / "text" / "tool_use"）
    stream_block_types: HashMap<u64, String>,
    /// 累积 thinking_delta，在 content_block_stop 时整段发出（避免前端碎片化）
    thinking_buffer: String,
    /// 本 turn 是否已通过 stream_event 流式过文本（用于完整快照去重，防止翻倍）
    streamed_text_this_turn: bool,
    /// 本 turn 是否已通过 stream_event 流式过 thinking
    streamed_thinking_this_turn: bool,
}

impl EventParser {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            tool_call_manager: ToolCallManager::new(),
            stream_block_types: HashMap::new(),
            thinking_buffer: String::new(),
            streamed_text_this_turn: false,
            streamed_thinking_this_turn: false,
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
                vec![AIEvent::AssistantMessage(AssistantMessageEvent::new(&self.session_id, text, true))]
            }
            StreamEvent::ToolStart { tool_use_id, tool_name, input } => {
                self.parse_tool_start(tool_use_id, tool_name, input)
            }
            StreamEvent::Thinking { thinking, .. } => {
                // 思考过程发送独立的 Thinking 事件
                vec![AIEvent::Thinking(ThinkingEvent::new(&self.session_id, thinking))]
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
                vec![AIEvent::Error(ErrorEvent::new(&self.session_id, error))]
            }
            StreamEvent::SessionEnd => {
                vec![AIEvent::SessionEnd(
                    SessionEndEvent::new(&self.session_id)
                        .with_reason(SessionEndReason::Completed)
                )]
            }
            StreamEvent::StreamEventChunk { event } => {
                self.parse_stream_event_chunk(event)
            }
            StreamEvent::PromptSuggestion { extra } => {
                self.parse_prompt_suggestion(extra)
            }
        }
    }

    /// 解析系统事件
    fn parse_system_event(
        &self,
        subtype: Option<String>,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let subtype = match subtype {
            Some(s) => s,
            None => return vec![],
        };

        // 特殊处理 init 事件
        if subtype == "init" {
            return self.parse_init_event(extra);
        }

        // Hook 生命周期事件（--include-hook-events）
        if subtype == "hook_started" || subtype == "hook_response" {
            return self.parse_hook_event(&subtype, extra);
        }

        // 已知的有意义子类型映射
        let message_map = HashMap::from([
            ("reading", "📖"),     // 读取文件
            ("writing", "✏️"),     // 写入文件
            ("thinking", "🤔"),    // 思考中
            ("searching", "🔍"),   // 搜索中
        ]);

        let message = if let Some(&msg) = message_map.get(subtype.as_str()) {
            msg.to_string()
        } else if let Some(msg) = extra.get("message").and_then(|v| v.as_str()) {
            msg.to_string()
        } else {
            // 未识别的子类型（如 hook_started, hook_response 等）
            // 不发出 Progress 事件，静默忽略
            return vec![];
        };

        vec![AIEvent::Progress(ProgressEvent::new(&self.session_id, message))]
    }

    /// 解析 init 事件 - 提取 CLI 动态数据
    fn parse_init_event(
        &self,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let mut init_event = CliInitEvent::new(&self.session_id);

        // 提取 tools
        if let Some(tools) = extra.get("tools").and_then(|v| v.as_array()) {
            let tools: Vec<String> = tools
                .iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect();
            init_event = init_event.with_tools(tools);
        }

        // 提取 mcp_servers
        if let Some(mcp_servers) = extra.get("mcp_servers").and_then(|v| v.as_array()) {
            let servers: Vec<McpServerStatus> = mcp_servers
                .iter()
                .filter_map(|s| {
                    let name = s.get("name")?.as_str()?.to_string();
                    let status = s.get("status")?.as_str()?.to_string();
                    Some(McpServerStatus { name, status })
                })
                .collect();
            init_event = init_event.with_mcp_servers(servers);
        }

        // 提取 agents
        if let Some(agents) = extra.get("agents").and_then(|v| v.as_array()) {
            let agents: Vec<String> = agents
                .iter()
                .filter_map(|a| a.as_str().map(String::from))
                .collect();
            init_event = init_event.with_agents(agents);
        }

        // 提取 skills
        if let Some(skills) = extra.get("skills").and_then(|v| v.as_array()) {
            let skills: Vec<String> = skills
                .iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect();
            init_event = init_event.with_skills(skills);
        }

        // 提取 model
        if let Some(model) = extra.get("model").and_then(|v| v.as_str()) {
            init_event = init_event.with_model(model.to_string());
        }

        // 提取 version
        if let Some(version) = extra.get("claude_code_version").and_then(|v| v.as_str()) {
            init_event = init_event.with_version(version.to_string());
        }

        tracing::info!(
            "[EventParser] init 事件解析完成: agents={}, tools={}, mcp_servers={}",
            init_event.agents.len(),
            init_event.tools.len(),
            init_event.mcp_servers.len()
        );

        vec![AIEvent::CliInit(init_event)]
    }

    /// 解析 hook 生命周期事件（system/hook_started、system/hook_response）
    ///
    /// 字段缺失时兜底为空字符串/None，保证不同 CLI 版本下的健壮性。
    fn parse_hook_event(
        &self,
        subtype: &str,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let hook_name = extra
            .get("hook_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let hook_event = extra
            .get("hook_event")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let ev = if subtype == "hook_started" {
            HookEvent::started(&self.session_id, hook_name, hook_event)
        } else {
            let outcome = extra
                .get("outcome")
                .and_then(|v| v.as_str())
                .map(String::from);
            let exit_code = extra.get("exit_code").and_then(|v| v.as_i64());
            HookEvent::completed(&self.session_id, hook_name, hook_event, outcome, exit_code)
        };

        vec![AIEvent::Hook(ev)]
    }

    /// 解析提示建议事件（--prompt-suggestions）
    ///
    /// 真实字段名未在本环境验证，按多个候选键防御性提取建议文本；
    /// 全部缺失或为空时返回空，不发出事件。
    fn parse_prompt_suggestion(
        &self,
        extra: HashMap<String, serde_json::Value>,
    ) -> Vec<AIEvent> {
        let suggestion = ["suggestion", "text", "prompt", "content", "value", "message"]
            .iter()
            .find_map(|key| extra.get(*key).and_then(|v| v.as_str()))
            .map(|s| s.to_string());

        match suggestion {
            Some(s) if !s.trim().is_empty() => {
                vec![AIEvent::PromptSuggestion(PromptSuggestionEvent::new(
                    &self.session_id,
                    s,
                ))]
            }
            _ => vec![],
        }
    }

    /// 解析 partial messages 增量事件（stream_event，--include-partial-messages）
    ///
    /// 包裹的是 Anthropic Messages API 原始 SSE 事件。此处只消费文本与思考增量：
    /// - content_block_delta / text_delta     → 增量 AssistantMessage(isDelta=true)，前端追加累积
    /// - content_block_delta / thinking_delta → 累积到 thinking_buffer，在 content_block_stop 时整段发出
    ///   （保证 thinking 块顺序正确，且不被前端 appendThinkingBlock 碎片化）
    /// - input_json_delta 等                  → 忽略，工具调用统一由完整 assistant 消息的 tool_use 处理
    ///
    /// 同时维护 turn 状态，供 parse_assistant_event 去重（避免增量 + 完整快照导致文本翻倍）。
    fn parse_stream_event_chunk(&mut self, event: serde_json::Value) -> Vec<AIEvent> {
        let event_type = match event.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => return vec![],
        };

        match event_type {
            // 新一轮 assistant 输出开始：重置 turn 状态
            "message_start" => {
                self.reset_stream_turn_state();
                vec![]
            }

            // 记录 content block 类型，供 content_block_stop / 去重判断
            "content_block_start" => {
                if let Some(index) = event.get("index").and_then(|v| v.as_u64()) {
                    let block_type = event
                        .get("content_block")
                        .and_then(|cb| cb.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.stream_block_types.insert(index, block_type);
                }
                vec![]
            }

            // 文本 / 思考增量
            "content_block_delta" => {
                let delta = match event.get("delta") {
                    Some(d) => d,
                    None => return vec![],
                };
                match delta.get("type").and_then(|v| v.as_str()) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                self.streamed_text_this_turn = true;
                                return vec![AIEvent::AssistantMessage(
                                    AssistantMessageEvent::new(&self.session_id, text, true),
                                )];
                            }
                        }
                        vec![]
                    }
                    Some("thinking_delta") => {
                        if let Some(thinking) = delta.get("thinking").and_then(|v| v.as_str()) {
                            self.thinking_buffer.push_str(thinking);
                            self.streamed_thinking_this_turn = true;
                        }
                        vec![]
                    }
                    _ => vec![],
                }
            }

            // content block 结束：thinking 块在此整段发出
            "content_block_stop" => {
                let is_thinking = event
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .and_then(|idx| self.stream_block_types.get(&idx))
                    .map(|t| t == "thinking")
                    .unwrap_or(false);
                if is_thinking && !self.thinking_buffer.trim().is_empty() {
                    let thinking = std::mem::take(&mut self.thinking_buffer);
                    return vec![AIEvent::Thinking(ThinkingEvent::new(&self.session_id, thinking))];
                }
                vec![]
            }

            // message_delta / message_stop / 其他：忽略
            // （turn 状态由下一个 message_start 或完整 assistant 消息重置）
            _ => vec![],
        }
    }

    /// 重置一轮 assistant 输出的流式状态
    fn reset_stream_turn_state(&mut self) {
        self.stream_block_types.clear();
        self.thinking_buffer.clear();
        self.streamed_text_this_turn = false;
        self.streamed_thinking_this_turn = false;
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
        // 若本 turn 已通过 stream_event 流式发送过 thinking，则跳过，避免与完整快照重复
        if !self.streamed_thinking_this_turn {
            for thinking in &thinking_blocks {
                results.push(AIEvent::Thinking(ThinkingEvent::new(&self.session_id, thinking.clone())));
            }
        }

        // 发出 AI 消息事件
        // 若本 turn 已通过 stream_event 流式发送过文本，则跳过（避免增量 + 完整快照翻倍）；
        // 未流式时（整段路径 / 端点不支持 partial）保持原行为。
        if !self.streamed_text_this_turn && (!text.is_empty() || !tool_calls.is_empty()) {
            results.push(AIEvent::AssistantMessage(
                AssistantMessageEvent::new(&self.session_id, text, false)
                    .with_tool_calls(tool_calls.clone())
            ));
        }

        // 发出工具调用开始事件
        for tc in &tool_calls {
            results.push(AIEvent::ToolCallStart(
                ToolCallStartEvent::new(&self.session_id, tc.name.clone(), tc.args.clone())
                    .with_call_id(tc.id.clone())
            ));
        }

        // 完整 assistant 消息代表本 turn 输出结束，重置流式 turn 状态
        self.reset_stream_turn_state();

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
                                &self.session_id, format!("{} {}", status_emoji, tc.name)
                            )));
                            results.push(AIEvent::ToolCallEnd(
                                ToolCallEndEvent::new(&self.session_id, tc.name, success)
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
                                ToolCallEndEvent::new(&self.session_id, "unknown".to_string(), success)
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
            results.push(AIEvent::UserMessage(UserMessageEvent::new(&self.session_id, text)));
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
            AIEvent::Progress(ProgressEvent::new(&self.session_id, format!("🔧 {}", tool_name))),
            AIEvent::ToolCallStart(
                ToolCallStartEvent::new(&self.session_id, tool_name, args)
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
                AIEvent::Progress(ProgressEvent::new(&self.session_id, format!("{} {}", status_emoji, tc.name))),
                AIEvent::ToolCallEnd(
                    ToolCallEndEvent::new(&self.session_id, tc.name, success)
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
                    AIEvent::Progress(ProgressEvent::new(&self.session_id, format!("{} {}", status_emoji, name))),
                    AIEvent::ToolCallEnd(
                        ToolCallEndEvent::new(&self.session_id, name.clone(), success)
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
                AIEvent::Progress(ProgressEvent::new(&self.session_id, format!("{} {}", status_emoji, name))),
                AIEvent::ToolCallEnd(ToolCallEndEvent::new(&self.session_id, name, success)),
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
        // 检查是否有 permission_denials（CLI --print 模式下权限拒绝信息）
        if let Some(denials_val) = extra.get("permission_denials") {
            if let Some(denial_arr) = denials_val.as_array() {
                if !denial_arr.is_empty() {
                    let parsed_denials: Vec<PermissionDenial> = denial_arr.iter()
                        .map(|d| {
                            // 从 JSON 中提取 tool_name 和 reason
                            let tool_name = d.get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let reason = d.get("reason")
                                .and_then(|v| v.as_str())
                                .unwrap_or("权限被拒绝")
                                .to_string();

                            let mut denial = PermissionDenial::new(tool_name, reason);
                            // 将剩余字段存入 extra
                            if let Some(obj) = d.as_object() {
                                let mut extra_map = HashMap::new();
                                for (k, v) in obj {
                                    if k != "tool_name" && k != "reason" {
                                        extra_map.insert(k.clone(), v.clone());
                                    }
                                }
                                if !extra_map.is_empty() {
                                    denial = denial.with_extra(extra_map);
                                }
                            }
                            denial
                        })
                        .collect();

                    if !parsed_denials.is_empty() {
                        tracing::info!(
                            "[EventParser] 检测到 permission_denials: {} 项",
                            parsed_denials.len()
                        );
                        let mut events = vec![AIEvent::PermissionRequest(
                            PermissionRequestEvent::new(&self.session_id, parsed_denials)
                        )];
                        // 仍然发送 result 事件（如果有 output）
                        if let Some(output) = extra.get("output") {
                            events.push(AIEvent::Result(
                                crate::models::ResultEvent::new(&self.session_id, output.clone())
                            ));
                        }
                        return events;
                    }
                }
            }
        }

        // 原有逻辑
        match subtype.as_str() {
            "success" => {
                if let Some(output) = extra.get("output") {
                    vec![AIEvent::Result(crate::models::ResultEvent::new(&self.session_id, output.clone()))]
                } else {
                    vec![]
                }
            }
            "canceled" => {
                vec![AIEvent::Progress(ProgressEvent::new(&self.session_id, "⚠️ 任务已取消"))]
            }
            _ => {
                if let Some(output) = extra.get("output") {
                    vec![
                        AIEvent::Progress(ProgressEvent::new(&self.session_id, &subtype)),
                        AIEvent::Result(crate::models::ResultEvent::new(&self.session_id, output.clone())),
                    ]
                } else {
                    vec![AIEvent::Progress(ProgressEvent::new(&self.session_id, &subtype))]
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
