use crate::error::{AppError, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::path::{Path, PathBuf};
use std::fs;
use std::time::SystemTime;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub destination_path: String,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// 文件搜索结果（用于 @file 引用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
}

/// 命令文件结构（从 .claude/commands/ 读取）
#[derive(serde::Serialize)]
pub struct CommandFile {
    pub name: String,
    pub description: Option<String>,
    pub params: Option<Vec<CommandParam>>,
    pub content: String,
    pub file_path: String,
}

#[derive(serde::Serialize)]
pub struct CommandParam {
    pub name: String,
    pub description: Option<String>,
    pub required: Option<bool>,
}

/// 文件信息结构
#[derive(serde::Serialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub extension: Option<String>,
    pub children: Option<Vec<FileInfo>>,
}

/// 读取目录内容（只读取直接子项，不递归）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn read_directory(path: String) -> Result<Vec<FileInfo>> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(AppError::InvalidPath("路径不存在".to_string()));
    }
    
    if !path_obj.is_dir() {
        return Err(AppError::InvalidPath("不是目录".to_string()));
    }
    
    let mut files = Vec::new();
    
    let entries = fs::read_dir(path_obj)?;
    
    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        
        let file_path = entry.path();
        let name = file_path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();
        
        let is_dir = metadata.is_dir();
        let size = if !is_dir { Some(metadata.len()) } else { None };
        
        // 获取修改时间
        let modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string());
        
        // 获取文件扩展名
        let extension = if !is_dir {
            file_path.extension()
                .and_then(|ext| ext.to_str())
                .map(|s| s.to_lowercase())
        } else {
            None
        };
        
        let file_info = FileInfo {
            name,
            path: file_path.to_string_lossy().to_string(),
            is_dir,
            size,
            modified,
            extension,
            children: None, // 子目录内容预留，需要懒加载
        };
        
        files.push(file_info);
    }
    
    // 排序：目录在前，然后按名称排序
    files.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });
    
    Ok(files)
}

/// 获取文件内容（限制大小）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn get_file_content(path: String) -> Result<String> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(AppError::InvalidPath("文件不存在".to_string()));
    }
    
    if path_obj.is_dir() {
        return Err(AppError::InvalidPath("是目录，不是文件".to_string()));
    }
    
    // 检查文件大小，限制为1MB
    let metadata = fs::metadata(path_obj)?;
    
    if metadata.len() > 1024 * 1024 {
        return Err(AppError::InvalidPath("文件过大，超过1MB限制".to_string()));
    }
    
    let content = fs::read_to_string(path_obj)?;
    
    Ok(content)
}

/// 创建文件
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn create_file(path: String, content: Option<String>) -> Result<()> {
    let path_obj = Path::new(&path);
    
    // 检查父目录是否存在
    if let Some(parent) = path_obj.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    
    // 创建文件
    if let Some(content) = content {
        fs::write(path_obj, content)?;
    } else {
        fs::File::create(path_obj)?;
    }
    
    Ok(())
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            IMAGE_EXTENSIONS.iter().any(|candidate| *candidate == ext.as_str())
        })
        .unwrap_or(false)
}

fn ensure_image_destination(path: &Path) -> Result<()> {
    if !is_supported_image_path(path) {
        return Err(AppError::InvalidPath(
            "仅支持保存 png、jpg、jpeg、webp、gif 图片".to_string(),
        ));
    }

    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    Ok(())
}

fn is_safe_codex_artifact_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !value.contains("..")
}

fn codex_generated_image_path(thread_id: &str, file_name: &str) -> Result<std::path::PathBuf> {
    if !is_safe_codex_artifact_segment(thread_id) || !is_safe_codex_artifact_segment(file_name) {
        return Err(AppError::InvalidPath("无效的图片路径".to_string()));
    }

    if !is_supported_image_path(Path::new(file_name)) {
        return Err(AppError::InvalidPath("不支持的图片类型".to_string()));
    }

    let home = dirs::home_dir()
        .ok_or_else(|| AppError::InvalidPath("无法获取用户目录".to_string()))?;

    Ok(home
        .join(".codex")
        .join("generated_images")
        .join(thread_id)
        .join(file_name))
}

/// 保存前端传入的图片二进制数据
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn save_image_bytes(path: String, data_base64: String) -> Result<String> {
    let path_obj = Path::new(&path);
    ensure_image_destination(path_obj)?;

    let bytes = BASE64_STANDARD
        .decode(data_base64.trim())
        .map_err(|e| AppError::InvalidPath(format!("图片数据无效: {}", e)))?;

    fs::write(path_obj, bytes)?;
    Ok(path)
}

/// 保存 Codex 生成图片 artifact
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn save_codex_image_artifact(
    thread_id: String,
    file_name: String,
    destination: String,
) -> Result<String> {
    let source = codex_generated_image_path(&thread_id, &file_name)?;
    if !source.exists() || !source.is_file() {
        return Err(AppError::InvalidPath("图片不存在".to_string()));
    }

    let destination_path = Path::new(&destination);
    ensure_image_destination(destination_path)?;

    fs::copy(source, destination_path)?;
    Ok(destination)
}

/// 创建目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn create_directory(path: String) -> Result<()> {
    fs::create_dir_all(&path)?;
    
    Ok(())
}

/// 删除文件或目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn delete_file(path: String) -> Result<()> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(AppError::InvalidPath("路径不存在".to_string()));
    }
    
    if path_obj.is_dir() {
        fs::remove_dir_all(path_obj)?;
    } else {
        fs::remove_file(path_obj)?;
    }
    
    Ok(())
}

/// 重命名文件或目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn rename_file(old_path: String, new_name: String) -> Result<()> {
    let old_path_obj = Path::new(&old_path);
    
    if !old_path_obj.exists() {
        return Err(AppError::InvalidPath("文件不存在".to_string()));
    }
    
    // 构建新路径
    let new_path = if let Some(parent) = old_path_obj.parent() {
        parent.join(&new_name)
    } else {
        Path::new(&new_name).to_path_buf()
    };
    
    fs::rename(old_path_obj, &new_path)?;

    Ok(())
}

/// 复制文件或目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn copy_path(source: String, destination: String) -> Result<()> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&destination);

    if !source_path.exists() {
        return Err(AppError::InvalidPath("源路径不存在".to_string()));
    }

    copy_path_to(source_path, dest_path)?;

    Ok(())
}

/// 复制文件或目录到目标目录，自动处理同名冲突
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn copy_path_to_directory(source: String, target_dir: String) -> Result<FileOperationResult> {
    let source_path = Path::new(&source);
    let target_dir_path = Path::new(&target_dir);

    if !source_path.exists() {
        return Err(AppError::InvalidPath("源路径不存在".to_string()));
    }
    if !target_dir_path.exists() || !target_dir_path.is_dir() {
        return Err(AppError::InvalidPath("目标目录不存在".to_string()));
    }

    let destination = next_available_destination(source_path, target_dir_path)?;
    copy_path_to(source_path, &destination)?;

    Ok(FileOperationResult {
        destination_path: destination.to_string_lossy().to_string(),
    })
}

/// 移动文件或目录
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn move_path(source: String, destination: String) -> Result<()> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&destination);

    if !source_path.exists() {
        return Err(AppError::InvalidPath("源路径不存在".to_string()));
    }

    // 确保目标目录存在
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    fs::rename(source_path, dest_path)?;

    Ok(())
}

/// 移动文件或目录到目标目录，自动处理同名冲突
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn move_path_to_directory(source: String, target_dir: String) -> Result<FileOperationResult> {
    let source_path = Path::new(&source);
    let target_dir_path = Path::new(&target_dir);

    if !source_path.exists() {
        return Err(AppError::InvalidPath("源路径不存在".to_string()));
    }
    if !target_dir_path.exists() || !target_dir_path.is_dir() {
        return Err(AppError::InvalidPath("目标目录不存在".to_string()));
    }

    let destination = next_available_destination(source_path, target_dir_path)?;
    fs::rename(source_path, &destination)?;

    Ok(FileOperationResult {
        destination_path: destination.to_string_lossy().to_string(),
    })
}

fn copy_path_to(source_path: &Path, dest_path: &Path) -> Result<()> {
    if source_path.is_dir() {
        copy_dir_all(source_path, dest_path)?;
    } else {
        if let Some(parent) = dest_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::copy(source_path, dest_path)?;
    }

    Ok(())
}

fn next_available_destination(source_path: &Path, target_dir: &Path) -> Result<PathBuf> {
    let file_name = source_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("源路径缺少文件名".to_string()))?;
    let candidate = target_dir.join(file_name);

    if !candidate.exists() {
        return Ok(candidate);
    }

    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let extension = source_path.extension().and_then(|e| e.to_str());

    for index in 1..10_000 {
        let file_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{} 副本 {}.{}", stem, index, ext),
            _ => format!("{} 副本 {}", stem, index),
        };
        let candidate = target_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::Unknown("无法生成可用的目标文件名".to_string()))
}

/// 递归复制目录
fn copy_dir_all(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let dest_path = destination.join(entry.file_name());

        if path.is_dir() {
            copy_dir_all(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path)?;
        }
    }

    Ok(())
}

/// 保存拖入的文件到目标目录，自动处理同名冲突
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn save_dropped_file_to_directory(
    target_dir: String,
    file_name: String,
    content_base64: String,
) -> Result<FileOperationResult> {
    let target_dir_path = Path::new(&target_dir);
    if !target_dir_path.exists() || !target_dir_path.is_dir() {
        return Err(AppError::InvalidPath("目标目录不存在".to_string()));
    }

    let safe_file_name = Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidPath("文件名无效".to_string()))?;
    let virtual_source = target_dir_path.join(safe_file_name);
    let destination = next_available_destination(&virtual_source, target_dir_path)?;
    let bytes = BASE64_STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|e| AppError::ParseError(format!("Base64 解码失败: {}", e)))?;

    fs::write(&destination, bytes)?;

    Ok(FileOperationResult {
        destination_path: destination.to_string_lossy().to_string(),
    })
}

/// 检查路径是否存在
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn path_exists(path: String) -> Result<bool> {
    Ok(Path::new(&path).exists())
}

/// 读取工作区中的自定义命令
/// 从 .claude/commands/ 目录读取 .md 文件
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn read_commands(work_dir: Option<String>) -> Result<Vec<CommandFile>> {
    let mut commands = Vec::new();

    let work_path = work_dir.unwrap_or_else(|| String::from("."));
    let base_path = Path::new(&work_path);

    // 构建 .claude/commands/ 路径
    let commands_dir = base_path.join(".claude").join("commands");

    if !commands_dir.exists() {
        return Ok(commands);
    }

    // 读取目录中的 .md 文件
    let entries = fs::read_dir(&commands_dir)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        // 只处理 .md 文件
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        // 读取文件内容
        let content = fs::read_to_string(&path)?;

        // 解析文件
        if let Ok(cmd) = parse_command_file(&content, &path) {
            commands.push(cmd);
        }
    }

    // 按名称排序
    commands.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(commands)
}

/// 解析命令文件（YAML frontmatter + 内容）
fn parse_command_file(content: &str, path: &Path) -> Result<CommandFile> {
    let lines: Vec<&str> = content.lines().collect();

    // 查找 frontmatter 分隔符
    let frontmatter_start = if lines.first().is_some_and(|l| l.trim() == "---") {
        1
    } else {
        0
    };

    let frontmatter_end = if frontmatter_start > 0 {
        lines[frontmatter_start..]
            .iter()
            .position(|l| l.trim() == "---")
            .map_or(lines.len(), |i| frontmatter_start + i)
    } else {
        0
    };

    // 提取文件名（去掉 .md 扩展名）
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut description = None;
    let mut params = None;

    // 解析 frontmatter
    if frontmatter_end > frontmatter_start {
        let frontmatter: String = lines[frontmatter_start..frontmatter_end].join("\n");

        // 简单解析（实际项目可以用 serde_yaml 等库）
        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("description:") {
                description = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(rest) = line.strip_prefix("params:") {
                // 简单参数解析
                params = Some(parse_simple_params(rest.trim()));
            }
        }
    }

    // 提取命令内容（frontmatter 之后的部分）
    let command_content = if frontmatter_end > 0 {
        lines.get(frontmatter_end + 1)
            .map_or("", |s| *s)
            .trim()
            .to_string()
    } else {
        // 没有 frontmatter，第一行就是命令
        lines.first()
            .map_or("", |s| s.trim())
            .to_string()
    };

    Ok(CommandFile {
        name,
        description,
        params,
        content: command_content,
        file_path: path.to_string_lossy().to_string(),
    })
}

/// 简单参数解析
fn parse_simple_params(params_str: &str) -> Vec<CommandParam> {
    let mut result = Vec::new();

    // 支持格式: param1 param2 或 param1|desc1 param2|desc2
    for param in params_str.split_whitespace() {
        let parts: Vec<&str> = param.split('|').collect();
        result.push(CommandParam {
            name: parts[0].to_string(),
            description: parts.get(1).map(|s| s.to_string()),
            required: None,
        });
    }

    result
}

/// 搜索文件（用于 @file 引用）
/// 支持模糊匹配文件名，并返回相对路径
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn search_files(
    work_dir: String,
    query: String,
    max_results: Option<usize>
) -> Result<Vec<FileMatch>> {
    let base_path = Path::new(&work_dir);
    let max_results = max_results.unwrap_or(20);

    if !base_path.exists() {
        return Ok(Vec::new());
    }

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    // 解析查询：可能是 "path/file" 格式
    let query_parts: Vec<String> = query_lower.split('/').map(|s| s.to_string()).collect();
    let name_query = query_parts.last().map(|s| s.as_str()).unwrap_or(&query_lower);
    let path_filters: Vec<String> = if query_parts.len() > 1 {
        query_parts[..query_parts.len() - 1].to_vec()
    } else {
        Vec::new()
    };

    // 递归搜索
    search_recursive(
        base_path,
        base_path,
        name_query,
        &path_filters.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        0,
        &mut results,
        max_results,
    )?;

    Ok(results)
}

/// 递归搜索文件
fn search_recursive(
    base_path: &Path,
    current_path: &Path,
    name_query: &str,
    path_filters: &[&str],
    depth: usize,
    results: &mut Vec<FileMatch>,
    max_results: usize,
) -> Result<()> {
    // 达到最大结果数或深度限制
    if results.len() >= max_results || depth > 30 {
        return Ok(());
    }

    let entries = fs::read_dir(current_path)?;

    for entry in entries {
        if results.len() >= max_results {
            break;
        }

        let entry = entry?;
        let path = entry.path();
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        // 跳过隐藏文件和特殊目录
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        let is_dir = path.is_dir();
        let name_lower = name.to_lowercase();

        // 计算相对路径
        let relative_path = pathdiff::diff_paths(&path, base_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());

        // 检查路径过滤器
        let relative_path_lower = relative_path.to_lowercase();
        let passes_path_filter = path_filters.is_empty()
            || path_filters.iter().all(|filter| relative_path_lower.contains(filter));

        // 如果名称匹配查询，添加到结果（文件和文件夹都可以）
        if name_lower.contains(name_query) && passes_path_filter {
            let extension = if !is_dir {
                path.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
            } else {
                None
            };

            results.push(FileMatch {
                name: name.to_string(),
                relative_path: relative_path.clone(),
                full_path: path.to_string_lossy().to_string(),
                is_dir,
                extension,
            });
        }

        // 如果是目录，递归搜索（即使已经匹配，也要搜索子目录）
        if is_dir {
            search_recursive(
                base_path,
                &path,
                name_query,
                path_filters,
                depth + 1,
                results,
                max_results,
            )?;
        }
    }

    Ok(())
}

// ============================================================================
// 文件内容搜索
// ============================================================================

/// 内容搜索结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    /// 文件名
    pub name: String,
    /// 相对路径
    pub relative_path: String,
    /// 完整路径
    pub full_path: String,
    /// 匹配行号（1-based）
    pub line_number: usize,
    /// 匹配内容（去除首尾空白）
    pub matched_line: String,
    /// 匹配前的上下文行（最多 2 行）
    pub context_before: Vec<String>,
    /// 匹配后的上下文行（最多 2 行）
    pub context_after: Vec<String>,
    /// 匹配文本在行中的起始位置
    pub match_start: usize,
    /// 匹配文本在行中的结束位置
    pub match_end: usize,
}

/// 内容搜索统计响应
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResponse {
    pub matches: Vec<ContentMatch>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub matched_files: usize,
    pub skipped_files: usize,
    pub elapsed_ms: u128,
    pub root: String,
    pub max_results: usize,
}

const DEFAULT_CONTENT_SEARCH_LIMIT: usize = 100;
const HARD_CONTENT_SEARCH_LIMIT: usize = 5_000;
const MAX_CONTENT_SEARCH_FILE_SIZE: u64 = 2 * 1024 * 1024;
const CONTENT_SEARCH_EXCLUDED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", "vendor",
    ".gradle", "out", "__pycache__",
];

/// 搜索文件内容（兼容旧 API：仅返回匹配项）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn search_file_contents(
    work_dir: String,
    query: String,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<ContentMatch>> {
    Ok(search_file_contents_detailed(work_dir, query, case_sensitive, whole_word, max_results)
        .await?
        .matches)
}

/// 搜索文件内容，返回匹配项和扫描统计信息。
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn search_file_contents_detailed(
    work_dir: String,
    query: String,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    max_results: Option<usize>,
) -> Result<ContentSearchResponse> {
    let max_results = max_results
        .unwrap_or(DEFAULT_CONTENT_SEARCH_LIMIT)
        .min(HARD_CONTENT_SEARCH_LIMIT);
    let case_sensitive = case_sensitive.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);
    let query = query.trim().to_string();
    let base_path = PathBuf::from(&work_dir);
    let root = fs::canonicalize(&base_path).unwrap_or(base_path.clone());
    let root_display = root.to_string_lossy().to_string();

    if !base_path.exists() || query.is_empty() || max_results == 0 {
        return Ok(ContentSearchResponse {
            matches: Vec::new(),
            truncated: false,
            scanned_files: 0,
            matched_files: 0,
            skipped_files: 0,
            elapsed_ms: 0,
            root: root_display,
            max_results,
        });
    }

    let pattern = build_content_search_pattern(&query, case_sensitive, whole_word)?;

    tokio::task::spawn_blocking(move || search_file_contents_blocking(root, pattern, max_results))
        .await
        .map_err(|e| AppError::Unknown(format!("搜索任务失败: {}", e)))?
}

/// 构建内容搜索正则表达式。默认是大小写不敏感的字面量搜索。
fn build_content_search_pattern(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<regex::Regex> {
    let pattern = if whole_word {
        format!(r"\b{}\b", regex::escape(query))
    } else {
        regex::escape(query)
    };

    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| AppError::InvalidPath(format!("无效的搜索模式: {}", e)))
}

fn search_file_contents_blocking(
    base_path: PathBuf,
    pattern: regex::Regex,
    max_results: usize,
) -> Result<ContentSearchResponse> {
    let started_at = std::time::Instant::now();
    let mut matches = Vec::new();
    let mut scanned_files = 0usize;
    let mut matched_files = 0usize;
    let mut skipped_files = 0usize;
    let mut truncated = false;

    let mut builder = ignore::WalkBuilder::new(&base_path);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false)
        .filter_entry(|entry| !is_content_search_excluded_entry(entry));

    for entry in builder.build() {
        if matches.len() >= max_results {
            truncated = true;
            break;
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };

        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }

        scanned_files += 1;
        let path = entry.path();
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };

        if metadata.len() > MAX_CONTENT_SEARCH_FILE_SIZE {
            skipped_files += 1;
            continue;
        }

        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };
        if looks_binary(&bytes) {
            skipped_files += 1;
            continue;
        }

        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };

        let before = matches.len();
        search_in_file(&base_path, path, &content, &pattern, max_results, &mut matches);
        if matches.len() > before {
            matched_files += 1;
        }
        if matches.len() >= max_results {
            truncated = true;
            break;
        }
    }

    Ok(ContentSearchResponse {
        matches,
        truncated,
        scanned_files,
        matched_files,
        skipped_files,
        elapsed_ms: started_at.elapsed().as_millis(),
        root: base_path.to_string_lossy().to_string(),
        max_results,
    })
}

fn is_content_search_excluded_entry(entry: &ignore::DirEntry) -> bool {
    if !entry.file_type().is_some_and(|ft| ft.is_dir()) {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    CONTENT_SEARCH_EXCLUDED_DIRS.iter().any(|excluded| name == *excluded)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn utf16_offset(s: &str, byte_idx: usize) -> usize {
    s.get(..byte_idx).unwrap_or("").encode_utf16().count()
}

/// 在单个文件中搜索
fn search_in_file(
    base_path: &Path,
    file_path: &Path,
    content: &str,
    pattern: &regex::Regex,
    max_results: usize,
    results: &mut Vec<ContentMatch>,
) {
    let lines: Vec<&str> = content.lines().collect();

    let relative_path = pathdiff::diff_paths(file_path, base_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string_lossy().to_string());

    let name = file_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let full_path = file_path.to_string_lossy().to_string();

    for (line_idx, line) in lines.iter().enumerate() {
        if results.len() >= max_results {
            break;
        }

        for cap in pattern.find_iter(line) {
            if results.len() >= max_results {
                break;
            }

            let line_number = line_idx + 1; // 1-based
            let match_start = utf16_offset(line, cap.start());
            let match_end = utf16_offset(line, cap.end());

            // 收集上下文（前后各 2 行）
            let context_before: Vec<String> = (1..=2)
                .rev()
                .filter_map(|i| lines.get(line_idx.saturating_sub(i)))
                .map(|s| s.to_string())
                .collect();

            let context_after: Vec<String> = (1..=2)
                .filter_map(|i| lines.get(line_idx + i))
                .map(|s| s.to_string())
                .collect();

            results.push(ContentMatch {
                name: name.clone(),
                relative_path: relative_path.clone(),
                full_path: full_path.clone(),
                line_number,
                matched_line: line.trim_end().to_string(),
                context_before,
                context_after,
                match_start,
                match_end,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn content_search_is_case_insensitive_by_default() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join("src/Main.java"), "Hello Polaris");
        let pattern = build_content_search_pattern("hello", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].line_number, 1);
    }

    #[test]
    fn content_search_treats_query_as_literal_text() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join("literal.txt"), "a+b? [test]\naxb");
        let pattern = build_content_search_pattern("a+b? [test]", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].matched_line, "a+b? [test]");

        let pattern = build_content_search_pattern("a.b", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert!(response.matches.is_empty());
    }

    #[test]
    fn content_search_returns_utf16_offsets_for_frontend_highlight() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join("unicode.txt"), "😀Hello");
        let pattern = build_content_search_pattern("hello", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].match_start, 2);
        assert_eq!(response.matches[0].match_end, 7);
    }

    #[test]
    fn content_search_respects_gitignore_and_skips_generated_dirs() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join(".gitignore"), "ignored.txt\n");
        write_file(&dir.path().join("ignored.txt"), "needle");
        write_file(&dir.path().join("node_modules/pkg/index.js"), "needle");
        write_file(&dir.path().join("src/ok.java"), "needle");
        let pattern = build_content_search_pattern("needle", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert_eq!(response.matches.len(), 1);
        assert!(response.matches[0].relative_path.replace('\\', "/").ends_with("src/ok.java"));
    }

    #[test]
    fn content_search_includes_no_extension_text_files() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join("Dockerfile"), "FROM scratch\n# needle");
        let pattern = build_content_search_pattern("needle", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 10).unwrap();
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].name, "Dockerfile");
    }

    #[test]
    fn content_search_reports_truncation() {
        let dir = TempDir::new().unwrap();
        write_file(&dir.path().join("many.txt"), "needle\nneedle\nneedle");
        let pattern = build_content_search_pattern("needle", false, false).unwrap();
        let response = search_file_contents_blocking(dir.path().to_path_buf(), pattern, 2).unwrap();
        assert_eq!(response.matches.len(), 2);
        assert!(response.truncated);
    }
}

// ============================================================================
// 文件下载
// ============================================================================

/// 二进制文件下载命令 — 读取文件原始字节，以 base64 编码返回
/// 适用于所有文件类型（文本、图片、压缩包等），不受 UTF-8 限制
/// 单文件上限 50MB，超出时返回错误（避免 base64 膨胀导致内存问题）
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn download_file_binary(path: String) -> Result<String> {
    const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50MB

    let path_obj = Path::new(&path);

    if !path_obj.exists() {
        return Err(AppError::InvalidPath("文件不存在".to_string()));
    }

    if path_obj.is_dir() {
        return Err(AppError::InvalidPath("是目录，不是文件".to_string()));
    }

    let metadata = fs::metadata(path_obj)?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(AppError::InvalidPath(format!(
            "文件过大 ({}MB)，超过 50MB 下载限制",
            metadata.len() / (1024 * 1024)
        )));
    }

    let bytes = fs::read(path_obj)?;
    let encoded = BASE64_STANDARD.encode(&bytes);

    Ok(encoded)
}

/// 目录打包下载命令 — 递归将目录内容打包为 zip，以 base64 编码返回
/// 单文件上限 100MB，总文件数上限 1000，超出时返回错误
#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn download_directory_to_zip(dir_path: String) -> Result<String> {
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024; // 100MB
    const MAX_FILE_COUNT: usize = 1000;

    let path_obj = Path::new(&dir_path);

    if !path_obj.exists() {
        return Err(AppError::InvalidPath("目录不存在".to_string()));
    }

    if !path_obj.is_dir() {
        return Err(AppError::InvalidPath("是文件，不是目录".to_string()));
    }

    // 收集目录中的所有文件
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    for recursive_result in walkdir::WalkDir::new(path_obj).into_iter() {
        let entry = recursive_result.map_err(|e| AppError::Unknown(e.to_string()))?;
        let file_path = entry.path();

        // 跳过自身
        if file_path == path_obj {
            continue;
        }

        if file_path.is_file() {
            if entries.len() >= MAX_FILE_COUNT {
                return Err(AppError::InvalidPath(format!(
                    "目录文件数超过上限 {}，请缩小打包范围",
                    MAX_FILE_COUNT
                )));
            }

            let metadata = fs::metadata(file_path)?;
            if metadata.len() > MAX_FILE_SIZE {
                return Err(AppError::InvalidPath(format!(
                    "文件 {} 超过 100MB 上限，无法打包",
                    file_path.display()
                )));
            }

            let bytes = fs::read(file_path)?;
            // 使用相对路径作为 zip 内部路径
            let relative_path = pathdiff::diff_paths(file_path, path_obj)
                .unwrap_or_else(|| file_path.to_path_buf());
            let relative_str = relative_path.to_string_lossy().to_string();
            entries.push((relative_str, bytes));
        }
    }

    // 打包为 zip
    let mut zip_bytes = Vec::new();
    {
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
        let options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for (name, data) in entries {
            archive.start_file(name, options)
                .map_err(|e| AppError::Unknown(e.to_string()))?;
            std::io::Write::write_all(&mut archive, &data)
                .map_err(|e| AppError::Unknown(e.to_string()))?;
        }
        archive.finish()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
    }

    let encoded = BASE64_STANDARD.encode(&zip_bytes);
    Ok(encoded)
}
