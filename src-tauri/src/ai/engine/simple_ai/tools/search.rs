/*! 搜索工具：search_files（按内容）+ glob（按文件名 pattern） */

use std::path::PathBuf;

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

/// 跳过的依赖/产物目录。
const SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", ".next", "build", ".venv"];

/// 解析搜索根目录：绝对路径原样，相对路径相对 `workdir`，缺省为 `workdir`。
fn resolve_root(path: Option<&str>, workdir: &str) -> PathBuf {
    match path {
        Some(p) if std::path::Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => PathBuf::from(workdir).join(p),
        None => PathBuf::from(workdir),
    }
}

/// 构建跳过依赖目录的 walker。
fn walker(root: &PathBuf) -> walkdir::IntoIter {
    WalkDir::new(root).into_iter()
}

fn is_skip_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.file_type().is_dir() {
        if let Some(name) = entry.file_name().to_str() {
            return SKIP_DIRS.contains(&name);
        }
    }
    false
}

// ============================================================================
// search_files（按内容）
// ============================================================================

pub(super) struct SearchFilesTool;

#[async_trait::async_trait]
impl Tool for SearchFilesTool {
    fn name(&self) -> &'static str {
        "search_files"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "search_files",
                "description": "Recursively search file CONTENTS for a text pattern under a directory. Cross-platform and reliable; skips .git/node_modules/target/dist/.next/build. Use this instead of shell grep/findstr/find.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Text to search for in file contents (plain substring, case-sensitive)" },
                        "path": { "type": "string", "description": "Directory to search under (optional, defaults to working directory)" },
                        "file_ext": { "type": "string", "description": "Optional file extension filter without dot, e.g. 'rs' or 'ts'" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        run_search_files(
            args["pattern"].as_str().unwrap_or(""),
            args["path"].as_str(),
            args["file_ext"].as_str(),
            ctx.work_dir,
        )
    }
}

fn run_search_files(
    pattern: &str,
    path: Option<&str>,
    file_ext: Option<&str>,
    workdir: &str,
) -> ToolOutcome {
    if pattern.is_empty() {
        return ToolOutcome::fail("pattern must not be empty".to_string());
    }

    let root = resolve_root(path, workdir);

    const MAX_MATCHES: usize = 200;
    const MAX_LINE_LEN: usize = 300;

    let mut matches: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in walker(&root)
        .filter_entry(|e| !is_skip_dir(e))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path();
        if let Some(ext) = file_ext {
            let ext_ok = file_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case(ext))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
        }
        // 仅读取文本文件（读取失败 / 非 UTF-8 直接跳过）
        let Ok(content) = std::fs::read_to_string(file_path) else {
            continue;
        };
        let rel = file_path.strip_prefix(&root).unwrap_or(file_path);
        for (idx, line) in content.lines().enumerate() {
            if line.contains(pattern) {
                let shown = truncate_chars(line.trim(), MAX_LINE_LEN);
                matches.push(format!("{}:{}: {}", rel.display(), idx + 1, shown));
                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }

    if matches.is_empty() {
        ToolOutcome::ok(format!("No matches for '{}'", pattern))
    } else {
        let mut out = matches.join("\n");
        if truncated {
            out.push_str(&format!("\n... (truncated at {} matches)", MAX_MATCHES));
        }
        ToolOutcome::ok(out)
    }
}

// ============================================================================
// glob（按文件名 pattern）
// ============================================================================

pub(super) struct GlobTool;

#[async_trait::async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files by name pattern (glob). Supports '*' (any chars except '/'), '**' (any path depth), and '?' (single char). Examples: '**/*.rs', 'src/*.ts', 'Cargo.toml'. Skips dependency/build dirs. Use this to locate files by name; use search_files to search file contents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob pattern relative to the search directory, e.g. '**/*.rs'" },
                        "path": { "type": "string", "description": "Directory to search under (optional, defaults to working directory)" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        run_glob(
            args["pattern"].as_str().unwrap_or(""),
            args["path"].as_str(),
            ctx.work_dir,
        )
    }
}

fn run_glob(pattern: &str, path: Option<&str>, workdir: &str) -> ToolOutcome {
    if pattern.is_empty() {
        return ToolOutcome::fail("pattern must not be empty".to_string());
    }

    let root = resolve_root(path, workdir);
    const MAX_RESULTS: usize = 300;

    let mut results: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in walker(&root)
        .filter_entry(|e| !is_skip_dir(e))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy();
        if glob_match(pattern, &rel_str) {
            results.push(rel_str.replace('\\', "/"));
            if results.len() >= MAX_RESULTS {
                truncated = true;
                break;
            }
        }
    }

    if results.is_empty() {
        ToolOutcome::ok(format!("No files match '{}'", pattern))
    } else {
        results.sort();
        let mut out = results.join("\n");
        if truncated {
            out.push_str(&format!("\n... (truncated at {} results)", MAX_RESULTS));
        }
        ToolOutcome::ok(out)
    }
}

/// glob 匹配：按 '/' 分段，`**` 匹配任意层级（含 0 段），段内 `*`/`?` 不跨 '/'。
fn glob_match(pattern: &str, path: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let normalized = path.replace('\\', "/");
    let seg: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    match_segments(&pat, &seg)
}

fn match_segments(pat: &[&str], seg: &[&str]) -> bool {
    if pat.is_empty() {
        return seg.is_empty();
    }
    if pat[0] == "**" {
        // 消费 0 段（跳过 **）或消费 1 段后继续用 ** 匹配
        if match_segments(&pat[1..], seg) {
            return true;
        }
        if !seg.is_empty() && match_segments(pat, &seg[1..]) {
            return true;
        }
        return false;
    }
    if seg.is_empty() {
        return false;
    }
    if match_one_segment(pat[0], seg[0]) {
        match_segments(&pat[1..], &seg[1..])
    } else {
        false
    }
}

/// 段内通配符匹配（`*` 任意非 '/'，`?` 单字符），经典回溯算法。
fn match_one_segment(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_files_finds_matches_and_filters_ext() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() { needle }").unwrap();
        std::fs::write(dir.path().join("b.txt"), "needle here").unwrap();

        let all = run_search_files("needle", None, None, dir.path().to_str().unwrap());
        assert!(all.success);
        assert!(all.content.contains("a.rs"));
        assert!(all.content.contains("b.txt"));

        let only_rs = run_search_files("needle", None, Some("rs"), dir.path().to_str().unwrap());
        assert!(only_rs.content.contains("a.rs"));
        assert!(!only_rs.content.contains("b.txt"));
    }

    #[test]
    fn search_files_skips_dependency_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nm = dir.path().join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("dep.js"), "needle").unwrap();
        std::fs::write(dir.path().join("app.js"), "needle").unwrap();

        let out = run_search_files("needle", None, None, dir.path().to_str().unwrap());
        assert!(out.content.contains("app.js"));
        assert!(!out.content.contains("dep.js"));
    }

    #[test]
    fn glob_match_basic_and_recursive() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs")); // * 不跨 /
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "a/b/c/x.rs"));
        assert!(glob_match("**/*.rs", "x.rs")); // ** 可消费 0 段
        assert!(glob_match("src/*.ts", "src/app.ts"));
        assert!(!glob_match("src/*.ts", "src/sub/app.ts"));
        assert!(glob_match("Cargo.toml", "Cargo.toml"));
        assert!(glob_match("src/**", "src/a/b.rs"));
        assert!(glob_match("a?c.txt", "abc.txt"));
        assert!(!glob_match("a?c.txt", "ac.txt"));
    }

    #[test]
    fn glob_finds_files_and_skips_deps() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "").unwrap();
        std::fs::write(dir.path().join("lib.rs"), "").unwrap();
        let nm = dir.path().join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("dep.rs"), "").unwrap();

        let out = run_glob("**/*.rs", None, dir.path().to_str().unwrap());
        assert!(out.success);
        assert!(out.content.contains("src/main.rs"));
        assert!(out.content.contains("lib.rs"));
        assert!(!out.content.contains("dep.rs"));
    }
}
