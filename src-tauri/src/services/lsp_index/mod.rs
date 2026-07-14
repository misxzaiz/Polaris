/*! Polaris 索引模式（lsp_index）
 *
 * 架构：
 * - `db`: SQLite 持久化（每 workspace 独立）
 * - `extractor`: tree-sitter 各语言提取器（目前 Java）
 * - `builder`: 全量 + 单文件构建
 * - `query`: 查询 + 行映射
 * - `regex_fallback`: 历史轻量实现（无索引 / 未支持语言时兜底）
 *
 * 对外入口：`IndexService`（在 state 里持有），并暴露兼容旧接口的 `find_definition` /
 * `find_references` 顶层函数（接受工作区根 + 符号 + 语言 + 扩展名集合，
 * 自动决定走索引 or 回退）。
 */

pub mod builder;
pub mod db;
pub mod extractor;
pub mod model;
pub mod query;
pub mod ranker;
pub mod regex_fallback;
pub mod service;
pub mod watcher;

pub use model::{DirtyBuffer, IndexMatch, IndexStatus};
pub use service::IndexService;

use crate::error::Result;

// ── 兼容旧接口的顶层函数 ───────────────────────────────────
//
// 原 `lsp_index::find_definition` / `find_references` 被 commands/lsp.rs 的
// `lsp_index_*` 命令直接调用，签名要保持兼容。
// 新实现：能拿到 IndexService 时走索引，否则回退到 regex_fallback。

/// 查找符号定义（兼容旧 API：无 workspace service 时回退）
pub fn find_definition(
    root: &str,
    symbol: &str,
    language: &str,
    extensions: &[String],
) -> Result<Vec<IndexMatch>> {
    regex_fallback::find_definition(root, symbol, language, extensions)
        .map(|v| v.into_iter().map(legacy_to_match).collect())
}

/// 查找符号引用（兼容旧 API：无 workspace service 时回退）
pub fn find_references(root: &str, symbol: &str, extensions: &[String]) -> Result<Vec<IndexMatch>> {
    regex_fallback::find_references(root, symbol, extensions)
        .map(|v| v.into_iter().map(legacy_to_match).collect())
}

fn legacy_to_match(m: regex_fallback::IndexMatch) -> IndexMatch {
    IndexMatch::legacy(m.path, m.line as u32, m.column as u32, m.preview)
}
