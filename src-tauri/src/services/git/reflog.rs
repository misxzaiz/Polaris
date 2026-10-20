/*! Git Reflog 操作（P1：reflog UI + 一键恢复）
 *
 * 提供引用日志查询（HEAD / 指定分支），「一键恢复」复用既有 checkout_commit。
 * CLI 实现：reflog 一次性轻查询，git2 reflog API 的 callback 签名繁琐收益低。
 */

use std::path::Path;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

use crate::models::git::{GitReflogEntry, GitServiceError};

/// 读取 reflog（默认 HEAD；`branch` Some 时读该分支的 reflog）
///
/// limit 默认 30；条目按新→旧排序（与 git CLI 一致）。
pub fn get_reflog(
    path: &Path,
    branch: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<GitReflogEntry>, GitServiceError> {
    // 记录分隔符 GS + 字段分隔符 US（与 search_log 同约定；%gs 不含换行，仍按同约定防漂移）
    const FORMAT: &str = "%H%x1f%h%x1f%gs%x1f%ct%x1f%gD%x1e";
    let mut args: Vec<String> = vec![
        "reflog".to_string(),
        "show".to_string(),
        format!("--format={}", FORMAT),
        "-n".to_string(),
        limit.unwrap_or(30).to_string(),
    ];
    if let Some(b) = branch {
        args.push(b.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(&arg_refs)
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(&arg_refs)
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for record in stdout.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let parts: Vec<&str> = record.split('\x1f').collect();
        if parts.len() != 5 {
            continue;
        }
        let selector = parts[4].trim().to_string();
        // selector 形如 HEAD@{2} 或 refs/heads/main@{3} —— 含分支前缀时提取分支名
        let branch_name = selector
            .strip_prefix("refs/heads/")
            .and_then(|rest| rest.split("@{").next())
            .map(String::from);

        entries.push(GitReflogEntry {
            sha: parts[0].trim().to_string(),
            short_sha: parts[1].trim().to_string(),
            subject: parts[2].trim().to_string(),
            timestamp: parts[3].trim().parse().unwrap_or(0),
            selector,
            branch: branch_name,
        });
    }

    Ok(entries)
}
