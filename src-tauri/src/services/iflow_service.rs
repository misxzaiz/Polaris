//! IFlow CLI 服务
//!
//! 提供 IFlow 会话历史查询功能
//! 注：会话执行功能已迁移到 ai/engine/iflow.rs

use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::iflow_events::{
    IFlowJsonlEvent, IFlowSessionMeta, IFlowHistoryMessage, IFlowFileContext,
    IFlowTokenStats, IFlowToolCall,
};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// IFlow CLI 服务
pub struct IFlowService;

impl IFlowService {
    /// 获取 IFlow 配置目录
    fn get_iflow_config_dir() -> Result<PathBuf> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| AppError::ConfigError("无法获取用户目录".to_string()))?;

        let config_dir = PathBuf::from(home).join(".iflow");

        if !config_dir.exists() {
            return Err(AppError::ConfigError("IFlow 配置目录不存在".to_string()));
        }

        Ok(config_dir)
    }

    /// 编码项目路径为 IFlow 格式
    fn encode_project_path(path: &str) -> String {
        let normalized = path.replace(":", "").replace("\\", "-").replace("/", "-");
        format!("-{}", normalized)
    }

    /// 获取项目会话目录
    fn get_project_session_dir(work_dir: &str) -> Result<PathBuf> {
        let config_dir = Self::get_iflow_config_dir()?;
        let encoded_path = Self::encode_project_path(work_dir);
        let mut projects_dir = config_dir;
        projects_dir.push("projects");
        projects_dir.push(&encoded_path);
        Ok(projects_dir)
    }

    /// 查找会话对应的 JSONL 文件
    pub fn find_session_jsonl(config: &Config, session_id: &str) -> Result<PathBuf> {
        let work_dir = config.work_dir.as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());

        let session_dir = Self::get_project_session_dir(&work_dir)?;

        let entries = std::fs::read_dir(&session_dir)
            .map_err(|e| AppError::ProcessError(format!("读取会话目录失败: {}", e)))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
                if filename.starts_with("session-") && filename.ends_with(".jsonl") {
                    if let Ok(file) = File::open(&path) {
                        let reader = BufReader::new(file);
                        for line in reader.lines().take(10).flatten() {
                            if let Some(event) = IFlowJsonlEvent::parse_line(&line) {
                                if event.session_id == session_id {
                                    return Ok(path);
                                }
                            }
                        }
                    }
                }
            }
        }

        Err(AppError::ProcessError(format!("未找到会话文件: {}", session_id)))
    }

    /// 列出项目的所有 IFlow 会话元数据
    pub fn list_sessions(config: &Config) -> Result<Vec<IFlowSessionMeta>> {
        let work_dir = config.work_dir.as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());

        let session_dir = Self::get_project_session_dir(&work_dir)?;

        if !session_dir.exists() {
            return Ok(Vec::new());
        }

        let entries = std::fs::read_dir(&session_dir)
            .map_err(|e| AppError::ProcessError(format!("读取会话目录失败: {}", e)))?;

        let mut sessions = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                if let Ok(meta) = Self::extract_session_meta(&path) {
                    sessions.push(meta);
                }
            }
        }

        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    /// 从 JSONL 文件提取会话元数据
    fn extract_session_meta(jsonl_path: &Path) -> Result<IFlowSessionMeta> {
        let file_size = std::fs::metadata(jsonl_path).map(|m| m.len()).unwrap_or(0);

        let file = File::open(jsonl_path)
            .map_err(|e| AppError::ProcessError(format!("打开会话文件失败: {}", e)))?;

        let reader = BufReader::new(file);

        let mut message_count = 0u32;
        let mut input_tokens = 0u32;
        let mut output_tokens = 0u32;
        let mut first_user_content = String::new();
        let mut created_at: Option<String> = None;
        let mut updated_at: Option<String> = None;
        let mut session_id = String::new();

        for line in reader.lines().filter_map(|r| r.ok()) {
            let line_trimmed = line.trim();
            if line_trimmed.is_empty() {
                continue;
            }

            if let Some(event) = IFlowJsonlEvent::parse_line(line_trimmed) {
                if session_id.is_empty() {
                    session_id = event.session_id.clone();
                }

                if created_at.is_none() {
                    created_at = Some(event.timestamp.clone());
                }
                updated_at = Some(event.timestamp.clone());

                if event.event_type == "user" || event.event_type == "assistant" {
                    message_count += 1;

                    if first_user_content.is_empty() && event.event_type == "user" {
                        first_user_content = event.extract_text_content();
                    }
                }

                if let Some(ref message) = event.message {
                    if let Some(ref usage) = message.usage {
                        input_tokens += usage.input_tokens;
                        output_tokens += usage.output_tokens;
                    }
                }
            }
        }

        let title = if first_user_content.is_empty() {
            "IFlow 对话".to_string()
        } else {
            let truncated: String = first_user_content.chars().take(50).collect();
            if first_user_content.len() > 50 {
                format!("{}...", truncated)
            } else {
                truncated
            }
        };

        Ok(IFlowSessionMeta {
            session_id,
            title,
            message_count,
            file_size,
            created_at: created_at.unwrap_or_default(),
            updated_at: updated_at.unwrap_or_default(),
            input_tokens,
            output_tokens,
        })
    }

    /// 获取会话的完整历史消息
    pub fn get_session_history(config: &Config, session_id: &str) -> Result<Vec<IFlowHistoryMessage>> {
        let jsonl_path = Self::find_session_jsonl(config, session_id)?;

        let file = File::open(&jsonl_path)
            .map_err(|e| AppError::ProcessError(format!("打开会话文件失败: {}", e)))?;

        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines().filter_map(|r| r.ok()) {
            let line_trimmed = line.trim();
            if line_trimmed.is_empty() {
                continue;
            }

            if let Some(event) = IFlowJsonlEvent::parse_line(line_trimmed) {
                if event.event_type == "user" || event.event_type == "assistant" {
                    let tool_calls = if event.event_type == "assistant" {
                        Self::extract_tool_calls_from_event(&event)
                    } else {
                        Vec::new()
                    };

                    let input_tokens = event.message.as_ref()
                        .and_then(|m| m.usage.as_ref())
                        .map(|u| u.input_tokens);
                    let output_tokens = event.message.as_ref()
                        .and_then(|m| m.usage.as_ref())
                        .map(|u| u.output_tokens);

                    messages.push(IFlowHistoryMessage {
                        uuid: event.uuid.clone(),
                        parent_uuid: event.parent_uuid.clone(),
                        timestamp: event.timestamp.clone(),
                        r#type: event.event_type.clone(),
                        content: event.extract_text_content(),
                        model: event.message.as_ref().and_then(|m| m.model.clone()),
                        stop_reason: event.message.as_ref().and_then(|m| m.stop_reason.clone()),
                        input_tokens,
                        output_tokens,
                        tool_calls,
                    });
                }
            }
        }

        messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        Ok(messages)
    }

    /// 从事件中提取工具调用
    fn extract_tool_calls_from_event(event: &IFlowJsonlEvent) -> Vec<IFlowToolCall> {
        let mut tool_calls = Vec::new();

        if let Some(ref message) = event.message {
            if let serde_json::Value::Array(arr) = &message.content {
                for item in arr {
                    if let Some(obj) = item.as_object() {
                        if obj.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                            tool_calls.push(IFlowToolCall {
                                id: obj.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                name: obj.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                                input: obj.get("input").cloned().unwrap_or(serde_json::Value::Null),
                            });
                        }
                    }
                }
            }
        }

        tool_calls
    }

    /// 获取会话的文件上下文
    pub fn get_file_contexts(config: &Config, session_id: &str) -> Result<Vec<IFlowFileContext>> {
        let jsonl_path = Self::find_session_jsonl(config, session_id)?;

        let file = File::open(&jsonl_path)
            .map_err(|e| AppError::ProcessError(format!("打开会话文件失败: {}", e)))?;

        let reader = BufReader::new(file);
        let mut file_map: HashMap<String, IFlowFileContext> = HashMap::new();

        for line in reader.lines().filter_map(|r| r.ok()) {
            let line_trimmed = line.trim();
            if line_trimmed.is_empty() {
                continue;
            }

            if let Some(event) = IFlowJsonlEvent::parse_line(line_trimmed) {
                if event.event_type == "assistant" {
                    if let Some(ref message) = event.message {
                        Self::extract_files_from_message(&event, message, &mut file_map);
                    }
                }
            }
        }

        let mut contexts: Vec<IFlowFileContext> = file_map.into_values().collect();
        contexts.sort_by(|a, b| b.last_accessed.cmp(&a.last_accessed));
        Ok(contexts)
    }

    /// 从消息中提取文件引用
    fn extract_files_from_message(
        event: &IFlowJsonlEvent,
        message: &crate::models::iflow_events::IFlowMessage,
        file_map: &mut HashMap<String, IFlowFileContext>,
    ) {
        if let serde_json::Value::Array(arr) = &message.content {
            for item in arr {
                if let Some(obj) = item.as_object() {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        if let Some(name) = obj.get("name").and_then(|v| v.as_str()) {
                            let (file_type, path_key): (Option<&str>, Option<&str>) = match name {
                                "read_file" => (Some("file"), Some("path")),
                                "list_directory" => (Some("directory"), Some("path")),
                                "image_read" => (Some("image"), Some("image_input")),
                                "search_file_content" => (Some("file"), Some("path")),
                                _ => (None, None),
                            };

                            if let (Some(ft), Some(pk)) = (file_type, path_key) {
                                if let Some(path) = obj.get(pk).and_then(|v| v.as_str()) {
                                    file_map.entry(path.to_string())
                                        .and_modify(|ctx| {
                                            ctx.access_count += 1;
                                            ctx.last_accessed = event.timestamp.clone();
                                        })
                                        .or_insert(IFlowFileContext {
                                            path: path.to_string(),
                                            file_type: ft.to_string(),
                                            access_count: 1,
                                            first_accessed: event.timestamp.clone(),
                                            last_accessed: event.timestamp.clone(),
                                        });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// 获取会话的 Token 统计
    pub fn get_token_stats(config: &Config, session_id: &str) -> Result<IFlowTokenStats> {
        let jsonl_path = Self::find_session_jsonl(config, session_id)?;

        let file = File::open(&jsonl_path)
            .map_err(|e| AppError::ProcessError(format!("打开会话文件失败: {}", e)))?;

        let reader = BufReader::new(file);

        let mut total_input_tokens = 0u32;
        let mut total_output_tokens = 0u32;
        let mut message_count = 0u32;
        let mut user_message_count = 0u32;
        let mut assistant_message_count = 0u32;

        for line in reader.lines().filter_map(|r| r.ok()) {
            let line_trimmed = line.trim();
            if line_trimmed.is_empty() {
                continue;
            }

            if let Some(event) = IFlowJsonlEvent::parse_line(line_trimmed) {
                match event.event_type.as_str() {
                    "user" => {
                        user_message_count += 1;
                        message_count += 1;
                    }
                    "assistant" => {
                        assistant_message_count += 1;
                        message_count += 1;

                        if let Some(ref message) = event.message {
                            if let Some(ref usage) = message.usage {
                                total_input_tokens += usage.input_tokens;
                                total_output_tokens += usage.output_tokens;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        Ok(IFlowTokenStats {
            total_input_tokens,
            total_output_tokens,
            total_tokens: total_input_tokens + total_output_tokens,
            message_count,
            user_message_count,
            assistant_message_count,
        })
    }
}
