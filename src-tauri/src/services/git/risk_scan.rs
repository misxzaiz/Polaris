//! Git 提交风险扫描（P3 AI-3：PR 式提交前 Review 门，纯本地零 AI）
//!
//! 对暂存区（index vs HEAD）逐新增行扫描三类风险：
//! - 疑似密钥（AWS/OpenAI/GitHub/Slack/私钥块/键值对模式）
//! - 冲突 marker 残留（`<<<<<<<`/`>>>>>>>` 开头行——把 marker 提交进去是常见事故）
//! - 大文件（blob > 1MB，一票就地报）
//!
//! 只读：不写盘不动 index；结果上限 120 条（超出截断并标注）。
//! 建议卡不阻断提交——Review 门语义（handoff FR-P3-AI3）。

use std::path::Path;

use crate::models::git::{GitCommitRiskFinding, GitCommitRiskReport};
use super::executor::open_repository;

/// 结果总数上限（超出即截断并标注，避免超长报告刷屏）
const MAX_TOTAL_FINDINGS: usize = 120;

/// 大文件阈值：1 MiB
const LARGE_FILE_BYTES: u64 = 1024 * 1024;

fn secret_patterns() -> Vec<(&'static str, regex::Regex)> {
    use regex::Regex;
    let defs: Vec<(&'static str, &str)> = vec![
        ("aws-access-key", r"AKIA[0-9A-Z]{16}"),
        ("openai-key", r"sk-[A-Za-z0-9_-]{20,}"),
        ("github-token", r"gh[pousr]_[A-Za-z0-9]{30,}"),
        ("slack-token", r"xox[baprs]-[A-Za-z0-9-]{10,}"),
        ("private-key-block", r"^-----BEGIN [A-Z ]*PRIVATE KEY-----"),
        (
            "kv-secret",
            r#"(?i)(api[_-]?key|secret|passwd|password|token)\s*[=:]\s*['"][^'"]{8,}['"]"#,
        ),
    ];
    defs.into_iter()
        .filter_map(|(name, source)| {
            Regex::new(source)
                .map(|re| (name, re))
                .map_err(|e| tracing::warn!("risk scan 正则编译失败({name}): {e}"))
                .ok()
        })
        .collect()
}

/// 扫描暂存区：返回报告。无 HEAD（空仓库）时以空树为基线。
pub fn scan_commit_risk(
    path: &Path,
) -> Result<GitCommitRiskReport, crate::models::git::GitServiceError> {
    use git2::DiffOptions;

    let repo = open_repository(path)?;
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true);

    let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?;

    let patterns = secret_patterns();
    let mut findings: Vec<GitCommitRiskFinding> = Vec::new();
    let mut truncated = false;

    let mut text_cb =
        |delta: git2::DiffDelta<'_>, hunk: Option<git2::DiffHunk<'_>>, line: git2::DiffLine<'_>| -> bool {
            if findings.len() >= MAX_TOTAL_FINDINGS {
                truncated = true;
                return true; // 截断即停
            }
            if line.origin() != '+' && line.origin() != '>' {
                return true; // 只看新增行
            }
            let Some(file_path) = delta.new_file().path().and_then(|p| p.to_str()) else {
                return true;
            };
            let content = String::from_utf8_lossy(line.content());
            let line_no = line.new_lineno().unwrap_or(0);

            // 大文件（每个文件只报一次）
            if let Some(entry) = repo.find_blob(delta.new_file().id()).ok() {
                if entry.size() > LARGE_FILE_BYTES as usize
                    && findings.iter().all(|f| f.file != file_path)
                {
                    findings.push(GitCommitRiskFinding {
                        file: file_path.to_string(),
                        line: None,
                        category: "large-file".into(),
                        pattern: None,
                        excerpt: format!("文件 {} 字节，超 1MiB（是否走 LFS 或加入 ignore？）", entry.size()),
                    });
                    return true;
                }
            }

            let trimmed = content.trim_end();

            // 冲突 marker 残留
            if trimmed.starts_with("<<<<<<<") || trimmed.starts_with(">>>>>>>") {
                findings.push(GitCommitRiskFinding {
                    file: file_path.to_string(),
                    line: Some(line_no),
                    category: "conflict-marker".into(),
                    pattern: None,
                    excerpt: trimmed.chars().take(80).collect(),
                });
                return true;
            }

            // 疑似密钥
            for (name, re) in &patterns {
                if re.is_match(&content) {
                    findings.push(GitCommitRiskFinding {
                        file: file_path.to_string(),
                        line: Some(line_no),
                        category: "secret".into(),
                        pattern: Some((*name).into()),
                        excerpt: trimmed.chars().take(60).collect(),
                    });
                    break; // 每行一条即可
                }
            }
            true
        };

    // git2 0.19：file_cb 必传（delta/progress 回调，本扫描不用 → no-op）
    let mut file_cb = |_delta: git2::DiffDelta<'_>, _progress: f32| -> bool { true };
    let _ = diff.foreach(&mut file_cb, None, None, Some(&mut text_cb));

    Ok(GitCommitRiskReport { findings, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_patterns_compile_and_match() {
        let pats = secret_patterns();
        assert!(pats.len() >= 5, "核心模式必须齐备");
        for (name, re) in &pats {
            match *name {
                "aws-access-key" => assert!(re.is_match("key = AKIAIOSFODNN7EXAMPLE")),
                "openai-key" => assert!(re.is_match("sk-proj-abcdefghij0123456789")),
                "github-token" => assert!(re.is_match("ghp_AbCdEfGh1234567890AbCdEfGh123456")),
                "slack-token" => assert!(re.is_match("xoxb-1234-abcdef")),
                "private-key-block" => assert!(re.is_match("-----BEGIN RSA PRIVATE KEY-----")),
                "kv-secret" => {
                    assert!(re.is_match(r#"password: "hunter22secret""#));
                    assert!(!re.is_match(r#"password = None"#));
                }
                _ => {}
            }
        }
    }
}
