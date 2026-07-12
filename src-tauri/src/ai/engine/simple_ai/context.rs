/*! Simple AI 运行时上下文注入
 *
 * 借鉴 codex 的 `environment_context` 与 `AGENTS.md` 机制，并适配 Polaris：
 * - **environment_context**：以结构化 XML 片段告知模型 cwd / os / shell / 当前日期；
 * - **项目指令**：从工作目录向上发现 `AGENTS.md` / `CLAUDE.md`，按 root→cwd 顺序拼接，
 *   作为 user 消息注入，让模型遵守项目约定。
 *
 * 二者均仅在会话首轮（`start_session`）注入；`continue_session` 不重复注入（已在历史中）。
 *
 * 注：codex 用 `<INSTRUCTIONS>` XML 标签包裹单个文件内容。考虑到 AGENTS.md/CLAUDE.md 是
 * Markdown（正文可能含尖括号、代码块），此处改用 Markdown 小标题分隔多文件，鲁棒性更好。
 */

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 项目指令文件名。同目录两者都存在时都收集，AGENTS.md 在前（更通用的 agent 约定）。
const INSTRUCTION_FILENAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// 项目指令总字节预算，超出则截断（对应 codex `project_doc_max_bytes` 思路）。
const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;

/// 构建首轮注入的上下文消息：始终含一条 `environment_context`，发现到项目指令时再追加一条。
pub(super) fn build_context_messages(work_dir: &str) -> Vec<Value> {
    let mut msgs = Vec::new();
    msgs.push(json!({
        "role": "user",
        "content": build_environment_context(work_dir),
    }));
    if let Some(instructions) = discover_project_instructions(work_dir) {
        msgs.push(json!({ "role": "user", "content": instructions }));
    }
    msgs
}

/// 结构化环境上下文（XML 片段）。
///
/// shell 由 `detect_shell()` 动态检测（复用 bash.rs 的缓存逻辑），
/// 让 LLM 准确知道当前 shell 类型，避免生成不适配的命令语法。
fn build_environment_context(work_dir: &str) -> String {
    let os = if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    let shell = super::tools::detect_shell().0;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let cwd = xml_escape(&display_path(work_dir));
    format!(
        "<environment_context>\n  \
<cwd>{cwd}</cwd>\n  \
<os>{os}</os>\n  \
<shell>{shell}</shell>\n  \
<current_date>{date}</current_date>\n\
</environment_context>"
    )
}

/// 发现并拼接项目指令文件。
fn discover_project_instructions(work_dir: &str) -> Option<String> {
    let cwd = PathBuf::from(work_dir);
    // project root：从 cwd 向上找含 `.git` 的目录；找不到则以（规范化的）cwd 为 root。
    let root = find_project_root(&cwd)
        .unwrap_or_else(|| std::fs::canonicalize(&cwd).unwrap_or_else(|_| cwd.clone()));
    let dirs = dirs_from_root_to_cwd(&root, &cwd);

    let mut sections: Vec<String> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    'outer: for dir in &dirs {
        for name in INSTRUCTION_FILENAMES {
            let path = dir.join(name);
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let content = raw.trim();
            if content.is_empty() {
                continue;
            }
            let display = xml_escape(&strip_unc(&path.to_string_lossy()));
            let section = format!("## {}\n\n{}", display, content);

            if total + section.len() > MAX_INSTRUCTION_BYTES {
                let remain = MAX_INSTRUCTION_BYTES.saturating_sub(total);
                if remain > 0 {
                    sections.push(truncate_bytes(&section, remain));
                }
                truncated = true;
                break 'outer;
            }
            total += section.len();
            sections.push(section);
        }
    }

    if sections.is_empty() {
        return None;
    }

    let mut out = String::from(
        "# Project instructions\n\
The following instructions come from AGENTS.md / CLAUDE.md files in this project. \
Treat them as authoritative project conventions and follow them.\n\n",
    );
    out.push_str(&sections.join("\n\n"));
    if truncated {
        out.push_str("\n\n(... project instructions truncated to fit the budget)");
    }
    Some(out)
}

/// 从 `start` 向上查找含 `.git` 标记的目录作为 project root。
fn find_project_root(start: &Path) -> Option<PathBuf> {
    let start_buf = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    let mut cur: Option<&Path> = Some(start_buf.as_path());
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// 返回从 `root` 到 `cwd`（含两端）路径上的目录序列，root 在前。
fn dirs_from_root_to_cwd(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let cwd_buf = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if let Ok(rel) = cwd_buf.strip_prefix(root) {
        let mut dirs = vec![root.to_path_buf()];
        let mut acc = root.to_path_buf();
        for comp in rel.components() {
            acc.push(comp.as_os_str());
            dirs.push(acc.clone());
        }
        dirs
    } else {
        // cwd 不在 root 之下（异常）：仅扫描 cwd。
        vec![cwd_buf]
    }
}

/// 去除 Windows verbatim 前缀 `\\?\`，便于阅读。
fn strip_unc(s: &str) -> String {
    s.strip_prefix(r"\\?\").unwrap_or(s).to_string()
}

/// 规范化展示路径（绝对化 + 去 UNC 前缀），失败时回退原值。
fn display_path(work_dir: &str) -> String {
    let p = PathBuf::from(work_dir);
    let canon = std::fs::canonicalize(&p).unwrap_or(p);
    strip_unc(&canon.to_string_lossy())
}

/// 最小 XML 转义（路径/属性值用）。
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 按字节预算安全截断（不切断 UTF-8 多字节序列）。
fn truncate_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_context_has_expected_tags() {
        let dir = tempfile::tempdir().unwrap();
        let msgs = build_context_messages(dir.path().to_str().unwrap());
        assert!(!msgs.is_empty());
        let env = msgs[0]["content"].as_str().unwrap();
        assert!(env.contains("<environment_context>"));
        assert!(env.contains("<cwd>"));
        assert!(env.contains("<os>"));
        assert!(env.contains("<shell>"));
        assert!(env.contains("<current_date>"));
    }

    #[test]
    fn no_instruction_files_yields_only_env_context() {
        let dir = tempfile::tempdir().unwrap();
        let msgs = build_context_messages(dir.path().to_str().unwrap());
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn discovers_agents_md_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "Use tabs not spaces.").unwrap();
        let msgs = build_context_messages(dir.path().to_str().unwrap());
        assert_eq!(msgs.len(), 2);
        let instr = msgs[1]["content"].as_str().unwrap();
        assert!(instr.contains("Use tabs not spaces."));
        assert!(instr.contains("AGENTS.md"));
    }

    #[test]
    fn agents_md_ordered_before_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "AGENTS_MARKER").unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "CLAUDE_MARKER").unwrap();
        let msgs = build_context_messages(dir.path().to_str().unwrap());
        let instr = msgs[1]["content"].as_str().unwrap();
        let ai = instr.find("AGENTS_MARKER").unwrap();
        let ci = instr.find("CLAUDE_MARKER").unwrap();
        assert!(ai < ci, "AGENTS.md should be ordered before CLAUDE.md");
    }

    #[test]
    fn root_instructions_precede_subdir() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join("AGENTS.md"), "ROOT_RULE").unwrap();
        let sub = root.path().join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("AGENTS.md"), "SUB_RULE").unwrap();
        let msgs = build_context_messages(sub.to_str().unwrap());
        let instr = msgs[1]["content"].as_str().unwrap();
        let ri = instr.find("ROOT_RULE").unwrap();
        let si = instr.find("SUB_RULE").unwrap();
        assert!(ri < si, "root instructions should precede subdir instructions");
    }

    #[test]
    fn instructions_truncated_to_budget() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let big = "A".repeat(MAX_INSTRUCTION_BYTES + 5000);
        std::fs::write(dir.path().join("AGENTS.md"), &big).unwrap();
        let msgs = build_context_messages(dir.path().to_str().unwrap());
        let instr = msgs[1]["content"].as_str().unwrap();
        assert!(instr.contains("truncated"));
        assert!(instr.len() < MAX_INSTRUCTION_BYTES + 2000);
    }
}
