/**
 * IFlow 会话历史提供者
 */

use std::collections::HashMap;
use std::path::PathBuf;

use crate::ai::history::{
    HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta,
    ToolCallInfo, ToolResultInfo, TokenUsage,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;

/// IFlow 会话历史提供者
pub struct IFlowHistoryProvider {
    config: Config,
}

impl IFlowHistoryProvider {
    /// 创建新的提供者
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// 获取 IFlow 项目目录
    fn get_iflow_dir(&self) -> PathBuf {
        if let Some(ref work_dir) = self.config.work_dir {
            work_dir.join(".iflow").join("projects")
        } else if cfg!(windows) {
            std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join(".iflow").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".iflow").join("projects"))
        } else {
            std::env::var("HOME")
                .map(|p| PathBuf::from(p).join(".iflow").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".iflow").join("projects"))
        }
    }

    /// 从消息内容中提取文本
    fn extract_text_from_content(content: &serde_json::Value) -> String {
        if let Some(text) = content.as_str() {
            return text.to_string();
        }

        if let Some(arr) = content.as_array() {
            let texts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            return texts.join("\n");
        }

        content.to_string()
    }
}

impl SessionHistoryProvider for IFlowHistoryProvider {
    fn engine_id(&self) -> &'static str {
        "iflow"
    }

    fn list_sessions(
        &self,
        _work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        let iflow_dir = self.get_iflow_dir();
        let mut all_sessions: Vec<SessionMeta> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&iflow_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let project_name = entry.file_name().to_string_lossy().to_string();

                    if let Ok(session_entries) = std::fs::read_dir(entry.path()) {
                        for session_entry in session_entries.flatten() {
                            let path = session_entry.path();
                            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                                let file_name = path.file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default();

                                // IFlow 文件名格式: session-[id].jsonl
                                let session_id = file_name
                                    .strip_prefix("session-")
                                    .and_then(|s| s.strip_suffix(".jsonl"))
                                    .unwrap_or(&file_name)
                                    .to_string();

                                all_sessions.push(SessionMeta {
                                    session_id,
                                    engine_id: "iflow".to_string(),
                                    project_path: Some(project_name.clone()),
                                    created_at: None,
                                    updated_at: None,
                                    message_count: None,
                                    summary: None,
                                    extra: HashMap::new(),
                                });
                            }
                        }
                    }
                }
            }
        }

        let total = all_sessions.len();
        let skip = pagination.skip();
        let take = pagination.take();

        let items: Vec<SessionMeta> = all_sessions
            .into_iter()
            .skip(skip)
            .take(take)
            .collect();

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_session_history(
        &self,
        session_id: &str,
        pagination: Pagination,
    ) -> Result<PagedResult<HistoryMessage>> {
        use std::io::{BufRead, BufReader};

        // 查找会话文件
        let iflow_dir = self.get_iflow_dir();
        let mut session_file: Option<PathBuf> = None;

        if let Ok(entries) = std::fs::read_dir(&iflow_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let candidate = entry.path().join(format!("session-{}.jsonl", session_id));
                    if candidate.exists() {
                        session_file = Some(candidate);
                        break;
                    }
                }
            }
        }

        let session_file = session_file
            .ok_or_else(|| AppError::ValidationError(format!("会话不存在: {}", session_id)))?;

        let file = std::fs::File::open(&session_file)
            .map_err(|e| AppError::ValidationError(format!("无法打开文件: {}", e)))?;

        let reader = BufReader::new(file);
        let mut all_messages: Vec<HistoryMessage> = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取行失败: {}", e)))?;
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = json.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let uuid = json.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string());
                let timestamp = json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());

                match event_type {
                    "user" => {
                        if let Some(message) = json.get("message") {
                            let content = message.get("content").cloned().unwrap_or(serde_json::Value::Null);
                            let text = Self::extract_text_from_content(&content);

                            all_messages.push(HistoryMessage {
                                message_id: uuid,
                                role: "user".to_string(),
                                content: text,
                                timestamp,
                                tool_calls: None,
                                tool_result: None,
                                usage: None,
                            });
                        }
                    }
                    "assistant" => {
                        if let Some(message) = json.get("message") {
                            let content = message.get("content").cloned().unwrap_or(serde_json::Value::Null);
                            let text = Self::extract_text_from_content(&content);

                            let usage = message.get("usage").map(|u| TokenUsage {
                                input_tokens: u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
                                output_tokens: u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
                            });

                            all_messages.push(HistoryMessage {
                                message_id: uuid,
                                role: "assistant".to_string(),
                                content: text,
                                timestamp,
                                tool_calls: None,
                                tool_result: None,
                                usage,
                            });
                        }
                    }
                    "tool_result" => {
                        if let Some(result) = json.get("toolUseResult") {
                            let tool_id = result.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("");
                            let output = result.get("output").and_then(|o| o.as_str()).map(|s| s.to_string());

                            all_messages.push(HistoryMessage {
                                message_id: uuid,
                                role: "tool".to_string(),
                                content: output.clone().unwrap_or_default(),
                                timestamp,
                                tool_calls: None,
                                tool_result: Some(ToolResultInfo {
                                    tool_id: tool_id.to_string(),
                                    tool_name: result.get("tool_name").and_then(|n| n.as_str()).map(|s| s.to_string()),
                                    output,
                                    success: result.get("is_error").and_then(|e| e.as_bool()).map(|e| !e).unwrap_or(true),
                                }),
                                usage: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        let total = all_messages.len();
        let skip = pagination.skip();
        let take = pagination.take();

        let items: Vec<HistoryMessage> = all_messages
            .into_iter()
            .skip(skip)
            .take(take)
            .collect();

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        // 简化实现：获取整个会话历史，然后查找特定消息
        let pagination = Pagination::new(1, usize::MAX);
        let result = self.get_session_history(session_id, pagination)?;

        for msg in result.items {
            if msg.message_id.as_deref() == Some(message_id) {
                return Ok(Some(msg));
            }
        }

        Ok(None)
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let iflow_dir = self.get_iflow_dir();

        // 查找并删除会话文件
        if let Ok(entries) = std::fs::read_dir(&iflow_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let session_file = entry.path().join(format!("session-{}.jsonl", session_id));
                    if session_file.exists() {
                        std::fs::remove_file(&session_file)
                            .map_err(|e| AppError::ValidationError(format!("删除会话失败: {}", e)))?;
                        return Ok(());
                    }
                }
            }
        }

        Err(AppError::ValidationError(format!("会话不存在: {}", session_id)))
    }
}