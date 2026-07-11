/*! 聊天命令模块
 *
 * 提供统一的 AI 聊天接口，使用 EngineRegistry 管理多种 AI 引擎。
 */

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::path::PathBuf;
use std::sync::Arc;

use crate::ai::{
    ClaudeHistoryProvider, CodexHistoryProvider, HistoryMessage, SessionHistoryProvider,
    SessionMeta,
};
use crate::ai::{EngineId, ImageAttachment, PagedResult, Pagination, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use crate::services::mcp_config_service::resolve_workspace_mcp_runtime_service;
use crate::services::proxy::ProxyWireApi;
#[cfg(feature = "tauri-app")]
use tauri::{Emitter, Manager, State, Window};
#[cfg(feature = "tauri-app")]
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
    /// 禁用的 MCP server 名称列表
    #[serde(default)]
    pub disabled_mcp_servers: Option<Vec<String>>,
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
    /// 模型 Profile ID（用于查找第三方端点配置）
    #[serde(default)]
    pub model_profile_id: Option<String>,
}

// ============================================================================
// 辅助函数
// ============================================================================

fn with_additional_disallowed_tools(
    mut session_opts: SessionOptions,
    tools: &[&str],
) -> SessionOptions {
    for tool in tools {
        if !session_opts.disallowed_tools.iter().any(|t| t == tool) {
            session_opts.disallowed_tools.push((*tool).to_string());
        }
    }
    session_opts
}

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
#[allow(dead_code)]
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
                        tracing::warn!(
                            "[process_attachments] 无法解析图片 data URL: {}",
                            &attachment.content[..50.min(attachment.content.len())]
                        );
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
                    tracing::warn!(
                        "[process_attachments] 图片附件无内容: {}",
                        attachment.file_name
                    );
                    continue;
                };

                tracing::info!(
                    "[process_attachments] 收集图片: {} ({}), base64 长度: {}",
                    attachment.file_name,
                    media_type,
                    raw_base64.len()
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
                        tracing::info!(
                            "[process_attachments] 嵌入文本文件: {} ({} bytes)",
                            attachment.file_name,
                            text.len()
                        );
                    } else {
                        // 大文件：保存到磁盘
                        let ext = attachment.file_name.rsplit('.').next().unwrap_or("txt");
                        let file_name = format!("file_{}.{}", file_index, ext);
                        let file_path = polaris_dir.join(&file_name);

                        std::fs::write(&file_path, text.as_bytes())
                            .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;

                        tracing::info!(
                            "[process_attachments] 保存大文本文件: {:?} ({} bytes)",
                            file_path,
                            text.len()
                        );
                        result.file_references.push(format!(
                            "文件 {} → .polaris/{}",
                            attachment.file_name, file_name
                        ));
                        file_index += 1;
                    }
                } else if !attachment.content.is_empty() {
                    // 有 base64 内容但没有 textContent（二进制文件或旧前端）
                    let base64_data = if attachment.content.starts_with("data:") {
                        let parts: Vec<&str> = attachment.content.splitn(2, ",").collect();
                        if parts.len() == 2 {
                            parts[1]
                        } else {
                            continue;
                        }
                    } else {
                        &attachment.content
                    };

                    let decoded = BASE64_STANDARD.decode(base64_data).map_err(|e| {
                        AppError::ProcessError(format!("解码文件 base64 失败: {}", e))
                    })?;

                    // 尝试作为文本解码
                    if let Ok(text) = String::from_utf8(decoded.clone()) {
                        if text.len() <= TEXT_EMBED_THRESHOLD {
                            let ext = attachment.file_name.rsplit('.').next().unwrap_or("txt");
                            result.embedded_sections.push(format!(
                                "📎 [文件: {}]\n```{}\n{}\n```",
                                attachment.file_name, ext, text
                            ));
                            tracing::info!(
                                "[process_attachments] 嵌入 base64 文本文件: {} ({} bytes)",
                                attachment.file_name,
                                text.len()
                            );
                        } else {
                            let ext = attachment.file_name.rsplit('.').next().unwrap_or("bin");
                            let file_name = format!("file_{}.{}", file_index, ext);
                            let file_path = polaris_dir.join(&file_name);
                            std::fs::write(&file_path, &decoded).map_err(|e| {
                                AppError::ProcessError(format!("写入文件失败: {}", e))
                            })?;
                            result.file_references.push(format!(
                                "文件 {} → .polaris/{}",
                                attachment.file_name, file_name
                            ));
                            file_index += 1;
                        }
                    } else {
                        // 纯二进制：保存到磁盘
                        let ext = attachment.file_name.rsplit('.').next().unwrap_or("bin");
                        let file_name = format!("file_{}.{}", file_index, ext);
                        let file_path = polaris_dir.join(&file_name);
                        std::fs::write(&file_path, &decoded)
                            .map_err(|e| AppError::ProcessError(format!("写入文件失败: {}", e)))?;
                        result.file_references.push(format!(
                            "二进制文件 {} → .polaris/{}",
                            attachment.file_name, file_name
                        ));
                        file_index += 1;
                    }
                } else {
                    tracing::warn!(
                        "[process_attachments] 文件附件无内容: {}",
                        attachment.file_name
                    );
                }
            }
            _ => {
                tracing::warn!(
                    "[process_attachments] 未知附件类型: {}",
                    attachment.attachment_type
                );
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
        let refs: Vec<String> = processed
            .file_references
            .iter()
            .map(|r| format!("- {}", r))
            .collect();
        parts.push(format!(
            "用户上传了以下文件，请使用 Read 工具查看它们:\n{}",
            refs.join("\n")
        ));
    }

    parts.join("\n\n")
}

// ============================================================================
// Transport-agnostic callback types (shared by Tauri commands & HTTP handlers)
// ============================================================================

/// Application paths needed for MCP config resolution, decoupled from Window.
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
}

/// Callbacks for chat event emission, abstracting over transport (Tauri Window vs HTTP/WS).
pub struct ChatCallbacks {
    /// Emit a chat-event JSON payload to all connected clients.
    pub emit_event: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
    /// Show a desktop notification when AI reply completes (no-op for web-only clients).
    pub notify_complete: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct PreparedMcpConfig {
    claude_config_path: Option<String>,
    codex_config_args: Vec<String>,
    /// SimpleAI 直接消费的 MCP server 列表（Phase 4b；CLI 引擎不用）。
    simple_ai_mcp_servers:
        Option<Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer>>,
}

fn merge_disabled_mcp_servers(requested: &[String], persisted: Vec<String>) -> Vec<String> {
    let mut merged = requested.to_vec();
    for server_name in persisted {
        if !merged.iter().any(|name| name == &server_name) {
            merged.push(server_name);
        }
    }
    merged
}

fn prepare_mcp_config_with_paths(
    options: &ChatRequestOptions,
    engine: &EngineId,
    paths: &AppPaths,
    ask_listener: Option<crate::services::ask_listener::AskListenerHandle>,
) -> Result<PreparedMcpConfig> {
    let enable_mcp_tools = options.enable_mcp_tools.unwrap_or(false);
    if !enable_mcp_tools {
        return Ok(PreparedMcpConfig::default());
    }

    let work_dir = match options.work_dir.as_deref() {
        Some(dir) if !dir.trim().is_empty() => dir,
        _ => return Ok(PreparedMcpConfig::default()),
    };

    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::ProcessError("无法确定应用根目录".to_string()))?
        .to_path_buf();

    let (service, persisted_disabled_servers) = resolve_workspace_mcp_runtime_service(
        paths.config_dir.clone(),
        paths.resource_dir.clone(),
        app_root,
        std::path::Path::new(work_dir),
        ask_listener,
        options
            .context_id
            .as_deref()
            .and_then(|id| id.strip_prefix("session-"))
            .map(str::to_string),
    )?;
    let disabled_servers = merge_disabled_mcp_servers(
        options.disabled_mcp_servers.as_deref().unwrap_or(&[]),
        persisted_disabled_servers,
    );

    match engine {
        EngineId::ClaudeCode => {
            let config_path =
                service.prepare_workspace_config_with_disabled(work_dir, &disabled_servers)?;
            Ok(PreparedMcpConfig {
                claude_config_path: Some(config_path.to_string_lossy().to_string()),
                codex_config_args: Vec::new(),
                simple_ai_mcp_servers: None,
            })
        }
        EngineId::Codex => {
            let codex_config_args = service
                .prepare_workspace_codex_config_args_with_disabled(work_dir, &disabled_servers)?;
            Ok(PreparedMcpConfig {
                claude_config_path: None,
                codex_config_args,
                simple_ai_mcp_servers: None,
            })
        }
        EngineId::SimpleAI => {
            // SimpleAI 直接消费 MCP server（Phase 4b + 内置桥接）：
            // service 已合并内置（polaris.builtin）+ 外部插件，按 disabled 过滤。
            let mut servers = service.resolved_simple_ai_servers(work_dir, &disabled_servers);
            // aiToolAccess 门控：内置（plugin_id="polaris.builtin"）总暴露；
            // 外部插件检查 aiToolAccess（决策 §12-7：只对 SimpleAI 过滤，CLI 引擎不变）。
            let (_, plugins) = crate::services::mcp_config_service::load_plugin_mcp_runtime_state(
                &paths.config_dir,
                std::path::Path::new(work_dir),
            );
            servers.retain(|s| {
                if s.plugin_id == "polaris.builtin" {
                    return true;
                }
                plugins
                    .iter()
                    .find(|p| p.id == s.plugin_id)
                    .map(|p| p.permissions.ai_tool_access.unwrap_or(false))
                    .unwrap_or(false)
            });
            if !servers.is_empty() {
                let builtin_count = servers
                    .iter()
                    .filter(|s| s.plugin_id == "polaris.builtin")
                    .count();
                let plugin_count = servers.len() - builtin_count;
                tracing::info!(
                    "[SimpleAI] 解析到 {} 个可用 MCP server（内置 {} + 插件 {}，aiToolAccess 已过滤）",
                    servers.len(),
                    builtin_count,
                    plugin_count
                );
            }
            Ok(PreparedMcpConfig {
                claude_config_path: None,
                codex_config_args: Vec::new(),
                simple_ai_mcp_servers: Some(servers),
            })
        }
        EngineId::MimoCode => {
            // Mimo 不使用 MCP 配置文件
            Ok(PreparedMcpConfig {
                claude_config_path: None,
                codex_config_args: Vec::new(),
                simple_ai_mcp_servers: None,
            })
        }
    }
}

async fn apply_model_profile_options(
    mut session_opts: SessionOptions,
    profile_id: Option<&String>,
    engine: &EngineId,
    state: &crate::AppState,
    log_scope: &str,
    session_id: &str,
) -> Result<SessionOptions> {
    let Some(profile_id) = profile_id else {
        return Ok(session_opts);
    };

    let config = state
        .clone_config()
        .map_err(|e| AppError::ProcessError(e))?;
    let profiles = &config.model_profiles;
    let Some(profile) = profiles.iter().find(|p| p.id == *profile_id) else {
        // 用户明确选择了某 Profile，但配置中已不存在（可能已删除或未同步）。
        // 不再静默回退到官方端点（会产生意外费用/答非所选），而是中断并提示用户。
        tracing::warn!(
            "[{}] 未找到模型 Profile: {}，中断请求",
            log_scope,
            profile_id
        );
        return Err(AppError::ClientError(
            "errors:modelProfile.notFoundRuntime".to_string(),
        ));
    };

    tracing::info!(
        "[{}] 使用模型 Profile: {} ({}), wireApi={:?}, targetEngines={:?}, category={:?}",
        log_scope,
        profile.name,
        profile.model,
        profile.wire_api,
        profile.resolve_target_engines(),
        profile.category
    );

    // 检查 Profile 是否适用于当前引擎。
    let expected_engine = match engine {
        EngineId::ClaudeCode => "claude",
        EngineId::Codex => "codex",
        EngineId::SimpleAI => "simple-ai",
        EngineId::MimoCode => "mimo",
    };
    if !profile.is_for_engine(expected_engine) {
        // 同样不静默跳过：明确告知用户所选 Profile 不适用于当前引擎，引导重新选择。
        tracing::warn!(
            "[{}] Profile {} 不适用于引擎 {:?}（targetEngines={:?}），中断请求",
            log_scope,
            profile.name,
            engine,
            profile.resolve_target_engines()
        );
        return Err(AppError::ClientError(
            "errors:modelProfile.incompatibleRuntime".to_string(),
        ));
    }

    match engine {
        EngineId::ClaudeCode => {
            let wire = profile.wire_api.as_deref();
            let use_openai_proxy = matches!(
                wire,
                Some("openai-chat-completions") | Some("openai-responses")
            );
            let use_anthropic_sanitized_proxy = !use_openai_proxy
                && !crate::services::ModelProfileService::supports_anthropic_server_tool_blocks(
                    profile,
                );
            let use_proxy = use_openai_proxy || use_anthropic_sanitized_proxy;
            if use_proxy {
                let proxy_wire = if use_anthropic_sanitized_proxy {
                    crate::services::proxy::ProxyWireApi::AnthropicMessages
                } else {
                    crate::services::proxy::ProxyWireApi::from_profile_wire_api(wire)
                };
                let custom_headers = profile.custom_headers.clone().unwrap_or_default();
                // 启动本地代理（Chat Completions 或 Responses 线路，由 proxy_wire 决定转换方式）
                tracing::info!(
                    "[{}] Profile {} 使用代理模式（{:?}），启动内嵌代理",
                    log_scope,
                    profile.name,
                    proxy_wire
                );

                match state
                    .proxy_manager
                    .start_proxy(
                        session_id,
                        &profile.id,
                        &profile.base_url,
                        &profile.api_key,
                        proxy_wire,
                        custom_headers,
                    )
                    .await
                {
                    Ok(proxy_addr) => {
                        tracing::info!(
                            "[{}] 代理已启动: {} -> http://{} (session={})",
                            log_scope,
                            profile.name,
                            proxy_addr,
                            session_id
                        );

                        match crate::services::ModelProfileService::write_proxy_settings_overlay(
                            profile, proxy_addr,
                        ) {
                            Ok(path) => {
                                session_opts = session_opts
                                    .with_settings_overlay_path(path.to_string_lossy().to_string());
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "[{}] 生成 proxy settings overlay 失败: {}",
                                    log_scope,
                                    e
                                );
                            }
                        }

                        // 代理模式下 env overrides 只需设置基础覆盖（API key 由代理管理）
                        let mut env_overrides = std::collections::HashMap::new();
                        env_overrides.insert(
                            "ANTHROPIC_BASE_URL".to_string(),
                            format!("http://{}", proxy_addr),
                        );
                        env_overrides.insert(
                            "ANTHROPIC_AUTH_TOKEN".to_string(),
                            "PROXY_MANAGED".to_string(),
                        );
                        // 合并用户自定义环境变量
                        if let Some(custom) = &profile.custom_env {
                            for (k, v) in custom {
                                env_overrides.insert(k.clone(), v.clone());
                            }
                        }
                        session_opts = session_opts.with_env_overrides(env_overrides);
                        if use_anthropic_sanitized_proxy {
                            session_opts = with_additional_disallowed_tools(
                                session_opts,
                                &["WebSearch", "WebFetch"],
                            );
                        }
                    }
                    Err(e) => {
                        tracing::error!("[{}] 启动代理失败: {}", log_scope, e);
                        return Err(crate::error::AppError::ProcessError(format!(
                            "启动模型代理失败: {}",
                            e
                        )));
                    }
                }
            } else {
                // Anthropic Messages 直连模式（原有逻辑）
                match crate::services::ModelProfileService::write_settings_overlay(profile) {
                    Ok(path) => {
                        session_opts = session_opts
                            .with_settings_overlay_path(path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        tracing::warn!("[{}] 生成 settings overlay 失败: {}", log_scope, e);
                    }
                }

                let env_overrides =
                    crate::services::ModelProfileService::generate_env_overrides(profile);
                session_opts = session_opts.with_env_overrides(env_overrides);
            }
        }
        EngineId::Codex => {
            let wire = profile.wire_api.as_deref();
            let use_codex_proxy = matches!(wire, Some("openai-chat-completions"));

            if use_codex_proxy {
                tracing::info!(
                    "[{}] Profile {} 使用 Codex Responses→Chat 代理转换模式",
                    log_scope,
                    profile.name
                );

                match state
                    .proxy_manager
                    .start_proxy(
                        session_id,
                        &format!("codex:{}", profile.id),
                        &profile.base_url,
                        &profile.api_key,
                        ProxyWireApi::CodexResponsesToChatCompletions,
                        profile.custom_headers.clone().unwrap_or_default(),
                    )
                    .await
                {
                    Ok(proxy_addr) => {
                        // 写入 Codex 模型目录，避免 "Model metadata not found" 警告
                        if let Err(e) =
                            crate::services::ModelProfileService::write_codex_proxy_model_catalog(
                                profile,
                            )
                        {
                            tracing::warn!("[{}] 写入 Codex 模型目录失败: {}", log_scope, e);
                        }

                        let codex_args =
                            crate::services::ModelProfileService::generate_codex_proxy_config_args(
                                profile, proxy_addr,
                            );
                        session_opts.codex_config_args.extend(codex_args);

                        let env_overrides = crate::services::ModelProfileService::generate_codex_proxy_env_overrides(profile);
                        session_opts.env_overrides.extend(env_overrides);
                    }
                    Err(e) => {
                        tracing::error!(
                            "[{}] 启动 Codex Responses 代理失败，回退到直连: {}",
                            log_scope,
                            e
                        );
                        let codex_args =
                            crate::services::ModelProfileService::generate_codex_config_args(
                                profile,
                            );
                        session_opts.codex_config_args.extend(codex_args);

                        let env_overrides =
                            crate::services::ModelProfileService::generate_codex_env_overrides(
                                profile,
                            );
                        session_opts.env_overrides.extend(env_overrides);
                    }
                }
            } else {
                let codex_args =
                    crate::services::ModelProfileService::generate_codex_config_args(profile);
                session_opts.codex_config_args.extend(codex_args);

                let env_overrides =
                    crate::services::ModelProfileService::generate_codex_env_overrides(profile);
                session_opts.env_overrides.extend(env_overrides);
            }
        }
        EngineId::SimpleAI => {
            // SimpleAI 引擎直接使用 profile 的 baseUrl/apiKey/model
            // 通过 env_overrides 传递 profile ID，让 SimpleAI 可以精确查找 Profile
            tracing::info!(
                "[{}] SimpleAI 引擎使用 Profile: {} (id={}, model={}, baseUrl={})",
                log_scope,
                profile.name,
                profile.id,
                profile.model,
                profile.base_url
            );
            let mut env_overrides = std::collections::HashMap::new();
            env_overrides.insert("__simple_ai_profile_id".to_string(), profile.id.clone());
            session_opts = session_opts.with_env_overrides(env_overrides);
        }
        EngineId::MimoCode => {
            // Mimo 引擎使用模型配置（通过 --model 传递）
            tracing::info!(
                "[{}] Mimo 引擎使用 Profile 模型: {}",
                log_scope,
                profile.model
            );
            // Mimo 不直接使用 env_overrides，由 CLI 自身处理认证
        }
    }

    // 如果前端传入了模型，优先使用前端选择的模型（Profile 多模型选择）
    // 否则回退到 Profile 默认模型
    let selected_model = session_opts.model.clone().unwrap_or_else(|| profile.model.clone());

    // 如果选了非默认模型，更新日志
    if selected_model != profile.model {
        tracing::info!(
            "[{}] Profile 使用前端选择的模型: {}（Profile 默认: {}）",
            log_scope,
            selected_model,
            profile.model
        );
    }

    Ok(session_opts.with_model(selected_model))
}

// ============================================================================
// Inner functions (shared business logic)
// ============================================================================

pub async fn start_chat_inner(
    message: String,
    options: ChatRequestOptions,
    state: &crate::AppState,
    callbacks: ChatCallbacks,
    app_paths: &AppPaths,
) -> Result<String> {
    tracing::info!(
        "[start_chat_inner] 消息长度: {} 字符, 附件数: {:?}",
        message.len(),
        options.attachments.as_ref().map(|a| a.len())
    );

    let processed =
        if let (Some(ref dir), Some(ref atts)) = (&options.work_dir, &options.attachments) {
            if !atts.is_empty() {
                process_attachments(dir, atts)?
            } else {
                ProcessedAttachment {
                    embedded_sections: Vec::new(),
                    file_references: Vec::new(),
                    image_data: Vec::new(),
                }
            }
        } else {
            ProcessedAttachment {
                embedded_sections: Vec::new(),
                file_references: Vec::new(),
                image_data: Vec::new(),
            }
        };

    let final_message = build_message_with_attachments(&message, &processed);
    tracing::info!(
        "[start_chat_inner] 消息长度: {}, 图片数: {}, 文件引用数: {}",
        final_message.len(),
        processed.image_data.len(),
        processed.file_references.len()
    );

    let default_engine = || {
        state
            .clone_config()
            .ok()
            .and_then(|config| EngineId::parse(&config.default_engine))
            .unwrap_or(EngineId::ClaudeCode)
    };

    let engine = match &options.engine_id {
        Some(id) => EngineId::parse(id).unwrap_or_else(|| {
            tracing::warn!(
                "[start_chat_inner] Unrecognized engine_id '{}', falling back to configured default",
                id
            );
            default_engine()
        }),
        None => default_engine(),
    };

    tracing::info!("[start_chat_inner] 使用引擎: {:?}", engine);
    let mut mcp_config = prepare_mcp_config_with_paths(
        &options,
        &engine,
        app_paths,
        if state
            .clone_config()
            .map(|c| c.interaction.ask_mcp_enabled)
            .unwrap_or(true)
        {
            state.ask_listener.get().cloned()
        } else {
            None
        },
    )?;

    let ctx_id = options.context_id.clone();
    let emit_ref = callbacks.emit_event.clone();
    let notify_ref = callbacks.notify_complete.clone();
    let event_callback = move |event: AIEvent| {
        let event_json = if let Some(ref cid) = ctx_id {
            serde_json::json!({ "contextId": cid, "payload": event })
        } else {
            serde_json::json!({ "contextId": "main", "payload": event })
        };
        tracing::debug!(
            "[start_chat_inner] 发送事件: {}",
            event_json.to_string().chars().take(200).collect::<String>()
        );
        emit_ref(event_json);
        if matches!(event, AIEvent::SessionEnd(_)) {
            notify_ref();
        }
    };

    let ctx_id_for_session = options.context_id.clone();
    let emit_ref2 = callbacks.emit_event.clone();
    let session_id_update_callback = move |new_session_id: String| {
        let event_json = if let Some(ref cid) = ctx_id_for_session {
            serde_json::json!({ "contextId": cid, "payload": { "type": "session_start", "sessionId": new_session_id } })
        } else {
            serde_json::json!({ "contextId": "main", "payload": { "type": "session_start", "sessionId": new_session_id } })
        };
        emit_ref2(event_json);
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
    if let Some(ref mcp_config_path) = mcp_config.claude_config_path {
        session_opts = session_opts.with_mcp_config_path(mcp_config_path.clone());
    }
    if !mcp_config.codex_config_args.is_empty() {
        session_opts = session_opts.with_codex_config_args(mcp_config.codex_config_args);
    }
    if let Some(servers) = mcp_config.simple_ai_mcp_servers.take() {
        if !servers.is_empty() {
            session_opts = session_opts.with_mcp_servers(servers);
        }
    }
    if let Some(ref dirs) = options.additional_dirs {
        session_opts.additional_dirs = dirs.clone();
    }
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
    if let Some(ref fork_sid) = options.fork_session_id {
        session_opts.fork_session_id = Some(fork_sid.clone());
    }
    if !processed.image_data.is_empty() {
        let images: Vec<ImageAttachment> = processed
            .image_data
            .iter()
            .map(|img| ImageAttachment {
                media_type: img.media_type.clone(),
                data: img.data.clone(),
            })
            .collect();
        tracing::info!(
            "[start_chat_inner] 传递 {} 张图片给引擎（stream-json 模式）",
            images.len()
        );
        session_opts = session_opts.with_image_attachments(images);
    }

    // 为当前会话生成一个临时 session_id，传给 start_proxy 作为代理索引。
    // 避免按 profile_id 索引代理时跨会话互相干扰。
    let session_id = uuid::Uuid::new_v4().to_string();

    session_opts = apply_model_profile_options(
        session_opts,
        options.model_profile_id.as_ref(),
        &engine,
        state,
        "start_chat_inner",
        &session_id,
    )
    .await?;

    let mut registry = state.engine_registry.lock().await;
    registry.start_session(Some(engine), &final_message, session_opts)
}

pub async fn continue_chat_inner(
    session_id: String,
    message: String,
    options: ChatRequestOptions,
    state: &crate::AppState,
    callbacks: ChatCallbacks,
    app_paths: &AppPaths,
) -> Result<()> {
    tracing::info!(
        "[continue_chat_inner] 继续会话: {}, 附件数: {:?}",
        session_id,
        options.attachments.as_ref().map(|a| a.len())
    );

    let processed = if let (Some(dir), Some(atts)) = (&options.work_dir, &options.attachments) {
        if !atts.is_empty() {
            process_attachments(dir, atts)?
        } else {
            ProcessedAttachment {
                embedded_sections: Vec::new(),
                file_references: Vec::new(),
                image_data: Vec::new(),
            }
        }
    } else {
        ProcessedAttachment {
            embedded_sections: Vec::new(),
            file_references: Vec::new(),
            image_data: Vec::new(),
        }
    };

    let final_message = build_message_with_attachments(&message, &processed);

    let engine = options
        .engine_id
        .as_ref()
        .and_then(|id| EngineId::parse(id))
        .ok_or_else(|| AppError::ValidationError("必须提供有效的 engine_id".to_string()))?;

    tracing::info!("[continue_chat_inner] 使用引擎: {:?}", engine);
    let mut mcp_config = prepare_mcp_config_with_paths(
        &options,
        &engine,
        app_paths,
        if state
            .clone_config()
            .map(|c| c.interaction.ask_mcp_enabled)
            .unwrap_or(true)
        {
            state.ask_listener.get().cloned()
        } else {
            None
        },
    )?;

    let ctx_id = options.context_id.clone();
    let emit_ref = callbacks.emit_event.clone();
    let notify_ref = callbacks.notify_complete.clone();
    let event_callback = move |event: AIEvent| {
        let event_json = if let Some(ref cid) = ctx_id {
            serde_json::json!({ "contextId": cid, "payload": event })
        } else {
            serde_json::json!({ "contextId": "main", "payload": event })
        };
        tracing::debug!(
            "[continue_chat_inner] 发送事件: {}",
            event_json.to_string().chars().take(200).collect::<String>()
        );
        emit_ref(event_json);
        if matches!(event, AIEvent::SessionEnd(_)) {
            notify_ref();
        }
    };

    let ctx_id_for_session = options.context_id.clone();
    let emit_ref2 = callbacks.emit_event.clone();
    let session_id_update_callback = move |new_session_id: String| {
        let event_json = if let Some(ref cid) = ctx_id_for_session {
            serde_json::json!({ "contextId": cid, "payload": { "type": "session_start", "sessionId": new_session_id } })
        } else {
            serde_json::json!({ "contextId": "main", "payload": { "type": "session_start", "sessionId": new_session_id } })
        };
        emit_ref2(event_json);
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
    if let Some(ref mcp_config_path) = mcp_config.claude_config_path {
        session_opts = session_opts.with_mcp_config_path(mcp_config_path.clone());
    }
    if !mcp_config.codex_config_args.is_empty() {
        session_opts = session_opts.with_codex_config_args(mcp_config.codex_config_args);
    }
    if let Some(servers) = mcp_config.simple_ai_mcp_servers.take() {
        if !servers.is_empty() {
            session_opts = session_opts.with_mcp_servers(servers);
        }
    }
    if let Some(ref dirs) = options.additional_dirs {
        session_opts.additional_dirs = dirs.clone();
    }
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
    if !processed.image_data.is_empty() {
        let images: Vec<ImageAttachment> = processed
            .image_data
            .iter()
            .map(|img| ImageAttachment {
                media_type: img.media_type.clone(),
                data: img.data.clone(),
            })
            .collect();
        tracing::info!(
            "[continue_chat_inner] 传递 {} 张图片给引擎（stream-json 模式）",
            images.len()
        );
        session_opts = session_opts.with_image_attachments(images);
    }

    // ──────────────────────────────────────────────────────
    // 先杀掉本会话的旧 CLI 进程，再处理代理。
    //
    // 仅对 CLI 类引擎（Claude/Codex/Mimo）生效：它们每轮会 spawn 新进程,
    // 旧进程若有 in-flight 请求在等上游响应,代理端口被关闭时会收到
    // ConnectionRefused(见 99770ad8)。先 try_interrupt_all 杀旧进程,
    // 确保无 in-flight 请求后再安全切换代理。
    //
    // SimpleAI 显式跳过:它的会话是单进程复用,中断走 watch::channel latch,
    // 一旦拨到 true 不可逆 —— 后续 continue 会在 run_chat_loop 首个检查点
    // 立即 SessionEnd 不输出任何内容(即"无法继续对话"根因)。
    // SimpleAI 的 continue 是复用同一会话追加消息,无需也不应先中断。
    // 注意:用户主动点"停止"走 interrupt_chat_inner,该路径仍会对 SimpleAI
    // 调 try_interrupt_all,本处只收窄 continue 路径,不影响主动停止。
    // ──────────────────────────────────────────────────────
    {
        let mut registry = state.engine_registry.lock().await;
        match engine {
            EngineId::ClaudeCode | EngineId::Codex | EngineId::MimoCode => {
                registry.try_interrupt_all(&session_id);
            }
            EngineId::SimpleAI => {}
        }
    }

    session_opts = apply_model_profile_options(
        session_opts,
        options.model_profile_id.as_ref(),
        &engine,
        state,
        "continue_chat_inner",
        &session_id,
    )
    .await?;

    let mut registry = state.engine_registry.lock().await;
    registry.continue_session(engine, &session_id, &final_message, session_opts)
}

pub async fn interrupt_chat_inner(
    session_id: String,
    engine_id: Option<String>,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!(
        "[interrupt_chat_inner] 中断会话: {} (engine_id hint: {:?})",
        session_id,
        engine_id
    );
    let engine = engine_id.as_ref().and_then(|id| EngineId::parse(id));
    let mut registry = state.engine_registry.lock().await;

    // 优先按前端给出的 engine_id 路由;失败时回退遍历所有引擎.
    //
    // 背景: per-session 多引擎改造后,前端 metadata.engineId 与后端实际启动会话所用
    // 引擎在边角路径(scheduler 自动创建、history 恢复缺失 engineId、fork)下可能错配.
    // 早期实现仅在 engine_id == None 时才走 try_interrupt_all,导致错配场景下中断
    // 直接报错,前端吞错后 UI 假装已停,但进程实际仍在运行.此处增加兜底:
    //   1. 指定的引擎能找到 session    -> 命中,直接成功
    //   2. 指定的引擎找不到/未注册     -> 降级到 try_interrupt_all,日志记录
    //   3. 所有引擎都找不到             -> 返回 "未找到会话"
    if let Some(engine) = engine {
        match registry.interrupt(&engine, &session_id) {
            Ok(()) => {}
            Err(primary_err) => {
                tracing::warn!(
                    "[interrupt_chat_inner] 指定引擎 {} 中断失败 ({}), 回退到全引擎兜底",
                    engine,
                    primary_err
                );
                if !registry.try_interrupt_all(&session_id) {
                    return Err(AppError::ProcessError(format!(
                        "未找到会话: {} (尝试引擎 {} 失败且全引擎兜底未命中: {})",
                        session_id, engine, primary_err
                    )));
                }
                tracing::info!(
                    "[interrupt_chat_inner] 通过全引擎兜底成功中断 session: {}",
                    session_id
                );
            }
        }
    } else if !registry.try_interrupt_all(&session_id) {
        return Err(AppError::ProcessError(format!(
            "未找到会话: {}",
            session_id
        )));
    }
    tracing::info!("[interrupt_chat_inner] 会话已中断: {}", session_id);
    Ok(())
}

// ============================================================================
// Tauri Commands - 聊天
// ============================================================================

/// 将 chat 事件包装为 WS envelope 后广播。
///
/// 前端 HTTP 传输层（httpTransport）按顶层 `event` 字段路由事件，
/// 未包 envelope 的裸事件会被 Web 客户端静默丢弃 —— 桌面端发起的会话
/// 在手机/浏览器端将完全看不到流式输出。格式与 `web::api::chat::dual_emit`
/// 的 WebSocket 分支保持一致。
#[cfg(feature = "tauri-app")]
fn broadcast_chat_event(tx: &crate::web::EventBroadcaster, event: &serde_json::Value) {
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    let _ = tx.send(ws_msg.to_string());
}

#[cfg(feature = "tauri-app")]
fn wrap_session_routed_event(session_id: &str, payload: serde_json::Value) -> serde_json::Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        serde_json::json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
    }
}

/// 启动聊天会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn start_chat(
    message: String,
    window: Window,
    state: State<'_, crate::AppState>,
    options: ChatRequestOptions,
) -> Result<String> {
    let app_paths = AppPaths {
        config_dir: window
            .path()
            .app_config_dir()
            .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {}", e)))?,
        resource_dir: window.path().resource_dir().ok(),
    };
    let window_clone = window.clone();
    let broadcast_tx = state.event_broadcast.clone();
    let callbacks = ChatCallbacks {
        emit_event: Arc::new(move |json: serde_json::Value| {
            let _ = window_clone.emit("chat-event", &json);
            broadcast_chat_event(&broadcast_tx, &json);
        }),
        notify_complete: Arc::new(move || {
            notify_ai_reply_complete(&window);
        }),
    };

    start_chat_inner(message, options, &state, callbacks, &app_paths).await
}

/// 继续聊天会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn continue_chat(
    session_id: String,
    message: String,
    window: Window,
    state: State<'_, crate::AppState>,
    options: ChatRequestOptions,
) -> Result<()> {
    let app_paths = AppPaths {
        config_dir: window
            .path()
            .app_config_dir()
            .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {}", e)))?,
        resource_dir: window.path().resource_dir().ok(),
    };
    let window_clone = window.clone();
    let broadcast_tx = state.event_broadcast.clone();
    let callbacks = ChatCallbacks {
        emit_event: Arc::new(move |json: serde_json::Value| {
            let _ = window_clone.emit("chat-event", &json);
            broadcast_chat_event(&broadcast_tx, &json);
        }),
        notify_complete: Arc::new(move || {
            notify_ai_reply_complete(&window);
        }),
    };

    continue_chat_inner(session_id, message, options, &state, callbacks, &app_paths).await
}

/// 中断聊天会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn interrupt_chat(
    session_id: String,
    engine_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    interrupt_chat_inner(session_id, engine_id, &state).await
}

// ============================================================================
// 辅助函数
// ============================================================================

#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
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

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
        "codex" | "openai-codex" => {
            let provider = CodexHistoryProvider::new(config);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
        _ => Err(AppError::ValidationError(format!(
            "不支持的引擎: {}",
            engine_id
        ))),
    }
}

/// 获取会话历史（统一接口，支持分页）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_session_history(
    session_id: String,
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PagedResult<HistoryMessage>> {
    tracing::info!(
        "[get_session_history] 会话: {}, 页码: {:?}",
        session_id,
        page
    );

    let pagination = Pagination::new(page.unwrap_or(1), page_size.unwrap_or(50));

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        }
        "codex" | "openai-codex" => {
            let provider = CodexHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        }
        _ => Err(AppError::ValidationError(format!(
            "不支持的引擎: {}",
            engine_id
        ))),
    }
}

/// 删除会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn delete_session(
    session_id: String,
    engine_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!("[delete_session] 删除会话: {}", session_id);

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.delete_session(&session_id)
        }
        "codex" | "openai-codex" => {
            let provider = CodexHistoryProvider::new(config);
            provider.delete_session(&session_id)
        }
        _ => Err(AppError::ValidationError(format!(
            "不支持的引擎: {}",
            engine_id
        ))),
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
fn parse_session_metadata(
    file_path: &PathBuf,
) -> (
    Option<String>,
    usize,
    Option<String>,
    Option<String>,
    Option<String>,
) {
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
                            if let Some(content) =
                                json.get("message").and_then(|m| m.get("content"))
                            {
                                let prompt_text = if let Some(text) = content.as_str() {
                                    // 字符串格式
                                    Some(text.to_string())
                                } else if let Some(arr) = content.as_array() {
                                    // 数组格式，提取第一个 text 类型
                                    let mut found = None;
                                    for item in arr {
                                        if item.get("type").and_then(|t| t.as_str()) == Some("text")
                                        {
                                            if let Some(text) =
                                                item.get("text").and_then(|t| t.as_str())
                                            {
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
                            created = json
                                .get("timestamp")
                                .and_then(|t| t.as_str())
                                .map(|s| s.to_string());
                        }
                        // 获取真实工作区路径（cwd）
                        if cwd.is_none() {
                            cwd = json
                                .get("cwd")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string());
                        }
                        // 获取 git 分支（gitBranch）
                        if git_branch.is_none() {
                            git_branch = json
                                .get("gitBranch")
                                .and_then(|b| b.as_str())
                                .map(|s| s.to_string());
                        }
                    } else if msg_type == "assistant" {
                        message_count += 1;
                        // assistant 消息也可能有 gitBranch
                        if git_branch.is_none() {
                            git_branch = json
                                .get("gitBranch")
                                .and_then(|b| b.as_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
            }
        }
    }

    (first_prompt, message_count, created, cwd, git_branch)
}

/// 列出 Claude Code 会话（旧接口）
#[cfg(feature = "tauri-app")]
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
                            let session_id = path
                                .file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();

                            // 获取文件元数据
                            let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

                            let modified = std::fs::metadata(&path)
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .map(|t| {
                                    let datetime: chrono::DateTime<chrono::Utc> = t.into();
                                    datetime.to_rfc3339()
                                });

                            // 解析会话内容获取详细信息
                            let (first_prompt, message_count, created, real_cwd, git_branch) =
                                parse_session_metadata(&path);

                            // claude_project_name: Claude Code 目录名（用于定位 jsonl 文件）
                            let claude_project_name = project_name.clone();
                            // project_path: 真实工作区路径（用于前端匹配/创建工作区）
                            let project_path = real_cwd.unwrap_or_else(|| project_name.clone());

                            // 从 git_branch 推断 PR 关联
                            let linked_pr = git_branch
                                .as_ref()
                                .and_then(|branch| extract_pr_from_branch(branch));

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
        let time_a = a
            .modified
            .as_ref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        let time_b = b
            .modified
            .as_ref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        time_b.cmp(&time_a)
    });

    // === Fork 检测算法 ===
    // 基于消息指纹推断 fork 关系
    infer_fork_relationships(&mut sessions);

    Ok(sessions)
}

/// 会话消息指纹（用于 fork 检测）
#[derive(Debug, Clone)]
#[allow(dead_code)]
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
    let hash: u64 = sample
        .iter()
        .enumerate()
        .map(|(i, &b)| (i as u64 + 1) * b as u64)
        .sum();
    format!("{:016x}", hash)
}

/// 从会话文件中提取消息指纹
fn compute_session_fingerprint(
    file_path: &PathBuf,
    session_id: &str,
) -> Option<SessionFingerprint> {
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
    sorted_ids.sort_by_key(|id| fingerprints.get(id).map(|fp| fp.created_at).unwrap_or(0));

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
        child_map
            .entry(parent_id.clone())
            .or_default()
            .push(child_id.clone());
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

    let match_count = hashes1
        .iter()
        .zip(hashes2.iter())
        .take(min_len)
        .filter(|(a, b)| a == b)
        .count();

    // 至少 80% 的前缀匹配
    match_count as f64 / min_len as f64 >= 0.8
}

/// 获取 Claude Code 会话历史（旧接口）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
    _state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ClaudeHistoryMessage>> {
    tracing::info!(
        "[get_claude_code_session_history] 获取会话历史: {}",
        session_id
    );

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
        claude_dir
            .join(project)
            .join(format!("{}.jsonl", session_id))
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
        return Err(AppError::ValidationError(format!(
            "会话文件不存在: {:?}",
            session_file
        )));
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
                                        timestamp: json
                                            .get("timestamp")
                                            .and_then(|t| t.as_str())
                                            .map(|s| s.to_string()),
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
                                        timestamp: json
                                            .get("timestamp")
                                            .and_then(|t| t.as_str())
                                            .map(|s| s.to_string()),
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

use crate::state::{PendingQuestion, QuestionAnswer, QuestionOption, QuestionStatus};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCardResponse {
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(default)]
    pub declined: bool,
}

/// 注册待回答问题
///
/// 当收到 ask_user_question 工具调用时调用此函数
#[cfg(feature = "tauri-app")]
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
        session_id,
        call_id,
        header
    );

    let question = PendingQuestion {
        call_id: call_id.clone(),
        session_id,
        questions: vec![crate::state::QuestionItem {
            question: header.clone(),
            header,
            multi_select,
            options,
            allow_custom_input,
        }],
        status: QuestionStatus::Pending,
    };

    let mut pending = state
        .pending_questions
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(call_id, question);

    Ok(())
}

/// 回答问题
///
/// 用户提交答案后调用此函数。会做两件事：
///   1. 取出 ask_listener 注册的 oneshot::Sender，触发同回合 tool_result 回填
///   2. emit `question_answered` 让前端把卡片切到已答态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn answer_question(
    session_id: String,
    call_id: String,
    answer: QuestionAnswer,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[answer_question] 回答问题: session={}, call={}, sub_answers={}, declined={}",
        session_id,
        call_id,
        answer.answers.len(),
        answer.declined,
    );

    // 1. 取出 ask_listener 注册的 oneshot::Sender，把答案推回 MCP companion。
    //    如果没有 sender（旧路径未走 MCP），则降级为只做事件广播。
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let outcome = crate::services::ask_listener::build_outcome_for_multiple_answers(
            &entry,
            answer.answers.clone(),
            answer.declined,
        );
        if entry.sender.send(outcome).is_err() {
            tracing::warn!("[answer_question] oneshot 接收端已关闭: {}", call_id);
        }
    } else {
        tracing::debug!(
            "[answer_question] 无 ask_listener sender，按 legacy 路径处理: {}",
            call_id
        );
    }

    // 2. 清理 pending_questions（ask_listener 也会清理，这里做幂等）
    {
        let mut pending = state
            .pending_questions
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        pending.remove(&call_id);
    }

    // 3. emit `question_answered`，前端把卡片切到 answered
    let first = answer.answers.first().cloned().unwrap_or_default();
    let event = serde_json::json!({
        "type": "question_answered",
        "sessionId": session_id,
        "questionId": call_id,
        "callId": call_id,  // 兼容字段
        "answers": answer.answers,
        "declined": answer.declined,
        // 兼容字段：旧 answer 单题摘要
        "answer": {
            "selected": first.selected,
            "customInput": first.custom_input,
        },
    });

    let routed_event = wrap_session_routed_event(&session_id, event);

    window
        .emit("chat-event", &routed_event)
        .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &routed_event);

    tracing::info!("[answer_question] 答案已提交，事件已发送");

    Ok(())
}

/// 回答插件交互卡片。
///
/// 取出 ask_listener 注册的 oneshot::Sender，将结果回填给插件 MCP server，
/// 再广播 `plugin_card_answered` 让前端卡片切换到已处理状态。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn respond_plugin_card(
    session_id: String,
    interaction_id: String,
    response: PluginCardResponse,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[respond_plugin_card] 回答插件卡片: session={}, interaction={}, declined={}",
        session_id,
        interaction_id,
        response.declined,
    );

    {
        let mut pending = state
            .pending_plugin_cards
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        if let Some(card) = pending.get(&interaction_id) {
            if card.session_id != session_id {
                return Err(AppError::ValidationError(format!(
                    "session_id mismatch: expected {}, got {}",
                    card.session_id, session_id
                )));
            }
        }
        pending.remove(&interaction_id);
    }

    let result = response.result.clone();
    let outcome = if response.declined {
        crate::services::ask_listener::PluginCardOutcome::declined()
    } else {
        crate::services::ask_listener::PluginCardOutcome::answer(result.clone())
    };
    if let Some(entry) = state.take_plugin_card_answer_sender(&interaction_id) {
        if entry.sender.send(outcome).is_err() {
            tracing::warn!(
                "[respond_plugin_card] oneshot 接收端已关闭: {}",
                interaction_id
            );
        }
    } else {
        tracing::debug!(
            "[respond_plugin_card] 无 plugin card sender，按事件广播处理: {}",
            interaction_id
        );
    }

    let event = serde_json::json!({
        "type": "plugin_card_answered",
        "sessionId": session_id,
        "interactionId": interaction_id,
        "declined": response.declined,
        "result": result,
    });
    let routed_event = wrap_session_routed_event(&session_id, event);

    window
        .emit("chat-event", &routed_event)
        .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;
    broadcast_chat_event(&state.event_broadcast, &routed_event);

    Ok(())
}

/// 获取待回答问题列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_pending_questions(
    session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PendingQuestion>> {
    let pending = state
        .pending_questions
        .lock()
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn clear_answered_questions(state: tauri::State<'_, crate::AppState>) -> Result<usize> {
    let mut pending = state
        .pending_questions
        .lock()
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

use crate::models::PlanApprovalResultEvent;
use crate::state::{PendingPlan, PlanApprovalStatus};

/// 注册待审批计划
///
/// 当收到 plan_approval_request 事件时调用此函数
#[cfg(feature = "tauri-app")]
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
        session_id,
        plan_id,
        title
    );

    let plan = PendingPlan {
        plan_id: plan_id.clone(),
        session_id,
        title,
        description,
        status: PlanApprovalStatus::Pending,
        feedback: None,
    };

    let mut pending = state
        .pending_plans
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    pending.insert(plan_id, plan);

    Ok(())
}

/// 批准计划
///
/// 用户批准计划后调用此函数
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn approve_plan(
    session_id: String,
    plan_id: String,
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    tracing::info!(
        "[approve_plan] 批准计划: session={}, plan={}",
        session_id,
        plan_id
    );

    // 更新计划状态并移除已处理的条目（避免内存泄漏）
    {
        let mut pending = state
            .pending_plans
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if pending.remove(&plan_id).is_some() {
            tracing::info!("[approve_plan] 已移除待处理计划: {}", plan_id);
        } else {
            tracing::warn!("[approve_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已批准
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, true);

    let payload = serde_json::json!({
        "contextId": "main",
        "payload": event
    });
    window
        .emit("chat-event", &payload)
        .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &payload);

    tracing::info!("[approve_plan] 计划已批准，事件已发送");

    Ok(())
}

/// 拒绝计划
///
/// 用户拒绝计划后调用此函数
#[cfg(feature = "tauri-app")]
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
        session_id,
        plan_id,
        feedback
    );

    // 更新计划状态并移除已处理的条目（避免内存泄漏）
    {
        let mut pending = state
            .pending_plans
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;

        if pending.remove(&plan_id).is_some() {
            tracing::info!("[reject_plan] 已移除待处理计划: {}", plan_id);
        } else {
            tracing::warn!("[reject_plan] 计划不存在: {}", plan_id);
        }
    }

    // 发送事件通知前端计划已拒绝
    let event = PlanApprovalResultEvent::new(&session_id, &plan_id, false)
        .with_feedback(feedback.unwrap_or_default());

    let payload = serde_json::json!({
        "contextId": "main",
        "payload": event
    });
    window
        .emit("chat-event", &payload)
        .map_err(|e| AppError::ProcessError(format!("发送事件失败: {}", e)))?;

    // Dual emission: also broadcast to WebSocket clients
    broadcast_chat_event(&state.event_broadcast, &payload);

    tracing::info!("[reject_plan] 计划已拒绝，事件已发送");

    Ok(())
}

/// 获取待审批计划列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_pending_plans(
    session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PendingPlan>> {
    let pending = state
        .pending_plans
        .lock()
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn clear_processed_plans(state: tauri::State<'_, crate::AppState>) -> Result<usize> {
    let mut pending = state
        .pending_plans
        .lock()
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn send_input(
    session_id: String,
    input: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool> {
    tracing::info!(
        "[send_input] 向会话 {} 发送输入: {} bytes",
        session_id,
        input.len()
    );

    let mut registry = state.engine_registry.lock().await;
    registry.send_input(&session_id, &input)
}
