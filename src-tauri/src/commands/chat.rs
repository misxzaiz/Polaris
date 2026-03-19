/*! 聊天命令模块
 *
 * 提供统一的 AI 聊天接口，使用 EngineRegistry 管理多种 AI 引擎。
 */

use std::sync::Arc;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};

use crate::ai::{EngineId, Pagination, PagedResult, SessionOptions};
use crate::ai::{SessionMeta, HistoryMessage, ClaudeHistoryProvider, IFlowHistoryProvider, SessionHistoryProvider};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use tauri::{Emitter, State, Window};
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ============================================================================
// 附件相关结构体
// ============================================================================

/// 附件类型
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// 附件类型
    #[serde(rename = "type")]
    pub attachment_type: String,
    /// 文件名
    pub file_name: String,
    /// MIME 类型
    pub mime_type: String,
    /// 内容 (base64 data URL)
    pub content: String,
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 保存附件到工作区，返回保存的图片路径列表
fn save_attachments(work_dir: &str, attachments: &[Attachment]) -> Result<Vec<String>> {
    let polaris_dir = PathBuf::from(work_dir).join(".polaris");
    let mut saved_image_paths = Vec::new();

    // 创建 .polaris 目录（如果不存在）
    if !polaris_dir.exists() {
        std::fs::create_dir_all(&polaris_dir)
            .map_err(|e| AppError::ProcessError(format!("创建 .polaris 目录失败: {}", e)))?;
    }

    // 保存图片附件
    let mut image_index = 0;
    for attachment in attachments {
        if attachment.attachment_type == "image" {
            // 从 data URL 中提取 base64 数据
            let base64_data = if attachment.content.starts_with("data:") {
                // 格式: data:image/png;base64,xxxxx
                let parts: Vec<&str> = attachment.content.splitn(2, ",").collect();
                if parts.len() == 2 {
                    parts[1]
                } else {
                    tracing::warn!("[save_attachments] 无法解析 data URL: {}", &attachment.content[..50.min(attachment.content.len())]);
                    continue;
                }
            } else {
                // 假设是纯 base64
                &attachment.content
            };

            // 解码 base64
            let decoded = BASE64_STANDARD.decode(base64_data)
                .map_err(|e| AppError::ProcessError(format!("解码 base64 失败: {}", e)))?;

            // 根据扩展名确定文件名
            let ext = if attachment.mime_type == "image/png" {
                "png"
            } else if attachment.mime_type == "image/jpeg" || attachment.mime_type == "image/jpg" {
                "jpg"
            } else if attachment.mime_type == "image/gif" {
                "gif"
            } else if attachment.mime_type == "image/webp" {
                "webp"
            } else if attachment.mime_type == "image/bmp" {
                "bmp"
            } else {
                // 从文件名提取扩展名
                attachment.file_name.rsplit('.').next().unwrap_or("png")
            };

            let file_name = format!("image_{}.{}", image_index, ext);
            let file_path = polaris_dir.join(&file_name);

            // 写入文件
            std::fs::write(&file_path, &decoded)
                .map_err(|e| AppError::ProcessError(format!("写入图片文件失败: {}", e)))?;

            tracing::info!("[save_attachments] 保存图片: {:?}", file_path);

            // 返回相对路径，便于在消息中引用
            saved_image_paths.push(format!(".polaris/{}", file_name));
            image_index += 1;
        }
    }

    Ok(saved_image_paths)
}

// ============================================================================
// Tauri Commands - 聊天
// ============================================================================

/// 启动聊天会话
#[tauri::command]
pub async fn start_chat(
    message: String,
    window: Window,
    state: State<'_, crate::AppState>,
    work_dir: Option<String>,
    engine_id: Option<String>,
    system_prompt: Option<String>,
    context_id: Option<String>,
    attachments: Option<Vec<Attachment>>,
    cli_args: Option<Vec<String>>,
) -> Result<String> {
    tracing::info!("[start_chat] 收到消息，长度: {} 字符, 附件数: {:?}, CLI 参数: {:?}", message.len(), attachments.as_ref().map(|a| a.len()), cli_args);

    // 保存附件到工作区并获取图片路径
    let saved_image_paths = if let (Some(ref dir), Some(ref atts)) = (&work_dir, &attachments) {
        if !atts.is_empty() {
            save_attachments(dir, atts)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // 构建包含图片引用的消息
    let final_message = if !saved_image_paths.is_empty() {
        let image_refs: Vec<String> = saved_image_paths.iter()
            .map(|path| format!("[图片: {}]", path))
            .collect();
        format!("{}\n\n{}", image_refs.join("\n"), message)
    } else {
        message
    };

    let engine = engine_id
        .as_ref()
        .and_then(|id| EngineId::from_str(id))
        .unwrap_or(EngineId::ClaudeCode);

    tracing::info!("[start_chat] 使用引擎: {:?}", engine);

    let window_clone = window.clone();
    let ctx_id = context_id.clone();
    let event_callback = move |event: AIEvent| {
        let event_json = if let Some(ref cid) = ctx_id {
            serde_json::json!({ "contextId": cid, "payload": event })
        } else {
            serde_json::json!({ "contextId": "main", "payload": event })
        };

        tracing::debug!("[start_chat] 发送事件: {}", event_json.to_string().chars().take(200).collect::<String>());
        let _ = window_clone.emit("chat-event", &event_json);

        if matches!(event, AIEvent::SessionEnd(_)) {
            notify_ai_reply_complete(&window_clone);
        }
    };

    // session_id 更新回调 - 发送 session_start 事件给前端
    let window_for_session = window.clone();
    let ctx_id_for_session = context_id.clone();
    let session_id_update_callback = move |new_session_id: String| {
        tracing::info!("[start_chat] session_id 更新，发送 session_start 事件: {}", new_session_id);

        let event_json = if let Some(ref cid) = ctx_id_for_session {
            serde_json::json!({
                "contextId": cid,
                "payload": {
                    "type": "session_start",
                    "sessionId": new_session_id
                }
            })
        } else {
            serde_json::json!({
                "contextId": "main",
                "payload": {
                    "type": "session_start",
                    "sessionId": new_session_id
                }
            })
        };

        let _ = window_for_session.emit("chat-event", &event_json);
    };

    let mut options = SessionOptions::new(event_callback);
    options.on_session_id_update = Some(Arc::new(session_id_update_callback));

    if let Some(ref dir) = work_dir {
        options = options.with_work_dir(dir.clone());
    }

    if let Some(ref prompt) = system_prompt {
        options = options.with_system_prompt(prompt.clone());
    }

    if let Some(ref args) = cli_args {
        options = options.with_cli_args(args.clone());
    }

    let mut registry = state.engine_registry.lock().await;
    registry.start_session(Some(engine), &final_message, options)
}

/// 继续聊天会话
#[tauri::command]
pub async fn continue_chat(
    session_id: String,
    message: String,
    window: Window,
    state: State<'_, crate::AppState>,
    work_dir: Option<String>,
    engine_id: Option<String>,
    system_prompt: Option<String>,
    context_id: Option<String>,
    attachments: Option<Vec<Attachment>>,
    cli_args: Option<Vec<String>>,
) -> Result<()> {
    tracing::info!("[continue_chat] 继续会话: {}, 附件数: {:?}, CLI 参数: {:?}", session_id, attachments.as_ref().map(|a| a.len()), cli_args);

    // 保存附件到工作区并获取图片路径
    let saved_image_paths = if let (Some(dir), Some(atts)) = (&work_dir, &attachments) {
        if !atts.is_empty() {
            save_attachments(dir, atts)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // 构建包含图片引用的消息
    let final_message = if !saved_image_paths.is_empty() {
        let image_refs: Vec<String> = saved_image_paths.iter()
            .map(|path| format!("[图片: {}]", path))
            .collect();
        format!("{}\n\n{}", image_refs.join("\n"), message)
    } else {
        message
    };

    let engine = engine_id
        .as_ref()
        .and_then(|id| EngineId::from_str(id))
        .ok_or_else(|| AppError::ValidationError("必须提供有效的 engine_id".to_string()))?;

    tracing::info!("[continue_chat] 使用引擎: {:?}", engine);

    let window_clone = window.clone();
    let ctx_id = context_id.clone();
    let event_callback = move |event: AIEvent| {
        let event_json = if let Some(ref cid) = ctx_id {
            serde_json::json!({ "contextId": cid, "payload": event })
        } else {
            serde_json::json!({ "contextId": "main", "payload": event })
        };

        tracing::debug!("[continue_chat] 发送事件: {}", event_json.to_string().chars().take(200).collect::<String>());
        let _ = window_clone.emit("chat-event", &event_json);

        if matches!(event, AIEvent::SessionEnd(_)) {
            notify_ai_reply_complete(&window_clone);
        }
    };

    // session_id 更新回调
    let window_for_session = window.clone();
    let ctx_id_for_session = context_id.clone();
    let session_id_update_callback = move |new_session_id: String| {
        tracing::info!("[continue_chat] session_id 更新: {}", new_session_id);

        let event_json = if let Some(ref cid) = ctx_id_for_session {
            serde_json::json!({
                "contextId": cid,
                "payload": {
                    "type": "session_start",
                    "sessionId": new_session_id
                }
            })
        } else {
            serde_json::json!({
                "contextId": "main",
                "payload": {
                    "type": "session_start",
                    "sessionId": new_session_id
                }
            })
        };

        let _ = window_for_session.emit("chat-event", &event_json);
    };

    let mut options = SessionOptions::new(event_callback);
    options.on_session_id_update = Some(Arc::new(session_id_update_callback));

    if let Some(ref dir) = work_dir {
        options = options.with_work_dir(dir.clone());
    }

    if let Some(ref prompt) = system_prompt {
        options = options.with_system_prompt(prompt.clone());
    }

    if let Some(ref args) = cli_args {
        options = options.with_cli_args(args.clone());
    }

    let mut registry = state.engine_registry.lock().await;
    registry.continue_session(engine, &session_id, &final_message, options)
}

/// 中断聊天会话
#[tauri::command]
pub async fn interrupt_chat(
    session_id: String,
    engine_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!("[interrupt_chat] 中断会话: {}", session_id);

    // 1. 先检查 OpenAI Proxy 任务
    {
        let mut tasks = state.openai_tasks.lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        if let Some(token) = tasks.remove(&session_id) {
            token.cancel();
            tracing::info!("[interrupt_chat] OpenAI Proxy 会话已中断: {}", session_id);
            return Ok(());
        }
    }

    // 2. 检查 EngineRegistry 中的引擎
    let engine = engine_id.as_ref().and_then(|id| EngineId::from_str(id));

    let mut registry = state.engine_registry.lock().await;

    if let Some(engine) = engine {
        registry.interrupt(&engine, &session_id)?;
    } else {
        // 遍历所有已注册的引擎尝试中断
        if !registry.try_interrupt_all(&session_id) {
            return Err(AppError::ProcessError(format!("未找到会话: {}", session_id)));
        }
    }

    tracing::info!("[interrupt_chat] 会话已中断: {}", session_id);
    Ok(())
}

// ============================================================================
// 辅助函数
// ============================================================================

fn notify_ai_reply_complete(window: &Window) {
    let _ = window
        .notification()
        .builder()
        .title("Polaris")
        .body("已完成本轮回复")
        .show();
}

// ============================================================================
// 统一会话历史接口（支持分页）
// ============================================================================

/// 列出会话（统一接口，支持分页）
#[tauri::command]
pub async fn list_sessions(
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    work_dir: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PagedResult<SessionMeta>> {
    tracing::info!("[list_sessions] 引擎: {}, 页码: {:?}", engine_id, page);

    let pagination = Pagination::new(page.unwrap_or(1), page_size.unwrap_or(50));

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
        "iflow" => {
            let provider = IFlowHistoryProvider::new(config);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
        _ => Err(AppError::ValidationError(format!("不支持的引擎: {}", engine_id))),
    }
}

/// 获取会话历史（统一接口，支持分页）
#[tauri::command]
pub async fn get_session_history(
    session_id: String,
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PagedResult<HistoryMessage>> {
    tracing::info!("[get_session_history] 会话: {}, 页码: {:?}", session_id, page);

    let pagination = Pagination::new(page.unwrap_or(1), page_size.unwrap_or(50));

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        }
        "iflow" => {
            let provider = IFlowHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        }
        _ => Err(AppError::ValidationError(format!("不支持的引擎: {}", engine_id))),
    }
}

/// 删除会话
#[tauri::command]
pub async fn delete_session(
    session_id: String,
    engine_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!("[delete_session] 删除会话: {}", session_id);

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.delete_session(&session_id)
        }
        "iflow" => {
            let provider = IFlowHistoryProvider::new(config);
            provider.delete_session(&session_id)
        }
        _ => Err(AppError::ValidationError(format!("不支持的引擎: {}", engine_id))),
    }
}

// ============================================================================
// IFlow 特有功能（保留向后兼容）
// ============================================================================

use crate::models::iflow_events::{
    IFlowSessionMeta, IFlowHistoryMessage, IFlowFileContext, IFlowTokenStats,
};

/// 列出 IFlow 会话（旧接口，保留向后兼容）
#[tauri::command]
pub async fn list_iflow_sessions(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<IFlowSessionMeta>> {
    tracing::info!("[list_iflow_sessions] 获取 IFlow 会话列表");

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let config = config_store.get().clone();
    crate::services::iflow_service::IFlowService::list_sessions(&config)
}

/// 获取 IFlow 会话历史（旧接口，保留向后兼容）
#[tauri::command]
pub async fn get_iflow_session_history(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<IFlowHistoryMessage>> {
    tracing::info!("[get_iflow_session_history] 获取会话历史: {}", session_id);

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let config = config_store.get().clone();
    crate::services::iflow_service::IFlowService::get_session_history(&config, &session_id)
}

/// 获取 IFlow 文件上下文
#[tauri::command]
pub async fn get_iflow_file_contexts(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<IFlowFileContext>> {
    tracing::info!("[get_iflow_file_contexts] 获取文件上下文: {}", session_id);

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let config = config_store.get().clone();
    crate::services::iflow_service::IFlowService::get_file_contexts(&config, &session_id)
}

/// 获取 IFlow Token 统计
#[tauri::command]
pub async fn get_iflow_token_stats(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<IFlowTokenStats> {
    tracing::info!("[get_iflow_token_stats] 获取 Token 统计: {}", session_id);

    let config_store = state.config_store.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let config = config_store.get().clone();
    crate::services::iflow_service::IFlowService::get_token_stats(&config, &session_id)
}

// ============================================================================
// Claude Code 会话历史（旧接口，保留向后兼容）
// ============================================================================

use std::process::Command;
use std::io::{BufRead, BufReader};

/// Claude Code 会话元数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionMeta {
    pub session_id: String,
    pub project_path: String,
    pub first_prompt: Option<String>,
    pub message_count: usize,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub file_path: String,
    pub file_size: u64,
}

/// Claude Code 历史消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryMessage {
    pub role: String,
    /// 内容可能是字符串或数组（包含 text、tool_use、tool_result 等）
    pub content: serde_json::Value,
    pub timestamp: Option<String>,
}

/// 解析会话文件获取元数据
fn parse_session_metadata(file_path: &PathBuf) -> (Option<String>, usize, Option<String>) {
    let mut first_prompt: Option<String> = None;
    let mut message_count = 0usize;
    let mut created: Option<String> = None;

    if let Ok(file) = std::fs::File::open(file_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().filter_map(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    if msg_type == "user" {
                        message_count += 1;
                        // 获取第一条用户消息作为标题
                        if first_prompt.is_none() {
                            if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                let prompt_text = if let Some(text) = content.as_str() {
                                    // 字符串格式
                                    Some(text.to_string())
                                } else if let Some(arr) = content.as_array() {
                                    // 数组格式，提取第一个 text 类型
                                    let mut found = None;
                                    for item in arr {
                                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                found = Some(text.to_string());
                                                break;
                                            }
                                        }
                                    }
                                    found
                                } else {
                                    None
                                };

                                if let Some(text) = prompt_text {
                                    // 截取前 100 个字符作为标题（使用 chars() 正确处理 Unicode）
                                    let title = if text.chars().count() > 100 {
                                        format!("{}...", text.chars().take(100).collect::<String>())
                                    } else {
                                        text
                                    };
                                    first_prompt = Some(title);
                                }
                            }
                        }
                        // 获取创建时间（第一条消息的时间戳）
                        if created.is_none() {
                            created = json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());
                        }
                    } else if msg_type == "assistant" {
                        message_count += 1;
                    }
                }
            }
        }
    }

    (first_prompt, message_count, created)
}

/// 列出 Claude Code 会话（旧接口）
#[tauri::command]
pub async fn list_claude_code_sessions(
    _state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ClaudeSessionMeta>> {
    tracing::info!("[list_claude_code_sessions] 获取 Claude Code 会话列表");

    let claude_dir = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    } else {
        std::env::var("HOME")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    };

    let mut sessions = Vec::new();

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

                            // 获取文件元数据
                            let file_size = std::fs::metadata(&path)
                                .map(|m| m.len())
                                .unwrap_or(0);

                            let modified = std::fs::metadata(&path)
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .map(|t| {
                                    let datetime: chrono::DateTime<chrono::Utc> = t.into();
                                    datetime.to_rfc3339()
                                });

                            // 解析会话内容获取详细信息
                            let (first_prompt, message_count, created) = parse_session_metadata(&path);

                            sessions.push(ClaudeSessionMeta {
                                session_id,
                                project_path: project_name.clone(),
                                first_prompt,
                                message_count,
                                created,
                                modified,
                                file_path: path.to_string_lossy().to_string(),
                                file_size,
                            });
                        }
                    }
                }
            }
        }
    }

    // 按修改时间排序（最新的在前）
    sessions.sort_by(|a, b| {
        let time_a = a.modified.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        let time_b = b.modified.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        time_b.cmp(&time_a)
    });

    Ok(sessions)
}

/// 获取 Claude Code 会话历史（旧接口）
#[tauri::command]
pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
    _state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ClaudeHistoryMessage>> {
    tracing::info!("[get_claude_code_session_history] 获取会话历史: {}", session_id);

    let claude_dir = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    } else {
        std::env::var("HOME")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    };

    let session_file = if let Some(project) = &project_path {
        claude_dir.join(project).join(format!("{}.jsonl", session_id))
    } else {
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(&claude_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let candidate = entry.path().join(format!("{}.jsonl", session_id));
                    if candidate.exists() {
                        found = Some(candidate);
                        break;
                    }
                }
            }
        }
        found.unwrap_or_else(|| claude_dir.join(format!("{}.jsonl", session_id)))
    };

    if !session_file.exists() {
        return Err(AppError::ValidationError(format!("会话文件不存在: {:?}", session_file)));
    }

    let mut messages = Vec::new();

    if let Ok(file) = std::fs::File::open(&session_file) {
        let reader = BufReader::new(file);
        for line in reader.lines().filter_map(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    match msg_type {
                        "user" => {
                            // 用户消息：content 可能是字符串或数组
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    messages.push(ClaudeHistoryMessage {
                                        role: "user".to_string(),
                                        content: content.clone(),
                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                    });
                                }
                            }
                        }
                        "assistant" => {
                            // 助手消息：content 通常是数组（包含 text、tool_use 等）
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    messages.push(ClaudeHistoryMessage {
                                        role: "assistant".to_string(),
                                        content: content.clone(),
                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(messages)
}

// ============================================================================
// Codex 会话历史
// ============================================================================

/// Codex 会话元数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionMeta {
    pub session_id: String,
    pub project_path: String,
    pub created_at: Option<String>,
    pub message_count: Option<usize>,
}

/// Codex 历史消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoryMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

/// Codex 路径验证结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPathValidationResult {
    pub valid: bool,
    pub error: Option<String>,
    pub version: Option<String>,
}

/// 查找 Codex 路径
#[tauri::command]
pub fn find_codex_paths() -> Vec<String> {
    let mut paths = Vec::new();

    if let Ok(path_env) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ";" } else { ":" };
        for dir in path_env.split(separator) {
            let codex_path = PathBuf::from(dir).join(if cfg!(windows) { "codex.cmd" } else { "codex" });
            if codex_path.exists() {
                paths.push(codex_path.to_string_lossy().to_string());
            }
        }
    }

    if cfg!(windows) {
        if let Ok(username) = std::env::var("USERNAME") {
            {
                let template = r"C:\Users\{}\AppData\Roaming\npm\codex.cmd";
                let path = template.replace("{}", &username);
                if PathBuf::from(&path).exists() {
                    paths.push(path);
                }
            }
        }
    } else {
        for path in ["/usr/local/bin/codex", "/usr/bin/codex", "/opt/homebrew/bin/codex"] {
            if PathBuf::from(path).exists() {
                paths.push(path.to_string());
            }
        }
    }

    paths
}

/// 验证 Codex 路径
#[tauri::command]
pub fn validate_codex_path(path: String) -> CodexPathValidationResult {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return CodexPathValidationResult {
            valid: false,
            error: Some("路径不存在".to_string()),
            version: None,
        };
    }

    #[cfg(windows)]
    let version = std::process::Command::new(&path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    #[cfg(not(windows))]
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    CodexPathValidationResult {
        valid: true,
        error: None,
        version,
    }
}

/// 列出 Codex 会话
#[tauri::command]
pub fn list_codex_sessions(work_dir: Option<String>) -> Result<Vec<CodexSessionMeta>> {
    tracing::info!("[list_codex_sessions] 获取 Codex 会话列表");

    let base_dir = work_dir
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .map(PathBuf::from)
                .ok()
        })
        .unwrap_or_else(|| PathBuf::from("."));

    let codex_dir = base_dir.join(".codex").join("sessions");
    let mut sessions = Vec::new();

    if codex_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&codex_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    let session_id = path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();

                    sessions.push(CodexSessionMeta {
                        session_id,
                        project_path: base_dir.to_string_lossy().to_string(),
                        created_at: None,
                        message_count: None,
                    });
                }
            }
        }
    }

    Ok(sessions)
}

/// 获取 Codex 会话历史
#[tauri::command]
pub fn get_codex_session_history(file_path: String) -> Result<Vec<CodexHistoryMessage>> {
    tracing::info!("[get_codex_session_history] 获取会话历史: {}", file_path);

    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Err(AppError::ValidationError(format!("会话文件不存在: {}", file_path)));
    }

    let mut messages = Vec::new();

    if let Ok(file) = std::fs::File::open(&path) {
        let reader = BufReader::new(file);
        for line in reader.lines().filter_map(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(role) = json.get("role").and_then(|r| r.as_str()) {
                    if let Some(content) = json.get("content").and_then(|c| c.as_str()) {
                        messages.push(CodexHistoryMessage {
                            role: role.to_string(),
                            content: content.to_string(),
                            timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                        });
                    }
                }
            }
        }
    }

    Ok(messages)
}
