/*! 轻量索引模式：无常驻进程的代码导航
 *
 * 用 `walkdir` + `regex` 在工作区内做"查找引用 / 跳转定义"，面向低配机
 * 或重型语言（Java / C++）——零常驻内存，按需扫描，用完即返回。
 *
 * 定位精度低于真正的 LSP（不区分同名不同作用域），但对日常"查询 / 查应用"
 * 完全够用，且不需要启动 JVM 等重型语言服务器。
 */

use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::error::{AppError, Result};

/// 单条匹配结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMatch {
    /// 文件绝对路径
    pub path: String,
    /// 行号（1-based，便于直接落位）
    pub line: usize,
    /// 列号（0-based，UTF-8 字符计数）
    pub column: usize,
    /// 该行去除首尾空白后的预览文本（截断）
    pub preview: String,
}

// ── 扫描限制（保护低配机，避免大仓库卡死或撑爆内存）──────────────
/// 超过此大小的文件视为非源码，跳过
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
/// 单次查询返回的最大匹配数
const MAX_MATCHES: usize = 2000;
/// 定义查询返回上限（定义通常很少）
const MAX_DEFINITION_MATCHES: usize = 200;
/// 单次扫描的最大文件数
const MAX_FILES: usize = 50_000;
/// 预览文本最大字符数
const PREVIEW_MAX: usize = 200;
/// 超长行（疑似压缩产物）跳过阈值
const MAX_LINE_LEN: usize = 5000;

/// 默认忽略目录（依赖产物、版本控制、构建输出等）
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".hg"
            | ".svn"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | "out"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".idea"
            | ".gradle"
            | ".cache"
            | "bin"
            | "obj"
            | ".pnpm-store"
            | "coverage"
            | ".turbo"
            | ".output"
            | ".dart_tool"
    )
}

/// 文件扩展名是否在目标集合内（exts 为空表示不限制）
fn ext_matches(path: &Path, exts: &[String]) -> bool {
    if exts.is_empty() {
        return true;
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) => {
            let e = e.to_lowercase();
            exts.iter()
                .any(|x| x.trim_start_matches('.').to_lowercase() == e)
        }
        None => false,
    }
}

/// 在 `root` 下查找 `symbol` 的全词引用（查应用）。
pub fn find_references(root: &str, symbol: &str, exts: &[String]) -> Result<Vec<IndexMatch>> {
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!(r"\b{}\b", regex::escape(symbol));
    search_with_regex(root, &pattern, exts, MAX_MATCHES)
}

/// 语言感知的"定义"模式集合（启发式，非语义精确）。
///
/// 目前各语言共用一组通用模式，覆盖 class/interface/enum/struct/trait、
/// fn/func/function/def、type、const/let/var/val 声明，以及 `foo(...) {`
/// 形式的方法/函数定义。预留 `language` 参数供将来细化。
fn definition_patterns(symbol: &str, language: &str) -> Vec<String> {
    let s = regex::escape(symbol);
    let _ = language;
    vec![
        format!(r"\b(class|interface|enum|struct|trait)\s+{}\b", s),
        format!(r"\b(fn|func|function|def|sub)\s+{}\b", s),
        format!(r"\b(type|typedef|typealias)\s+{}\b", s),
        format!(r"\b(const|let|var|val|static)\s+{}\b", s),
        format!(r"\b{}\s*(:|=)\s*(function|\()", s),
        format!(r"\b{}\s*\([^)]*\)\s*\{{", s),
    ]
}

/// 在 `root` 下查找 `symbol` 的定义候选（跳转定义）。
pub fn find_definition(
    root: &str,
    symbol: &str,
    language: &str,
    exts: &[String],
) -> Result<Vec<IndexMatch>> {
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return Ok(Vec::new());
    }
    let joined = definition_patterns(symbol, language).join("|");
    search_with_regex(root, &joined, exts, MAX_DEFINITION_MATCHES)
}

/// 核心扫描：遍历 root，对匹配扩展名的文本文件逐行正则查找。
fn search_with_regex(
    root: &str,
    pattern: &str,
    exts: &[String],
    cap: usize,
) -> Result<Vec<IndexMatch>> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!("不是有效目录: {}", root)));
    }
    let re = regex::Regex::new(pattern)
        .map_err(|e| AppError::ValidationError(format!("正则构造失败: {}", e)))?;

    let mut out: Vec<IndexMatch> = Vec::new();
    let mut files_seen = 0usize;

    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // 进入目录前先判断是否忽略
            if e.file_type().is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    return !is_ignored_dir(name);
                }
            }
            true
        });

    for entry in walker.filter_map(|e| e.ok()) {
        if out.len() >= cap || files_seen >= MAX_FILES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !ext_matches(path, exts) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        files_seen += 1;

        let content = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // 跳过疑似二进制（前 8KB 含 NUL 字节）
        if content.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&content);
        let path_str = path.to_string_lossy().to_string();

        for (idx, line) in text.lines().enumerate() {
            if out.len() >= cap {
                break;
            }
            if line.len() > MAX_LINE_LEN {
                continue;
            }
            for m in re.find_iter(line) {
                if out.len() >= cap {
                    break;
                }
                let col = line[..m.start()].chars().count();
                let preview = {
                    let t = line.trim();
                    if t.chars().count() > PREVIEW_MAX {
                        let truncated: String = t.chars().take(PREVIEW_MAX).collect();
                        format!("{}…", truncated)
                    } else {
                        t.to_string()
                    }
                };
                out.push(IndexMatch {
                    path: path_str.clone(),
                    line: idx + 1,
                    column: col,
                    preview,
                });
            }
        }
    }

    Ok(out)
}
