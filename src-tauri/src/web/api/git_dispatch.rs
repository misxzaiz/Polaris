//! Git command dispatch for Web IPC bridge.
//! This module uses separate #[cfg] blocks for the two cases:
//! - git feature enabled: full implementation using commands::git
//! - git feature disabled: returns "not supported" error

use axum::Json;
use serde_json::Value;
use super::WebError;

/// Dispatch a git command. When git is available, dispatches to the real handler.
/// When git is not compiled in, returns a "not supported" error.
#[cfg(not(feature = "git"))]
pub async fn dispatch_git_command(_cmd: &str, _args: &Value) -> Result<Json<Value>, WebError> {
    Err(WebError::NotFound("Git support not compiled in".to_string()))
}

#[cfg(feature = "git")]
pub async fn dispatch_git_command(cmd: &str, args: &Value) -> Result<Json<Value>, WebError> {
    use crate::commands::git::*;

    fn require_string(args: &Value, key: &str) -> Result<String, WebError> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| WebError::BadRequest(format!("Missing required argument: {}", key)))
    }

    fn git_err(e: crate::models::git::GitError) -> WebError {
        WebError::Internal(e.to_string())
    }

    fn dispatch_git_simple1<T: serde::Serialize>(
        _name: &str, args: &Value,
        f: fn(String) -> Result<T, crate::models::git::GitError>,
    ) -> Result<Json<Value>, WebError> {
        let wp = require_string(args, "workspacePath")?;
        let r = f(wp).map_err(git_err)?;
        Ok(Json(serde_json::to_value(r).unwrap_or_default()))
    }

    fn dispatch_git_simple2<T: serde::Serialize>(
        _name: &str, args: &Value,
        f: fn(String, String) -> Result<T, crate::models::git::GitError>,
    ) -> Result<Json<Value>, WebError> {
        let wp = require_string(args, "workspacePath")?;
        let arg2_key = ["filePath", "name", "commitSha", "sourceBranch", "remoteName", "url", "branch"]
            .iter().find(|&&k| args.get(k).is_some()).copied().unwrap_or("name");
        let arg2 = require_string(args, arg2_key)?;
        let r = f(wp, arg2).map_err(git_err)?;
        Ok(Json(serde_json::to_value(r).unwrap_or_default()))
    }

    match cmd {
        "git_is_repository" => {
            let wp = require_string(args, "workspacePath")?;
            Ok(Json(Value::Bool(git_is_repository(wp).map_err(git_err)?)))
        }
        "git_get_status" => {
            let wp = require_string(args, "workspacePath")?;
            Ok(Json(serde_json::to_value(git_get_status(wp).map_err(git_err)?).unwrap_or_default()))
        }
        "git_get_diffs" => {
            let wp = require_string(args, "workspacePath")?;
            let base = require_string(args, "baseCommit")?;
            Ok(Json(serde_json::to_value(git_get_diffs(wp, base).map_err(git_err)?).unwrap_or_default()))
        }
        "git_get_log" => {
            let wp = require_string(args, "workspacePath")?;
            let limit = args.get("limit").or_else(|| args.get("maxCount"))
                .and_then(|v| v.as_u64()).map(|n| n as usize);
            let skip = args.get("skip").and_then(|v| v.as_u64()).map(|n| n as usize);
            let branch = args.get("branch").and_then(|v| v.as_str()).map(String::from);
            Ok(Json(serde_json::to_value(git_get_log(wp, limit, skip, branch).map_err(git_err)?).unwrap_or_default()))
        }
        "git_get_commit_details" => {
            let wp = require_string(args, "workspacePath")?;
            let commit_sha = require_string(args, "commitSha")?;
            Ok(Json(serde_json::to_value(git_get_commit_details(wp, commit_sha).map_err(git_err)?).unwrap_or_default()))
        }
        "git_get_file_history" => {
            let wp = require_string(args, "workspacePath")?;
            let file_path = require_string(args, "filePath")?;
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
            let skip = args.get("skip").and_then(|v| v.as_u64()).map(|n| n as usize);
            let branch = args.get("branch").and_then(|v| v.as_str()).map(String::from);
            Ok(Json(serde_json::to_value(git_get_file_history(wp, file_path, limit, skip, branch).map_err(git_err)?).unwrap_or_default()))
        }
        "git_init_repository" => {
            let wp = require_string(args, "workspacePath")?;
            let ib = args.get("initialBranch").and_then(|v| v.as_str()).map(String::from);
            Ok(Json(serde_json::to_value(git_init_repository(wp, ib).map_err(git_err)?).unwrap_or_default()))
        }
        "git_commit_changes" => {
            let wp = require_string(args, "workspacePath")?;
            let msg = require_string(args, "message")?;
            let stage_all = args.get("stageAll").and_then(|v| v.as_bool()).unwrap_or(false);
            let files = args.get("selectedFiles").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>());
            Ok(Json(serde_json::to_value(git_commit_changes(wp, msg, stage_all, files).await.map_err(git_err)?).unwrap_or_default()))
        }
        "git_get_branches" => dispatch_git_simple1("git_get_branches", args, git_get_branches),
        "git_get_tags" => dispatch_git_simple1("git_get_tags", args, git_get_tags),
        "git_get_remotes" => dispatch_git_simple1("git_get_remotes", args, git_get_remotes),
        "git_get_stash_list" | "git_stash_list" => dispatch_git_simple1("git_stash_list", args, git_stash_list),
        "git_get_worktree_diff" => dispatch_git_simple1("git_get_worktree_diff", args, git_get_worktree_diff),
        "git_get_index_diff" => dispatch_git_simple1("git_get_index_diff", args, git_get_index_diff),
        "git_get_gitignore" => dispatch_git_simple1("git_get_gitignore", args, git_get_gitignore),
        "git_checkout_branch" => dispatch_git_simple2("git_checkout_branch", args, git_checkout_branch),
        "git_delete_tag" => dispatch_git_simple2("git_delete_tag", args, git_delete_tag),
        "git_remove_remote" => dispatch_git_simple2("git_remove_remote", args, git_remove_remote),
        "git_stage_file" => dispatch_git_simple2("git_stage_file", args, git_stage_file),
        "git_unstage_file" => dispatch_git_simple2("git_unstage_file", args, git_unstage_file),
        "git_discard_changes" => dispatch_git_simple2("git_discard_changes", args, git_discard_changes),
        "git_blame_file" => dispatch_git_simple2("git_blame_file", args, git_blame_file),
        _ => Err(WebError::NotFound(format!("Unknown git command: {}", cmd)))
    }
}