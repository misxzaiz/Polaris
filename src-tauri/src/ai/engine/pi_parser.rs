/*! Pi RPC 事件解析器
 *
 * 将 pi (`@earendil-works/pi-coding-agent`) `--mode rpc` 输出的 JSONL 行
 * 归一化为 Polaris 标准化 AIEvent。
 *
 * pi RPC stdout 有三类 JSON 行（严格 LF 分隔，不能用 Node readline）：
 * 1. **响应**：`{"type":"response","id":..,"command":..,"success":..,"data":..}`
 *    ——命令的 ack，成功/失败确认。本解析器只识别不透出（除非是错误响应）。
 * 2. **会话头**：`{"type":"session","version":3,"id":"uuid","cwd":"/path"}`
 *    ——首行，携带 pi 内部 sessionId。
 * 3. **事件**：`{"type":"agent_start"|"turn_start"|"message_start"|
 *    "message_update"|"message_end"|"turn_end"|"agent_end"|
 *    "tool_execution_start"|"tool_execution_update"|"tool_execution_end"|...}`
 *
 * 事件形态基于 pi.dev/docs/latest/rpc 与 SDK AgentEvent 实测：
 * - `message_update` + `assistantMessageEvent.type=="text_delta"` → 文本增量
 * - `message_update` + `assistantMessageEvent.type=="thinking_delta"` → 思考增量
 * - `tool_execution_start/update/end` → 工具调用（含 toolCallId/toolName/args/result/isError）
 *
 * 文本/思考增量采用"累积增量"语义：pi 流式输出逐 chunk delta，
 * 与 Polaris AIEvent::assistant_message(is_delta=true) 对齐。
 */

use crate::models::{AIEvent, ToolCallStartEvent, ToolCallEndEvent};

/// pi RPC stdout 单行的宽松解析结构
///
/// 顶层 `type` 字段决定行类别；其余字段按需按事件类型惰性提取。
#[derive(Debug, serde::Deserialize)]
pub struct PiRpcLine {
    #[serde(rename = "type")]
    pub line_type: String,
    /// 响应行携带的请求 id（命令 ack）——保留供将来按 id 关联请求/响应
    #[serde(default)]
    #[allow(dead_code)]
    pub id: Option<serde_json::Value>,
    /// 响应行的命令名（"prompt" / "get_state" / ...）
    #[serde(default)]
    pub command: Option<String>,
    /// 响应行的成功标志
    #[serde(default)]
    pub success: Option<bool>,
    /// 会话头/事件/响应的 data 字段
    #[serde(default)]
    pub data: serde_json::Value,
    /// 事件 message 字段（message_start/update/end / turn_end / agent_end）
    #[serde(default)]
    pub message: Option<serde_json::Value>,
    /// message_update 事件的子事件描述符
    #[serde(default, rename = "assistantMessageEvent")]
    pub assistant_message_event: Option<serde_json::Value>,
    /// 工具执行事件的 toolCallId / toolName / args / result / isError
    #[serde(default, rename = "toolCallId")]
    pub tool_call_id: Option<String>,
    #[serde(default, rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub args: Option<serde_json::Value>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default, rename = "isError")]
    pub is_error: Option<bool>,
}

impl PiRpcLine {
    /// 解析单行 JSON。空行或非 JSON 返回 None。
    pub fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}

/// 解析结果：携带 0..n 个 AIEvent，以及可能从会话头/响应中提取的元信息
pub struct ParsedPiLine {
    pub events: Vec<AIEvent>,
    /// 从 `session` 头或 `get_state` 响应里提取的真实 sessionId
    pub session_id_hint: Option<String>,
    /// 命令失败响应的错误消息（供调用方决定是否上报）
    pub command_error: Option<String>,
}

/// 将一行 pi RPC 输出翻译为标准化 AIEvent 集合
///
/// `current_sid` 为当前 Polaris 会话 ID（事件透出时回填）。
pub fn pi_line_to_ai_events(line: &PiRpcLine, current_sid: &str) -> ParsedPiLine {
    let mut out = ParsedPiLine {
        events: Vec::new(),
        session_id_hint: None,
        command_error: None,
    };

    match line.line_type.as_str() {
        // —— 会话头：提取 pi sessionId ——
        "session" => {
            if let Some(id) = line.data.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    out.session_id_hint = Some(id.to_string());
                }
            }
        }

        // —— 命令响应 ——
        "response" => {
            // 失败响应：尝试从 data 提取错误信息（字段名未在本环境实测，
            // 防御性按 message/error/err 取值）
            if line.success == Some(false) {
                let msg = line.data.get("message")
                    .or_else(|| line.data.get("error"))
                    .or_else(|| line.data.get("err"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        format!("pi 命令 {} 失败", line.command.as_deref().unwrap_or("?"))
                    });
                // prompt 失败属于"接受前拒绝"，上报为错误
                if line.command.as_deref() == Some("prompt") {
                    out.events.push(AIEvent::error(current_sid, msg));
                } else {
                    out.command_error = Some(msg);
                }
            }
        }

        // —— Agent / Turn 生命周期：不直接透出，仅日志边界 ——
        "agent_start" | "turn_start" => {}

        // —— 消息生命周期 ——
        "message_start" | "message_end" => {
            // pi 的 message_start/end 携带完整 message 对象；
            // 文本内容通过 message_update(text_delta) 增量透出，这里不重复整段发送，
            // 避免 delta + 整段双渲染。仅对纯工具调用消息在 end 时补发工具事件兜底
            // （工具执行有独立的 tool_execution_* 事件，通常无需在此处理）。
        }
        "message_update" => {
            if let Some(ame) = &line.assistant_message_event {
                let ev_type = ame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match ev_type {
                    "text_delta" => {
                        if let Some(delta) = ame.get("delta").and_then(|v| v.as_str()) {
                            if !delta.is_empty() {
                                out.events.push(AIEvent::assistant_message(
                                    current_sid, delta, true,
                                ));
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(delta) = ame.get("delta").and_then(|v| v.as_str()) {
                            if !delta.is_empty() {
                                out.events.push(AIEvent::thinking(current_sid, delta));
                            }
                        }
                    }
                    // text_start / text_end / thinking_start/end / toolcall_*/done /
                    // error 等子事件：边界或终态，增量已由 delta 透出，此处不重复
                    _ => {}
                }
            }
        }

        "turn_end" | "agent_end" => {
            // agent_end 携带 messages 数组；增量文本已透出，无需再发整段。
            // 借机检测 assistant 消息里的 error 状态作兜底。
            if line.line_type == "agent_end" {
                if let Some(msgs) = line.message.as_ref().and_then(|m| m.as_array()) {
                    for m in msgs {
                        if let Some(role) = m.get("role").and_then(|v| v.as_str()) {
                            if role == "assistant" {
                                if let Some(err) = m.get("error").and_then(|v| v.as_str()) {
                                    if !err.is_empty() {
                                        out.events.push(AIEvent::error(current_sid, err));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // —— 工具执行 ——
        "tool_execution_start" => {
            let tool = line.tool_name.clone().unwrap_or_else(|| "unknown".to_string());
            let args_map = line.args.as_ref()
                .and_then(|a| a.as_object())
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            let mut start = ToolCallStartEvent::new(current_sid, tool, args_map);
            if let Some(cid) = line.tool_call_id.clone() {
                start = start.with_call_id(cid);
            }
            out.events.push(AIEvent::ToolCallStart(start));
        }
        "tool_execution_update" => {
            // 工具执行进度（流式输出）；当前不透出，避免噪声
        }
        "tool_execution_end" => {
            let tool = line.tool_name.clone().unwrap_or_else(|| "unknown".to_string());
            let success = line.is_error != Some(true);
            let mut end = ToolCallEndEvent::new(current_sid, tool, success);
            if let Some(cid) = line.tool_call_id.clone() {
                end = end.with_call_id(cid);
            }
            if let Some(result) = line.result.clone() {
                if !result.is_null() {
                    end = end.with_result(result);
                }
            }
            out.events.push(AIEvent::ToolCallEnd(end));
        }

        // —— 其它生命周期（queue/compaction/retry 等）：当前不透出 ——
        // 后续可按需映射 compaction → ContextCompacted、auto_retry → Progress 等
        _ => {
            tracing::debug!("[PiEngine] 未映射的 pi 事件类型: {}", line.line_type);
        }
    }

    out
}

/// 从 `get_state` 响应的 data 中提取 sessionId
pub fn extract_session_id_from_state(data: &serde_json::Value) -> Option<String> {
    data.get("sessionId").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 构造发送给 pi stdin 的 prompt 命令 JSONL 行
pub fn build_prompt_command(message: &str, request_id: &str) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("id".to_string(), serde_json::Value::String(request_id.to_string()));
    obj.insert("type".to_string(), serde_json::Value::String("prompt".to_string()));
    obj.insert("message".to_string(), serde_json::Value::String(message.to_string()));
    let mut line = serde_json::to_string(&serde_json::Value::Object(obj))
        .unwrap_or_else(|_| "{}".to_string());
    line.push('\n');
    line
}

/// 构造 abort 命令
pub fn build_abort_command() -> String {
    "{\"type\":\"abort\"}\n".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> PiRpcLine {
        PiRpcLine::parse_line(line).expect("应能解析")
    }

    #[test]
    fn test_parse_session_header() {
        let line = parse(r#"{"type":"session","version":3,"id":"abc-123","timestamp":1,"cwd":"/x"}"#);
        let r = pi_line_to_ai_events(&line, "sid");
        assert_eq!(r.session_id_hint.as_deref(), Some("abc-123"));
        assert!(r.events.is_empty());
    }

    #[test]
    fn test_text_delta_produces_delta_event() {
        let line = parse(r#"{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}"#);
        let r = pi_line_to_ai_events(&line, "sid");
        assert_eq!(r.events.len(), 1);
        match &r.events[0] {
            AIEvent::AssistantMessage(e) => {
                assert_eq!(e.content, "Hi");
                assert!(e.is_delta);
            }
            other => panic!("应为 AssistantMessage(delta)，实际: {}", other.event_type()),
        }
    }

    #[test]
    fn test_thinking_delta_produces_thinking_event() {
        let line = parse(r#"{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","delta":"思考"}}"#);
        let r = pi_line_to_ai_events(&line, "sid");
        assert_eq!(r.events.len(), 1);
        match &r.events[0] {
            AIEvent::Thinking(e) => assert_eq!(e.content, "思考"),
            other => panic!("应为 Thinking，实际: {}", other.event_type()),
        }
    }

    #[test]
    fn test_tool_execution_start_end() {
        let start_line = parse(r#"{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}"#);
        let r1 = pi_line_to_ai_events(&start_line, "sid");
        assert_eq!(r1.events.len(), 1);
        match &r1.events[0] {
            AIEvent::ToolCallStart(e) => {
                assert_eq!(e.tool, "bash");
                assert_eq!(e.call_id.as_deref(), Some("c1"));
                assert!(e.args.contains_key("command"));
            }
            other => panic!("应为 ToolCallStart，实际: {}", other.event_type()),
        }

        let end_line = parse(r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"exit":0},"isError":false}"#);
        let r2 = pi_line_to_ai_events(&end_line, "sid");
        assert_eq!(r2.events.len(), 1);
        match &r2.events[0] {
            AIEvent::ToolCallEnd(e) => {
                assert_eq!(e.tool, "bash");
                assert!(e.success);
                assert!(e.result.is_some());
            }
            other => panic!("应为 ToolCallEnd，实际: {}", other.event_type()),
        }
    }

    #[test]
    fn test_prompt_failure_response_emits_error() {
        let line = parse(r#"{"id":"q1","type":"response","command":"prompt","success":false,"data":{"message":"rate limited"}}"#);
        let r = pi_line_to_ai_events(&line, "sid");
        assert_eq!(r.events.len(), 1);
        match &r.events[0] {
            AIEvent::Error(e) => assert!(e.error.contains("rate limited")),
            other => panic!("应为 Error，实际: {}", other.event_type()),
        }
    }

    #[test]
    fn test_non_prompt_failure_is_command_error_not_event() {
        let line = parse(r#"{"id":"q1","type":"response","command":"set_model","success":false,"data":{"error":"bad model"}}"#);
        let r = pi_line_to_ai_events(&line, "sid");
        assert!(r.events.is_empty());
        assert!(r.command_error.is_some());
    }

    #[test]
    fn test_rejects_non_json() {
        assert!(PiRpcLine::parse_line("").is_none());
        assert!(PiRpcLine::parse_line("plain text").is_none());
        assert!(PiRpcLine::parse_line("{broken").is_none());
    }

    #[test]
    fn test_prompt_command_format() {
        let cmd = build_prompt_command("Hello", "req-1");
        assert!(cmd.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(cmd.trim()).unwrap();
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["id"], "req-1");
        assert_eq!(v["message"], "Hello");
    }
}
