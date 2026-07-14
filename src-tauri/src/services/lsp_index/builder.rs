/*! 索引构建器（S3 实装；当前是骨架）
 *
 * 负责：
 * - 工作区遍历（沿用 walkdir + ignore 规则）
 * - 并行解析（rayon）
 * - 批量入库（单事务）
 * - 进度上报（回调）
 */

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use walkdir::WalkDir;

use crate::error::Result;

use super::db::IndexDb;
use super::extractor;
use super::model::FileIndex;

/// 进度回调
pub type ProgressFn = Arc<dyn Fn(u32, u32) + Send + Sync>;

/// 全量构建。返回 (索引文件数, 错误数)。
pub fn build_full(
    db: &IndexDb,
    workspace: &Path,
    progress: Option<ProgressFn>,
) -> Result<(u32, u32)> {
    let files = collect_indexable_files(workspace);
    let total = files.len() as u32;

    if let Some(cb) = progress.as_ref() {
        cb(0, total);
    }

    let done = AtomicU32::new(0);
    let errors = AtomicU32::new(0);

    let extracted: Vec<FileIndex> = files
        .par_iter()
        .filter_map(|abs| {
            let rel = abs
                .strip_prefix(workspace)
                .unwrap_or(abs)
                .to_string_lossy()
                .replace('\\', "/");

            // 读文件 + 跳过过大/二进制
            let bytes = match std::fs::read(abs) {
                Ok(b) => b,
                Err(_) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            };
            if bytes.len() > 5 * 1024 * 1024 {
                return None;
            }
            // 二进制启发式
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return None;
            }
            let source = match std::str::from_utf8(&bytes) {
                Ok(s) => s.to_string(),
                Err(_) => return None,
            };

            let ext = abs.extension().and_then(|s| s.to_str()).unwrap_or("");
            let lang = extractor::language_for_ext(ext)?;

            let extracted_opt = match extractor::extract(&rel, abs, lang, &source) {
                Ok(opt) => opt,
                Err(_) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            };
            let mut fi = extracted_opt?;

            // 填充 mtime/size/hash（extractor 内部默认 0）
            if let Ok(meta) = std::fs::metadata(abs) {
                fi.size = meta.len();
                fi.mtime_ns = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as i64)
                    .unwrap_or(0);
            }
            if fi.content_hash == 0 {
                fi.content_hash = xxhash_rust::xxh3::xxh3_64(source.as_bytes());
            }

            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(cb) = progress.as_ref() {
                if n % 64 == 0 || n == total {
                    cb(n, total);
                }
            }
            Some(fi)
        })
        .collect();

    db.truncate_all()?;
    // 分批写入，避免事务过大
    for chunk in extracted.chunks(500) {
        db.batch_insert_files(chunk)?;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    db.set_last_built_at(now_ms)?;

    if let Some(cb) = progress {
        cb(total, total);
    }

    Ok((extracted.len() as u32, errors.load(Ordering::Relaxed)))
}

/// 收集工作区下所有可索引的文件（暂时只 .java；后续语言加进来）。
fn collect_indexable_files(workspace: &Path) -> Vec<PathBuf> {
    WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    return !is_ignored_dir(name);
                }
            }
            true
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|ext| extractor::language_for_ext(ext).is_some())
                .unwrap_or(false)
        })
        .collect()
}

fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | ".idea"
            | ".vscode"
            | ".gradle"
            | ".mvn"
            | ".m2"
            | "target"
            | "build"
            | "out"
            | "bin"
            | "classes"
            | "node_modules"
            | "dist"
            | ".next"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | ".pnpm-store"
            | "coverage"
            | ".turbo"
            | ".output"
            | ".dart_tool"
            | ".settings"
            | ".metadata"
            | ".eclipse"
            | "logs"
            | "tmp"
            | "temp"
            | ".polaris"
    )
}

/// 单文件增量更新（替换式）。
pub fn build_one(db: &IndexDb, workspace: &Path, abs_path: &Path) -> Result<()> {
    let rel = abs_path
        .strip_prefix(workspace)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .replace('\\', "/");
    let bytes = match std::fs::read(abs_path) {
        Ok(b) => b,
        Err(_) => {
            // 文件被删 → 清记录
            db.delete_file(&rel)?;
            return Ok(());
        }
    };
    if bytes.len() > 5 * 1024 * 1024 {
        return Ok(());
    }
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(());
    }
    let source = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(_) => return Ok(()),
    };
    let ext = abs_path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let Some(lang) = extractor::language_for_ext(ext) else {
        return Ok(());
    };

    let mut fi = match extractor::extract(&rel, abs_path, lang, &source)? {
        Some(fi) => fi,
        None => return Ok(()),
    };
    if let Ok(meta) = std::fs::metadata(abs_path) {
        fi.size = meta.len();
        fi.mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
    }
    if fi.content_hash == 0 {
        fi.content_hash = xxhash_rust::xxh3::xxh3_64(source.as_bytes());
    }
    db.replace_file(&fi)?;
    Ok(())
}
