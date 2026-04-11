/*! 聊天命令模块
 *
 * 提供统一的 AI 聊天接口，使用 EngineRegistry 管理多种 AI 引擎。
 */

use std::sync::Arc;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};

use crate::ai::{EngineId, Pagination, PagedResult, SessionOptions};
use crate::ai::{SessionMeta, HistoryMessage, ClaudeHistoryProvider, SessionHistoryProvider};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use crate::services::mcp_config_service::WorkspaceMcpConfigService;
use tauri::{Emitter, Manager, State, Window};
use tauri_plugin_notification::NotificationExt;


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

/// 聊天请求的可选参数
/// 用于减少 start_chat 和 continue_chat 函数的参数数量
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequestOptions {
    /// 工作目录
    #[serde(default)]
    pub work_dir: Option<String>,
    /// 引擎 ID
    #[serde(default)]
    pub engine_id: Option<String>,
    /// 系统提示词（用户自定义，会覆盖默认部分）
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// 追加到默认系统提示词的内容（工作区信息等，始终追加）
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    /// 是否启用 MCP 工具
    #[serde(default)]
    pub enable_mcp_tools: Option<bool>,
    /// 上下文 ID
    #[serde(default)]
    pub context_id: Option<String>,
    /// 附件列表
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
    /// 关联工作区路径列表（通过 --add-dir 传递给 Claude CLI）
    #[serde(default)]
    pub additional_dirs: Option<Vec<String>>,
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

fn prepare_mcp_config_path(options: &ChatRequestOptions, engine: &EngineId, window: &Window) -> Result<Option<String>> {
    let enable_mcp_tools = options.enable_mcp_tools.unwrap_or(false);
    if !enable_mcp_tools || !matches!(engine, EngineId::ClaudeCode) {
        return Ok(None);
    }

    let work_dir = match options.work_dir.as_deref() {
        Some(dir) if !dir.trim().is_empty() => dir,
        _ => return Ok(None),
    };

    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::ProcessError("无法确定应用根目录".to_string()))?
        .to_path_buf();
    let resource_dir = window.path().resource_dir().ok();
    let config_dir = window.path().app_config_dir()
        .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let service = WorkspaceMcpConfigService::from_app_paths(config_dir, resource_dir, app_root)?;
    let config_path = service.prepare_workspace_config(work_dir)?;
    Ok(Some(config_path.to_string_lossy().to_string()))
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
    options: ChatRequestOptions,
) -> Result<String> {
    tracing::info!("[start_chat] 收到消息，长度: {} 字符, 附件数: {:?}", message.len(), options.attachments.as_ref().map(|a| a.len()));

    // 保存附件到工作区并获取图片路径
    let saved_image_paths = if let (Some(ref dir), Some(ref atts)) = (&options.work_dir, &options.attachments) {
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

    let engine = options.engine_id
        .as_ref()
        .and_then(|id| EngineId::from_str(id))
        .unwrap_or(EngineId::ClaudeCode);

    tracing::info!("[start_chat] 使用引擎: {:?}", engine);
    let mcp_config_path = prepare_mcp_config_path(&options, &engine, &window)?;

    let window_clone = window.clone();
    let ctx_id = options.context_id.clone();
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
    let ctx_id_for_session = options.context_id.clone();
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

    let mut session_opts = SessionOptions::new(event_callback);
    session_opts.on_session_id_update = Some(Arc::new(session_id_update_callback));

    if let Some(ref dir) = options.work_dir {
        session_opts = session_opts.with_work_dir(dir.clone());
    }

    if let Some(ref prompt) = options.system_prompt {
        session_opts = session_opts.with_system_prompt(prompt.clone());
    }

    if let Some(ref prompt) = options.append_system_prompt {
        session_opts = session_opts.with_append_system_prompt(prompt.clone());
    }

    if let Some(ref mcp_config_path) = mcp_config_path {
        session_opts = session_opts.with_mcp_config_path(mcp_config_path.clone());
    }

    if let Some(ref dirs) = options.additional_dirs {
        session_opts.additional_dirs = dirs.clone();
    }

    let mut registry = state.engine_registry.lock().await;
    registry.start_session(Some(engine), &final_message, session_opts)
}

/// 继续聊天会话
#[tauri::command]
pub async fn continue_chat(
    session_id: String,
    message: String,
    window: Window,
    state: State<'_, crate::AppState>,
    options: ChatRequestOptions,
) -> Result<()> {
    tracing::info!("[continue_chat] 继续会话: {}, 附件数: {:?}", session_id, options.attachments.as_ref().map(|a| a.len()));

    // 保存附件到工作区并获取图片路径
    let saved_image_paths = if let (Some(dir), Some(atts)) = (&options.work_dir, &options.attachments) {
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

    let engine = options.engine_id
        .as_ref()
        .and_then(|id| EngineId::from_str(id))
        .ok_or_else(|| AppError::ValidationError("必须提供有效的 engine_id".to_string()))?;

    tracing::info!("[continue_chat] 使用引擎: {:?}", engine);
    let mcp_config_path = prepare_mcp_config_path(&options, &engine, &window)?;

    let window_clone = window.clone();
    let ctx_id = options.context_id.clone();
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
    let ctx_id_for_session = options.context_id.clone();
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

    let mut session_opts = SessionOptions::new(event_callback);
    session_opts.on_session_id_update = Some(Arc::new(session_id_update_callback));

    if let Some(ref dir) = options.work_dir {
        session_opts = session_opts.with_work_dir(dir.clone());
    }

    if let Some(ref prompt) = options.system_prompt {
        session_opts = session_opts.with_system_prompt(prompt.clone());
    }

    if let Some(ref prompt) = options.append_system_prompt {
        session_opts = session_opts.with_append_system_prompt(prompt.clone());
    }

    if let Some(ref mcp_config_path) = mcp_config_path {
        session_opts = session_opts.with_mcp_config_path(mcp_config_path.clone());
    }

    if let Some(ref dirs) = options.additional_dirs {
        session_opts.additional_dirs = dirs.clone();
    }

    let mut registry = state.engine_registry.lock().await;
    registry.continue_session(engine, &session_id, &final_message, session_opts)
}

/// 中断聊天会话
#[tauri::command]
pub async fn interrupt_chat(
    session_id: String,
    engine_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!("[interrupt_chat] 中断会话: {}", session_id);

    // 检查 EngineRegistry 中的引擎
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
        _ => Err(AppError::ValidationError(format!("不支持的引擎: {}", engine_id))),
    }
}

// ============================================================================
// Claude Code 会话历史（旧接口，保留向后兼容）
// ============================================================================

use std::io::{BufRead, BufReader};

/// Claude Code 会话元数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionMeta {
    pub session_id: String,
    /// 真实工作区路径（用于前端匹配/创建工作区）
    pub project_path: String,
    /// Claude Code 目录名（用于定位 jsonl 文件）
    pub claude_project_name: String,
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

/// 解析会话文件获取元数据（包括真实工作区路径 cwd）
fn parse_session_metadata(file_path: &PathBuf) -> (Option<String>, usize, Option<String>, Option<String>) {
    let mut first_prompt: Option<String> = None;
    let mut message_count = 0usize;
    let mut created: Option<String> = None;
    let mut cwd: Option<String> = None;

    if let Ok(file) = std::fs::File::open(file_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
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
                        // 获取真实工作区路径（cwd）
                        if cwd.is_none() {
                            cwd = json.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string());
                        }
                    } else if msg_type == "assistant" {
                        message_count += 1;
                    }
                }
            }
        }
    }

    (first_prompt, message_count, created, cwd)
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
                            let (first_prompt, message_count, created, real_cwd) = parse_session_metadata(&path);

                            // claude_project_name: Claude Code 目录名（用于定位 jsonl 文件）
                            let claude_project_name = project_name.clone();
                            // project_path: 真实工作区路径（用于前端匹配/创建工作区）
                            let project_path = real_cwd.unwrap_or_else(|| project_name.clone());

                            sessions.push(ClaudeSessionMeta {
                                session_id,
                                project_path,
                                claude_project_name,
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
        for line in reader.lines().map_while(|r| r.ok()) {
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
// AskUserQuestion 相关命令
// ============================================================================

use crate::state::{PendingQuestion, QuestionOption, QuestionStatus, QuestionAnswer};

/// 注册待回答问题
///
/// 当收到 ask_user_question 工具调用时调用此函数
#[tauri::command]
pub fn register_pending_question(
    session_id: String,
    call_id: String,
    header: String,
    multi_select: bool,
    options: Vec<QuestionOption>,
    allow_custom_input: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[register_pending_question] 注册问题: session={}, call={}, header={}",
        session_id, call_id, header
    );

    let question = PendingQuestion {
        call_id: call_id.clone(),
        session_id,
        header,
        multi_select,
        options,
        allow_custom_input,
        status: QuestionStatus::Pending,
    };

    let mut pending = state.pending_questions.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(call_id, question);

    Ok(())
}

/// 回答问题
///
/// 用户提交答案后调用此函数
#[tauri::command]
pub async fn answer_question(
    session_id: String,
    call_id: String,
    answer: QuestionAnswer,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[answer_question] 回答问题: session={}, call={}, selected={:?}, custom={:?}",
        session_id, call_id, answer.selected, answer.custom_input
    );

    // 更新问题状态
    {
        let mut pending = state.pending_questions.lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if let Some(question) = pending.get_mut(&call_id) {
            question.status = QuestionStatus::Answered;
        } else {
            tracing::warn!("[answer_question] 问题不存在: {}", call_id);
        }
    }

    // 发送事件通知前端问题已回答
    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": session_id,
        "callId": call_id,
        "answer": answer,
    });

    window.emit("chat-event", &event)
        .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    tracing::info!("[answer_question] 答案已提交，事件已发送");

    Ok(())
}

/// 获取待回答问题列表
#[tauri::command]
pub fn get_pending_questions(
    session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PendingQuestion>> {
    let pending = state.pending_questions.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let questions: Vec<PendingQuestion> = pending
        .values()
        .filter(|q| {
            if let Some(ref sid) = session_id {
                &q.session_id == sid
            } else {
                true
            }
        })
        .filter(|q| matches!(q.status, QuestionStatus::Pending))
        .cloned()
        .collect();

    Ok(questions)
}

/// 清除已回答的问题
#[tauri::command]
pub fn clear_answered_questions(
    state: tauri::State<'_, crate::AppState>,
) -> Result<usize> {
    let mut pending = state.pending_questions.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let initial_count = pending.len();
    pending.retain(|_, q| matches!(q.status, QuestionStatus::Pending));
    let removed = initial_count - pending.len();

    tracing::info!("[clear_answered_questions] 清除了 {} 个已回答问题", removed);

    Ok(removed)
}

// ============================================================================
// PlanMode 相关命令
// ============================================================================

use crate::state::{PendingPlan, PlanApprovalStatus};
use crate::models::PlanApprovalResultEvent;

/// 注册待审批计划
///
/// 当收到 plan_approval_request 事件时调用此函数
#[tauri::command]
pub fn register_pending_plan(
    session_id: String,
    plan_id: String,
    title: Option<String>,
    description: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[register_pending_plan] 注册计划: session={}, plan={}, title={:?}",
        session_id, plan_id, title
    );

    let plan = PendingPlan {
        plan_id: plan_id.clone(),
        session_id,
        title,
        description,
        status: PlanApprovalStatus::Pending,
        feedback: None,
    };

    let mut pending = state.pending_plans.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(plan_id, plan);

    Ok(())
}

/// 批准计划
///
/// 用户批准计划后调用此函数
#[tauri::command]
pub async fn approve_plan(
    session_id: String,
    plan_id: String,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[approve_plan] 批准计划: session={}, plan={}",
        session_id, plan_id
    );

    // 更新计划状态
    {
        let mut pending = state.pending_plans.lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if let Some(plan) = pending.get_mut(&plan_id) {
            plan.status = PlanApprovalStatus::Approved;
        } else {
            tracing::warn!("[approve_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已批准
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, true);

    window.emit("chat-event", &serde_json::json!({
        "contextId": "main",
        "payload": event
    }))
    .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    tracing::info!("[approve_plan] 计划已批准，事件已发送");

    Ok(())
}

/// 拒绝计划
///
/// 用户拒绝计划后调用此函数
#[tauri::command]
pub async fn reject_plan(
    session_id: String,
    plan_id: String,
    feedback: Option<String>,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[reject_plan] 拒绝计划: session={}, plan={}, feedback={:?}",
        session_id, plan_id, feedback
    );

    // 更新计划状态
    {
        let mut pending = state.pending_plans.lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if let Some(plan) = pending.get_mut(&plan_id) {
            plan.status = PlanApprovalStatus::Rejected;
            plan.feedback = feedback.clone();
        } else {
            tracing::warn!("[reject_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已拒绝
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, false)
        .with_feedback(feedback.unwrap_or_default());

    window.emit("chat-event", &serde_json::json!({
        "contextId": "main",
        "payload": event
    }))
    .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    tracing::info!("[reject_plan] 计划已拒绝，事件已发送");

    Ok(())
}

/// 获取待审批计划列表
#[tauri::command]
pub fn get_pending_plans(
    session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PendingPlan>> {
    let pending = state.pending_plans.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let plans: Vec<PendingPlan> = pending
        .values()
        .filter(|p| {
            if let Some(ref sid) = session_id {
                &p.session_id == sid
            } else {
                true
            }
        })
        .filter(|p| matches!(p.status, PlanApprovalStatus::Pending))
        .cloned()
        .collect();

    Ok(plans)
}

/// 清除已处理的计划
#[tauri::command]
pub fn clear_processed_plans(
    state: tauri::State<'_, crate::AppState>,
) -> Result<usize> {
    let mut pending = state.pending_plans.lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let initial_count = pending.len();
    pending.retain(|_, p| matches!(p.status, PlanApprovalStatus::Pending));
    let removed = initial_count - pending.len();

    tracing::info!("[clear_processed_plans] 清除了 {} 个已处理计划", removed);

    Ok(removed)
}

// ============================================================================
// stdin 输入相关命令
// ============================================================================

/// 向会话发送输入
///
/// 通过 stdin 向运行中的会话发送输入数据
#[tauri::command]
pub async fn send_input(
    session_id: String,
    input: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool> {
    tracing::info!("[send_input] 向会话 {} 发送输入: {} bytes", session_id, input.len());

    let mut registry = state.engine_registry.lock().await;
    registry.send_input(&session_id, &input)
}
