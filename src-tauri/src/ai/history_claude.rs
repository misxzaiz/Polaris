/**
 * Claude Code 会话历史提供者
 */

use std::collections::HashMap;
use std::path::PathBuf;

use crate::ai::history::{
    HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta,
    ToolCallInfo, ToolResultInfo, TokenUsage,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;

/// Claude Code 会话历史提供者
pub struct ClaudeHistoryProvider {
    config: Config,
}

impl ClaudeHistoryProvider {
    /// 创建新的提供者
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// 获取 Claude Code 项目目录
    fn get_claude_dir() -> PathBuf {
        if cfg!(windows) {
            std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join(".claude").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
        } else {
            std::env::var("HOME")
                .map(|p| PathBuf::from(p).join(".claude").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
        }
    }

    /// 查找会话文件
    fn find_session_file(&self, session_id: &str, project_path: Option<&str>) -> Option<PathBuf> {
        let claude_dir = Self::get_claude_dir();

        if let Some(project) = project_path {
            let path = claude_dir.join(project).join(format!("{}.jsonl", session_id));
            if path.exists() {
                return Some(path);
            }
        }

        // 搜索所有项目目录
        if let Ok(entries) = std::fs::read_dir(&claude_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let candidate = entry.path().join(format!("{}.jsonl", session_id));
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }

        None
    }

    /// 解析 JSONL 文件中的消息
    fn parse_jsonl_messages(&self, path: &PathBuf, pagination: &Pagination) -> Result<(Vec<HistoryMessage>, usize)> {
        use std::io::{BufRead, BufReader};

        let file = std::fs::File::open(path)
            .map_err(|e| AppError::ValidationError(format!("无法打开文件: {}", e)))?;

        let reader = BufReader::new(file);
        let mut all_messages: Vec<HistoryMessage> = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取行失败: {}", e)))?;
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    match msg_type {
                        "user" => {
                            if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                if let Some(text) = content.as_str() {
                                    all_messages.push(HistoryMessage {
                                        message_id: json.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()),
                                        role: "user".to_string(),
                                        content: text.to_string(),
                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                        tool_calls: None,
                                        tool_result: None,
                                        usage: None,
                                    });
                                }
                            }
                        }
                        "assistant" => {
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    if let Some(arr) = content.as_array() {
                                        for item in arr {
                                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                    all_messages.push(HistoryMessage {
                                                        message_id: json.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()),
                                                        role: "assistant".to_string(),
                                                        content: text.to_string(),
                                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                                        tool_calls: None,
                                                        tool_result: None,
                                                        usage: None,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
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

        Ok((items, total))
    }
}

impl SessionHistoryProvider for ClaudeHistoryProvider {
    fn engine_id(&self) -> &'static str {
        "claude"
    }

    fn list_sessions(
        &self,
        _work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        let claude_dir = Self::get_claude_dir();
        let mut all_sessions: Vec<SessionMeta> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&claude_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let project_name = entry.file_name().to_string_lossy().to_string();

                    if let Ok(session_entries) = std::fs::read_dir(entry.path()) {
                        for session_entry in session_entries.flatten() {
                            let path = session_entry.path();
                            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                                let session_id = path.file_stem()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default();

                                all_sessions.push(SessionMeta {
                                    session_id,
                                    engine_id: "claude".to_string(),
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
        let session_file = self.find_session_file(session_id, None)
            .ok_or_else(|| AppError::ValidationError(format!("会话不存在: {}", session_id)))?;

        let (items, total) = self.parse_jsonl_messages(&session_file, &pagination)?;

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        let session_file = match self.find_session_file(session_id, None) {
            Some(f) => f,
            None => return Ok(None),
        };

        use std::io::{BufRead, BufReader};
        let file = std::fs::File::open(&session_file)
            .map_err(|e| AppError::ValidationError(format!("无法打开文件: {}", e)))?;

        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取行失败: {}", e)))?;
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json.get("uuid").and_then(|u| u.as_str()) == Some(message_id) {
                    if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                        match msg_type {
                            "user" => {
                                if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                    if let Some(text) = content.as_str() {
                                        return Ok(Some(HistoryMessage {
                                            message_id: Some(message_id.to_string()),
                                            role: "user".to_string(),
                                            content: text.to_string(),
                                            timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                            tool_calls: None,
                                            tool_result: None,
                                            usage: None,
                                        }));
                                    }
                                }
                            }
                            "assistant" => {
                                if let Some(message) = json.get("message") {
                                    if let Some(content) = message.get("content") {
                                        if let Some(arr) = content.as_array() {
                                            for item in arr {
                                                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                        return Ok(Some(HistoryMessage {
                                                            message_id: Some(message_id.to_string()),
                                                            role: "assistant".to_string(),
                                                            content: text.to_string(),
                                                            timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                                            tool_calls: None,
                                                            tool_result: None,
                                                            usage: None,
                                                        }));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        Ok(None)
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let session_file = self.find_session_file(session_id, None)
            .ok_or_else(|| AppError::ValidationError(format!("会话不存在: {}", session_id)))?;

        std::fs::remove_file(&session_file)
            .map_err(|e| AppError::ValidationError(format!("删除会话失败: {}", e)))?;

        Ok(())
    }
}
