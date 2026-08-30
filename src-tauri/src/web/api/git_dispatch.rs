//! Git command dispatch for Web IPC bridge.
//! This module uses separate #[cfg] blocks for the two cases:
//! - git feature enabled: full implementation using commands::git
//! - git feature disabled: returns "not supported" error
//!
//! Registry must stay in sync with the frontend gitStore slices
//! (src/stores/gitStore/*.ts) — every `invoke('git_*')` call site needs
//! a matching arm here, otherwise remote/Web mode reports
//! "Unknown git command".

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

    fn optional_string(args: &Value, key: &str) -> Option<String> {
        args.get(key).and_then(|v| v.as_str()).map(String::from)
    }

    fn string_vec(args: &Value, key: &str) -> Vec<String> {
        args.get(key).and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    fn require_u64(args: &Value, key: &str) -> Result<u64, WebError> {
        args.get(key)
            .and_then(|v| v.as_u64())
            .ok_or_else(|| WebError::BadRequest(format!("Missing required argument: {}", key)))
    }

    fn git_err(e: crate::models::git::GitError) -> WebError {
        WebError::Internal(e.to_string())
    }

    fn json_ok<T: serde::Serialize>(r: Result<T, crate::models::git::GitError>) -> Result<Json<Value>, WebError> {
        Ok(Json(serde_json::to_value(r.map_err(git_err)?).unwrap_or_default()))
    }

    /// 1 个参数：workspacePath
    fn dispatch_git_simple1<T: serde::Serialize>(
        args: &Value,
        f: fn(String) -> Result<T, crate::models::git::GitError>,
    ) -> Result<Json<Value>, WebError> {
        let wp = require_string(args, "workspacePath")?;
        json_ok(f(wp))
    }

    /// 2 个参数：workspacePath + 第二个字符串参数（按键序取第一个存在的）
    fn dispatch_git_simple2<T: serde::Serialize>(
        args: &Value,
        f: fn(String, String) -> Result<T, crate::models::git::GitError>,
    ) -> Result<Json<Value>, WebError> {
        let wp = require_string(args, "workspacePath")?;
        let arg2_key = ["filePath", "name", "commitSha", "sourceBranch", "remoteName", "url", "branch"]
            .iter().find(|&&k| args.get(k).is_some()).copied().unwrap_or("name");
        let arg2 = require_string(args, arg2_key)?;
        json_ok(f(wp, arg2))
    }

    match cmd {
        // ── 状态 / 只读 ─────────────────────────────────────────────────────
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
            let branch = optional_string(args, "branch");
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
            let branch = optional_string(args, "branch");
            Ok(Json(serde_json::to_value(git_get_file_history(wp, file_path, limit, skip, branch).map_err(git_err)?).unwrap_or_default()))
        }

        // ── 仓库初始化 ──────────────────────────────────────────────────────
        "git_init_repository" => {
            let wp = require_string(args, "workspacePath")?;
            let ib = optional_string(args, "initialBranch");
            Ok(Json(serde_json::to_value(git_init_repository(wp, ib).map_err(git_err)?).unwrap_or_default()))
        }

        // ── 提交 / 暂存 ─────────────────────────────────────────────────────
        "git_commit_changes" => {
            let wp = require_string(args, "workspacePath")?;
            let msg = require_string(args, "message")?;
            let stage_all = args.get("stageAll").and_then(|v| v.as_bool()).unwrap_or(false);
            let files = args.get("selectedFiles").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>());
            Ok(Json(serde_json::to_value(git_commit_changes(wp, msg, stage_all, files).await.map_err(git_err)?).unwrap_or_default()))
        }
        "git_stage_file" => dispatch_git_simple2(args, git_stage_file),
        "git_unstage_file" => dispatch_git_simple2(args, git_unstage_file),
        "git_discard_changes" => dispatch_git_simple2(args, git_discard_changes),
        "git_batch_stage" => {
            let wp = require_string(args, "workspacePath")?;
            let files = string_vec(args, "filePaths");
            json_ok(git_batch_stage(wp, files))
        }

        // ── Diff ────────────────────────────────────────────────────────────
        "git_get_worktree_diff" => dispatch_git_simple1(args, git_get_worktree_diff),
        "git_get_index_diff" => dispatch_git_simple1(args, git_get_index_diff),
        "git_get_worktree_file_diff" => dispatch_git_simple2(args, git_get_worktree_file_diff),
        "git_get_index_file_diff" => dispatch_git_simple2(args, git_get_index_file_diff),

        // ── 分支 ────────────────────────────────────────────────────────────
        "git_get_branches" => dispatch_git_simple1(args, git_get_branches),
        "git_create_branch" => {
            let wp = require_string(args, "workspacePath")?;
            let name = require_string(args, "name")?;
            let checkout = args.get("checkout").and_then(|v| v.as_bool()).unwrap_or(false);
            let start_point = optional_string(args, "startPoint");
            json_ok(git_create_branch(wp, name, checkout, start_point))
        }
        "git_checkout_branch" => dispatch_git_simple2(args, git_checkout_branch),
        "git_delete_branch" => {
            let wp = require_string(args, "workspacePath")?;
            let name = require_string(args, "name")?;
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            json_ok(git_delete_branch(wp, name, force))
        }
        "git_rename_branch" => {
            let wp = require_string(args, "workspacePath")?;
            let old = require_string(args, "oldName")?;
            let new = require_string(args, "newName")?;
            json_ok(git_rename_branch(wp, old, new))
        }
        "git_merge_branch" => {
            let wp = require_string(args, "workspacePath")?;
            let src = require_string(args, "sourceBranch")?;
            let no_ff = args.get("noFF").and_then(|v| v.as_bool()).unwrap_or(false);
            json_ok(git_merge_branch(wp, src, no_ff))
        }
        "git_rebase_branch" => dispatch_git_simple2(args, git_rebase_branch),
        "git_rebase_abort" => dispatch_git_simple1(args, git_rebase_abort),
        "git_rebase_continue" => dispatch_git_simple1(args, git_rebase_continue),

        // ── Cherry-pick / Revert / Reset / Checkout commit ──────────────────
        "git_cherry_pick" => dispatch_git_simple2(args, git_cherry_pick),
        "git_cherry_pick_abort" => dispatch_git_simple1(args, git_cherry_pick_abort),
        "git_cherry_pick_continue" => dispatch_git_simple1(args, git_cherry_pick_continue),
        "git_revert" => dispatch_git_simple2(args, git_revert),
        "git_revert_abort" => dispatch_git_simple1(args, git_revert_abort),
        "git_revert_continue" => dispatch_git_simple1(args, git_revert_continue),
        "git_reset" => {
            let wp = require_string(args, "workspacePath")?;
            let mode = require_string(args, "mode")?;
            let commit_sha = require_string(args, "commitSha")?;
            json_ok(git_reset(wp, mode, commit_sha))
        }
        "git_checkout_commit" => dispatch_git_simple2(args, git_checkout_commit),

        // ── 标签 ────────────────────────────────────────────────────────────
        "git_get_tags" => dispatch_git_simple1(args, git_get_tags),
        "git_create_tag" => {
            let wp = require_string(args, "workspacePath")?;
            let name = require_string(args, "name")?;
            let commitish = optional_string(args, "commitish");
            let message = optional_string(args, "message");
            json_ok(git_create_tag(wp, name, commitish, message))
        }
        "git_delete_tag" => dispatch_git_simple2(args, git_delete_tag),

        // ── 远程 / 推送 / 拉取 ───────────────────────────────────────────────
        "git_get_remotes" => dispatch_git_simple1(args, git_get_remotes),
        "git_add_remote" => {
            let wp = require_string(args, "workspacePath")?;
            let name = require_string(args, "name")?;
            let url = require_string(args, "url")?;
            json_ok(git_add_remote(wp, name, url))
        }
        "git_remove_remote" => dispatch_git_simple2(args, git_remove_remote),
        "git_push_branch" => {
            let wp = require_string(args, "workspacePath")?;
            let branch = require_string(args, "branchName")?;
            let remote = optional_string(args, "remoteName").unwrap_or_else(|| "origin".to_string());
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let remote_branch = optional_string(args, "remoteBranchName");
            json_ok(git_push_branch(wp, branch, remote, force, remote_branch))
        }
        "git_push_set_upstream" => {
            let wp = require_string(args, "workspacePath")?;
            let branch = require_string(args, "branchName")?;
            let remote = optional_string(args, "remoteName").unwrap_or_else(|| "origin".to_string());
            let remote_branch = optional_string(args, "remoteBranchName");
            json_ok(git_push_set_upstream(wp, branch, remote, remote_branch))
        }
        "git_pull" => {
            let wp = require_string(args, "workspacePath")?;
            let remote = optional_string(args, "remoteName");
            let branch = optional_string(args, "branchName");
            json_ok(git_pull(wp, remote, branch).await)
        }
        "git_detect_host" => {
            let remote_url = require_string(args, "remoteUrl")?;
            Ok(Json(serde_json::to_value(git_detect_host(remote_url)).unwrap_or_default()))
        }

        // ── Stash ───────────────────────────────────────────────────────────
        "git_stash_list" | "git_get_stash_list" => dispatch_git_simple1(args, git_stash_list),
        "git_stash_save" => {
            let wp = require_string(args, "workspacePath")?;
            let msg = optional_string(args, "message");
            let include_untracked = args.get("includeUntracked").and_then(|v| v.as_bool()).unwrap_or(false);
            json_ok(git_stash_save(wp, msg, include_untracked))
        }
        "git_stash_pop" => {
            let wp = require_string(args, "workspacePath")?;
            let index = args.get("index").and_then(|v| v.as_u64()).map(|n| n as usize);
            json_ok(git_stash_pop(wp, index))
        }
        "git_stash_drop" => {
            let wp = require_string(args, "workspacePath")?;
            let index = require_u64(args, "index")? as usize;
            json_ok(git_stash_drop(wp, index))
        }

        // ── Blame / gitignore ───────────────────────────────────────────────
        "git_blame_file" => dispatch_git_simple2(args, git_blame_file),
        "git_get_gitignore" => dispatch_git_simple1(args, git_get_gitignore),
        "git_save_gitignore" => {
            let wp = require_string(args, "workspacePath")?;
            let content = require_string(args, "content")?;
            json_ok(git_save_gitignore(wp, content))
        }
        "git_add_to_gitignore" => {
            let wp = require_string(args, "workspacePath")?;
            let rules = string_vec(args, "rules");
            json_ok(git_add_to_gitignore(wp, rules))
        }
        "git_get_gitignore_templates" => {
            Ok(Json(serde_json::to_value(git_get_gitignore_templates()).unwrap_or_default()))
        }

        // ── PR ──────────────────────────────────────────────────────────────
        "git_create_pr" => {
            let wp = require_string(args, "workspacePath")?;
            let options: crate::models::git::CreatePROptions =
                serde_json::from_value(args.get("options").cloned().unwrap_or(Value::Null))
                    .map_err(|e| WebError::BadRequest(format!("Invalid PR options: {}", e)))?;
            json_ok(git_create_pr(wp, options))
        }
        "git_get_pr_status" => {
            let wp = require_string(args, "workspacePath")?;
            let pr_number = require_u64(args, "prNumber")?;
            json_ok(git_get_pr_status(wp, pr_number))
        }

        _ => Err(WebError::NotFound(format!("Unknown git command: {}", cmd)))
    }
}
