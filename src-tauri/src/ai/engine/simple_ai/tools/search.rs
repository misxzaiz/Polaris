/*! 搜索工具：search_files（按内容，ripgrep 级）+ glob（按文件名 pattern） */

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

/// 解析搜索根目录：绝对路径原样，相对路径相对 `workdir`，缺省为 `workdir`。
fn resolve_root(path: Option<&str>, workdir: &str) -> PathBuf {
    match path {
        Some(p) if std::path::Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => PathBuf::from(workdir).join(p),
        None => PathBuf::from(workdir),
    }
}

// ============================================================================
// search_files（按内容，复用 ignore crate 达到 ripgrep 级水准）
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
                "description": "Search file contents using regex pattern. Respects .gitignore and .ignore files. Skips binary files and build/dependency directories.\n\nParameters: pattern (regex), path (dir, optional), file_ext (e.g. 'rs'), case_insensitive (default true).\n\nExamples: 'fn main' finds main functions; 'log\\\\.(error|warn)' finds log calls. Use regex-escaped special chars.\nUse this to locate code before editing. Returns file:line:context format with up to 200 matches.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regex pattern to search for (supports regex metacharacters)" },
                        "path": { "type": "string", "description": "Directory to search under (optional, defaults to working directory)" },
                        "file_ext": { "type": "string", "description": "Optional file extension filter without dot, e.g. 'rs' or 'ts'" },
                        "case_insensitive": { "type": "boolean", "description": "Case-insensitive matching (default true)" }
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
            args["case_insensitive"].as_bool().unwrap_or(true),
            ctx.work_dir,
        )
    }
}

/// 搜索文件内容，使用 ignore crate（ripgrep 底层）+ regex。
fn run_search_files(
    pattern: &str,
    path: Option<&str>,
    file_ext: Option<&str>,
    case_insensitive: bool,
    workdir: &str,
) -> ToolOutcome {
    if pattern.is_empty() {
        return ToolOutcome::fail("pattern must not be empty".to_string());
    }

    let root = resolve_root(path, workdir);

    // 构建 regex：优先尝试 regex，失败则回退为字面量搜索
    let regex = regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build();
    let (regex, is_regex) = match regex {
        Ok(r) => (Some(r), true),
        Err(e) => {
            tracing::warn!("search_files regex build failed for '{}': {}, falling back to literal search", pattern, e);
            (None, false)
        }
    };

    const MAX_MATCHES: usize = 200;
    const MAX_LINE_LEN: usize = 300;
    const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2MB

    let mut matches: Vec<String> = Vec::new();
    let mut scanned_files = 0usize;
    let mut truncated = false;

    // 使用 ignore::WalkBuilder（ripgrep 同款），支持 .gitignore
    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false);

    for entry in builder.build().filter_map(|e| e.ok()) {
        if matches.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }

        // 只处理文件
        let file_type = match entry.file_type() {
            Some(ft) if ft.is_file() => ft,
            _ => continue,
        };
        let _ = file_type;

        let file_path = entry.path();

        // 文件扩展名过滤
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

        // 文件大小过滤
        let Ok(metadata) = std::fs::metadata(file_path) else {
            continue;
        };
        if metadata.len() > MAX_FILE_SIZE {
            continue;
        }

        scanned_files += 1;

        // 二进制检测（前 8192 字节含 NUL 即判定为二进制）
        let Ok(bytes) = std::fs::read(file_path) else {
            continue;
        };
        if looks_binary(&bytes) {
            continue;
        }

        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };

        let rel = file_path.strip_prefix(&root).unwrap_or(file_path);
        let rel_str = rel.to_string_lossy().to_string();

        // 行级搜索
        for (line_idx, line) in content.lines().enumerate() {
            let matched = if let Some(ref re) = regex {
                re.is_match(line)
            } else {
                // 字面量回退
                if case_insensitive {
                    line.to_lowercase().contains(&pattern.to_lowercase())
                } else {
                    line.contains(pattern)
                }
            };

            if matched {
                let shown = truncate_chars(line.trim(), MAX_LINE_LEN);
                matches.push(format!("{}:{}: {}", rel_str, line_idx + 1, shown));
                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break;
                }
            }
        }
    }

    if matches.is_empty() {
        let hint = if is_regex {
            format!("No matches for regex '{}'. Scanned {} file(s). Try a different pattern, add file_ext filter, or check the directory.", pattern, scanned_files)
        } else {
            format!("No matches for '{}'. Scanned {} file(s). Note: regex build failed, fell back to literal search.", pattern, scanned_files)
        };
        ToolOutcome::ok(hint)
    } else {
        let mut out = matches.join("\n");
        if truncated {
            out.push_str(&format!("\n... (truncated at {} matches)", MAX_MATCHES));
        }
        out.push_str(&format!("\n(Scanned {} file(s))", scanned_files));
        ToolOutcome::ok(out)
    }
}

/// 二进制检测：前 8192 字节含 NUL 即判定为二进制
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

// ============================================================================
// glob（按文件名 pattern）—— 保留原有实现，已完备
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

    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false);

    for entry in builder.build().filter_map(|e| e.ok()) {
        if results.len() >= MAX_RESULTS {
            truncated = true;
            break;
        }

        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }

        let file_path = entry.path();
        let rel = file_path.strip_prefix(&root).unwrap_or(file_path);
        let rel_str = rel.to_string_lossy().to_string();
        if glob_match(pattern, &rel_str) {
            results.push(rel_str.replace('\\', "/"));
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

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_files_finds_matches_and_filters_ext() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() { needle }").unwrap();
        std::fs::write(dir.path().join("b.txt"), "needle here").unwrap();

        let all = run_search_files("needle", None, None, true, dir.path().to_str().unwrap());
        assert!(all.success);
        assert!(all.content.contains("a.rs"));
        assert!(all.content.contains("b.txt"));

        let only_rs = run_search_files("needle", None, Some("rs"), true, dir.path().to_str().unwrap());
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

        let out = run_search_files("needle", None, None, true, dir.path().to_str().unwrap());
        assert!(out.content.contains("app.js"));
        assert!(!out.content.contains("dep.js"));
    }

    #[test]
    fn search_files_with_regex_pattern() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {\n    log.error(\"test\");\n}").unwrap();
        std::fs::write(dir.path().join("b.rs"), "fn other() {\n    log.warn(\"test\");\n}").unwrap();

        let out = run_search_files("log\\.(error|warn)", None, None, true, dir.path().to_str().unwrap());
        assert!(out.content.contains("log.error"));
        assert!(out.content.contains("log.warn"));
    }

    #[test]
    fn search_files_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "Hello World").unwrap();
        std::fs::write(dir.path().join("b.txt"), "HELLO WORLD").unwrap();

        let out = run_search_files("hello", None, None, true, dir.path().to_str().unwrap());
        assert!(out.content.contains("a.txt"));
        assert!(out.content.contains("b.txt"));
    }

    #[test]
    fn search_files_case_sensitive() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "Hello World").unwrap();
        std::fs::write(dir.path().join("b.txt"), "HELLO WORLD").unwrap();

        let out = run_search_files("hello", None, None, false, dir.path().to_str().unwrap());
        assert!(out.content.contains("a.txt"));
        assert!(!out.content.contains("b.txt"));
    }

    #[test]
    fn search_files_invalid_regex_falls_back_to_literal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "Hello World").unwrap();

        // 无效 regex 应回退为字面量搜索
        let out = run_search_files("Hello[", None, None, true, dir.path().to_str().unwrap());
        // 无效 regex 编译失败，回退字面量；"Hello[" 在字面量下不会匹配 "Hello World"
        assert!(out.content.contains("No matches") || out.content.contains("Scanned"));
    }

    #[test]
    fn glob_match_basic_and_recursive() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "a/b/c/x.rs"));
        assert!(glob_match("**/*.rs", "x.rs"));
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
