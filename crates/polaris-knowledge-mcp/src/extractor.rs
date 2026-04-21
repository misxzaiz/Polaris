//! Lightweight, dependency-free symbol extractor for TS/TSX/JS/Rust files.
//!
//! Produces per-module [`StructureReport`] JSON (saved to
//! `.polaris/knowledge/structures/<module>.structure.json`) that the
//! validator and compiler can consume for precise symbol → line lookups.
//!
//! Design notes
//! ------------
//! * **Not a real AST**. We scan line-by-line for top-level signatures
//!   (`export const`, `export function`, `export class`, `export interface`,
//!   `pub fn`, `pub struct`, `pub const`, `pub enum`, `pub trait`). Nested
//!   locals are ignored. Good enough to anchor assertions; full tree-sitter
//!   integration lands in a later sprint.
//! * **Zero extra deps**. Uses only stdlib + already-imported crates.
//! * **Glob-aware**. Honours `ScopeSpec { include, exclude }` from
//!   [`ModuleV2`]. Matching is deliberately simple: `**` matches any number
//!   of path segments, `*` matches within a segment. Non-ASCII paths are
//!   passed through as-is.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{KnowledgeError, Result};
use crate::models::{KnowledgeIndexV2, ModuleV2, ScopeSpec};

// ─── Output types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructureReport {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    #[serde(rename = "symbolCount")]
    pub symbol_count: usize,
    pub files: Vec<FileStructure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStructure {
    pub path: String,
    pub language: String,
    #[serde(rename = "lineCount")]
    pub line_count: usize,
    pub symbols: Vec<SymbolEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolEntry {
    pub name: String,
    pub kind: SymbolKind,
    #[serde(rename = "lineStart")]
    pub line_start: u32,
    #[serde(rename = "exportLevel")]
    pub export_level: ExportLevel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolKind {
    Const,
    Let,
    Function,
    Class,
    Interface,
    TypeAlias,
    Enum,
    Struct,
    Trait,
    Impl,
    Module,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportLevel {
    /// `export`, `export default`, `pub`, `pub(crate)`.
    Public,
    /// Not exported / private visibility.
    Local,
}

// ─── Public API ─────────────────────────────────────────────────────

/// Extract structure for every module in `index`, writing one file per module
/// under `<knowledge_dir>/structures/<id>.structure.json`.
///
/// Returns the collated list of reports so the caller can also return them
/// from an MCP tool response.
pub fn extract_all(
    index: &KnowledgeIndexV2,
    workspace_root: &Path,
    knowledge_dir: &Path,
) -> Result<Vec<StructureReport>> {
    let out_dir = knowledge_dir.join("structures");
    fs::create_dir_all(&out_dir)
        .map_err(|e| KnowledgeError::Io(format!("structures dir: {}", e)))?;

    let mut reports = Vec::with_capacity(index.modules.len());
    for module in &index.modules {
        let report = extract_module(module, workspace_root)?;
        let path = out_dir.join(format!("{}.structure.json", module.id));
        fs::write(&path, serde_json::to_vec_pretty(&report)?)
            .map_err(|e| KnowledgeError::Io(format!("write structure: {}", e)))?;
        reports.push(report);
    }
    Ok(reports)
}

/// Extract a single module. Walks the workspace once, filtering by glob.
pub fn extract_module(module: &ModuleV2, workspace_root: &Path) -> Result<StructureReport> {
    let matched = collect_files(&module.scope, workspace_root)?;

    let mut files: Vec<FileStructure> = Vec::new();
    let mut symbol_count = 0usize;

    for file_rel in matched {
        let abs = workspace_root.join(&file_rel);
        let content = match fs::read_to_string(&abs) {
            Ok(c) => c,
            Err(_) => continue, // skip unreadable files silently
        };
        let language = detect_language(&file_rel);
        let symbols = match language.as_str() {
            "typescript" | "javascript" => extract_ts_symbols(&content),
            "rust" => extract_rust_symbols(&content),
            _ => Vec::new(),
        };
        symbol_count += symbols.len();
        let line_count = content.lines().count();
        files.push(FileStructure {
            path: file_rel.replace('\\', "/"),
            language,
            line_count,
            symbols,
        });
    }

    // Stable sort for reproducible output.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(StructureReport {
        module_id: module.id.clone(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        file_count: files.len(),
        symbol_count,
        files,
    })
}

/// Load a previously persisted structure report.
pub fn load_structure(module_id: &str, knowledge_dir: &Path) -> Result<Option<StructureReport>> {
    let path = knowledge_dir
        .join("structures")
        .join(format!("{}.structure.json", module_id));
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path)
        .map_err(|e| KnowledgeError::Io(format!("read structure: {}", e)))?;
    let report: StructureReport = serde_json::from_str(&body)?;
    Ok(Some(report))
}

// ─── File discovery + glob matching ─────────────────────────────────

/// Return workspace-relative paths (forward slashes) matching the scope.
pub fn collect_files(scope: &ScopeSpec, workspace_root: &Path) -> Result<Vec<String>> {
    let mut matches = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    let include: Vec<&str> = scope.include.iter().map(|s| s.as_str()).collect();
    let exclude: Vec<&str> = scope.exclude.iter().map(|s| s.as_str()).collect();

    walk_dir(workspace_root, workspace_root, &mut |rel_path| {
        if seen.contains(rel_path) {
            return;
        }
        if !matches_any(rel_path, &include) {
            return;
        }
        if matches_any(rel_path, &exclude) {
            return;
        }
        seen.insert(rel_path.to_string());
        matches.push(rel_path.to_string());
    })?;

    matches.sort();
    Ok(matches)
}

fn walk_dir<F: FnMut(&str)>(root: &Path, dir: &Path, cb: &mut F) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip VCS / build / deps dirs aggressively.
        if path.is_dir() {
            if matches!(
                name_str.as_ref(),
                ".git" | "node_modules" | "target" | "dist" | ".polaris" | ".claude" |
                "__pycache__" | ".venv" | "venv" | ".next" | ".idea" | ".vscode" | "coverage"
            ) {
                continue;
            }
            walk_dir(root, &path, cb)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                cb(&rel_str);
            }
        }
    }
    Ok(())
}

/// `true` iff path matches any of the glob patterns.
pub fn matches_any(path: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| glob_match(p, path))
}

/// Tiny recursive-descent glob matcher. Supports:
///
/// * `**` — any number of path segments (0+)
/// * `*` — any characters except `/`
/// * `?` — single char (non-`/`)
/// * literal text
///
/// No brace expansion; keep patterns single-pattern.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    // Normalize: treat backslashes as forward slashes.
    let pat = pattern.replace('\\', "/");
    let tgt = path.replace('\\', "/");
    glob_match_inner(pat.as_bytes(), tgt.as_bytes())
}

fn glob_match_inner(pat: &[u8], tgt: &[u8]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_p, mut star_t): (Option<usize>, Option<usize>) = (None, None);
    let (mut gstar_p, mut gstar_t): (Option<usize>, Option<usize>) = (None, None);

    while ti < tgt.len() {
        if pi < pat.len() {
            // `**` matches any (possibly empty) number of segments
            if pi + 1 < pat.len() && pat[pi] == b'*' && pat[pi + 1] == b'*' {
                gstar_p = Some(pi + 2);
                gstar_t = Some(ti);
                // Skip optional trailing '/'.
                pi += 2;
                if pi < pat.len() && pat[pi] == b'/' {
                    pi += 1;
                }
                continue;
            }
            match pat[pi] {
                b'*' => {
                    star_p = Some(pi + 1);
                    star_t = Some(ti);
                    pi += 1;
                    continue;
                }
                b'?' => {
                    if tgt[ti] == b'/' {
                        // `?` doesn't cross segments; fall through to backtrack.
                    } else {
                        pi += 1;
                        ti += 1;
                        continue;
                    }
                }
                c if c == tgt[ti] => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                _ => {}
            }
        }
        // Backtrack: prefer `*` first, then `**`.
        if let (Some(sp), Some(st)) = (star_p, star_t) {
            if tgt[st] != b'/' {
                pi = sp;
                ti = st + 1;
                star_t = Some(ti);
                continue;
            }
            // `*` cannot cross a segment; fall through to `**`.
        }
        if let (Some(gp), Some(gt)) = (gstar_p, gstar_t) {
            pi = gp;
            ti = gt + 1;
            gstar_t = Some(ti);
            continue;
        }
        return false;
    }

    // Consume trailing `*` / `**` in pattern.
    while pi < pat.len() {
        if pat[pi] == b'*' {
            pi += 1;
            continue;
        }
        if pat[pi] == b'/' && pi + 1 == pat.len() {
            pi += 1;
            continue;
        }
        return false;
    }
    true
}

// ─── Language-specific extractors ───────────────────────────────────

fn detect_language(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        "typescript".into()
    } else if lower.ends_with(".js") || lower.ends_with(".jsx") || lower.ends_with(".mjs") {
        "javascript".into()
    } else if lower.ends_with(".rs") {
        "rust".into()
    } else if lower.ends_with(".md") {
        "markdown".into()
    } else if lower.ends_with(".json") {
        "json".into()
    } else {
        "other".into()
    }
}

/// Extract top-level TypeScript / JavaScript symbols. Line-based; handles:
///   - `export const Name = ...`
///   - `export let Name = ...`
///   - `export function name(...)`
///   - `export class Name ...`
///   - `export interface Name ...`
///   - `export type Name = ...`
///   - `export enum Name ...`
///   - `export default function ...`
///   - Non-export equivalents become `ExportLevel::Local`.
fn extract_ts_symbols(content: &str) -> Vec<SymbolEntry> {
    let mut out = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim_start();
        let line_no = (i as u32) + 1;
        let (is_export, rest) = strip_export_ts(line);
        let level = if is_export {
            ExportLevel::Public
        } else {
            ExportLevel::Local
        };

        if let Some(name) = after_keyword(rest, "const") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::Const,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(name) = after_keyword(rest, "let") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::Let,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        // async function / function*
        if let Some(name) = function_name_ts(rest) {
            out.push(SymbolEntry {
                name,
                kind: SymbolKind::Function,
                line_start: line_no,
                export_level: level,
            });
            continue;
        }
        if let Some(name) = after_keyword(rest, "class") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::Class,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(name) = after_keyword(rest, "interface") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::Interface,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(name) = after_keyword(rest, "type") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::TypeAlias,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(name) = after_keyword(rest, "enum") {
            if let Some(ident) = first_ident(name) {
                out.push(SymbolEntry {
                    name: ident,
                    kind: SymbolKind::Enum,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
    }
    out
}

fn strip_export_ts(line: &str) -> (bool, &str) {
    if let Some(rest) = line.strip_prefix("export default ") {
        return (true, rest);
    }
    if let Some(rest) = line.strip_prefix("export ") {
        return (true, rest);
    }
    (false, line)
}

fn function_name_ts(rest: &str) -> Option<String> {
    // `async function foo(`, `function bar(`, `function* gen(`
    let mut cursor = rest;
    if let Some(stripped) = cursor.strip_prefix("async ") {
        cursor = stripped;
    }
    if let Some(after) = cursor.strip_prefix("function") {
        let after = after.trim_start_matches('*').trim_start();
        return first_ident(after);
    }
    None
}

/// Extract top-level Rust symbols. Handles:
///   - `pub fn name(...)`, `fn name(...)` (and `pub(crate) fn`, `async fn`)
///   - `pub struct Name`, `struct Name`
///   - `pub enum Name`, `enum Name`
///   - `pub trait Name`, `trait Name`
///   - `pub const NAME`, `const NAME`
///   - `pub mod name`, `mod name`
///   - `impl Name { ... }` (counts as an `Impl` anchor)
fn extract_rust_symbols(content: &str) -> Vec<SymbolEntry> {
    let mut out = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim_start();
        let line_no = (i as u32) + 1;
        let (is_pub, rest) = strip_pub_rust(line);
        let level = if is_pub {
            ExportLevel::Public
        } else {
            ExportLevel::Local
        };

        // async fn / fn
        let mut rest_fn = rest;
        if let Some(stripped) = rest_fn.strip_prefix("async ") {
            rest_fn = stripped;
        }
        if let Some(after) = rest_fn.strip_prefix("fn ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Function,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("struct ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Struct,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("enum ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Enum,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("trait ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Trait,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("const ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Const,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("static ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Const,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("mod ") {
            if let Some(name) = first_ident(after) {
                out.push(SymbolEntry {
                    name,
                    kind: SymbolKind::Module,
                    line_start: line_no,
                    export_level: level,
                });
                continue;
            }
        }
        // `impl Foo {` or `impl<T> Foo<T> for Bar {` → capture the target name.
        if let Some(after) = rest.strip_prefix("impl") {
            if after.starts_with(' ') || after.starts_with('<') || after.starts_with('!') {
                if let Some(name) = impl_target(after) {
                    out.push(SymbolEntry {
                        name,
                        kind: SymbolKind::Impl,
                        line_start: line_no,
                        export_level: ExportLevel::Local,
                    });
                    continue;
                }
            }
        }
    }
    out
}

fn strip_pub_rust(line: &str) -> (bool, &str) {
    if let Some(rest) = line.strip_prefix("pub(crate) ") {
        return (true, rest);
    }
    if let Some(rest) = line.strip_prefix("pub(super) ") {
        return (true, rest);
    }
    if let Some(rest) = line.strip_prefix("pub ") {
        return (true, rest);
    }
    (false, line)
}

fn impl_target(raw: &str) -> Option<String> {
    // Rough: strip generics `<...>` and take the first identifier after that.
    // Handles `impl Foo` / `impl<T> Foo<T>` / `impl<T> Trait for Foo`.
    let mut cursor = raw.trim_start();
    // Drop generic params.
    if cursor.starts_with('<') {
        if let Some(end) = find_matching_angle(cursor) {
            cursor = &cursor[end + 1..].trim_start();
        }
    }
    // Split on " for " if present; target is after.
    if let Some(idx) = cursor.find(" for ") {
        let after = &cursor[idx + 5..].trim_start();
        return first_ident(after);
    }
    first_ident(cursor)
}

fn find_matching_angle(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, b) in s.as_bytes().iter().enumerate() {
        match *b {
            b'<' => depth += 1,
            b'>' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

// ─── Small parsing helpers ──────────────────────────────────────────

fn first_ident(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut start: Option<usize> = None;
    let mut end = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        let is_start = b.is_ascii_alphabetic() || *b == b'_';
        let is_cont = is_start || b.is_ascii_digit();
        if start.is_none() {
            if is_start {
                start = Some(i);
                end = i + 1;
            } else if b.is_ascii_whitespace() || *b == b':' || *b == b'(' {
                continue;
            } else {
                return None;
            }
        } else if is_cont {
            end = i + 1;
        } else {
            break;
        }
    }
    let s0 = start?;
    Some(s[s0..end].to_string())
}

fn after_keyword<'a>(s: &'a str, keyword: &str) -> Option<&'a str> {
    let with_space = format!("{} ", keyword);
    s.strip_prefix(&with_space)
}

// ─── Symbol index (name → location) ─────────────────────────────────

/// Map symbol name → list of (file, line) occurrences across the report.
pub fn build_symbol_index(report: &StructureReport) -> BTreeMap<String, Vec<(String, u32)>> {
    let mut idx: BTreeMap<String, Vec<(String, u32)>> = BTreeMap::new();
    for file in &report.files {
        for s in &file.symbols {
            idx.entry(s.name.clone())
                .or_default()
                .push((file.path.clone(), s.line_start));
        }
    }
    idx
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── glob ────────────────────────────────────────────────────────

    #[test]
    fn glob_matches_globstar() {
        assert!(glob_match("src/**", "src/a.ts"));
        assert!(glob_match("src/**", "src/foo/bar.ts"));
        assert!(glob_match("src/**", "src/foo/bar/baz.ts"));
        assert!(!glob_match("src/**", "other/foo.ts"));
    }

    #[test]
    fn glob_matches_single_star() {
        assert!(glob_match("src/*.ts", "src/a.ts"));
        assert!(!glob_match("src/*.ts", "src/foo/a.ts"));
    }

    #[test]
    fn glob_matches_exact() {
        assert!(glob_match("README.md", "README.md"));
        assert!(!glob_match("README.md", "src/README.md"));
    }

    #[test]
    fn glob_matches_prefix_startstar() {
        assert!(glob_match("src/utils/markdown*.ts", "src/utils/markdown.ts"));
        assert!(glob_match("src/utils/markdown*.ts", "src/utils/markdownRenderer.ts"));
        assert!(!glob_match("src/utils/markdown*.ts", "src/utils/other.ts"));
    }

    #[test]
    fn glob_matches_exclude_patterns() {
        // typical exclude from chat-render scope
        assert!(glob_match("**/*.test.ts", "src/foo.test.ts"));
        assert!(glob_match("**/*.test.ts", "src/a/b/c.test.ts"));
        assert!(!glob_match("**/*.test.ts", "src/foo.ts"));
    }

    // ── TS extraction ───────────────────────────────────────────────

    #[test]
    fn extract_ts_exports() {
        let src = r#"
import { foo } from './foo';

export const MAX_SNAPSHOTS = 20;
export let mutableFlag = true;
export function compact(msgs: Message[]) {
    return msgs;
}
export class MessageCompactor {
    private cache = new Map();
}
export interface CompactOptions { }
export type Handler = (x: number) => void;
export enum Direction { Up, Down }

const privateLocal = 42;
function helper() {}
"#;
        let syms = extract_ts_symbols(src);
        let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"MAX_SNAPSHOTS"));
        assert!(names.contains(&"mutableFlag"));
        assert!(names.contains(&"compact"));
        assert!(names.contains(&"MessageCompactor"));
        assert!(names.contains(&"CompactOptions"));
        assert!(names.contains(&"Handler"));
        assert!(names.contains(&"Direction"));
        assert!(names.contains(&"privateLocal"));
        assert!(names.contains(&"helper"));

        // Export level tracking.
        let max = syms.iter().find(|s| s.name == "MAX_SNAPSHOTS").unwrap();
        assert_eq!(max.export_level, ExportLevel::Public);
        let priv_local = syms.iter().find(|s| s.name == "privateLocal").unwrap();
        assert_eq!(priv_local.export_level, ExportLevel::Local);
    }

    #[test]
    fn extract_ts_async_and_default() {
        let src = r#"
export default function render() {}
export async function loadIndex() {}
"#;
        let syms = extract_ts_symbols(src);
        let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"render"));
        assert!(names.contains(&"loadIndex"));
    }

    // ── Rust extraction ─────────────────────────────────────────────

    #[test]
    fn extract_rust_items() {
        let src = r#"
//! crate docs
use std::fs;

pub const MAX: usize = 20;
pub static GLOBAL: i32 = 0;
const INTERNAL: u32 = 1;

pub fn compile_context(req: &Req) -> Result<Out> { todo!() }
async fn helper() {}

pub struct ModuleV2 { pub id: String }
struct Hidden;

pub enum Confidence { Green, Yellow }

pub trait Validator { fn check(&self); }

pub mod migrate {}

impl Validator for Engine {
    fn check(&self) {}
}
impl<T> Iterator for Wrapper<T> { type Item = T; fn next(&mut self) -> Option<T> { None } }
"#;
        let syms = extract_rust_symbols(src);
        let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"MAX"));
        assert!(names.contains(&"GLOBAL"));
        assert!(names.contains(&"INTERNAL"));
        assert!(names.contains(&"compile_context"));
        assert!(names.contains(&"helper"));
        assert!(names.contains(&"ModuleV2"));
        assert!(names.contains(&"Hidden"));
        assert!(names.contains(&"Confidence"));
        assert!(names.contains(&"Validator"));
        assert!(names.contains(&"migrate"));
        // impl anchors — target is "Engine" or "Wrapper".
        assert!(names.contains(&"Engine"));
        assert!(names.contains(&"Wrapper"));

        let max = syms.iter().find(|s| s.name == "MAX").unwrap();
        assert_eq!(max.export_level, ExportLevel::Public);
        let hidden = syms.iter().find(|s| s.name == "Hidden").unwrap();
        assert_eq!(hidden.export_level, ExportLevel::Local);
    }

    // ── End-to-end on a fake workspace ──────────────────────────────

    #[test]
    fn extract_module_over_fake_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let src_dir = root.join("src/utils");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(
            src_dir.join("messageCompactor.ts"),
            "export const MAX_SNAPSHOTS = 20;\nexport function compact() {}\n",
        )
        .unwrap();
        fs::write(
            src_dir.join("cache.ts"),
            "export class MarkdownRenderCache { constructor() {} }\n",
        )
        .unwrap();
        fs::write(
            src_dir.join("cache.test.ts"),
            "// excluded test file\nexport const dummy = 1;\n",
        )
        .unwrap();

        let module = ModuleV2 {
            id: "chat-render".into(),
            name: "Chat Render".into(),
            domain: "ai-conversation".into(),
            scope: ScopeSpec {
                include: vec!["src/utils/**".into()],
                exclude: vec!["**/*.test.ts".into()],
            },
            dependencies: Vec::new(),
            dependents: Vec::new(),
            document_file: "chat-render.md".into(),
            structure_file: None,
            complexity: crate::models::Complexity::High,
            change_frequency: crate::models::ChangeFrequency::High,
            assertions: Vec::new(),
            traps: Vec::new(),
        };

        let report = extract_module(&module, root).unwrap();
        assert_eq!(report.module_id, "chat-render");
        assert_eq!(report.file_count, 2, "excluded .test.ts must be skipped");

        let compactor = report
            .files
            .iter()
            .find(|f| f.path.ends_with("messageCompactor.ts"))
            .unwrap();
        assert!(compactor.symbols.iter().any(|s| s.name == "MAX_SNAPSHOTS"));
        assert!(compactor.symbols.iter().any(|s| s.name == "compact"));

        let cache = report
            .files
            .iter()
            .find(|f| f.path.ends_with("cache.ts"))
            .unwrap();
        assert!(cache.symbols.iter().any(|s| s.name == "MarkdownRenderCache"));
    }

    #[test]
    fn symbol_index_aggregates_occurrences() {
        let report = StructureReport {
            module_id: "m".into(),
            generated_at: "t".into(),
            file_count: 2,
            symbol_count: 2,
            files: vec![
                FileStructure {
                    path: "a.ts".into(),
                    language: "typescript".into(),
                    line_count: 1,
                    symbols: vec![SymbolEntry {
                        name: "X".into(),
                        kind: SymbolKind::Const,
                        line_start: 3,
                        export_level: ExportLevel::Public,
                    }],
                },
                FileStructure {
                    path: "b.ts".into(),
                    language: "typescript".into(),
                    line_count: 1,
                    symbols: vec![SymbolEntry {
                        name: "X".into(),
                        kind: SymbolKind::Class,
                        line_start: 17,
                        export_level: ExportLevel::Public,
                    }],
                },
            ],
        };
        let idx = build_symbol_index(&report);
        let occurrences = idx.get("X").unwrap();
        assert_eq!(occurrences.len(), 2);
        assert_eq!(occurrences[0], ("a.ts".into(), 3));
        assert_eq!(occurrences[1], ("b.ts".into(), 17));
    }
}
