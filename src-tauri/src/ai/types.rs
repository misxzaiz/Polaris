/*! AI 模块公共类型定义
 */

use serde::{Deserialize, Serialize};

/// 引擎状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    /// 引擎 ID
    pub id: String,
    /// 引擎名称
    pub name: String,
    /// 是否可用
    pub available: bool,
    /// 不可用原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// 活动会话数
    pub active_sessions: usize,
}

impl EngineStatus {
    pub fn from_engine(engine: &dyn super::traits::AIEngine) -> Self {
        Self {
            id: engine.id().as_str().to_string(),
            name: engine.name().to_string(),
            available: engine.is_available(),
            unavailable_reason: engine.unavailable_reason(),
            active_sessions: engine.active_session_count(),
        }
    }
}

/// 引擎描述信息（预留功能）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineDescriptor {
    /// 引擎 ID
    pub id: String,
    /// 引擎名称
    pub name: String,
    /// 引擎描述
    pub description: String,
    /// 是否可用
    pub available: bool,
}

#[allow(dead_code)]
impl EngineDescriptor {
    /// 获取所有引擎描述
    pub fn all() -> Vec<Self> {
        vec![
            Self {
                id: "claude".to_string(),
                name: "Claude Code".to_string(),
                description: "Anthropic 官方 Claude CLI".to_string(),
                available: true, // 实际可用性需要运行时检查
            },
        ]
    }
}

/// 从事件中提取文本内容
#[allow(dead_code)]
pub fn extract_text_from_event(event: &crate::models::events::StreamEvent) -> Option<String> {
    use crate::models::events::StreamEvent;

    match event {
        StreamEvent::TextDelta { text } => Some(text.clone()),
        StreamEvent::Result { extra, .. } => {
            // 尝试从 extra 中提取文本
            extra.get("result").and_then(|v| v.as_str()).map(|s| s.to_string())
                .or_else(|| extra.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
        }
        StreamEvent::Assistant { message } => {
            // 从 message.content 数组中提取文本
            if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                let text: String = content
                    .iter()
                    .filter_map(|item| {
                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                            item.get("text").and_then(|t| t.as_str())
                        } else {
                            None
                        }
                    })
                    .collect();
                if !text.is_empty() {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}
