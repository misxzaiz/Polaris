//! 附件处理辅助（K-R6 自 ai_chat_core.rs 迁入）

use crate::ai::SessionOptions;
use crate::error::{AppError, Result};
use super::types::{Attachment, ChatRequestOptions};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::path::PathBuf;

// ============================================================================
// 辅助函数
// ============================================================================

pub(super) fn with_additional_disallowed_tools(
    mut session_opts: SessionOptions,
    tools: &[&str],
) -> SessionOptions {
    for tool in tools {
        if !session_opts.disallowed_tools.iter().any(|t| t == tool) {
            session_opts.disallowed_tools.push(tool.to_string());
        }
    }
    session_opts
}

/// 客户端身份注入（start/continue 共用）。
///
/// SimpleAI 经 `environment_context` 注入结构化 `<client>` 段（simple_ai/context.rs）；
/// 其余引擎（Claude 等）无该机制，向 `append_system_prompt` 追加一行客户端事实陈述。
/// 目的：避免模型把服务端 os/cwd 当作用户环境（如 APK 移动端对话被答成
/// 「你在用电脑桌面客户端」——2026-10-25 修复，见 plans/ai-client-context-spec.md）。
pub(super) fn inject_client_context(
    session_opts: &mut SessionOptions,
    options: &ChatRequestOptions,
    engine_str: &str,
) {
    let Some(ref client_type) = options.client_type else {
        return;
    };
    session_opts.client_type = Some(client_type.clone());
    session_opts.client_platform = options.client_platform.clone();
    if engine_str != "simple-ai" {
        let platform = options.client_platform.as_deref().unwrap_or("unknown");
        let line = format!(
            "\n\nCurrent client: {client_type} ({platform}). The user may be talking from a \
different device than this runtime — answer client/environment questions based on this fact, \
and do not assume the user is on a desktop app."
        );
        match &mut session_opts.append_system_prompt {
            Some(prompt) => prompt.push_str(&line),
            None => session_opts.append_system_prompt = Some(line.trim().to_string()),
        }
    }
}

/// 附件处理结果
pub struct ProcessedAttachment {
    /// 需要嵌入到消息中的文本段落
    pub embedded_sections: Vec<String>,
    /// 需要用 Read 工具查看的文件路径（大文件、二进制文件）
    pub file_references: Vec<String>,
    /// 图片原始数据（用于 stream-json 模式原生传递给模型）
    pub image_data: Vec<ImageData>,
    /// 图片落盘后的本地路径（供「落盘 + 指向 + AI 决策」路径使用）
    pub image_paths: Vec<String>,
}

/// 图片原始数据
#[allow(dead_code)]
pub struct ImageData {
    /// MIME 类型（如 "image/png"）
    pub media_type: String,
    /// 纯 base64 数据（不含 data: 前缀）
    pub data: String,
    /// 文件名（日志用）
    pub file_name: String,
}

/// 处理附件：图片存盘 + 文本嵌入 + 大文件存盘引用
///
/// 策略：
/// - 图片：保存到 .polaris/ → 模型通过 Read 工具查看
/// - 文本/代码文件 (< 30KB)：直接嵌入消息文本
/// - 文本/代码文件 (> 30KB) + 其他二进制：保存到 .polaris/ → 引用路径
pub fn process_attachments(work_dir: &str, attachments: &[Attachment]) -> Result<ProcessedAttachment> {
    let polaris_dir = PathBuf::from(work_dir).join(".polaris");
    let mut result = ProcessedAttachment {
        embedded_sections: Vec::new(),
        file_references: Vec::new(),
        image_data: Vec::new(),
        image_paths: Vec::new(),
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
                    media_type: media_type.clone(),
                    data: raw_base64.clone(),
                    file_name: attachment.file_name.clone(),
                });

                // 落盘图片到 .polaris/attachments/，供「落盘 + 指向 + AI 决策」路径使用。
                // 图片以 base64 传输，这里解码写回二进制；路径随 image_paths 返回，
                // 由 build_message_with_attachments 生成指引文本告知模型可读文件/调 vision MCP。
                match BASE64_STANDARD.decode(&raw_base64) {
                    Ok(bytes) => {
                        let att_dir = polaris_dir.join("attachments");
                        if std::fs::create_dir_all(&att_dir).is_err() {
                            tracing::warn!(
                                "[process_attachments] 创建 attachments 目录失败: {:?}",
                                att_dir
                            );
                        } else {
                            let ext = guess_image_ext(&media_type, &attachment.file_name);
                            let file_name = format!("img_{}.{}", file_index, ext);
                            let img_path = att_dir.join(&file_name);
                            match std::fs::write(&img_path, &bytes) {
                                Ok(()) => {
                                    tracing::info!(
                                        "[process_attachments] 图片已落盘: {:?} ({} bytes)",
                                        img_path,
                                        bytes.len()
                                    );
                                    result.image_paths.push(img_path.to_string_lossy().to_string());
                                    file_index += 1;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "[process_attachments] 图片落盘失败: {:?} ({})",
                                        img_path,
                                        e
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[process_attachments] 图片 base64 解码失败，跳过落盘: {} ({})",
                            attachment.file_name,
                            e
                        );
                    }
                }
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
pub(super) fn guess_image_ext(mime_type: &str, file_name: &str) -> String {
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
pub(super) fn build_message_with_attachments(message: &str, processed: &ProcessedAttachment) -> String {
    if processed.embedded_sections.is_empty()
        && processed.file_references.is_empty()
        && processed.image_paths.is_empty()
    {
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

    // 图片指引（落盘 + 指向 + AI 决策）：模型若支持视觉可 read_file 直读，
    // 否则可调 mcp__image-recognition__recognize_image 识别。绝不盲发图块（避免 400）。
    if !processed.image_paths.is_empty() {
        let img_lines: Vec<String> = processed
            .image_paths
            .iter()
            .map(|p| format!("- {}", p))
            .collect();
        parts.push(format!(
            "用户上传了 {} 张图片，已保存到以下路径：\n{}\n\
             请根据当前模型能力自行决定：\n\
             a) 若你支持视觉（多模态），可用 read_file 直接查看图片内容；\n\
             b) 否则请调用 mcp__image-recognition__recognize_image 工具，\
             传入 image=\"<上述路径>\" 识别图片内容后，把识别结果告诉用户；\n\
             c) 若两者都不可行，请明确告知用户图片无法识别。\n\
             注意：不要把图片 base64 直接嵌入文本（会超长且无效）。",
            processed.image_paths.len(),
            img_lines.join("\n")
        ));
    }

    parts.join("\n\n")
}

/// 图片直通判定（供 start/continue_chat_inner 的直通点使用）。
///
/// 从 `state` 读取配置，按 `profile_id` 找到 `ModelProfile`，用 `vision::resolve_vision_support`
/// 判定该 Profile 是否确定支持视觉。返回 true 才允许把 base64 图块传给引擎。
///
/// 边界：
/// - `profile_id` 为 None（官方/未选 Profile）→ 按引擎默认处理：Claude 家族确定支持，
///   返回 true；否则（无 Profile 可查，模型名未知）保守返回 false（走指向路径）。
/// - Profile 找不到 → 保守 false。
/// - SimpleAI 必须有 Profile（它从 Profile 读 API key），无 Profile 时本来就走不通，
///   保守 false 无副作用。
pub(super) fn should_direct_send_image(
    state: &crate::AppState,
    profile_id: Option<&str>,
) -> bool {
    let Some(pid) = profile_id else {
        // 未选 Profile：无模型信息可判定。保守返回 false（走指向路径，避免 400）。
        // 注：Claude 官方端点（engine=ClaudeCode, profile=None）实际支持视觉，
        // 但这里拿不到 engine 上下文；官方 Claude 模型名含 "claude" 会走下方
        // Profile 分支（若配置了官方 Profile），或由 model 名兜底。此处保守。
        tracing::info!("[vision] 未指定模型 Profile，跳过图片直通（保守走指向路径）");
        return false;
    };

    let config = match state.clone_config() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[vision] 读取配置失败，跳过图片直通: {}", e);
            return false;
        }
    };

    match config.model_profiles.iter().find(|p| p.id == *pid) {
        Some(profile) => {
            let support = crate::ai::vision::resolve_vision_support(profile);
            tracing::info!(
                "[vision] Profile {} 图片能力判定: {:?}",
                profile.id,
                support
            );
            support == crate::ai::vision::VisionSupport::Support
        }
        None => {
            tracing::warn!("[vision] 未找到 Profile {}，跳过图片直通", pid);
            false
        }
    }
}

