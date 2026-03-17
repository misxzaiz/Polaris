/**
 * Git 服务工具函数
 *
 * 提供二进制检测、状态标志等辅助功能
 */

use std::path::Path;
use bitflags::bitflags;

/// 最大内联 Diff 大小 (2MB)
pub const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024;

// 文件状态位标记
bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct FileStatusFlags: u16 {
        // 索引状态 (低 4 位)
        const INDEX_NEW      = 0b0000_0001;
        const INDEX_MODIFIED = 0b0000_0010;
        const INDEX_DELETED  = 0b0000_0100;
        const INDEX_RENAMED  = 0b0000_1000;

        // 工作区状态 (中 4 位)
        const WT_NEW         = 0b0001_0000;
        const WT_MODIFIED    = 0b0010_0000;
        const WT_DELETED     = 0b0100_0000;
        const WT_RENAMED     = 0b1000_0000;

        // 其他状态
        const CONFLICTED     = 0b0001_0000_0000;
    }
}

/// 文件状态信息（用于合并多个 Git 状态条目）
#[derive(Debug)]
pub struct FileStatusInfo {
    pub path: String,
    pub flags: FileStatusFlags,
}

/// 已知的二进制文件扩展名
pub const BINARY_EXTENSIONS: &[&str] = &[
    // 图片
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "psd", "ai",
    // 压缩文件
    "zip", "gz", "tar", "rar", "7z", "bz2", "xz", "zst",
    // 可执行文件
    "exe", "dll", "so", "dylib", "app", "bin",
    // 字体
    "ttf", "otf", "woff", "woff2", "eot",
    // 媒体
    "mp3", "mp4", "avi", "mov", "wav", "flac", "ogg", "webm", "mkv",
    // Office
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    // 其他
    "sqlite", "db", "jar", "class", "pyc",
];

/// 根据文件扩展名检测是否为二进制文件
pub fn is_binary_by_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext_lower = ext.to_lowercase();
            BINARY_EXTENSIONS.contains(&ext_lower.as_str())
        })
        .unwrap_or(false)
}

/// 检测字节流是否为二进制内容
pub fn is_binary_bytes(bytes: &[u8]) -> bool {
    const CHECK_SIZE: usize = 8192;
    let sample = &bytes[..bytes.len().min(CHECK_SIZE)];

    // 1. 检查 UTF-8 有效性
    if std::str::from_utf8(sample).is_err() {
        return true;
    }

    // 2. 检查 null 字节（文本文件中很少出现超过 10 个）
    let null_count = sample.iter().filter(|&&b| b == 0).count();
    if null_count > 10 {
        return true;
    }

    // 3. 检查特定二进制文件签名（魔术字节）
    if sample.len() >= 4 {
        // PNG: \x89PNG
        if sample.starts_with(b"\x89PNG") {
            return true;
        }
        // PDF: %PDF
        if sample.starts_with(b"%PDF") {
            return true;
        }
        // ZIP: PK\x03\x04
        if sample.starts_with(b"PK\x03\x04") {
            return true;
        }
        // RAR: Rar!
        if sample.starts_with(b"Rar!") {
            return true;
        }
        // ELF (可执行文件)
        if sample.starts_with(b"\x7fELF") {
            return true;
        }
        // Mach-O (macOS 可执行文件)
        if sample.starts_with(b"\xfe\xed\xfa") || sample.starts_with(b"\xcf\xfa\xed\xfe") {
            return true;
        }
        // PE (Windows 可执行文件)
        if sample.starts_with(b"MZ") {
            return true;
        }
    }

    false
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;
