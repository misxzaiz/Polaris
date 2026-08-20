/*! 索引查询 + 排序（S4 实装；当前为骨架，仅做基础查询）
 *
 * 排序在 [`rank::rank_definition_candidates`] 里。dirty buffer 合并由 service 层负责。
 */

use crate::error::Result;

use super::db::{IndexDb, RefRow, SymbolRow};
use super::model::{IndexMatch, RefKind, SymbolKind};

/// 查询定义候选。
pub fn find_definition_rows(
    db: &IndexDb,
    name: &str,
) -> Result<Vec<SymbolRow>> {
    db.find_symbols_by_name(name)
}

/// 查询引用候选。
pub fn find_references_rows(
    db: &IndexDb,
    name: &str,
    target_fqn: Option<&str>,
    max: usize,
) -> Result<Vec<RefRow>> {
    db.find_refs_by_name(name, target_fqn, max)
}

/// `SymbolRow` → 前端 `IndexMatch`，附绝对路径。
pub fn symbol_to_match(row: &SymbolRow, workspace_abs: &str, score: Option<i32>) -> IndexMatch {
    let abs = join_abs(workspace_abs, &row.rel_path);
    IndexMatch {
        path: abs,
        line: row.name_line,
        column: row.name_column,
        preview: format_symbol_preview(row),
        kind: Some(row.kind.as_str()),
        fqn: Some(row.fqn.clone()),
        ref_kind: None,
        score,
    }
}

/// `RefRow` → 前端 `IndexMatch`。
pub fn ref_to_match(row: &RefRow, workspace_abs: &str) -> IndexMatch {
    let abs = join_abs(workspace_abs, &row.rel_path);
    IndexMatch {
        path: abs,
        line: row.line,
        column: row.column,
        preview: row.line_text.clone(),
        kind: None,
        fqn: row.target_fqn.clone(),
        ref_kind: Some(row.ref_kind.as_str()),
        score: None,
    }
}

fn format_symbol_preview(row: &SymbolRow) -> String {
    let mut s = String::new();
    s.push_str(row.kind.as_str());
    s.push(' ');
    s.push_str(&row.fqn);
    if let Some(sig) = &row.signature {
        s.push_str(sig);
    }
    s
}

fn join_abs(workspace: &str, rel: &str) -> String {
    let sep = if workspace.contains('\\') { '\\' } else { '/' };
    let mut s = workspace.to_string();
    if !s.ends_with(['/', '\\']) {
        s.push(sep);
    }
    s.push_str(&rel.replace('/', &sep.to_string()));
    s
}

/// 让外部 dead-code 检查不报警（这两个 enum 当前只在 model 里使用）。
#[allow(dead_code)]
fn _force_use(_: SymbolKind, _: RefKind) {}
