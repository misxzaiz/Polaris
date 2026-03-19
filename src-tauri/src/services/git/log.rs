/*! Git 日志和 Blame 操作
 *
 * 提供提交历史查询、文件 Blame 等功能
 */

use std::path::Path;

use crate::models::git::{GitBlameLine, GitBlameResult, GitCommit, GitServiceError};
use super::executor::open_repository;

/// 获取提交历史
pub fn get_log(
    path: &Path,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<&str>,
) -> Result<Vec<GitCommit>, GitServiceError> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;

    revwalk.set_sorting(git2::Sort::TIME)?;

    if let Some(branch_name) = branch {
        let ref_name = format!("refs/heads/{}", branch_name);
        revwalk.push_ref(&ref_name)?;
    } else {
        revwalk.push_head()?;
    }

    let limit = limit.unwrap_or(50);
    let skip = skip.unwrap_or(0);

    let mut commits = Vec::new();
    for (idx, oid_result) in revwalk.enumerate() {
        if idx < skip {
            continue;
        }
        if commits.len() >= limit {
            break;
        }

        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;

        commits.push(GitCommit {
            sha: commit.id().to_string(),
            short_sha: commit.id().to_string()[..8].to_string(),
            message: commit.message().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("").to_string(),
            author_email: commit.author().email().unwrap_or("").to_string(),
            timestamp: Some(commit.time().seconds()),
            parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        });
    }

    Ok(commits)
}

/// 获取文件 Blame 信息
pub fn blame_file(path: &Path, file_path: &str) -> Result<GitBlameResult, GitServiceError> {
    let repo = open_repository(path)?;

    // 获取 HEAD 提交
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    // 查找文件
    let file_entry = head_tree.get_path(std::path::Path::new(file_path))?;
    let file_oid = file_entry.id();

    // 获取文件内容
    let blob = repo.find_blob(file_oid)?;
    let content = std::str::from_utf8(blob.content())
        .map_err(|_| GitServiceError::CLIError("File is not valid UTF-8".to_string()))?;

    // 执行 Blame
    let blame = repo.blame_file(std::path::Path::new(file_path), None)?;

    let mut lines = Vec::new();
    let mut line_number = 1;

    for line_content in content.lines() {
        // 获取该行的 Blame 信息
        let blame_hunk = blame.get_line(line_number);

        // 先获取 original_line_number
        let original_line_number = blame_hunk
            .as_ref()
            .map(|h| h.final_start_line())
            .unwrap_or(line_number);

        let (commit_sha, short_sha, author, author_email, timestamp, summary) =
            if let Some(hunk) = blame_hunk {
                let oid = hunk.final_commit_id();
                let sha = oid.to_string();
                let short = sha[..8.min(sha.len())].to_string();

                // 获取提交信息
                let commit_info = repo.find_commit(oid).ok();
                let (author_name, author_mail, time, msg) = if let Some(c) = commit_info {
                    (
                        c.author().name().unwrap_or("Unknown").to_string(),
                        c.author().email().unwrap_or("").to_string(),
                        c.time().seconds(),
                        c.summary().map(|s| s.to_string()),
                    )
                } else {
                    ("Unknown".to_string(), "".to_string(), 0, None)
                };

                (sha, short, author_name, author_mail, time, msg)
            } else {
                (
                    "unknown".to_string(),
                    "unknown".to_string(),
                    "Unknown".to_string(),
                    "".to_string(),
                    0,
                    None,
                )
            };

        lines.push(GitBlameLine {
            line_number,
            original_line_number,
            commit_sha,
            short_sha,
            author,
            author_email,
            timestamp,
            summary,
            content: line_content.to_string(),
        });

        line_number += 1;
    }

    Ok(GitBlameResult {
        file_path: file_path.to_string(),
        total_lines: lines.len(),
        lines,
    })
}
