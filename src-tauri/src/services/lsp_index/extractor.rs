/*! 多语言 extractor 入口。
 *
 * - Java：tree-sitter（S2 实现）
 * - 其他：暂时返回 None，调用方 fallback 到 regex_fallback。
 */

use std::path::Path;

use crate::error::Result;

use super::model::FileIndex;

pub mod java;
// 注：单元测试位于 java_test.rs（被 java.rs 内部 #[cfg(test)] 模块通过 include! 引用），
// 但本机 cargo test --lib 受 Tauri 原生 DLL 限制无法跑（memory: rust-lib-test-env-limit）。
// 等 CI 或独立 crate 化后再启用。当前阶段以 cargo check 验证语法，逻辑靠手测/文档。

/// 根据语言/扩展名分发到具体 extractor。
/// 返回 `Ok(None)` 表示该语言尚未支持索引提取，调用方应走 regex 兜底。
pub fn extract(
    rel_path: &str,
    abs_path: &Path,
    language: &str,
    source: &str,
) -> Result<Option<FileIndex>> {
    match language {
        "java" => Ok(Some(java::extract_java(rel_path, abs_path, source)?)),
        _ => Ok(None),
    }
}

/// 给定文件扩展名 → 语言 ID（用于 builder 决定是否能用 AST extractor）。
pub fn language_for_ext(ext: &str) -> Option<&'static str> {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        "java" => Some("java"),
        _ => None,
    }
}
