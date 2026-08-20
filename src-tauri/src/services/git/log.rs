/*! Git 日志和 Blame 操作
 *
 * 提供提交历史查询、文件 Blame 等功能
 */

use std::path::Path;

use git2::{DiffOptions, Oid, Repository};

use crate::models::git::{
    GitBlameLine, GitBlameResult, GitCommit, GitCommitDetails, GitFileHistoryEntry,
    GitServiceError,
};
use super::diff::convert_diff;
use super::executor::open_repository;

fn commit_to_model(commit: &git2::Commit<'_>) -> GitCommit {
    let sha = commit.id().to_string();
    GitCommit {
        sha: sha.clone(),
        short_sha: sha[..8.min(sha.len())].to_string(),
        message: commit.message().unwrap_or("").to_string(),
        author: commit.author().name().unwrap_or("").to_string(),
        author_email: commit.author().email().unwrap_or("").to_string(),
        timestamp: Some(commit.time().seconds()),
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
    }
}

fn push_history_tip(
    repo: &Repository,
    revwalk: &mut git2::Revwalk<'_>,
    branch: Option<&str>,
) -> Result<(), GitServiceError> {
    let Some(branch_name) = branch.map(str::trim).filter(|name| !name.is_empty()) else {
        revwalk.push_head()?;
        return Ok(());
    };

    let ref_names = [
        format!("refs/heads/{}", branch_name),
        format!("refs/remotes/{}", branch_name),
    ];

    for ref_name in ref_names {
        if repo.find_reference(&ref_name).is_ok() {
            revwalk.push_ref(&ref_name)?;
            return Ok(());
        }
    }

    let object = repo
        .revparse_single(branch_name)
        .map_err(|_| GitServiceError::BranchNotFound(branch_name.to_string()))?;
    let commit = object
        .peel_to_commit()
        .map_err(|_| GitServiceError::BranchNotFound(branch_name.to_string()))?;
    revwalk.push(commit.id())?;

    Ok(())
}

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

    push_history_tip(&repo, &mut revwalk, branch)?;

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

        commits.push(commit_to_model(&commit));
    }

    Ok(commits)
}

/// 获取单个提交详情，包括该提交变更的文件和内容
pub fn get_commit_details(
    path: &Path,
    commit_sha: &str,
) -> Result<GitCommitDetails, GitServiceError> {
    let repo = open_repository(path)?;
    let commit = find_commit_by_prefix(&repo, commit_sha)?;
    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let mut diff_opts = DiffOptions::new();
    diff_opts.include_typechange(true);

    let mut diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        Some(&mut diff_opts),
    )?;
    diff.find_similar(None)?;

    let files = convert_diff(&repo, &diff)?;
    let total_additions = files.iter().map(|file| file.additions.unwrap_or(0)).sum();
    let total_deletions = files.iter().map(|file| file.deletions.unwrap_or(0)).sum();

    Ok(GitCommitDetails {
        commit: commit_to_model(&commit),
        files,
        total_additions,
        total_deletions,
    })
}

/// 获取单个文件的提交历史，并返回每次提交中该文件的 diff
pub fn get_file_history(
    path: &Path,
    file_path: &str,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<&str>,
) -> Result<Vec<GitFileHistoryEntry>, GitServiceError> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;

    revwalk.set_sorting(git2::Sort::TIME)?;
    push_history_tip(&repo, &mut revwalk, branch)?;

    let limit = limit.unwrap_or(50);
    let skip = skip.unwrap_or(0);
    let normalized_file_path = file_path.replace('\\', "/");

    let mut matched_count = 0usize;
    let mut entries = Vec::new();

    for oid_result in revwalk {
        if entries.len() >= limit {
            break;
        }

        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;
        let commit_tree = commit.tree()?;
        let parent_tree = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        let mut diff_opts = DiffOptions::new();
        diff_opts.include_typechange(true);
        diff_opts.pathspec(file_path);

        let mut diff = repo.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&commit_tree),
            Some(&mut diff_opts),
        )?;
        diff.find_similar(None)?;

        let mut files = convert_diff(&repo, &diff)?;
        if files.is_empty() {
            continue;
        }

        let matching_index = files
            .iter()
            .position(|file| {
                file.file_path.replace('\\', "/") == normalized_file_path
                    || file.old_file_path
                        .as_ref()
                        .map(|old_path| old_path.replace('\\', "/") == normalized_file_path)
                        .unwrap_or(false)
            });
        let file = matching_index
            .map(|index| files.remove(index))
            .or_else(|| files.into_iter().next());

        let Some(file) = file else {
            continue;
        };

        if matched_count < skip {
            matched_count += 1;
            continue;
        }

        matched_count += 1;
        entries.push(GitFileHistoryEntry {
            commit: commit_to_model(&commit),
            file,
        });
    }

    Ok(entries)
}

fn find_commit_by_prefix<'repo>(
    repo: &'repo Repository,
    commit_sha: &str,
) -> Result<git2::Commit<'repo>, GitServiceError> {
    let trimmed = commit_sha.trim();
    if trimmed.is_empty() {
        return Err(GitServiceError::CommitNotFound(commit_sha.to_string()));
    }

    if let Ok(oid) = Oid::from_str(trimmed) {
        return repo
            .find_commit(oid)
            .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()));
    }

    let object = repo
        .revparse_single(trimmed)
        .or_else(|_| repo.revparse_single(&format!("{}^{{commit}}", trimmed)))
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))?;

    object
        .peel_to_commit()
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))
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
