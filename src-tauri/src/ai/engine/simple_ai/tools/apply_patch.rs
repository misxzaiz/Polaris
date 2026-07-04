/*! apply_patch 工具：codex V4A 补丁信封格式的解析与应用
 *
 * 支持单次补丁内多文件的新增 / 删除 / 更新 / 重命名。相比 edit_file 的单点替换，
 * 带上下文锚点定位更鲁棒，且可一次完成多处改动。
 *
 * 信封格式（参考 openai/codex apply-patch grammar）：
 * ```text
 * *** Begin Patch
 * *** Add File: path/to/new.rs
 * +line 1
 * +line 2
 * *** Delete File: path/to/old.rs
 * *** Update File: path/to/edit.rs
 * *** Move to: path/to/renamed.rs        (可选)
 * @@ optional context anchor
 *  unchanged context line
 * -removed line
 * +added line
 * *** End Patch
 * ```
 */

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{Tool, ToolContext, ToolOutcome};

pub(super) struct ApplyPatchTool;

#[async_trait::async_trait]
impl Tool for ApplyPatchTool {
    fn name(&self) -> &'static str {
        "apply_patch"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "apply_patch",
                "description": "Create, update, delete, or rename files via a single patch. Preferred for edits — especially multi-file or multi-hunk changes. The `input` must be the full patch envelope:\n*** Begin Patch\n*** Add File: <path>\n+<new line>\n*** Update File: <path>\n@@ <optional context>\n <unchanged line>\n-<removed line>\n+<added line>\n*** Delete File: <path>\n*** End Patch\nPaths are relative to the working directory. For Update hunks, include a few unchanged context lines (prefixed by a single space) around your changes so the location is unambiguous.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": {
                            "type": "string",
                            "description": "The full patch text, starting with '*** Begin Patch' and ending with '*** End Patch'."
                        }
                    },
                    "required": ["input"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let input = args["input"].as_str().unwrap_or("");
        match parse_patch(input) {
            Ok(ops) => match apply_ops(&ops, ctx.work_dir) {
                Ok(summary) => ToolOutcome::ok(summary),
                Err(e) => ToolOutcome::fail(format!("apply_patch failed: {}", e)),
            },
            Err(e) => ToolOutcome::fail(format!("apply_patch parse error: {}", e)),
        }
    }
}

// ============================================================================
// 数据结构
// ============================================================================

#[derive(Debug, PartialEq)]
enum FileOp {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        chunks: Vec<Chunk>,
    },
}

#[derive(Debug, PartialEq)]
struct Chunk {
    /// `@@` 之后的上下文锚点行（用于在文件中缩小定位范围）。
    context: Option<String>,
    /// 旧内容（上下文行 + 被删除行，按出现顺序）。
    old_lines: Vec<String>,
    /// 新内容（上下文行 + 新增行，按出现顺序）。
    new_lines: Vec<String>,
}

impl Chunk {
    fn empty() -> Self {
        Self { context: None, old_lines: Vec::new(), new_lines: Vec::new() }
    }
}

// ============================================================================
// 解析
// ============================================================================

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD_FILE: &str = "*** Add File:";
const DELETE_FILE: &str = "*** Delete File:";
const UPDATE_FILE: &str = "*** Update File:";
const MOVE_TO: &str = "*** Move to:";
const END_OF_FILE: &str = "*** End of File";

fn strip_marker<'a>(trimmed: &'a str, marker: &str) -> Option<&'a str> {
    trimmed.strip_prefix(marker).map(|rest| rest.trim())
}

fn is_file_marker(line: &str) -> bool {
    let t = line.trim();
    t.starts_with(ADD_FILE)
        || t.starts_with(DELETE_FILE)
        || t.starts_with(UPDATE_FILE)
        || t == END
}

fn parse_patch(patch: &str) -> Result<Vec<FileOp>, String> {
    let lines: Vec<&str> = patch.lines().collect();
    let Some(begin) = lines.iter().position(|l| l.trim() == BEGIN) else {
        return Err("patch must start with '*** Begin Patch'".to_string());
    };

    let mut ops: Vec<FileOp> = Vec::new();
    let mut i = begin + 1;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed == END {
            break;
        }

        if let Some(rest) = strip_marker(trimmed, ADD_FILE) {
            let path = rest.to_string();
            i += 1;
            let mut content: Vec<String> = Vec::new();
            while i < lines.len() && !is_file_marker(lines[i]) {
                let l = lines[i];
                if let Some(c) = l.strip_prefix('+') {
                    content.push(c.to_string());
                } else {
                    content.push(l.to_string()); // 容错：原样收录
                }
                i += 1;
            }
            ops.push(FileOp::Add { path, content: content.join("\n") });
            continue;
        }

        if let Some(rest) = strip_marker(trimmed, DELETE_FILE) {
            ops.push(FileOp::Delete { path: rest.to_string() });
            i += 1;
            continue;
        }

        if let Some(rest) = strip_marker(trimmed, UPDATE_FILE) {
            let path = rest.to_string();
            i += 1;

            let mut move_to = None;
            if i < lines.len() {
                if let Some(m) = strip_marker(lines[i].trim(), MOVE_TO) {
                    move_to = Some(m.to_string());
                    i += 1;
                }
            }

            let mut chunks: Vec<Chunk> = Vec::new();
            let mut cur: Option<Chunk> = None;
            while i < lines.len() && !is_file_marker(lines[i]) {
                let l = lines[i];
                if l.starts_with("@@") {
                    if let Some(c) = cur.take() {
                        chunks.push(c);
                    }
                    let ctx = l[2..].trim();
                    cur = Some(Chunk {
                        context: if ctx.is_empty() { None } else { Some(ctx.to_string()) },
                        old_lines: Vec::new(),
                        new_lines: Vec::new(),
                    });
                    i += 1;
                    continue;
                }
                if l.trim() == END_OF_FILE {
                    i += 1;
                    continue;
                }
                let c = cur.get_or_insert_with(Chunk::empty);
                if let Some(rest) = l.strip_prefix('+') {
                    c.new_lines.push(rest.to_string());
                } else if let Some(rest) = l.strip_prefix('-') {
                    c.old_lines.push(rest.to_string());
                } else if let Some(rest) = l.strip_prefix(' ') {
                    c.old_lines.push(rest.to_string());
                    c.new_lines.push(rest.to_string());
                } else {
                    // 无前缀（含空行）：视为上下文
                    c.old_lines.push(l.to_string());
                    c.new_lines.push(l.to_string());
                }
                i += 1;
            }
            if let Some(c) = cur.take() {
                chunks.push(c);
            }
            ops.push(FileOp::Update { path, move_to, chunks });
            continue;
        }

        // 其它行（Begin 之后的空行/杂项）跳过
        i += 1;
    }

    if ops.is_empty() {
        return Err("no file operations found in patch".to_string());
    }
    Ok(ops)
}

// ============================================================================
// 应用
// ============================================================================

fn resolve(path: &str, workdir: &str) -> PathBuf {
    if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        PathBuf::from(workdir).join(path)
    }
}

fn apply_ops(ops: &[FileOp], workdir: &str) -> Result<String, String> {
    let mut summary: Vec<String> = Vec::new();

    for op in ops {
        match op {
            FileOp::Add { path, content } => {
                let full = resolve(path, workdir);
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("create dir for '{}': {}", path, e))?;
                }
                std::fs::write(&full, content)
                    .map_err(|e| format!("write '{}': {}", path, e))?;
                summary.push(format!("Added {}", path));
            }
            FileOp::Delete { path } => {
                let full = resolve(path, workdir);
                std::fs::remove_file(&full)
                    .map_err(|e| format!("delete '{}': {}", path, e))?;
                summary.push(format!("Deleted {}", path));
            }
            FileOp::Update { path, move_to, chunks } => {
                let full = resolve(path, workdir);
                let content = std::fs::read_to_string(&full)
                    .map_err(|e| format!("read '{}': {}", path, e))?;
                let updated = apply_chunks(&content, chunks)
                    .map_err(|e| format!("update '{}': {}", path, e))?;

                match move_to {
                    Some(dest) if dest != path => {
                        let dest_full = resolve(dest, workdir);
                        if let Some(parent) = dest_full.parent() {
                            std::fs::create_dir_all(parent)
                                .map_err(|e| format!("create dir for '{}': {}", dest, e))?;
                        }
                        std::fs::write(&dest_full, updated)
                            .map_err(|e| format!("write '{}': {}", dest, e))?;
                        std::fs::remove_file(&full)
                            .map_err(|e| format!("remove old '{}': {}", path, e))?;
                        summary.push(format!("Updated {} -> {}", path, dest));
                    }
                    _ => {
                        std::fs::write(&full, updated)
                            .map_err(|e| format!("write '{}': {}", path, e))?;
                        summary.push(format!("Updated {}", path));
                    }
                }
            }
        }
    }

    Ok(summary.join("\n"))
}

/// 比较两行时忽略行尾空白差异（提高 patch 匹配成功率）。
fn lines_eq(a: &str, b: &str) -> bool {
    a.trim_end() == b.trim_end()
}

fn find_line(hay: &[String], target: &str, from: usize) -> Option<usize> {
    (from..hay.len()).find(|&i| lines_eq(&hay[i], target))
}

fn find_subsequence(hay: &[String], needle: &[String], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from);
    }
    if needle.len() > hay.len() {
        return None;
    }
    let mut i = from;
    while i + needle.len() <= hay.len() {
        if (0..needle.len()).all(|k| lines_eq(&hay[i + k], &needle[k])) {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn splice(lines: &mut Vec<String>, at: usize, remove: usize, insert: &[String]) {
    let tail = lines.split_off(at + remove);
    lines.truncate(at);
    lines.extend(insert.iter().cloned());
    lines.extend(tail);
}

fn apply_chunks(content: &str, chunks: &[Chunk]) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(String::from).collect();
    let trailing_newline = content.ends_with('\n');
    let mut search_from = 0usize;

    for (ci, chunk) in chunks.iter().enumerate() {
        let mut start = search_from;
        if let Some(ctx) = &chunk.context {
            match find_line(&lines, ctx, search_from) {
                Some(idx) => start = idx + 1,
                None => {
                    return Err(format!("chunk {}: context anchor '{}' not found", ci + 1, ctx))
                }
            }
        }

        if chunk.old_lines.is_empty() {
            // 纯插入（无删除/上下文行）：在锚点处插入
            splice(&mut lines, start, 0, &chunk.new_lines);
            search_from = start + chunk.new_lines.len();
            continue;
        }

        match find_subsequence(&lines, &chunk.old_lines, start) {
            Some(pos) => {
                splice(&mut lines, pos, chunk.old_lines.len(), &chunk.new_lines);
                search_from = pos + chunk.new_lines.len();
            }
            None => {
                return Err(format!(
                    "chunk {}: could not locate the lines to replace (the surrounding context may not match the file)",
                    ci + 1
                ))
            }
        }
    }

    let mut out = lines.join("\n");
    if trailing_newline {
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_handles_add_delete_update() {
        let patch = "\
*** Begin Patch
*** Add File: new.txt
+hello
+world
*** Delete File: old.txt
*** Update File: edit.txt
@@ fn main
 context
-remove me
+add me
*** End Patch";
        let ops = parse_patch(patch).unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0], FileOp::Add { path: "new.txt".into(), content: "hello\nworld".into() });
        assert_eq!(ops[1], FileOp::Delete { path: "old.txt".into() });
        match &ops[2] {
            FileOp::Update { path, move_to, chunks } => {
                assert_eq!(path, "edit.txt");
                assert!(move_to.is_none());
                assert_eq!(chunks.len(), 1);
                assert_eq!(chunks[0].context.as_deref(), Some("fn main"));
                assert_eq!(chunks[0].old_lines, vec!["context", "remove me"]);
                assert_eq!(chunks[0].new_lines, vec!["context", "add me"]);
            }
            other => panic!("expected Update, got {:?}", other),
        }
    }

    #[test]
    fn parse_errors_without_begin() {
        assert!(parse_patch("no markers here").is_err());
    }

    #[test]
    fn apply_update_replaces_lines() {
        let content = "line1\nline2\nline3\n";
        let chunk = Chunk {
            context: None,
            old_lines: vec!["line2".into()],
            new_lines: vec!["LINE_TWO".into()],
        };
        let out = apply_chunks(content, &[chunk]).unwrap();
        assert_eq!(out, "line1\nLINE_TWO\nline3\n");
    }

    #[test]
    fn apply_update_uses_context_anchor() {
        // 两处相同的 "x"，靠 context 锚点选中第二处之后
        let content = "x\nmarker\nx\n";
        let chunk = Chunk {
            context: Some("marker".into()),
            old_lines: vec!["x".into()],
            new_lines: vec!["Y".into()],
        };
        let out = apply_chunks(content, &[chunk]).unwrap();
        assert_eq!(out, "x\nmarker\nY\n");
    }

    #[test]
    fn apply_chunks_fails_when_old_not_found() {
        let content = "a\nb\n";
        let chunk = Chunk {
            context: None,
            old_lines: vec!["zzz".into()],
            new_lines: vec!["q".into()],
        };
        assert!(apply_chunks(content, &[chunk]).is_err());
    }

    #[test]
    fn end_to_end_add_update_delete() {
        let dir = tempfile::tempdir().unwrap();
        let wd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("edit.txt"), "alpha\nbeta\ngamma\n").unwrap();
        std::fs::write(dir.path().join("old.txt"), "remove").unwrap();

        let patch = "\
*** Begin Patch
*** Add File: created.txt
+brand new
*** Update File: edit.txt
@@
 alpha
-beta
+BETA
 gamma
*** Delete File: old.txt
*** End Patch";

        let ops = parse_patch(patch).unwrap();
        let summary = apply_ops(&ops, wd).unwrap();
        assert!(summary.contains("Added created.txt"));
        assert!(summary.contains("Updated edit.txt"));
        assert!(summary.contains("Deleted old.txt"));

        assert_eq!(std::fs::read_to_string(dir.path().join("created.txt")).unwrap(), "brand new");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("edit.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );
        assert!(!dir.path().join("old.txt").exists());
    }

    #[test]
    fn end_to_end_update_with_move() {
        let dir = tempfile::tempdir().unwrap();
        let wd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();

        let patch = "\
*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
 one
-two
+TWO
*** End Patch";
        let ops = parse_patch(patch).unwrap();
        apply_ops(&ops, wd).unwrap();

        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("b.txt")).unwrap(), "one\nTWO\n");
    }
}
