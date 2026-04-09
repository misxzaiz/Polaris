use crate::error::{AppError, Result};
use std::path::Path;
use std::fs;
use std::time::SystemTime;

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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

/// 创建目录
#[tauri::command]
pub async fn create_directory(path: String) -> Result<()> {
    fs::create_dir_all(&path)?;
    
    Ok(())
}

/// 删除文件或目录
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
pub async fn copy_path(source: String, destination: String) -> Result<()> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&destination);

    if !source_path.exists() {
        return Err(AppError::InvalidPath("源路径不存在".to_string()));
    }

    if source_path.is_dir() {
        // 复制目录
        copy_dir_all(source_path, dest_path)?;
    } else {
        // 复制文件
        // 确保目标目录存在
        if let Some(parent) = dest_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::copy(source_path, dest_path)?;
    }

    Ok(())
}

/// 移动文件或目录
#[tauri::command]
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

/// 检查路径是否存在
#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool> {
    Ok(Path::new(&path).exists())
}

/// 读取工作区中的自定义命令
/// 从 .claude/commands/ 目录读取 .md 文件
#[tauri::command]
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
#[tauri::command]
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