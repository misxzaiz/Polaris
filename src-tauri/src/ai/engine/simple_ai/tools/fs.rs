/*! 文件系统工具：read_file / write_file / list_directory / edit_file */

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

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

impl Tool for ReadFileTool {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" }
                    },
                    "required": ["path"]
                }
            }
        })
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome {
        read_file_op(args["path"].as_str().unwrap_or(""), ctx.work_dir)
    }
}

fn read_file_op(path: &str, workdir: &str) -> ToolOutcome {
    let full_path = resolve_path(path, workdir);
    match std::fs::read_to_string(&full_path) {
        Ok(content) => ToolOutcome::ok(truncate_chars(&content, 65_536)),
        Err(e) => ToolOutcome::fail(format!("Failed to read file '{}': {}", full_path.display(), e)),
    }
}

// ============================================================================
// write_file
// ============================================================================

pub(super) struct WriteFileTool;

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

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome {
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
        Ok(_) => ToolOutcome::ok(format!("File written successfully: {}", full_path.display())),
        Err(e) => ToolOutcome::fail(format!("Failed to write file '{}': {}", full_path.display(), e)),
    }
}

// ============================================================================
// list_directory
// ============================================================================

pub(super) struct ListDirectoryTool;

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

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome {
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

impl Tool for EditFileTool {
    fn name(&self) -> &'static str {
        "edit_file"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace an exact substring in an existing file with new text. Prefer this over write_file when modifying part of a file — it keeps the rest intact. The old_string must occur EXACTLY ONCE; include enough surrounding context to make it unique. For larger or multi-file edits, prefer apply_patch.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path" },
                        "old_string": { "type": "string", "description": "Exact text to replace (must be unique within the file)" },
                        "new_string": { "type": "string", "description": "Replacement text" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        })
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome {
        edit_file_op(
            args["path"].as_str().unwrap_or(""),
            args["old_string"].as_str().unwrap_or(""),
            args["new_string"].as_str().unwrap_or(""),
            ctx.work_dir,
        )
    }
}

/// 对文本应用一次精确字符串替换（纯函数，便于单测）。
/// old 必须恰好出现一次；0 次或多次均报错（避免误改）。
fn apply_string_edit(content: &str, old: &str, new: &str) -> std::result::Result<String, String> {
    if old.is_empty() {
        return Err("old_string must not be empty".to_string());
    }
    let count = content.matches(old).count();
    match count {
        0 => Err("old_string not found in file".to_string()),
        1 => Ok(content.replacen(old, new, 1)),
        n => Err(format!(
            "old_string is not unique ({} matches); add more surrounding context",
            n
        )),
    }
}

fn edit_file_op(path: &str, old_string: &str, new_string: &str, workdir: &str) -> ToolOutcome {
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

    match apply_string_edit(&content, old_string, new_string) {
        Ok(updated) => match std::fs::write(&full_path, updated) {
            Ok(_) => ToolOutcome::ok(format!("Edited file: {}", full_path.display())),
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
    fn apply_string_edit_replaces_unique_match() {
        assert_eq!(
            apply_string_edit("hello world", "world", "rust").unwrap(),
            "hello rust"
        );
    }

    #[test]
    fn apply_string_edit_errors_when_not_found() {
        assert!(apply_string_edit("hello", "xyz", "abc").is_err());
    }

    #[test]
    fn apply_string_edit_errors_when_ambiguous() {
        assert!(apply_string_edit("a a a", "a", "b").is_err());
    }

    #[test]
    fn apply_string_edit_errors_on_empty_old() {
        assert!(apply_string_edit("abc", "", "x").is_err());
    }

    #[test]
    fn edit_file_op_replaces_unique() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "foo bar baz").unwrap();
        let outcome = edit_file_op(
            file.to_str().unwrap(),
            "bar",
            "QUX",
            dir.path().to_str().unwrap(),
        );
        assert!(outcome.success);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "foo QUX baz");
    }

    #[test]
    fn edit_file_op_fails_on_ambiguous_match() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x x").unwrap();
        let outcome = edit_file_op(
            file.to_str().unwrap(),
            "x",
            "y",
            dir.path().to_str().unwrap(),
        );
        assert!(!outcome.success);
    }
}
