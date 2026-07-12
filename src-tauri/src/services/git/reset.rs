/*! Git Reset 操作
 *
 * 提供 git reset 功能：Soft/Mixed/Hard 三种模式
 */

use std::path::Path;

use git2::ResetType;

use crate::models::git::GitServiceError;
use super::executor::open_repository;

/// Reset 模式
pub enum ResetMode {
    /// --soft：仅移动 HEAD，保留暂存区和工作区
    Soft,
    /// --mixed（默认）：移动 HEAD，重置暂存区，保留工作区
    Mixed,
    /// --hard：移动 HEAD，重置暂存区和工作区
    Hard,
}

impl From<ResetMode> for ResetType {
    fn from(m: ResetMode) -> Self {
        match m {
            ResetMode::Soft => ResetType::Soft,
            ResetMode::Mixed => ResetType::Mixed,
            ResetMode::Hard => ResetType::Hard,
        }
    }
}

/// 重置 HEAD 到指定提交
pub fn reset(path: &Path, commit_sha: &str, mode: ResetMode) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;
    let oid = git2::Oid::from_str(commit_sha)
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))?;
    let commit = repo.find_commit(oid)
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))?;
    repo.reset(commit.as_object(), mode.into(), None)?;
    Ok(())
}