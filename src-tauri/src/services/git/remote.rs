/*! Git 远程仓库操作
 *
 * 提供远程仓库管理、推送、拉取、PR 创建等功能
 */

use std::path::Path;

use crate::models::git::{
    CreatePROptions, GitHostType, GitPullResult, GitRemote, GitServiceError, PRReviewStatus,
    PRState, PullRequest,
};
use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// 获取远程仓库
pub fn get_remotes(path: &Path) -> Result<Vec<GitRemote>, GitServiceError> {
    let repo = open_repository(path)?;

    let mut remotes = Vec::new();

    for name in repo.remotes()?.iter().flatten() {
        let remote = repo.find_remote(name)?;
        remotes.push(GitRemote {
            name: name.to_string(),
            fetch_url: remote.url().map(|s: &str| s.to_string()),
            push_url: remote.pushurl().map(|s: &str| s.to_string()),
        });
    }

    Ok(remotes)
}

/// 检测 Git Host 类型
pub fn detect_git_host(remote_url: &str) -> GitHostType {
    if remote_url.contains("github.com") {
        GitHostType::GitHub
    } else if remote_url.contains("gitlab.com") {
        GitHostType::GitLab
    } else if remote_url.contains("dev.azure.com") || remote_url.contains("visualstudio.com") {
        GitHostType::AzureDevOps
    } else if remote_url.contains("bitbucket.org") {
        GitHostType::Bitbucket
    } else {
        GitHostType::Unknown
    }
}

/// 添加远程仓库
pub fn add_remote(path: &Path, name: &str, url: &str) -> Result<GitRemote, GitServiceError> {
    let repo = open_repository(path)?;

    // 检查远程仓库是否已存在
    if repo.find_remote(name).is_ok() {
        return Err(GitServiceError::RemoteExists(name.to_string()));
    }

    // 创建远程仓库
    let remote = repo.remote(name, url)?;

    Ok(GitRemote {
        name: name.to_string(),
        fetch_url: remote.url().map(|s| s.to_string()),
        push_url: remote.pushurl().map(|s| s.to_string()),
    })
}

/// 删除远程仓库
pub fn delete_remote(path: &Path, name: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    // 检查远程仓库是否存在
    if repo.find_remote(name).is_err() {
        return Err(GitServiceError::RemoteNotFound(name.to_string()));
    }

    repo.remote_delete(name)?;

    Ok(())
}

/// 推送分支到远程
pub fn push_branch(
    path: &Path,
    branch_name: &str,
    remote_name: &str,
    force: bool,
) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .arg("push")
        .arg(remote_name)
        .arg(branch_name)
        .arg(if force { "--force" } else { "--force-with-lease" })
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .arg("push")
        .arg(remote_name)
        .arg(branch_name)
        .arg(if force { "--force" } else { "--force-with-lease" })
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 推送分支并设置上游
pub fn push_set_upstream(
    path: &Path,
    branch_name: &str,
    remote_name: &str,
) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .arg("push")
        .arg("-u")
        .arg(remote_name)
        .arg(branch_name)
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .arg("push")
        .arg("-u")
        .arg(remote_name)
        .arg(branch_name)
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    Ok(())
}

/// 创建 Pull Request
pub fn create_pr(path: &Path, options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
    let remote_url = get_remote_url(path, "origin")?;
    let host = detect_git_host(&remote_url);

    match host {
        GitHostType::GitHub => create_github_pr(path, options),
        GitHostType::GitLab => create_gitlab_pr(path, options),
        GitHostType::AzureDevOps => create_azure_pr(path, options),
        GitHostType::Bitbucket => create_bitbucket_pr(path, options),
        GitHostType::Unknown => Err(GitServiceError::CLIError(
            "Unsupported Git host".to_string(),
        )),
    }
}

/// 获取远程 URL
fn get_remote_url(path: &Path, remote_name: &str) -> Result<String, GitServiceError> {
    let repo = open_repository(path)?;

    let remote = repo
        .find_remote(remote_name)
        .map_err(|_| GitServiceError::RemoteNotFound(remote_name.to_string()))?;

    remote
        .url()
        .ok_or_else(|| GitServiceError::CLIError("Remote has no URL".to_string()))
        .map(|s| s.to_string())
}

/// 使用 gh CLI 创建 GitHub PR
fn create_github_pr(path: &Path, options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
    // 检查 gh 是否可用
    #[cfg(windows)]
    let check = std::process::Command::new("gh")
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    #[cfg(not(windows))]
    let check = std::process::Command::new("gh").arg("--version").output();

    if check.is_err() || !check.ok().map(|o| o.status.success()).unwrap_or(false) {
        return Err(GitServiceError::CLINotFound("gh".to_string()));
    }

    let mut cmd = std::process::Command::new("gh");
    cmd.arg("pr")
        .arg("create")
        .arg("--title")
        .arg(&options.title)
        .arg("--base")
        .arg(&options.base_branch)
        .arg("--head")
        .arg(&options.head_branch)
        .arg("--json")
        .arg("number,state,title,body,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,author,additions,deletions,changedFiles");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Some(body) = &options.body {
        cmd.arg("--body").arg(body);
    }

    if options.draft.unwrap_or(false) {
        cmd.arg("--draft");
    }

    if let Some(assignees) = &options.assignees {
        for assignee in assignees {
            cmd.arg("--assignee").arg(assignee);
        }
    }

    if let Some(labels) = &options.labels {
        for label in labels {
            cmd.arg("--label").arg(label);
        }
    }

    let output = cmd.current_dir(path).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    // 解析 JSON 输出
    let json = String::from_utf8_lossy(&output.stdout);
    let pr_data: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| GitServiceError::CLIError(format!("Failed to parse PR info: {}", e)))?;

    Ok(PullRequest {
        number: pr_data["number"]
            .as_u64()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR number".to_string()))?,
        url: pr_data["url"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR URL".to_string()))?
            .to_string(),
        title: pr_data["title"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR title".to_string()))?
            .to_string(),
        body: pr_data["body"].as_str().map(|s| s.to_string()),
        state: match pr_data["state"].as_str().unwrap_or("open") {
            "OPEN" => PRState::Open,
            "MERGED" => PRState::Merged,
            "CLOSED" => PRState::Closed,
            _ => PRState::Open,
        },
        head_branch: pr_data["headRefName"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing head branch".to_string()))?
            .to_string(),
        base_branch: pr_data["baseRefName"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing base branch".to_string()))?
            .to_string(),
        created_at: pr_data["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0),
        updated_at: pr_data["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0),
        merged_at: pr_data["mergedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp()),
        closed_at: pr_data["closedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp()),
        author: pr_data["author"]
            .as_object()
            .and_then(|o| o.get("login"))
            .and_then(|l| l.as_str())
            .unwrap_or("unknown")
            .to_string(),
        review_status: None,
        additions: pr_data["additions"].as_u64().map(|v| v as usize),
        deletions: pr_data["deletions"].as_u64().map(|v| v as usize),
        changed_files: pr_data["changedFiles"].as_u64().map(|v| v as usize),
    })
}

/// 使用 git CLI 创建 GitLab MR（暂不支持）
fn create_gitlab_pr(_path: &Path, _options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
    Err(GitServiceError::CLIError(
        "GitLab MR creation not yet supported".to_string(),
    ))
}

/// 使用 az CLI 创建 Azure DevOps PR（暂不支持）
fn create_azure_pr(_path: &Path, _options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
    Err(GitServiceError::CLIError(
        "Azure DevOps PR creation not yet supported".to_string(),
    ))
}

/// 使用 git CLI 创建 Bitbucket PR（暂不支持）
fn create_bitbucket_pr(_path: &Path, _options: &CreatePROptions) -> Result<PullRequest, GitServiceError> {
    Err(GitServiceError::CLIError(
        "Bitbucket PR creation not yet supported".to_string(),
    ))
}

/// 获取 PR 状态
pub fn get_pr_status(path: &Path, pr_number: u64) -> Result<PullRequest, GitServiceError> {
    let remote_url = get_remote_url(path, "origin")?;
    let host = detect_git_host(&remote_url);

    match host {
        GitHostType::GitHub => get_github_pr_status(path, pr_number),
        _ => Err(GitServiceError::CLIError(
            "PR status check not supported for this host".to_string(),
        )),
    }
}

/// 获取 GitHub PR 状态
fn get_github_pr_status(path: &Path, pr_number: u64) -> Result<PullRequest, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("gh")
        .arg("pr")
        .arg("view")
        .arg(pr_number.to_string())
        .arg("--json")
        .arg("number,state,title,body,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,author,additions,deletions,changedFiles,reviews")
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("gh")
        .arg("pr")
        .arg("view")
        .arg(pr_number.to_string())
        .arg("--json")
        .arg("number,state,title,body,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,author,additions,deletions,changedFiles,reviews")
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    let pr_data: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| GitServiceError::CLIError(format!("Failed to parse PR info: {}", e)))?;

    // 解析审查状态
    let review_status = pr_data["reviews"].as_array().and_then(|reviews| {
        reviews.last().and_then(|latest| {
            latest["state"].as_str().map(|s| match s {
                "APPROVED" => PRReviewStatus::Approved,
                "CHANGES_REQUESTED" => PRReviewStatus::ChangesRequested,
                "COMMENTED" => PRReviewStatus::Commented,
                "PENDING" => PRReviewStatus::Pending,
                _ => PRReviewStatus::Pending,
            })
        })
    });

    Ok(PullRequest {
        number: pr_data["number"]
            .as_u64()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR number".to_string()))?,
        url: pr_data["url"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR URL".to_string()))?
            .to_string(),
        title: pr_data["title"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing PR title".to_string()))?
            .to_string(),
        body: pr_data["body"].as_str().map(|s| s.to_string()),
        state: match pr_data["state"].as_str().unwrap_or("open") {
            "OPEN" => PRState::Open,
            "MERGED" => PRState::Merged,
            "CLOSED" => PRState::Closed,
            _ => PRState::Open,
        },
        head_branch: pr_data["headRefName"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing head branch".to_string()))?
            .to_string(),
        base_branch: pr_data["baseRefName"]
            .as_str()
            .ok_or_else(|| GitServiceError::CLIError("Missing base branch".to_string()))?
            .to_string(),
        created_at: pr_data["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0),
        updated_at: pr_data["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0),
        merged_at: pr_data["mergedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp()),
        closed_at: pr_data["closedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp()),
        author: pr_data["author"]
            .as_object()
            .and_then(|o| o.get("login"))
            .and_then(|l| l.as_str())
            .unwrap_or("unknown")
            .to_string(),
        review_status,
        additions: pr_data["additions"].as_u64().map(|v| v as usize),
        deletions: pr_data["deletions"].as_u64().map(|v| v as usize),
        changed_files: pr_data["changedFiles"].as_u64().map(|v| v as usize),
    })
}

/// Pull 远程更新
pub fn pull(
    path: &Path,
    remote_name: &str,
    branch_name: Option<&str>,
) -> Result<GitPullResult, GitServiceError> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("pull").arg(remote_name);

    if let Some(branch) = branch_name {
        cmd.arg(branch);
    }

    cmd.arg("--no-edit");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.current_dir(path).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let fast_forward = stdout.contains("Fast-forward");

    Ok(GitPullResult {
        success: true,
        fast_forward,
        pulled_commits: 0,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        conflicts: vec![],
    })
}
