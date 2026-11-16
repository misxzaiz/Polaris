//! tools_for_protocol 工具转换（K-R1 拆分）

use serde_json::{json, Value};
use super::wire::WireProtocol;
// ============================================================================
// 工具定义转换
// ============================================================================

/// 将内部 OpenAI Chat 工具定义（`{type:"function", function:{name,description,parameters}}`）
/// 转换为目标协议的工具定义。
pub fn tools_for_protocol(protocol: WireProtocol, openai_tools: &[Value]) -> Vec<Value> {
    match protocol {
        WireProtocol::OpenAIChat => openai_tools.to_vec(),
        WireProtocol::Anthropic => openai_tools
            .iter()
            .filter_map(|t| {
                let f = t.get("function")?;
                Some(json!({
                    "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "description": f.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    "input_schema": f
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                }))
            })
            .collect(),
        WireProtocol::Responses => openai_tools
            .iter()
            .filter_map(|t| {
                let f = t.get("function")?;
                let mut tool = json!({
                    "type": "function",
                    "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "parameters": f
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                });
                if let Some(desc) = f.get("description").and_then(|v| v.as_str()) {
                    if !desc.is_empty() {
                        tool["description"] = json!(desc);
                    }
                }
                Some(tool)
            })
            .collect(),
    }
}