/*! 文件系统工具：read_file / write_file / list_directory / edit_file */

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{Tool, ToolContext, ToolOutcome};

/// 解析路径：绝对路径原样，相对路径相对 `workdir`。
fn resolve_path(path: &str, workdir: &str) -> PathBuf {
    if std::path::Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        PathBuf::from(workdir).join(path)
    }
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
                "description": "Read the contents of a file with line numbers. Use offset/limit to read specific ranges. For large files (>500 lines), use search_files to locate the relevant section first.\n\nReturns each line prefixed with its line number (e.g. '     1\tfn main() {'). Use the line numbers with edit_file for precise edits.\n\nParameters: path (required), offset (optional, 1-based line number to start from), limit (optional, max lines to return).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "offset": { "type": "integer", "description": "1-based line number to start reading from (optional, default: 1)" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to return (optional, default: all)" }
                    },
                    "required": ["path"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let path = args["path"].as_str().unwrap_or("");
        let offset = match args["offset"].as_i64() {
            Some(v) if v > 0 => v as usize,
            _ => 1, // 负数/0 无效，回退到 1
        };
        let limit =
            args["limit"]
                .as_i64()
                .map(|v| v as usize)
                .and_then(|v| if v > 0 { Some(v) } else { None });
        read_file_op(path, ctx.work_dir, offset, limit)
    }
}

/// 读取文件并返回带行号的内容。支持 offset/limit 参数读取指定行范围。
/// 默认不指定 offset/limit 时，最多输出 DEFAULT_MAX_OUTPUT_LINES 行，防止大文件撑爆上下文。
const DEFAULT_MAX_OUTPUT_LINES: usize = 1000;

fn read_file_op(path: &str, workdir: &str, offset: usize, limit: Option<usize>) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    match std::fs::read_to_string(&full_path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let total_lines = lines.len();
            let total_bytes = content.len();

            // 计算实际读取范围
            let start = if offset == 0 {
                0
            } else {
                offset.saturating_sub(1)
            };
            let raw_end = limit.map_or(total_lines, |l| (start + l).min(total_lines));

            // 未指定 limit 时，应用默认行限制（避免大文件撑爆上下文）
            let (end, limit_applied) = if limit.is_some() {
                (raw_end, false)
            } else {
                let max_end = start
                    .saturating_add(DEFAULT_MAX_OUTPUT_LINES)
                    .min(total_lines);
                if raw_end > max_end {
                    (max_end, true)
                } else {
                    (raw_end, false)
                }
            };

            if start >= total_lines {
                return ToolOutcome::fail(format!(
                    "Offset {} is beyond the end of file '{}'. The file has {} lines.",
                    offset,
                    full_path.display(),
                    total_lines
                ));
            }

            // 构建带行号输出的内容
            let mut output = String::new();
            for i in start..end {
                output.push_str(&format!("{:>5}\t{}", i + 1, lines[i]));
                output.push('\n');
            }

            // 附加元信息
            if offset != 1 || limit.is_some() {
                output.push_str(&format!(
                    "---\nShowing lines {}-{} of {} ({} bytes total)",
                    start + 1,
                    end,
                    total_lines,
                    total_bytes
                ));
            } else if limit_applied {
                output.push_str(&format!(
                    "---\nShowing first {} of {} lines ({} bytes total). Use offset={} to continue reading.",
                    end - start,
                    total_lines,
                    total_bytes,
                    end + 1
                ));
            } else if total_lines > 500 {
                output.push_str(&format!(
                    "---\nShowing all {} lines ({} bytes total). For large files, use offset/limit to read specific ranges, or search_files to locate content.",
                    total_lines, total_bytes
                ));
            }

            ToolOutcome::ok(output)
        }
        Err(e) => ToolOutcome::fail(format!(
            "Failed to read file '{}': {}",
            full_path.display(),
            e
        )),
    }
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
                "description": "Write content to a file (creates parent directories if needed)",
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
        write_file_op(
            args["path"].as_str().unwrap_or(""),
            args["content"].as_str().unwrap_or(""),
            ctx.work_dir,
        )
    }
}

fn write_file_op(path: &str, content: &str, workdir: &str) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    if let Some(parent) = full_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolOutcome::fail(format!(
                "Failed to create directory '{}': {}",
                parent.display(),
                e
            ));
        }
    }
    match std::fs::write(&full_path, content) {
        Ok(_) => ToolOutcome::ok(format!(
            "File written successfully: {}",
            full_path.display()
        )),
        Err(e) => ToolOutcome::fail(format!(
            "Failed to write file '{}': {}",
            full_path.display(),
            e
        )),
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
        Err(e) => ToolOutcome::fail(format!(
            "Failed to list directory '{}': {}",
            full_path.display(),
            e
        )),
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
                "description": "Replace lines in a file by line range. FIRST read the file with read_file to get line numbers, then specify the exact range to replace.\n\nIMPORTANT: Always read the file first to verify line numbers before editing. Do NOT guess line numbers.\n\nParameters:\n- path: file path\n- start_line: 1-based starting line number\n- end_line: 1-based ending line number (inclusive)\n- replacement_text: text to replace the specified line range with (may span multiple lines; empty = delete lines)\n\nExample: read_file shows line 3 contains 'foo', use start_line=3, end_line=3, replacement_text='bar' to change it.\n\nFor multi-file or complex edits, use apply_patch. For small single-line changes, this tool is best.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "start_line": { "type": "integer", "description": "1-based starting line number" },
                        "end_line": { "type": "integer", "description": "1-based ending line number (inclusive)" },
                        "replacement_text": { "type": "string", "description": "Text to replace the specified line range with (may be empty to delete lines)" }
                    },
                    "required": ["path", "start_line", "end_line", "replacement_text"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let path = args["path"].as_str().unwrap_or("");

        // 行号参数验证：负数/0 无效
        let start_line = match args["start_line"].as_i64() {
            Some(v) if v > 0 => v as usize,
            _ => {
                return ToolOutcome::fail(
                    "edit_file: start_line must be a positive integer".to_string(),
                )
            }
        };
        let end_line = match args["end_line"].as_i64() {
            Some(v) if v > 0 => v as usize,
            _ => {
                return ToolOutcome::fail(
                    "edit_file: end_line must be a positive integer".to_string(),
                )
            }
        };

        // replacement_text 必须显式提供；缺失时返回错误而非静默删除
        let replacement_text =
            match args["replacement_text"].as_str() {
                Some(v) => v.to_string(),
                None => return ToolOutcome::fail(
                    "edit_file: replacement_text is required (pass empty string to delete lines)"
                        .to_string(),
                ),
            };

        edit_file_op(path, start_line, end_line, &replacement_text, ctx.work_dir)
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

fn edit_file_op(
    path: &str,
    start_line: usize,
    end_line: usize,
    replacement_text: &str,
    workdir: &str,
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

    match edit_file_by_lines(&content, start_line, end_line, replacement_text) {
        Ok(updated) => match std::fs::write(&full_path, updated) {
            Ok(_) => ToolOutcome::ok(format!(
                "Edited file '{}': replaced lines {}-{} with {} new line(s)",
                full_path.display(),
                start_line,
                end_line,
                if replacement_text.is_empty() {
                    0
                } else {
                    replacement_text.lines().count()
                }
            )),
            Err(e) => ToolOutcome::fail(format!(
                "Failed to write file '{}': {}",
                full_path.display(),
                e
            )),
        },
        Err(e) => ToolOutcome::fail(format!("edit_file failed: {}", e)),
    }
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
    fn edit_file_op_edits_file_with_line_range() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello\nworld\nfoo\n").unwrap();
        let outcome = edit_file_op(
            file.to_str().unwrap(),
            2,
            2,
            "WORLD",
            dir.path().to_str().unwrap(),
        );
        assert!(outcome.success);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "hello\nWORLD\nfoo\n"
        );
    }

    #[test]
    fn read_file_op_returns_with_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "a\nb\nc\n").unwrap();
        let outcome = read_file_op(
            file.to_str().unwrap(),
            dir.path().to_str().unwrap(),
            1,
            None,
        );
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
        let outcome = read_file_op(
            file.to_str().unwrap(),
            dir.path().to_str().unwrap(),
            2,
            Some(2),
        );
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
        let outcome = read_file_op(
            file.to_str().unwrap(),
            dir.path().to_str().unwrap(),
            10,
            None,
        );
        assert!(!outcome.success);
        assert!(outcome.content.contains("Offset 10"));
    }
}
