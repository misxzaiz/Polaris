/*! 聊天命令模块
 *
 * 提供统一的 AI 聊天接口，使用 EngineRegistry 管理多种 AI 引擎。
 */

use std::sync::Arc;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};

use crate::ai::{EngineId, Pagination, PagedResult, SessionOptions, ImageAttachment};
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
    /// 附件类型 ("image" | "file")
    #[serde(rename = "type")]
    pub attachment_type: String,
    /// 文件名
    pub file_name: String,
    /// MIME 类型
    pub mime_type: String,
    /// 二进制内容 (base64 data URL，用于图片和二进制文件)
    #[serde(default)]
    pub content: String,
    /// 文本内容（前端直接读取的文本，用于文本/代码文件，避免 base64 膨胀）
    #[serde(default)]
    pub text_content: Option<String>,
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
    /// CLI Agent 选择
    #[serde(default)]
    pub agent: Option<String>,
    /// 模型选择
    #[serde(default)]
    pub model: Option<String>,
    /// 努力级别
    #[serde(default)]
    pub effort: Option<String>,
    /// 权限模式
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// 允许的工具列表（权限重试时使用）
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// Fork 来源会话 ID（配合 --fork-session 创建分支会话）
    #[serde(default)]
    pub fork_session_id: Option<String>,
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 附件处理结果
struct ProcessedAttachment {
    /// 需要嵌入到消息中的文本段落
    embedded_sections: Vec<String>,
    /// 需要用 Read 工具查看的文件路径（大文件、二进制文件）
    file_references: Vec<String>,
    /// 图片原始数据（用于 stream-json 模式原生传递给模型）
    image_data: Vec<ImageData>,
}

/// 图片原始数据
struct ImageData {
    /// MIME 类型（如 "image/png"）
    media_type: String,
    /// 纯 base64 数据（不含 data: 前缀）
    data: String,
    /// 文件名（日志用）
    file_name: String,
}

/// 处理附件：图片存盘 + 文本嵌入 + 大文件存盘引用
///
/// 策略：
/// - 图片：保存到 .polaris/ → 模型通过 Read 工具查看
/// - 文本/代码文件 (< 30KB)：直接嵌入消息文本
/// - 文本/代码文件 (> 30KB) + 其他二进制：保存到 .polaris/ → 引用路径
fn process_attachments(work_dir: &str, attachments: &[Attachment]) -> Result<ProcessedAttachment> {
    let polaris_dir = PathBuf::from(work_dir).join(".polaris");
    let mut result = ProcessedAttachment {
        embedded_sections: Vec::new(),
        file_references: Vec::new(),
        image_data: Vec::new(),
    };

    // 创建 .polaris 目录（如果不存在）
    if !polaris_dir.exists() {
        std::fs::create_dir_all(&polaris_dir)
            .map_err(|e| AppError::ProcessError(format!("创建 .polaris 目录失败: {}", e)))?;
    }

    /// 文本文件嵌入阈值 (30KB)
    const TEXT_EMBED_THRESHOLD: usize = 30 * 1024;

    let mut file_index: usize = 0;

    for attachment in attachments {
        match attachment.attachment_type.as_str() {
            "image" => {
                // 图片：提取纯 base64 数据，用于 stream-json 原生传递
                let (raw_base64, media_type) = if attachment.content.starts_with("data:") {
                    // data URL 格式: "data:image/png;base64,<data>"
                    let parts: Vec<&str> = attachment.content.splitn(2, ",").collect();
                    if parts.len() != 2 {
                        tracing::warn!("[process_attachments] 无法解析图片 data URL: {}", &attachment.content[..50.min(attachment.content.len())]);
                        continue;
                    }
                    // 从 data URL 中提取 MIME 类型
                    let mime = parts[0]
                        .strip_prefix("data:")
                        .and_then(|s| s.split(';').next())
                        .unwrap_or(&attachment.mime_type)
                        .to_string();
                    (parts[1].to_string(), mime)
                } else if !attachment.content.is_empty() {
                    // 已经是纯 base64
                    (attachment.content.clone(), attachment.mime_type.clone())
                } else {
                    tracing::warn!("[process_attachments] 图片附件无内容: {}", attachment.file_name);
                    continue;
                };

                tracing::info!(
                    "[process_attachments] 收集图片: {} ({}), base64 长度: {}",
                    attachment.file_name, media_type, raw_base64.len()
                );
                result.image_data.push(ImageData {
                    media_type,
                    data: raw_base64,
                    file_name: attachment.file_name.clone(),
                });
            }
            "file" => {
                // 文本/代码文件：优先使用前端传递的 textContent
                if let Some(ref text) = attachment.text_content {
                    if text.len() <= TEXT_EMBED_THRESHOLD {
                        // 小文件：直接嵌入消息
                        let ext = attachment.file_name.rsplit('.').next().unwrap_or("txt");
                        result.embedded_sections.push(format!(
                            "📎 [文件: {}]\n```{}\n{}\n```",
                            attachment.file_name, ext, text
                        ));
                        tracing::info!("[process_attachments] 嵌入文本文件: {} ({} bytes)", attachment.file_name, text.len());
                    } else {
                        // 大文件：保存到磁盘
                        let ext = attachment.file_name.rsplit('.').next().unwrap_or("txt");
                        let file_name = format!("file_{}.{}", file_index, ext);
                        let file_path = polaris_dir.join(&file_name);

                        std::fs::write(&file_path, text.as_bytes())
                            .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;

                        tracing::info!("[process_attachments] 保存大文本文件: {:?} ({} bytes)", file_path, text.len());
                        result.file_references.push(format!("文件 {} → .polaris/{}", attachment.file_name, file_name));
                        file_index += 1;
                    }
                } else if !attachment.content.is_empty() {
                    // 有 base64 内容但没有 textContent（二进制文件或旧前端）
                    let base64_data = if attachment.content.starts_with("data:") {
                        let parts: Vec<&str> = attachment.content.splitn(2, ",").collect();
                        if parts.len() == 2 { parts[1] } else { continue; }
                    } else {
                        &attachment.content
                    };

                    let decoded = BASE64_STANDARD.decode(base64_data)
                        .map_err(|e| AppError::ProcessError(format!("解码文件 base64 失败: {}", e)))?;

                    // 尝试作为文本解码
                    if let Ok(text) = String::from_utf8(decoded.clone()) {
                        if text.len() <= TEXT_EMBED_THRESHOLD {
                            let ext = attachment.file_name.rsplit('.').next().unwrap_or("txt");
                            result.embedded_sections.push(format!(
                                "📎 [文件: {}]\n```{}\n{}\n```",
                                attachment.file_name, ext, text
                            ));
                            tracing::info!("[process_attachments] 嵌入 base64 文本文件: {} ({} bytes)", attachment.file_name, text.len());
                        } else {
                            let ext = attachment.file_name.rsplit('.').next().unwrap_or("bin");
                            let file_name = format!("file_{}.{}", file_index, ext);
                            let file_path = polaris_dir.join(&file_name);
                            std::fs::write(&file_path, &decoded)
                                .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;
                            result.file_references.push(format!("文件 {} → .polaris/{}", attachment.file_name, file_name));
                            file_index += 1;
                        }
                    } else {
                        // 纯二进制：保存到磁盘
                        let ext = attachment.file_name.rsplit('.').next().unwrap_or("bin");
                        let file_name = format!("file_{}.{}", file_index, ext);
                        let file_path = polaris_dir.join(&file_name);
                        std::fs::write(&file_path, &decoded)
                            .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;
                        result.file_references.push(format!("二进制文件 {} → .polaris/{}", attachment.file_name, file_name));
                        file_index += 1;
                    }
                } else {
                    tracing::warn!("[process_attachments] 文件附件无内容: {}", attachment.file_name);
                }
            }
            _ => {
                tracing::warn!("[process_attachments] 未知附件类型: {}", attachment.attachment_type);
            }
        }
    }

    Ok(result)
}

/// 根据 MIME 类型和文件名猜测图片扩展名（保留用于未来图片导出需求）
#[allow(dead_code)]
fn guess_image_ext(mime_type: &str, file_name: &str) -> String {
    match mime_type {
        "image/png" => "png".to_string(),
        "image/jpeg" | "image/jpg" => "jpg".to_string(),
        "image/gif" => "gif".to_string(),
        "image/webp" => "webp".to_string(),
        "image/bmp" => "bmp".to_string(),
        "image/svg+xml" => "svg".to_string(),
        _ => file_name.rsplit('.').next().unwrap_or("png").to_string(),
    }
}

/// 构建包含附件内容的最终消息
fn build_message_with_attachments(message: &str, processed: &ProcessedAttachment) -> String {
    if processed.embedded_sections.is_empty() && processed.file_references.is_empty() {
        return message.to_string();
    }

    let mut parts = Vec::new();

    // 嵌入的文本内容（直接可见）
    if !processed.embedded_sections.is_empty() {
        parts.extend(processed.embedded_sections.clone());
    }

    // 用户原始消息
    if !message.is_empty() {
        parts.push(message.to_string());
    }

    // 文件引用（需要模型用 Read 工具查看）
    if !processed.file_references.is_empty() {
        let refs: Vec<String> = processed.file_references.iter()
            .map(|r| format!("- {}", r))
            .collect();
        parts.push(format!(
            "用户上传了以下文件，请使用 Read 工具查看它们:\n{}",
            refs.join("\n")
        ));
    }

    parts.join("\n\n")
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

    // 处理附件：图片收集 base64 + 文本嵌入 + 大文件存盘引用
    let processed = if let (Some(ref dir), Some(ref atts)) = (&options.work_dir, &options.attachments) {
        if !atts.is_empty() {
            process_attachments(dir, atts)?
        } else {
            ProcessedAttachment { embedded_sections: Vec::new(), file_references: Vec::new(), image_data: Vec::new() }
        }
    } else {
        ProcessedAttachment { embedded_sections: Vec::new(), file_references: Vec::new(), image_data: Vec::new() }
    };

    // 构建包含附件内容的最终消息（文本部分）
    let final_message = build_message_with_attachments(&message, &processed);

    tracing::info!("[start_chat] 消息长度: {}, 图片数: {}, 文件引用数: {}",
        final_message.len(), processed.image_data.len(), processed.file_references.len());

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

    // 添加会话配置参数
    if let Some(ref agent) = options.agent {
        session_opts = session_opts.with_agent(agent.clone());
    }

    if let Some(ref model) = options.model {
        session_opts = session_opts.with_model(model.clone());
    }

    if let Some(ref effort) = options.effort {
        session_opts = session_opts.with_effort(effort.clone());
    }

    if let Some(ref permission_mode) = options.permission_mode {
        session_opts = session_opts.with_permission_mode(permission_mode.clone());
    }

    if let Some(ref tools) = options.allowed_tools {
        if !tools.is_empty() {
            session_opts = session_opts.with_allowed_tools(tools.clone());
        }
    }

    // Fork 会话：传递源会话 ID，引擎将使用 --resume + --fork-session
    if let Some(ref fork_sid) = options.fork_session_id {
        session_opts.fork_session_id = Some(fork_sid.clone());
    }

    // 传递图片附件（非空时引擎切换到 stream-json 模式）
    if !processed.image_data.is_empty() {
        let images: Vec<ImageAttachment> = processed.image_data.iter().map(|img| {
            ImageAttachment {
                media_type: img.media_type.clone(),
                data: img.data.clone(),
            }
        }).collect();
        tracing::info!("[start_chat] 传递 {} 张图片给引擎（stream-json 模式）", images.len());
        session_opts = session_opts.with_image_attachments(images);
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

    // 处理附件：图片收集 base64 + 文本嵌入 + 大文件存盘引用
    let processed = if let (Some(dir), Some(atts)) = (&options.work_dir, &options.attachments) {
        if !atts.is_empty() {
            process_attachments(dir, atts)?
        } else {
            ProcessedAttachment { embedded_sections: Vec::new(), file_references: Vec::new(), image_data: Vec::new() }
        }
    } else {
        ProcessedAttachment { embedded_sections: Vec::new(), file_references: Vec::new(), image_data: Vec::new() }
    };

    // 构建包含附件内容的最终消息（文本部分）
    let final_message = build_message_with_attachments(&message, &processed);

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

    // 添加会话配置参数
    if let Some(ref agent) = options.agent {
        session_opts = session_opts.with_agent(agent.clone());
    }

    if let Some(ref model) = options.model {
        session_opts = session_opts.with_model(model.clone());
    }

    if let Some(ref effort) = options.effort {
        session_opts = session_opts.with_effort(effort.clone());
    }

    if let Some(ref permission_mode) = options.permission_mode {
        session_opts = session_opts.with_permission_mode(permission_mode.clone());
    }

    if let Some(ref tools) = options.allowed_tools {
        if !tools.is_empty() {
            session_opts = session_opts.with_allowed_tools(tools.clone());
        }
    }

    // 传递图片附件（非空时引擎切换到 stream-json 模式）
    if !processed.image_data.is_empty() {
        let images: Vec<ImageAttachment> = processed.image_data.iter().map(|img| {
            ImageAttachment {
                media_type: img.media_type.clone(),
                data: img.data.clone(),
            }
        }).collect();
        tracing::info!("[continue_chat] 传递 {} 张图片给引擎（stream-json 模式）", images.len());
        session_opts = session_opts.with_image_attachments(images);
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

/// PR 关联信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPR {
    pub number: u32,
    pub url: Option<String>,
    pub title: Option<String>,
    pub state: Option<String>, // "open" | "merged" | "closed"
}

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

    // === Fork 关系字段 ===
    /// 父会话 ID（fork 来源，通过消息指纹推断）
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// 子会话 ID 列表
    #[serde(default)]
    pub child_session_ids: Vec<String>,

    // === Git/PR 关联字段 ===
    /// Git 分支名称（从会话文件中提取）
    #[serde(default)]
    pub git_branch: Option<String>,
    /// PR 关联信息（通过 git branch 推断）
    #[serde(default)]
    pub linked_pr: Option<LinkedPR>,
}

/// 从 git 分支名称中提取 PR 编号
///
/// 支持的分支命名格式：
/// - pr-123, pr/123
/// - 123-feature-description
fn extract_pr_from_branch(branch_name: &str) -> Option<LinkedPR> {
    // 规则 1: pr-123 或 pr/123
    let pr_pattern = regex::Regex::new(r"(?i)pr[-/](\d+)").ok()?;
    if let Some(caps) = pr_pattern.captures(branch_name) {
        if let Some(num_str) = caps.get(1) {
            if let Ok(number) = num_str.as_str().parse::<u32>() {
                return Some(LinkedPR {
                    number,
                    url: None,
                    title: None,
                    state: None,
                });
            }
        }
    }

    // 规则 2: 123-feature-description（数字开头）
    let number_prefix = regex::Regex::new(r"^(\d+)-").ok()?;
    if let Some(caps) = number_prefix.captures(branch_name) {
        if let Some(num_str) = caps.get(1) {
            if let Ok(number) = num_str.as_str().parse::<u32>() {
                return Some(LinkedPR {
                    number,
                    url: None,
                    title: None,
                    state: None,
                });
            }
        }
    }

    None
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

/// 解析会话文件获取元数据（包括真实工作区路径 cwd 和 gitBranch）
fn parse_session_metadata(file_path: &PathBuf) -> (Option<String>, usize, Option<String>, Option<String>, Option<String>) {
    let mut first_prompt: Option<String> = None;
    let mut message_count = 0usize;
    let mut created: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;

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
                        // 获取 git 分支（gitBranch）
                        if git_branch.is_none() {
                            git_branch = json.get("gitBranch").and_then(|b| b.as_str()).map(|s| s.to_string());
                        }
                    } else if msg_type == "assistant" {
                        message_count += 1;
                        // assistant 消息也可能有 gitBranch
                        if git_branch.is_none() {
                            git_branch = json.get("gitBranch").and_then(|b| b.as_str()).map(|s| s.to_string());
                        }
                    }
                }
            }
        }
    }

    (first_prompt, message_count, created, cwd, git_branch)
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
                            let (first_prompt, message_count, created, real_cwd, git_branch) = parse_session_metadata(&path);

                            // claude_project_name: Claude Code 目录名（用于定位 jsonl 文件）
                            let claude_project_name = project_name.clone();
                            // project_path: 真实工作区路径（用于前端匹配/创建工作区）
                            let project_path = real_cwd.unwrap_or_else(|| project_name.clone());

                            // 从 git_branch 推断 PR 关联
                            let linked_pr = git_branch.as_ref().and_then(|branch| {
                                extract_pr_from_branch(branch)
                            });

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
                                parent_session_id: None, // 后续通过 fork 检测算法填充
                                child_session_ids: Vec::new(),
                                git_branch,
                                linked_pr,
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

    // === Fork 检测算法 ===
    // 基于消息指纹推断 fork 关系
    infer_fork_relationships(&mut sessions);

    Ok(sessions)
}

/// 会话消息指纹（用于 fork 检测）
#[derive(Debug, Clone)]
struct SessionFingerprint {
    session_id: String,
    /// 前 N 条消息的内容哈希
    message_hashes: Vec<String>,
    /// 创建时间戳
    created_at: i64,
}

/// 计算消息内容的简单哈希（用于指纹匹配）
fn simple_hash(content: &str) -> String {
    // 使用简单的哈希算法：取前 200 字符的字节和
    let bytes = content.as_bytes();
    let sample = &bytes[..bytes.len().min(200)];
    let hash: u64 = sample.iter().enumerate().map(|(i, &b)| (i as u64 + 1) * b as u64).sum();
    format!("{:016x}", hash)
}

/// 从会话文件中提取消息指纹
fn compute_session_fingerprint(file_path: &PathBuf, session_id: &str) -> Option<SessionFingerprint> {
    let mut message_hashes = Vec::new();
    let mut created_at: i64 = 0;

    if let Ok(file) = std::fs::File::open(file_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    if msg_type == "user" || msg_type == "assistant" {
                        // 提取消息内容
                        if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                            let content_str = if let Some(text) = content.as_str() {
                                text.to_string()
                            } else if let Some(arr) = content.as_array() {
                                // 数组格式，拼接所有 text
                                arr.iter()
                                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                    .collect::<Vec<_>>()
                                    .join("")
                            } else {
                                String::new()
                            };

                            // 只取前 5 条消息
                            if message_hashes.len() < 5 && !content_str.is_empty() {
                                message_hashes.push(simple_hash(&content_str));
                            }
                        }

                        // 获取创建时间
                        if created_at == 0 {
                            if let Some(ts) = json.get("timestamp").and_then(|t| t.as_str()) {
                                created_at = chrono::DateTime::parse_from_rfc3339(ts)
                                    .map(|dt| dt.timestamp())
                                    .unwrap_or(0);
                            }
                        }
                    }
                }
            }
        }
    }

    if message_hashes.is_empty() {
        None
    } else {
        Some(SessionFingerprint {
            session_id: session_id.to_string(),
            message_hashes,
            created_at,
        })
    }
}

/// 推断 fork 关系
///
/// 算法：
/// 1. 计算每个会话的消息指纹（前 5 条消息的哈希）
/// 2. 按创建时间排序
/// 3. 对于每个会话，检查是否有更早的会话与其共享消息前缀
/// 4. 如果找到共享前缀 >= 80%，则认为该会话是 fork
fn infer_fork_relationships(sessions: &mut [ClaudeSessionMeta]) {
    use std::collections::HashMap;

    // 计算所有会话的指纹
    let fingerprints: HashMap<String, SessionFingerprint> = sessions
        .iter()
        .filter_map(|s| {
            compute_session_fingerprint(&PathBuf::from(&s.file_path), &s.session_id)
                .map(|fp| (s.session_id.clone(), fp))
        })
        .collect();

    // 按创建时间排序的会话 ID 列表
    let mut sorted_ids: Vec<String> = sessions.iter().map(|s| s.session_id.clone()).collect();
    sorted_ids.sort_by_key(|id| {
        fingerprints.get(id).map(|fp| fp.created_at).unwrap_or(0)
    });

    // 构建父子关系映射
    let mut parent_map: HashMap<String, String> = HashMap::new();

    for (i, session_id) in sorted_ids.iter().enumerate() {
        if let Some(fp) = fingerprints.get(session_id) {
            // 检查所有更早的会话
            for earlier_id in sorted_ids.iter().take(i) {
                if let Some(earlier_fp) = fingerprints.get(earlier_id) {
                    // 检查消息前缀匹配
                    if has_common_prefix(&fp.message_hashes, &earlier_fp.message_hashes) {
                        // 找到父会话
                        parent_map.insert(session_id.clone(), earlier_id.clone());
                        break;
                    }
                }
            }
        }
    }

    // 更新会话的 parent_session_id 和 child_session_ids
    for session in sessions.iter_mut() {
        if let Some(parent_id) = parent_map.get(&session.session_id) {
            session.parent_session_id = Some(parent_id.clone());
        }
    }

    // 构建子会话列表
    let mut child_map: HashMap<String, Vec<String>> = HashMap::new();
    for (child_id, parent_id) in &parent_map {
        child_map.entry(parent_id.clone()).or_default().push(child_id.clone());
    }

    for session in sessions.iter_mut() {
        if let Some(children) = child_map.get(&session.session_id) {
            session.child_session_ids = children.clone();
        }
    }
}

/// 检查两个消息哈希列表是否有共同前缀
fn has_common_prefix(hashes1: &[String], hashes2: &[String]) -> bool {
    let min_len = hashes1.len().min(hashes2.len());
    if min_len < 2 {
        return false;
    }

    let match_count = hashes1.iter().zip(hashes2.iter()).take(min_len).filter(|(a, b)| a == b).count();

    // 至少 80% 的前缀匹配
    match_count as f64 / min_len as f64 >= 0.8
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
