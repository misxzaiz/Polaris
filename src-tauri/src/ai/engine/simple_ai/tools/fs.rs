// ============================================================================
// fs tools: read_file / write_file / edit_file / list_directory
// ============================================================================

use serde_json::{json, Value};
use std::path::PathBuf;

use super::{Tool, ToolContext, ToolOutcome};
use crate::ai::engine::simple_ai::tools::file_state::{
    apply_line_endings, detect_line_endings, FileStateRegistry,
};

/// Resolve a possibly-relative path against the working directory.
fn resolve_path(path: &str, workdir: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        let base = PathBuf::from(workdir);
        base.join(p)
    }
}

fn is_binary(content: &[u8]) -> bool {
    content.iter().take(8000).any(|&b| b == 0)
}

// ============================================================================
// read_file
// ============================================================================

pub(super) struct ReadFileTool;

#[async_trait::async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file with line numbers. Use this to inspect files before editing. Returns each line prefixed with its line number so you can refer to exact lines.\n\nParameters:\n- path: file path\n- offset: (optional) 1-based line number to start reading from\n- limit: (optional) max lines to return",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "offset": { "type": "integer", "description": "1-based line number to start reading from (default 1)" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to return" }
                    },
                    "required": ["path"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let path = args["path"].as_str().unwrap_or("");
        let offset = args["offset"].as_i64().unwrap_or(1);
        let limit = args["limit"].as_i64();
        match read_file_op(path, ctx.work_dir, offset, limit, Some(ctx.file_states.as_ref())) {
            Ok(outcome) => outcome,
            Err(e) => ToolOutcome::fail(e),
        }
    }
}

/// Read a file and render numbered lines.
/// When `states` is provided, registers the file content snapshot for later
/// string-match edits and mtime conflict detection.
fn read_file_op(
    path: &str,
    workdir: &str,
    offset: i64,
    limit: Option<i64>,
    states: Option<&FileStateRegistry>,
) -> Result<ToolOutcome, String> {
    let full_path = resolve_path(path, workdir);
    let bytes = std::fs::read(&full_path)
        .map_err(|e| format!("Failed to read file '{}': {}", full_path.display(), e))?;

    if is_binary(&bytes) {
        return Ok(ToolOutcome::fail(format!(
            "File '{}' appears to be a binary file and was not read.",
            full_path.display()
        )));
    }

    let content = String::from_utf8_lossy(&bytes).to_string();

// 登记 FileState：供后续 edit_file 的字符串匹配与冲突检测使用。
    // 这里读取已成功，register 失败仅表示登记冗余信息不可用（如再次读取失败），
    // 不应阻断本次 read（read 本身已拿到内容）。
    if let Some(states) = states {
        let _ = states.register(&full_path);
    }

    let total_lines = content.lines().count();
    let offset = offset.max(1);

if (offset as usize) > total_lines {
        return Ok(ToolOutcome::fail(format!(
            "Offset {} is beyond the end of file '{}' ({} lines total). File has {} lines.",
            offset,
            full_path.display(),
            total_lines,
            total_lines
        )));
    }

    let mut out = String::new();
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };

    let limit = limit.unwrap_or(i64::MAX).max(1) as usize;
    let end = total_lines.min(offset as usize + limit - 1);

    out.push_str(&format!(
        "File '{}' - {} lines total (showing lines {}-{}){}",
        full_path.display(),
        total_lines,
        offset,
        end,
        eol
    ));

    for (i, line) in content.lines().enumerate() {
        let n = i + 1;
        if n >= offset as usize && n <= end {
            out.push_str(&format!("{:>6}\t{}", n, line));
            out.push_str(eol);
        }
    }

    Ok(ToolOutcome::ok(out.trim_end().to_string()))
}
// ============================================================================
// write_file
// ============================================================================

pub(super) struct WriteFileTool;

#[async_trait::async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &'static str {
        "write_file"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file (creates parent directories if needed). Overwrites the entire file. Prefer edit_file for surgical changes to existing files.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "content": { "type": "string", "description": "Content to write" }
                    },
                    "required": ["path", "content"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let path = args["path"].as_str().unwrap_or("");
        let content = match args["content"].as_str() {
            Some(v) => v,
            None => return ToolOutcome::fail("write_file: content is required".to_string()),
        };
        write_file_op(path, content, ctx.work_dir)
    }
}

fn write_file_op(path: &str, content: &str, workdir: &str) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    if let Some(parent) = full_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutcome::fail(format!(
                    "Failed to create parent directory '{}': {}",
                    parent.display(),
                    e
                ));
            }
        }
    }

    // 若目标文件已存在，沿用其行尾风格；新文件默认 \n
    let eol = std::fs::read_to_string(&full_path)
        .ok()
        .map(|content| detect_line_endings(&content))
        .unwrap_or("\n");

    let normalized = apply_line_endings(content, eol);

    let written = normalized.len();
    match std::fs::write(&full_path, &normalized) {
        Ok(_) => ToolOutcome::ok(format!("Wrote {} bytes to '{}'", written, full_path.display())),
        Err(e) => ToolOutcome::fail(format!("Failed to write file '{}': {}", full_path.display(), e)),
    }
}

// ============================================================================
// list_directory
// ============================================================================

pub(super) struct ListDirectoryTool;

#[async_trait::async_trait]
impl Tool for ListDirectoryTool {
    fn name(&self) -> &'static str {
        "list_directory"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List files and directories at the given path",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path to list" }
                    },
                    "required": ["path"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        list_directory_op(args["path"].as_str().unwrap_or("."), ctx.work_dir)
    }
}

fn list_directory_op(path: &str, workdir: &str) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    match std::fs::read_dir(&full_path) {
        Ok(entries) => {
            let mut items: Vec<String> = Vec::new();
            for entry in entries {
                match entry {
                    Ok(e) => {
                        let name = e.file_name().to_string_lossy().to_string();
                        let is_dir = e.metadata().map(|m| m.is_dir()).unwrap_or(false);
                        if is_dir {
                            items.push(format!("{}/", name));
                        } else {
                            items.push(name);
                        }
                    }
                    Err(e) => items.push(format!("<error: {}>", e)),
                }
            }
            items.sort();
            if items.is_empty() {
                ToolOutcome::ok("(empty directory)")
            } else {
                ToolOutcome::ok(items.join("\n"))
            }
        }
        Err(e) => ToolOutcome::fail(format!("Failed to list directory '{}': {}", full_path.display(), e)),
    }
}

// ============================================================================
// edit_file
// ============================================================================

pub(super) struct EditFileTool;

#[async_trait::async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &'static str {
        "edit_file"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Make surgical edits to a file using exact string matching instead of line numbers. ALWAYS read the file first with read_file, then pass the exact old_string you want to replace. The tool requires the old text to appear exactly once in the file (or you can specify expected_replacements for repeats).\n\nParameters:\n- path: file path\n- old_string: the exact text to find (must match uniquely, including indentation)\n- new_string: the replacement text (may be empty to delete)\n- expected_replacements: (optional) number of times old_string should appear; when the file contains that many identical occurrences, all are replaced\n\nExample: read_file shows line 3 contains 'foo', use old_string=\"foo\", new_string=\"bar\" to change it.\n\nFor multi-file or complex edits, use apply_patch. For small single-line changes, this tool is best.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "old_string": { "type": "string", "description": "The exact text to find and replace" },
                        "new_string": { "type": "string", "description": "The replacement text (may be empty to delete)" },
                        "expected_replacements": { "type": "integer", "description": "Optional: expected number of matches. If provided and matches exactly, replace all; otherwise fail on ambiguity." }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let path = args["path"].as_str().unwrap_or("");

        // 字符串匹配模式（推荐）
        if let Some(old_string) = args["old_string"].as_str() {
            let new_string = match args["new_string"].as_str() {
                Some(v) => v,
                None => return ToolOutcome::fail("edit_file: new_string is required (pass empty string to delete)".to_string()),
            };
            let expected = args["expected_replacements"].as_i64().map(|v| v as usize);
            let outcome = edit_file_op(
                path,
                old_string,
                new_string,
                expected,
                ctx.work_dir,
                Some(ctx.file_states.as_ref()),
            );
            return outcome;
        }

        // 兼容降级：旧的行号模式（start_line / end_line / replacement_text）
        let start_line = match args["start_line"].as_i64() {
            Some(v) if v > 0 => v as usize,
            _ => return ToolOutcome::fail(
                "edit_file: neither old_string nor a valid start_line was provided. Use old_string/new_string (string match) or start_line/end_line/replacement_text (legacy).".to_string()
            ),
        };
        let end_line = match args["end_line"].as_i64() {
            Some(v) if v > 0 => v as usize,
            _ => return ToolOutcome::fail("edit_file: end_line must be a positive integer".to_string()),
        };
        let replacement_text = match args["replacement_text"].as_str() {
            Some(v) => v.to_string(),
            None => return ToolOutcome::fail(
                "edit_file: replacement_text is required (pass empty string to delete lines)".to_string()
            ),
        };
        let outcome = edit_file_by_line_numbers(path, start_line, end_line, &replacement_text, ctx.work_dir, Some(ctx.file_states.as_ref()));
        outcome
    }
}

/// 核心实现：字符串精确匹配替换。
/// - 若 old_string 出现 0 次：报错并给出相近行提示
/// - 若出现多次且未提供 expected_replacements：报错（要求 re-read 后指定）
/// - 若出现多次且次数 == expected：全部替换
/// - 写前校验 mtime（read-before-write 冲突检测）
fn edit_file_op(
    path: &str,
    old_string: &str,
    new_string: &str,
    expected_replacements: Option<usize>,
    workdir: &str,
    states: Option<&FileStateRegistry>,
) -> ToolOutcome {
    if old_string.is_empty() {
        return ToolOutcome::fail("edit_file: old_string must not be empty".to_string());
    }

    let full_path = resolve_path(path, workdir);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
            return ToolOutcome::fail(format!(
                "Failed to read file '{}': {}",
                full_path.display(),
                e
            ))
        }
    };

    // mtime 冲突检测：文件在 read_file 之后被外部修改则拒绝写入
    if let Some(states) = states {
        if let Err(err) = states.verify_before_write(&full_path) {
            return ToolOutcome::fail(err);
        }
    }

    let matches: Vec<_> = content.match_indices(old_string).collect();
    let count = matches.len();

    match count {
        0 => {
            // 找不到目标字符串：给出附近行的上下文，帮助模型纠错
            let hint = closest_line_hint(&content, old_string);
            ToolOutcome::fail(format!(
                "old_string was not found in '{}'. It must match exactly (including leading/trailing whitespace and line endings). Re-read the file and copy the exact text.\n{}",
                full_path.display(),
                hint
            ))
        }
        1 => {
            let updated = content.replacen(old_string, new_string, 1);
            write_edit(&full_path, updated, 1, states)
        }
        n => {
            match expected_replacements {
                Some(e) if e == n => {
                    let updated = content.replace(old_string, new_string);
                    write_edit(&full_path, updated, n, states)
                }
                Some(e) => ToolOutcome::fail(format!(
                    "old_string appears {} times in '{}', but expected_replacements={} was specified. Re-read the file and adjust expected_replacements or make old_string more specific.",
                    n,
                    full_path.display(),
                    e
                )),
                None => ToolOutcome::fail(format!(
                    "old_string appears {} times in '{}' — ambiguous. Add expected_replacements={} to replace all, or make old_string more specific so it matches exactly once. Re-read the file to see all occurrences.",
                    n,
                    full_path.display(),
                    n
                )),
            }
        }
    }
}

/// 写入文件，并同步更新 FileStateRegistry 中的快照
fn write_edit(
    full_path: &std::path::Path,
    updated: String,
    replacements: usize,
    states: Option<&FileStateRegistry>,
) -> ToolOutcome {
    // 保持原有行尾风格
    let eol = std::fs::read_to_string(full_path)
        .ok()
        .map(|content| detect_line_endings(&content))
        .unwrap_or("\n");
    let updated = apply_line_endings(&updated, eol);

    match std::fs::write(full_path, updated.clone()) {
        Ok(_) => {
            if let Some(states) = states {
                states.update_after_write(full_path, &updated);
            }
            ToolOutcome::ok(format!(
                "Edited file '{}': replaced {} occurrence(s).",
                full_path.display(),
                replacements
            ))
        }
        Err(e) => ToolOutcome::fail(format!(
            "Failed to write file '{}': {}",
            full_path.display(),
            e
        )),
    }
}

/// 兼容旧行号模式：按 [start_line, end_line] 区间替换。若文件已登记 FileState
/// 且内容与快照一致则直接用快照定位；否则按当前内容定位行号。
fn edit_file_by_line_numbers(
    path: &str,
    start_line: usize,
    end_line: usize,
    replacement_text: &str,
    workdir: &str,
    states: Option<&FileStateRegistry>,
) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
            return ToolOutcome::fail(format!(
                "Failed to read file '{}': {}",
                full_path.display(),
                e
            ))
        }
    };

    if let Some(states) = states {
        if let Err(err) = states.verify_before_write(&full_path) {
            return ToolOutcome::fail(err);
        }
    }

    match edit_file_by_lines(&content, start_line, end_line, replacement_text) {
        Ok(updated) => write_edit(&full_path, updated, 1, states),
        Err(e) => ToolOutcome::fail(format!("edit_file failed: {}", e)),
    }
}

/// 对文件内容按行范围进行替换（纯函数，便于单测）。
/// start_line / end_line 是 1-based，替换区间 [start_line, end_line]。
/// replacement_text 为空表示删除指定行。
fn edit_file_by_lines(
    content: &str,
    start_line: usize,
    end_line: usize,
    replacement_text: &str,
) -> Result<String, String> {
    // 检测文件总行数和末尾换行
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    let had_trailing_newline = content.ends_with('\n') || content.is_empty();

    if start_line == 0 || start_line > total_lines {
        return Err(format!(
            "Invalid line range: start_line={} is beyond file end ({} lines). Re-read the file to get updated line numbers.",
            start_line, total_lines
        ));
    }
    if end_line > total_lines {
        let context_lines: Vec<String> = (0..3)
            .rev()
            .filter_map(|i| lines.get(total_lines - 1 - i))
            .enumerate()
            .map(|(j, l)| {
                let line_num = total_lines - j;
                format!("{:>5}\t{}", line_num, l)
            })
            .collect();
        return Err(format!(
            "Invalid line range: end_line={} exceeds file end ({} lines). Re-read the file to get updated line numbers.\nLast {} line(s) of file:\n{}",
            end_line, total_lines, context_lines.len(), context_lines.join("\n")
        ));
    }
    if start_line > end_line {
        return Err(format!(
            "Invalid line range: start_line={} > end_line={}. Re-read the file to verify line numbers.",
            start_line, end_line
        ));
    }

    // 构建新内容
    let mut new_lines: Vec<String> = lines[..(start_line - 1)]
        .iter()
        .map(|&l| l.to_string())
        .collect();

    if !replacement_text.is_empty() {
        new_lines.extend(replacement_text.lines().map(String::from));
    }

    if end_line <= total_lines {
        new_lines.extend(lines[end_line..].iter().map(|&l| l.to_string()));
    }

    let mut result = new_lines.join("\n");
    if had_trailing_newline {
        result.push('\n');
    }
    Ok(result)
}

/// 在 content 中找与 old_string 最相似的行，给出提示。
fn closest_line_hint(content: &str, old_string: &str) -> String {
    let needle = old_string.lines().next().unwrap_or(old_string).trim();
    if needle.is_empty() {
        return String::new();
    }
    let mut best: Option<(usize, &str)> = None; // (similarity, line)
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let score = similarity(needle, trimmed);
        if best.map(|(s, _)| score > s).unwrap_or(true) {
            best = Some((score, line));
        }
    }
    match best {
        Some((score, line)) if score >= 40 => format!("Closest line: \"{}\"", line.trim()),
        _ => String::new(),
    }
}

/// 简单字符级相似度（0-100），用于错误提示。
fn similarity(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    // 最长公共子串长度
    let mut max_len = 0usize;
    for i in 0..a.len() {
        for j in 0..b.len() {
            let mut k = 0;
            while i + k < a.len() && j + k < b.len() && a[i + k] == b[j + k] {
                k += 1;
            }
            if k > max_len {
                max_len = k;
            }
        }
    }
    (max_len * 100) / a.len().max(b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_file_by_lines_replaces_single_line() {
        let content = "line1\nline2\nline3\n";
        let result = edit_file_by_lines(content, 2, 2, "LINE_TWO").unwrap();
        assert_eq!(result, "line1\nLINE_TWO\nline3\n");
    }

    #[test]
    fn edit_file_by_lines_replaces_multiple_lines() {
        let content = "a\nb\nc\nd\n";
        let result = edit_file_by_lines(content, 2, 3, "X\nY").unwrap();
        assert_eq!(result, "a\nX\nY\nd\n");
    }

    #[test]
    fn edit_file_by_lines_deletes_lines() {
        let content = "a\nb\nc\n";
        let result = edit_file_by_lines(content, 2, 2, "").unwrap();
        assert_eq!(result, "a\nc\n");
    }

    #[test]
    fn edit_file_by_lines_handles_no_trailing_newline() {
        let content = "a\nb\nc";
        let result = edit_file_by_lines(content, 1, 1, "A").unwrap();
        assert_eq!(result, "A\nb\nc");
    }

    #[test]
    fn edit_file_by_lines_errors_on_start_beyond_file() {
        let result = edit_file_by_lines("a\nb", 5, 5, "x");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("beyond file end"));
    }

    #[test]
    fn edit_file_by_lines_errors_on_end_beyond_file() {
        let result = edit_file_by_lines("a\nb", 1, 5, "x");
        let err = result.unwrap_err();
        assert!(err.contains("exceeds file end"));
        assert!(err.contains("Last"));
    }

    #[test]
    fn edit_file_by_lines_errors_on_invalid_range() {
        let result = edit_file_by_lines("a\nb", 3, 1, "x");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("start_line=3 > end_line=1"));
    }

    #[test]
    fn read_file_op_returns_with_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\nc\n").unwrap();
        let outcome = read_file_op(file.to_str().unwrap(), dir.path().to_str().unwrap(), 1, None, None).unwrap();
        assert!(outcome.success);
        assert!(outcome.content.contains("     1\ta"));
        assert!(outcome.content.contains("     2\tb"));
        assert!(outcome.content.contains("     3\tc"));
    }

    #[test]
    fn read_file_op_with_offset_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\nc\nd\ne\n").unwrap();
        let outcome = read_file_op(file.to_str().unwrap(), dir.path().to_str().unwrap(), 2, Some(2), None).unwrap();
        assert!(outcome.success);
        assert!(outcome.content.contains("Showing lines 2-3"));
        assert!(outcome.content.contains("     2\tb"));
        assert!(outcome.content.contains("     3\tc"));
    }

    #[test]
    fn read_file_op_offset_beyond_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\n").unwrap();
        let outcome = read_file_op(file.to_str().unwrap(), dir.path().to_str().unwrap(), 10, None, None);
        assert!(outcome.is_err() || !outcome.as_ref().unwrap().success);
    }

    #[test]
    fn edit_file_op_string_match_single() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello\nworld\nfoo\n").unwrap();
        let outcome = edit_file_op(file.to_str().unwrap(), "world", "WORLD", None, dir.path().to_str().unwrap(), None);
        assert!(outcome.success);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello\nWORLD\nfoo\n");
    }

    #[test]
    fn edit_file_op_string_match_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello\nworld\n").unwrap();
        let outcome = edit_file_op(file.to_str().unwrap(), "nope", "x", None, dir.path().to_str().unwrap(), None);
        assert!(!outcome.success);
        assert!(outcome.content.contains("was not found"));
    }

    #[test]
    fn edit_file_op_string_match_ambiguous_without_expected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\na\n").unwrap();
        let outcome = edit_file_op(file.to_str().unwrap(), "a", "X", None, dir.path().to_str().unwrap(), None);
        assert!(!outcome.success);
        assert!(outcome.content.contains("ambiguous"));
    }

    #[test]
    fn edit_file_op_string_match_expected_replaces_all() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\na\n").unwrap();
        let outcome = edit_file_op(file.to_str().unwrap(), "a", "X", Some(2), dir.path().to_str().unwrap(), None);
        assert!(outcome.success);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "X\nb\nX\n");
    }

    #[test]
    fn edit_file_op_rejects_empty_old_string() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "abc\n").unwrap();
        let outcome = edit_file_op(file.to_str().unwrap(), "", "x", None, dir.path().to_str().unwrap(), None);
        assert!(!outcome.success);
    }
}
