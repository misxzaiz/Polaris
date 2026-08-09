/*! 插件引擎会话历史提供者
 *
 * 为插件引擎（PluginEngineRunner）提供统一的会话历史查询、恢复和删除。
 * 插件引擎的会话文件存储在 `<DataRoot>/plugin-sessions/<engine-id>/` 目录下，
 * 格式为 `<timestamp>_<session-id>.jsonl`，与 Pi 引擎的 JSONL 格式兼容。
 *
 * 前端通过 `list_sessions` / `get_session_history` / `delete_session` Tauri 命令
 * 统一访问，无需区分引擎类型。
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::ai::history::{
    HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta,
    ToolCallInfo, ToolResultInfo, TokenUsage,
};
use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

/// 插件引擎会话历史提供者
pub struct PluginHistoryProvider {
    /// 引擎 ID（如 "omp"）
    engine_id: &'static str,
    /// 引擎显示名称
    #[allow(dead_code)]
    engine_name: &'static str,
}

impl PluginHistoryProvider {
    /// 创建新的插件历史提供者
    pub fn new(engine_id: impl Into<String>, engine_name: impl Into<String>) -> Self {
        Self {
            engine_id: Box::leak(engine_id.into().into_boxed_str()),
            engine_name: Box::leak(engine_name.into().into_boxed_str()),
        }
    }

    /// 获取插件引擎的 session 目录
    fn session_dir(&self) -> PathBuf {
        data_root().root().join("plugin-sessions").join(self.engine_id)
    }

    /// 扫描目录获取所有会话文件
    fn scan_session_files(&self) -> Result<Vec<SessionFileEntry>> {
        let dir = self.session_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        match fs::read_dir(&dir) {
            Ok(reader) => {
                for entry in reader.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let file_name = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    // 文件名为 <timestamp>_<session-id>.jsonl
                    // 提取 session_id（下划线之后、.jsonl 之前的部分）
                    let session_id = if let Some(underscore_pos) = file_name.find('_') {
                        file_name[underscore_pos + 1..]
                            .strip_suffix(".jsonl")
                            .unwrap_or(&file_name)
                            .to_string()
                    } else {
                        file_name.strip_suffix(".jsonl").unwrap_or(&file_name).to_string()
                    };

                    let metadata = match fs::metadata(&path) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    let file_size = metadata.len();
                    let mtime = metadata.modified().ok();

                    // 从文件名解析时间戳
                    let created_at = if let Some(underscore_pos) = file_name.find('_') {
                        // 格式: 2026-07-30T10-00-58-575Z_<uuid>.jsonl
                        // 将下划线前的部分恢复为 ISO 时间
                        let ts_part = &file_name[..underscore_pos].replace('-', ":");
                        // 第一个冒号已经在日期部分，需要恢复 T
                        let ts_iso = format!("{}Z", ts_part.replacen(':', "T", 1));
                        Some(ts_iso)
                    } else {
                        None
                    };

                    entries.push(SessionFileEntry {
                        path,
                        file_name,
                        session_id,
                        file_size,
                        mtime,
                        created_at,
                    });
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[PluginHistoryProvider:{}] 读取 session 目录失败: {}",
                    self.engine_id, e
                );
                return Ok(Vec::new());
            }
        }

        // 按 mtime 降序排列
        entries.sort_by(|a, b| b.mtime.unwrap_or(SystemTime::UNIX_EPOCH).cmp(&a.mtime.unwrap_or(SystemTime::UNIX_EPOCH)));

        Ok(entries)
    }

    /// 从 JSONL 文件中提取摘要（第一条用户消息的文本内容）
    fn extract_summary(&self, path: &Path) -> Option<String> {
        let file = fs::File::open(path).ok()?;
        let reader = BufReader::new(file);
        let mut first_user_message = None;

        for line in reader.lines().map_while(|r| r.ok()) {
            if line.trim().is_empty() || !line.trim().starts_with('{') {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if val.get("type").and_then(|t| t.as_str()) == Some("message") {
                    if let Some(msg) = val.get("message") {
                        if msg.get("role").and_then(|r| r.as_str()) == Some("user") {
                            // 兼容 content 字符串和数组格式
                            if let Some(content) = msg.get("content") {
                                if let Some(text) = Self::extract_text_content(content) {
                                    first_user_message = Some(text.to_string());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        first_user_message.map(|s| {
            if s.len() > 100 {
                format!("{}...", &s[..100])
            } else {
                s
            }
        })
    }

    /// 从 content 字段提取纯文本内容
    ///
    /// 兼容两种格式：
    /// - 字符串：`"content": "hello"`
    /// - 数组（OMP 风格）：`"content": [{"type":"text","text":"hello"}, ...]`
    fn extract_text_content<'a>(content: &'a serde_json::Value) -> Option<&'a str> {
        // 字符串格式
        if let Some(s) = content.as_str() {
            return Some(s);
        }
        // 数组格式：取第一个 text 类型块的内容
        if let Some(arr) = content.as_array() {
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        return Some(text);
                    }
                }
            }
        }
        None
    }

    /// 从 content 数组提取工具调用列表
    ///
    /// OMP 风格在 content 数组中嵌入 `{"type":"toolCall","name":"...","arguments":{...}}` 块。
    fn extract_tool_calls_from_content(content: &serde_json::Value) -> Vec<ToolCallInfo> {
        let Some(arr) = content.as_array() else { return Vec::new() };
        arr.iter().filter_map(|block| {
            if block.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                return None;
            }
            let tool_name = block.get("name").and_then(|n| n.as_str())?.to_string();
            let tool_id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
            let arguments = block.get("arguments").or_else(|| block.get("args")).map(|a| a.to_string());
            Some(ToolCallInfo { tool_id, tool_name, arguments })
        }).collect()
    }

    /// 从 content 数组提取工具结果（role=toolResult 消息）
    ///
    /// OMP 风格工具结果在 role=toolResult 消息的 content 数组第一个 text 块中。
    fn extract_tool_result_from_content(content: &serde_json::Value) -> Option<ToolResultInfo> {
        let Some(arr) = content.as_array() else { return None };
        let mut tool_id = String::new();
        let mut tool_name = None;
        let mut output = None;
        let mut success = true;

        for block in arr {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    output = output.or_else(|| block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()));
                }
                Some("toolResult") => {
                    tool_id = block.get("id").or_else(|| block.get("toolCallId"))
                        .and_then(|i| i.as_str()).unwrap_or("").to_string();
                    tool_name = block.get("name").or_else(|| block.get("toolName"))
                        .and_then(|n| n.as_str()).map(|s| s.to_string());
                    output = output.or_else(|| block.get("output").or_else(|| block.get("text"))
                        .and_then(|o| o.as_str()).map(|s| s.to_string()));
                    success = block.get("isError").and_then(|e| e.as_bool()) != Some(true);
                }
                _ => {}
            }
        }
        Some(ToolResultInfo { tool_id, tool_name, output, success })
    }

    /// 解析 JSONL 文件为消息列表
    fn parse_messages(&self, path: &Path) -> Result<Vec<HistoryMessage>> {
        let file = fs::File::open(path)
            .map_err(|e| AppError::ProcessError(format!("打开会话文件失败: {}", e)))?;
        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines().map_while(|r| r.ok()) {
            if line.trim().is_empty() || !line.trim().starts_with('{') {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if val.get("type").and_then(|t| t.as_str()) != Some("message") {
                    continue;
                }
                if let Some(msg) = val.get("message") {
                    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string();

                    // 兼容 content 字符串和数组格式
                    let content = msg.get("content")
                        .map(|c| Self::extract_text_content(c).unwrap_or("").to_string())
                        .unwrap_or_default();

                    let message_id = val.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                    let timestamp = val.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());

                    // 提取工具调用信息：优先从 msg.toolCalls/msg.tool_calls，否则从 content 数组提取
                    let tool_calls = msg.get("toolCalls").or_else(|| msg.get("tool_calls"))
                        .and_then(|tc| tc.as_array())
                        .map(|arr| {
                            arr.iter().filter_map(|tc| {
                                let tool_id = tc.get("id").or_else(|| tc.get("toolCallId"))
                                    .and_then(|i| i.as_str())?.to_string();
                                let tool_name = tc.get("name").or_else(|| tc.get("toolName"))
                                    .and_then(|n| n.as_str())?.to_string();
                                let arguments = tc.get("arguments").or_else(|| tc.get("args"))
                                    .map(|a| a.to_string());
                                Some(ToolCallInfo {
                                    tool_id,
                                    tool_name,
                                    arguments,
                                })
                            }).collect()
                        })
                        .or_else(|| {
                            // OMP 风格：toolCall 嵌入在 content 数组中
                            let calls = Self::extract_tool_calls_from_content(msg.get("content").unwrap_or(&serde_json::Value::Null));
                            if calls.is_empty() { None } else { Some(calls) }
                        });

                    let mut hm = HistoryMessage {
                        message_id,
                        role: role.clone(),
                        content,
                        timestamp,
                        tool_calls,
                        tool_result: None,
                        usage: None,
                    };

                    // 工具结果：优先从顶层 result/toolResult 字段，否则从 role=toolResult 消息的 content 提取
                    if let Some(result) = val.get("result").or_else(|| val.get("toolResult")) {
                        hm.tool_result = Some(ToolResultInfo {
                            tool_id: result.get("id").or_else(|| result.get("toolCallId"))
                                .and_then(|i| i.as_str()).unwrap_or("").to_string(),
                            tool_name: result.get("name").or_else(|| result.get("toolName"))
                                .and_then(|n| n.as_str()).map(|s| s.to_string()),
                            output: result.get("output").or_else(|| result.get("text"))
                                .and_then(|o| o.as_str()).map(|s| s.to_string()),
                            success: result.get("isError").and_then(|e| e.as_bool()) != Some(true),
                        });
                    } else if role == "toolResult" {
                        // OMP 风格：toolResult 消息从 content 数组提取
                        hm.tool_result = Self::extract_tool_result_from_content(
                            msg.get("content").unwrap_or(&serde_json::Value::Null)
                        );
                    }

                    // Token 用量（OMP 风格在 msg.usage 中，字段名为 input/output/cacheRead 等）
                    if let Some(usage) = msg.get("usage") {
                        hm.usage = Some(TokenUsage {
                            input_tokens: usage.get("inputTokens").or_else(|| usage.get("input"))
                                .and_then(|v| v.as_u64()).unwrap_or(0),
                            output_tokens: usage.get("outputTokens").or_else(|| usage.get("output"))
                                .and_then(|v| v.as_u64()).unwrap_or(0),
                        });
                    }

                    messages.push(hm);
                }
            }
        }

        Ok(messages)
    }
}

/// 会话文件条目
struct SessionFileEntry {
    path: PathBuf,
    #[allow(dead_code)]
    file_name: String,
    session_id: String,
    file_size: u64,
    mtime: Option<SystemTime>,
    created_at: Option<String>,
}

impl SessionHistoryProvider for PluginHistoryProvider {
    fn engine_id(&self) -> &'static str {
        self.engine_id
    }

    fn list_sessions(
        &self,
        _work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        let all_entries = self.scan_session_files()?;
        let total = all_entries.len();

        // 分页
        let skip = pagination.skip();
        let page_entries: Vec<&SessionFileEntry> = all_entries.iter()
            .skip(skip)
            .take(pagination.take())
            .collect();

        let mut items = Vec::new();
        for entry in &page_entries {
            let summary = self.extract_summary(&entry.path);
            let updated_at = entry.mtime.map(|t| {
                let duration = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
                let secs = duration.as_secs();
                // 格式化为 ISO 8601
                let naive = chrono::DateTime::from_timestamp(secs as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default();
                naive
            });

            items.push(SessionMeta {
                session_id: entry.session_id.clone(),
                engine_id: self.engine_id.to_string(),
                project_path: None,
                created_at: entry.created_at.clone(),
                updated_at,
                message_count: None,
                summary,
                file_size: Some(entry.file_size),
                claude_project_name: None,
                file_path: Some(entry.path.to_string_lossy().to_string()),
                parent_session_id: None,
                child_session_ids: Vec::new(),
                git_branch: None,
                linked_pr: None,
                extra: HashMap::new(),
            });
        }

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_session_history(
        &self,
        session_id: &str,
        pagination: Pagination,
    ) -> Result<PagedResult<HistoryMessage>> {
        let all_entries = self.scan_session_files()?;
        let entry = all_entries.iter()
            .find(|e| e.session_id == session_id)
            .ok_or_else(|| AppError::ValidationError(format!(
                "会话 {} 不存在", session_id
            )))?;

        let messages = self.parse_messages(&entry.path)?;
        let total = messages.len();
        let skip = pagination.skip();
        let items: Vec<HistoryMessage> = messages.into_iter()
            .skip(skip)
            .take(pagination.take())
            .collect();

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        let all_entries = self.scan_session_files()?;
        let entry = all_entries.iter()
            .find(|e| e.session_id == session_id)
            .ok_or_else(|| AppError::ValidationError(format!(
                "会话 {} 不存在", session_id
            )))?;

        let messages = self.parse_messages(&entry.path)?;
        Ok(messages.into_iter().find(|m| m.message_id.as_deref() == Some(message_id)))
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let all_entries = self.scan_session_files()?;
        let entry = all_entries.iter()
            .find(|e| e.session_id == session_id)
            .ok_or_else(|| AppError::ValidationError(format!(
                "会话 {} 不存在", session_id
            )))?;

        fs::remove_file(&entry.path)
            .map_err(|e| AppError::ProcessError(format!("删除会话文件失败: {}", e)))
    }
}

/// 提取插件引擎 JSONL 文件的元数据（供索引扫描使用）
///
/// 返回 (title, message_count, created_at, workspace_path, session_id)
pub(crate) fn parse_plugin_metadata(path: &Path) -> (Option<String>, usize, Option<String>, Option<String>, Option<String>) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, 0, None, None, None),
    };
    let reader = BufReader::new(file);
    let mut title = None;
    let mut created_at = None;
    let mut workspace_path = None;
    let mut session_id = None;
    let mut message_count: usize = 0;

    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() || !line.trim().starts_with('{') {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match val.get("type").and_then(|t| t.as_str()) {
            Some("title") => {
                let t = val.get("title").and_then(|v| v.as_str()).unwrap_or("");
                if !t.is_empty() {
                    title = Some(t.to_string());
                }
            }
            Some("session") => {
                session_id = val.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                created_at = val.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());
                let cwd = val.get("cwd").and_then(|v| v.as_str());
                if cwd.map_or(false, |c| !c.is_empty()) {
                    workspace_path = cwd.map(|s| s.to_string());
                }
            }
            Some("message") => {
                message_count += 1;
                // 优先取第一条 user 消息作为 title（若无 title 行）
                if title.is_none() {
                    if let Some(msg) = val.get("message") {
                        if msg.get("role").and_then(|r| r.as_str()) == Some("user") {
                            if let Some(content) = msg.get("content") {
                                if let Some(text) = PluginHistoryProvider::extract_text_content(content) {
                                    let text = text.to_string();
                                    if !text.is_empty() {
                                        title = Some(text.chars().take(80).collect());
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

    (title, message_count, created_at, workspace_path, session_id)
}