//! Generic IPC Bridge — routes unmatched /api/* requests to Tauri command handlers.
//!
//! Instead of creating individual HTTP routes for every Tauri command, this module
//! provides a single catch-all handler that dispatches based on the URL path.
//! The URL `/api/snippet-list` is converted to command `snippet_list` and dispatched
//! to the appropriate business logic function.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::models::prompt_snippet::{CreateSnippetParams, UpdateSnippetParams};
use crate::models::scheduler::{
    CreateTaskParams, PromptTemplate, ScheduledTask, TaskCategory, TaskMode,
};
use crate::services::prompt_snippet_service::PromptSnippetService;
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;
use crate::utils::LockStatus;
use crate::AppState;

use super::WebError;

/// Handle all unmatched /api/* paths by dispatching to the appropriate handler.
pub async fn handle_ipc_bridge(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Result<Json<Value>, WebError> {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path();
    // Convert kebab-case path to snake_case command name: "/snippet-list" → "snippet_list"
    let command = path.trim_start_matches('/').replace('-', "_");

    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|e| WebError::Internal(format!("Failed to read body: {}", e)))?;

    let args: Value = if bytes.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|e| WebError::BadRequest(format!("Invalid JSON: {}", e)))?
    };

    tracing::debug!(
        "[Web:IPC] command={} args_keys={:?}",
        command,
        args.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );

    match command.as_str() {
        // ── Workspace ──────────────────────────────────────────────────────
        "validate_workspace_path" => dispatch_validate_workspace_path(&args),
        "get_home_dir" => dispatch_get_home_dir(),
        "get_directory_info" => dispatch_get_directory_info(&args),
        "path_exists" => dispatch_path_exists(&args),

        // ── Snippets ───────────────────────────────────────────────────────
        "snippet_list" => dispatch_snippet_list(&state),
        "snippet_get" => dispatch_snippet_get(&state, &args),
        "snippet_create" => dispatch_snippet_create(&state, &args),
        "snippet_update" => dispatch_snippet_update(&state, &args),
        "snippet_delete" => dispatch_snippet_delete(&state, &args),

        // ── Scheduler: Task CRUD ───────────────────────────────────────────
        "scheduler_list_tasks" => dispatch_scheduler_list_tasks(&state, &args),
        "scheduler_get_task" => dispatch_scheduler_get_task(&state, &args),
        "scheduler_create_task" => dispatch_scheduler_create_task(&state, &args),
        "scheduler_update_task" => dispatch_scheduler_update_task(&state, &args),
        "scheduler_delete_task" => dispatch_scheduler_delete_task(&state, &args),
        "scheduler_toggle_task" => dispatch_scheduler_toggle_task(&state, &args),

        // ── Scheduler: Listing helpers ─────────────────────────────────────
        "scheduler_list_tasks_by_category" => {
            dispatch_scheduler_list_by_category(&state, &args)
        }
        "scheduler_list_tasks_by_mode" => dispatch_scheduler_list_by_mode(&state, &args),
        "scheduler_list_tasks_by_group" => dispatch_scheduler_list_by_group(&state, &args),
        "scheduler_get_workspace_breakdown" => {
            dispatch_scheduler_workspace_breakdown(&state, &args)
        }

        // ── Scheduler: Utility ─────────────────────────────────────────────
        "scheduler_validate_trigger" => dispatch_scheduler_validate_trigger(&args),
        "scheduler_parse_interval" => dispatch_scheduler_parse_interval(&args),

        // ── Scheduler: Lock & Status (no repo needed) ──────────────────────
        "scheduler_get_lock_status" => dispatch_scheduler_lock_status(),
        "scheduler_acquire_lock" => dispatch_scheduler_acquire_lock(),
        "scheduler_release_lock" => dispatch_scheduler_release_lock(),
        "scheduler_get_status" => dispatch_scheduler_get_status(),

        // ── Scheduler: Templates ───────────────────────────────────────────
        "scheduler_list_templates" => dispatch_scheduler_list_templates(&state, &args),
        "scheduler_get_template" => dispatch_scheduler_get_template(&state, &args),
        "scheduler_create_template" => dispatch_scheduler_create_template(&state, &args),
        "scheduler_update_template" => dispatch_scheduler_update_template(&state, &args),
        "scheduler_delete_template" => dispatch_scheduler_delete_template(&state, &args),
        "scheduler_toggle_template" => dispatch_scheduler_toggle_template(&state, &args),
        "scheduler_build_prompt" => dispatch_scheduler_build_prompt(&state, &args),

        // ── Integrations ───────────────────────────────────────────────────
        "list_integration_instances" => dispatch_list_integration_instances(&state).await,
        "list_integration_instances_by_platform" => {
            dispatch_list_integration_instances_by_platform(&state, &args).await
        }
        "get_active_integration_instance" => {
            dispatch_get_active_integration_instance(&state, &args).await
        }

        // ── Context Memory ─────────────────────────────────────────────────
        "context_get_all" => dispatch_context_get_all(&state, &args),

        // ── Config helpers ─────────────────────────────────────────────────
        "set_work_dir" => dispatch_set_work_dir(&state, &args),
        "set_claude_cmd" => dispatch_set_claude_cmd(&state, &args).await,
        "reset_cli_config" => dispatch_reset_cli_config(&state).await,

        // ── File Explorer ──────────────────────────────────────────────────
        "read_directory" => dispatch_read_directory(&args).await,
        "get_file_content" => dispatch_get_file_content(&args).await,
        "create_file" => dispatch_create_file(&args).await,
        "create_directory" => dispatch_create_directory(&args).await,
        "delete_file" => dispatch_delete_file(&args).await,
        "rename_file" => dispatch_rename_file(&args).await,
        "copy_path" => dispatch_copy_path(&args).await,
        "move_path" => dispatch_move_path(&args).await,
        "search_files" => dispatch_search_files(&args).await,
        "search_file_contents" => dispatch_search_file_contents(&args).await,
        "read_commands" => dispatch_read_commands(&args).await,

        // ── Git ──────────────────────────────────────────────────────────────
        "git_is_repository" => dispatch_git_is_repository(&args),
        "git_get_status" => dispatch_git_get_status(&args),
        "git_get_diffs" => dispatch_git_get_diffs(&args),
        "git_get_log" => dispatch_git_get_log(&args),
        "git_get_commit_details" => dispatch_git_get_commit_details(&args),
        "git_get_file_history" => dispatch_git_get_file_history(&args),
        "git_init_repository" => dispatch_git_init_repository(&args),
        "git_commit_changes" => dispatch_git_commit_changes(&args).await,
        "git_create_branch" => dispatch_git_create_branch(&args),
        "git_rename_branch" => dispatch_git_rename_branch(&args),
        "git_create_tag" => dispatch_git_create_tag(&args),
        "git_merge_branch" => dispatch_git_merge_branch(&args),
        "git_add_remote" => dispatch_git_add_remote(&args),
        "git_push_branch" => dispatch_git_push_branch(&args),
        "git_push_set_upstream" => dispatch_git_push_set_upstream(&args),
        "git_batch_stage" => dispatch_git_batch_stage(&args),
        "git_stash_save" => dispatch_git_stash_save(&args),
        "git_save_gitignore" => dispatch_git_save_gitignore(&args),
        "git_add_to_gitignore" => dispatch_git_add_to_gitignore(&args),
        "git_create_pr" => dispatch_git_create_pr(&args).await,
        "git_pull" => dispatch_git_pull(&args).await,
        "git_get_gitignore_templates" => dispatch_get_gitignore_templates(),
        // Git simple1 (workspacePath only)
        "git_get_branches" => dispatch_git_simple1("git_get_branches", &args, crate::commands::git::git_get_branches),
        "git_get_tags" => dispatch_git_simple1("git_get_tags", &args, crate::commands::git::git_get_tags),
        "git_get_remotes" => dispatch_git_simple1("git_get_remotes", &args, crate::commands::git::git_get_remotes),
        "git_get_stash_list" | "git_stash_list" => dispatch_git_simple1("git_stash_list", &args, crate::commands::git::git_stash_list),
        "git_get_worktree_diff" => dispatch_git_simple1("git_get_worktree_diff", &args, crate::commands::git::git_get_worktree_diff),
        "git_get_index_diff" => dispatch_git_simple1("git_get_index_diff", &args, crate::commands::git::git_get_index_diff),
        "git_get_gitignore" => dispatch_git_simple1("git_get_gitignore", &args, crate::commands::git::git_get_gitignore),
        "git_rebase_abort" => dispatch_git_simple1("git_rebase_abort", &args, crate::commands::git::git_rebase_abort),
        "git_rebase_continue" => dispatch_git_simple1("git_rebase_continue", &args, crate::commands::git::git_rebase_continue),
        "git_cherry_pick_abort" => dispatch_git_simple1("git_cherry_pick_abort", &args, crate::commands::git::git_cherry_pick_abort),
        "git_cherry_pick_continue" => dispatch_git_simple1("git_cherry_pick_continue", &args, crate::commands::git::git_cherry_pick_continue),
        "git_revert_abort" => dispatch_git_simple1("git_revert_abort", &args, crate::commands::git::git_revert_abort),
        "git_revert_continue" => dispatch_git_simple1("git_revert_continue", &args, crate::commands::git::git_revert_continue),
        // Git simple2 (workspacePath + one string arg)
        "git_checkout_branch" => dispatch_git_simple2("git_checkout_branch", &args, crate::commands::git::git_checkout_branch),
        "git_delete_branch" => dispatch_git_delete_branch(&args),
        "git_delete_tag" => dispatch_git_simple2("git_delete_tag", &args, crate::commands::git::git_delete_tag),
        "git_remove_remote" => dispatch_git_simple2("git_remove_remote", &args, crate::commands::git::git_remove_remote),
        "git_stage_file" => dispatch_git_simple2("git_stage_file", &args, crate::commands::git::git_stage_file),
        "git_unstage_file" => dispatch_git_simple2("git_unstage_file", &args, crate::commands::git::git_unstage_file),
        "git_discard_changes" => dispatch_git_simple2("git_discard_changes", &args, crate::commands::git::git_discard_changes),
        "git_rebase_branch" => dispatch_git_simple2("git_rebase_branch", &args, crate::commands::git::git_rebase_branch),
        "git_cherry_pick" => dispatch_git_simple2("git_cherry_pick", &args, crate::commands::git::git_cherry_pick),
        "git_revert" => dispatch_git_simple2("git_revert", &args, crate::commands::git::git_revert),
        "git_get_worktree_file_diff" => dispatch_git_simple2("git_get_worktree_file_diff", &args, crate::commands::git::git_get_worktree_file_diff),
        "git_get_index_file_diff" => dispatch_git_simple2("git_get_index_file_diff", &args, crate::commands::git::git_get_index_file_diff),
        // Git commands with custom dispatch
        "git_stash_pop" => dispatch_git_stash_pop(&args),
        "git_stash_drop" => dispatch_git_stash_drop(&args),
        "git_blame_file" => dispatch_git_simple2("git_blame_file", &args, crate::commands::git::git_blame_file),
        "git_get_pr_status" => dispatch_git_get_pr_status(&args),
        "git_detect_host" => dispatch_git_detect_host(&args),
        cmd if cmd.starts_with("git_") => {
            Err(WebError::NotFound(format!("Git command not supported via HTTP: {}", cmd)))
        }

        // ── Todo ──────────────────────────────────────────────────────────────
        "list_todos" => dispatch_list_todos(&state, &args),
        "create_todo" => dispatch_create_todo(&state, &args),
        "update_todo" => dispatch_update_todo(&state, &args),
        "delete_todo" => dispatch_delete_todo(&state, &args),
        "start_todo" => dispatch_start_todo(&state, &args),
        "complete_todo" => dispatch_complete_todo(&state, &args),
        "get_todo_workspace_breakdown" => dispatch_todo_workspace_breakdown(&state, &args),

        // ── Requirement ───────────────────────────────────────────────────────
        "list_requirements" => dispatch_list_requirements(&state, &args),
        "create_requirement" => dispatch_create_requirement(&state, &args),
        "update_requirement" => dispatch_update_requirement(&state, &args),
        "delete_requirement" => dispatch_delete_requirement(&state, &args),
        "save_requirement_prototype" => dispatch_save_requirement_prototype(&state, &args),
        "read_requirement_prototype" => dispatch_read_requirement_prototype(&state, &args),
        "get_requirement_workspace_breakdown" => dispatch_requirement_workspace_breakdown(&state, &args),

        // ── Scheduler: Run & Protocol ─────────────────────────────────────────
        "scheduler_run_task" => dispatch_scheduler_run_task(&state, &args).await,
        "scheduler_update_run_status" => dispatch_scheduler_update_run_status(&state, &args).await,
        "scheduler_start" => dispatch_scheduler_start(&state).await,
        "scheduler_stop" => dispatch_scheduler_stop(&state).await,
        "scheduler_read_protocol_documents" => Ok(Json(serde_json::json!([]))),
        "scheduler_build_protocol_prompt" => Ok(Json(Value::String(String::new()))),

        // ── Other commands ────────────────────────────────────────────────────
        "auto_mode_config" => dispatch_auto_mode_config(&state),
        "auto_mode_defaults" => dispatch_auto_mode_defaults(&state),
        "cli_get_agents" => dispatch_cli_get_agents(&state),
        "cli_get_auth_status" => dispatch_cli_get_auth_status(&state),
        "cli_get_version" => dispatch_cli_get_version(&state),
        "cli_check_installed" => dispatch_cli_check_installed(&args),
        "cli_find_paths" => dispatch_cli_find_paths(&args),
        "cli_get_version_for" => dispatch_cli_get_version_for(&args),
        "baidu_translate" => dispatch_baidu_translate(&args).await,
        "find_claude_paths" => dispatch_find_claude_paths(),
        "validate_claude_path" => dispatch_validate_claude_path(&args),
        "detect_claude" => dispatch_detect_claude(&state),
        "read_claude_settings" => dispatch_read_claude_settings().await,
        "write_claude_settings" => dispatch_write_claude_settings(&args).await,
        "get_claude_settings_path" => dispatch_get_claude_settings_path().await,
        "write_file_absolute" => dispatch_write_file_absolute(&args),
        "read_file_absolute" => dispatch_read_file_absolute(&args),

        // ── File Watcher ──────────────────────────────────────────────────
        "fs_watch_start" => {
            // File watcher requires Tauri AppHandle for event emission;
            // not functional in pure web mode. Return OK to avoid 404 errors.
            tracing::debug!("[Web:IPC] fs_watch_start: no-op in web mode (no AppHandle)");
            Ok(Json(serde_json::json!({ "status": "ok" })))
        }
        "fs_watch_stop" => dispatch_fs_watch_stop(&state),

        // ── MCP Manager ────────────────────────────────────────────────────
        "mcp_list_servers" => dispatch_mcp_list_servers(&state, &args),
        "mcp_health_check" => dispatch_mcp_health_check(&state),
        "mcp_health_check_one" => dispatch_mcp_health_check_one(&state, &args),
        "mcp_add_server" => dispatch_mcp_add_server(&state, &args),
        "mcp_remove_server" => dispatch_mcp_remove_server(&state, &args),

        // ── Terminal ───────────────────────────────────────────────────────
        "terminal_create" => dispatch_terminal_create(&state, &args),
        "terminal_write" => dispatch_terminal_write(&state, &args),
        "terminal_resize" => dispatch_terminal_resize(&state, &args),
        "terminal_close" => dispatch_terminal_close(&state, &args),
        "terminal_list" => dispatch_terminal_list(&state),
        "terminal_get" => dispatch_terminal_get(&state, &args),
        "terminal_discover_scripts" => dispatch_terminal_discover_scripts(&args).await,

        // ── Network ──────────────────────────────────────────────────────
        "get_local_ips" => dispatch_get_local_ips(),
        "get_web_server_status" => dispatch_get_web_server_status(&state).await,

        // ── Chat session liveness（Web 断线重连状态恢复） ────────────────────
        "is_chat_session_running" => dispatch_is_chat_session_running(&state, &args).await,

        // ── Integration ────────────────────────────────────────────────────
        "init_integration" => Ok(Json(Value::Null)), // no-op in web mode (no AppHandle)
        "get_all_integration_status" => dispatch_get_all_integration_status(&state).await,
        "send_integration_message" => Err(WebError::BadRequest("send_integration_message requires local runtime".into())),

        // ── Plugin ─────────────────────────────────────────────────────────
        "plugin_list" => dispatch_plugin_list(&state, &args),
        "plugin_discover" => dispatch_plugin_discover(&state, &args),
        "plugin_install_locations" => dispatch_plugin_install_locations(&state, &args),
        "plugin_validate_manifest" => dispatch_plugin_validate_manifest(&args),
        "plugin_install_local" => dispatch_plugin_install_local(&state, &args),
        "plugin_install_package" => dispatch_plugin_install_package(&state, &args),
        "plugin_install_remote" => dispatch_plugin_install_remote(&state, &args).await,
        "plugin_uninstall_local" => dispatch_plugin_uninstall_local(&state, &args),
        "plugin_check_update" => dispatch_plugin_check_update(&args).await,
        "plugin_apply_update" => dispatch_plugin_apply_update(&state, &args).await,
        "plugin_state_load" => dispatch_plugin_state_load(&state),
        "plugin_state_save" => dispatch_plugin_state_save(&state, &args),

        // ── Unsupported ────────────────────────────────────────────────────
        _ => {
            tracing::debug!("[Web:IPC] Unsupported command: {}", command);
            Err(WebError::NotFound(format!(
                "Command not supported via HTTP: {}",
                command
            )))
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Convert `crate::error::Result<T>` → `Result<Json<Value>, WebError>`
macro_rules! json_result {
    ($expr:expr) => {
        match $expr {
            Ok(val) => Ok(Json(
                serde_json::to_value(val)
                    .map_err(|e| WebError::Internal(format!("Serialization error: {}", e)))?,
            )),
            Err(e) => Err(e.into()),
        }
    };
}

/// Extract a required string field from JSON args.
fn require_string(args: &Value, key: &str) -> Result<String, WebError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| WebError::BadRequest(format!("Missing required field: {}", key)))
}

/// Get the app config directory from AppState.
fn get_config_dir(state: &AppState) -> Result<std::path::PathBuf, WebError> {
    state
        .app_config_dir
        .get()
        .cloned()
        .ok_or_else(|| WebError::Internal("Config dir not set".into()))
}

/// Create a UnifiedSchedulerRepository from state and args.
fn get_scheduler_repo(state: &AppState, args: &Value) -> Result<UnifiedSchedulerRepository, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace = args
        .get("workspacePath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from);
    Ok(UnifiedSchedulerRepository::new(config_dir, workspace))
}

/// Create a PromptSnippetService from state.
fn get_snippet_service(state: &AppState) -> Result<PromptSnippetService, WebError> {
    let config_dir = get_config_dir(state)?;
    Ok(PromptSnippetService::new(&config_dir))
}

// ═══════════════════════════════════════════════════════════════════════════
// Workspace
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_validate_workspace_path(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    let p = Path::new(&path);
    let valid = p.exists() && p.is_dir();
    Ok(Json(serde_json::to_value(valid).unwrap()))
}

fn dispatch_get_home_dir() -> Result<Json<Value>, WebError> {
    let home = dirs::home_dir()
        .and_then(|p| p.to_str().map(String::from))
        .ok_or_else(|| WebError::Internal("Cannot determine home directory".into()))?;
    Ok(Json(Value::String(home)))
}

fn dispatch_get_directory_info(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    let p = Path::new(&path);
    if !p.exists() || !p.is_dir() {
        return Err(WebError::BadRequest("Path does not exist or is not a directory".into()));
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("Unknown");
    let has_git = p.join(".git").exists();
    Ok(Json(serde_json::json!({
        "name": name,
        "path": path,
        "hasGit": has_git
    })))
}

fn dispatch_path_exists(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    Ok(Json(serde_json::to_value(Path::new(&path).exists()).unwrap()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Snippets
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_snippet_list(state: &AppState) -> Result<Json<Value>, WebError> {
    let service = get_snippet_service(state)?;
    json_result!(service.list_all_snippets())
}

fn dispatch_snippet_get(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let service = get_snippet_service(state)?;
    json_result!(service.get_snippet(&id))
}

fn dispatch_snippet_create(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let params: CreateSnippetParams = serde_json::from_value(
        args.get("params").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| WebError::BadRequest(format!("Invalid snippet params: {}", e)))?;
    let service = get_snippet_service(state)?;
    json_result!(service.create_snippet(params))
}

fn dispatch_snippet_update(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let params: UpdateSnippetParams = serde_json::from_value(
        args.get("params").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| WebError::BadRequest(format!("Invalid update params: {}", e)))?;
    let service = get_snippet_service(state)?;
    json_result!(service.update_snippet(&id, params))
}

fn dispatch_snippet_delete(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let service = get_snippet_service(state)?;
    json_result!(service.delete_snippet(&id))
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Task CRUD
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_scheduler_list_tasks(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.list_tasks())
}

fn dispatch_scheduler_get_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.get_task(&id))
}

fn dispatch_scheduler_create_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let params: CreateTaskParams = serde_json::from_value(
        args.get("params").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| WebError::BadRequest(format!("Invalid create params: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.create_task(params))
}

fn dispatch_scheduler_update_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let task: ScheduledTask = serde_json::from_value(
        args.get("task").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| WebError::BadRequest(format!("Invalid task: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.update_task(
        &task.id,
        TaskUpdateParams {
            name: Some(task.name),
            enabled: Some(task.enabled),
            trigger_type: Some(task.trigger_type),
            trigger_value: Some(task.trigger_value),
            engine_id: Some(task.engine_id),
            prompt: Some(task.prompt),
            work_dir: task.work_dir,
            description: task.description,
            mode: Some(task.mode),
            category: Some(task.category),
            mission: task.mission,
            template_id: task.template_id,
            template_params: task.template_params,
            max_runs: task.max_runs,
            current_runs: Some(task.current_runs),
            max_retries: task.max_retries,
            retry_count: Some(task.retry_count),
            retry_interval: task.retry_interval,
            timeout_minutes: task.timeout_minutes,
            group: task.group,
            notify_on_complete: Some(task.notify_on_complete),
            ..Default::default()
        }
    ))
}

fn dispatch_scheduler_delete_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.delete_task(&id))
}

fn dispatch_scheduler_toggle_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let enabled = args
        .get("enabled")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| WebError::BadRequest("Missing 'enabled' field".into()))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.toggle_task(&id, enabled))
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Listing helpers
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_scheduler_list_by_category(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let category_str = require_string(args, "category")?;
    let category: TaskCategory = serde_json::from_value(Value::String(category_str))
        .map_err(|e| WebError::BadRequest(format!("Invalid category: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.list_tasks_by_category(category))
}

fn dispatch_scheduler_list_by_mode(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let mode_str = require_string(args, "mode")?;
    let mode: TaskMode = serde_json::from_value(Value::String(mode_str))
        .map_err(|e| WebError::BadRequest(format!("Invalid mode: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.list_tasks_by_mode(mode))
}

fn dispatch_scheduler_list_by_group(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let group = require_string(args, "group")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.list_tasks_by_group(&group))
}

fn dispatch_scheduler_workspace_breakdown(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.get_workspace_breakdown())
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Utility
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_scheduler_validate_trigger(args: &Value) -> Result<Json<Value>, WebError> {
    let trigger_type_str = require_string(args, "triggerType")?;
    let trigger_value = require_string(args, "triggerValue")?;
    let trigger_type: crate::models::scheduler::TriggerType = serde_json::from_value(Value::String(trigger_type_str))
        .map_err(|e| WebError::BadRequest(format!("Invalid triggerType: {}", e)))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let result = trigger_type.calculate_next_run(&trigger_value, now);
    Ok(Json(serde_json::json!(result)))
}

fn dispatch_scheduler_parse_interval(args: &Value) -> Result<Json<Value>, WebError> {
    let value = require_string(args, "value")?;
    let result = crate::models::scheduler::parse_interval(&value);
    Ok(Json(serde_json::to_value(result).unwrap()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Lock & Status
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_scheduler_lock_status() -> Result<Json<Value>, WebError> {
    let status = crate::utils::get_lock_status();
    Ok(Json(serde_json::to_value(LockStatus {
        is_holder: status.is_holder,
        is_locked_by_other: status.is_locked_by_other,
        pid: std::process::id(),
    })
    .unwrap()))
}

fn dispatch_scheduler_acquire_lock() -> Result<Json<Value>, WebError> {
    let acquired = crate::utils::acquire_and_hold_lock()
        .map_err(|e| WebError::Internal(format!("Lock error: {}", e)))?;
    Ok(Json(Value::Bool(acquired)))
}

fn dispatch_scheduler_release_lock() -> Result<Json<Value>, WebError> {
    let _ = crate::utils::release_held_lock();
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

fn dispatch_scheduler_get_status() -> Result<Json<Value>, WebError> {
    use crate::commands::scheduler::SchedulerStatus;
    let lock_status = crate::utils::get_lock_status();
    let pid = std::process::id();
    let status = SchedulerStatus {
        is_running: lock_status.is_holder,
        is_holder: lock_status.is_holder,
        is_locked_by_other: lock_status.is_locked_by_other,
        pid,
        message: None,
    };
    Ok(Json(serde_json::to_value(status).unwrap()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Templates
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_scheduler_list_templates(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.list_templates())
}

fn dispatch_scheduler_get_template(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.get_template(&id))
}

fn dispatch_scheduler_create_template(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CreateTemplateRequest {
        name: String,
        content: String,
        description: Option<String>,
        enabled: Option<bool>,
    }
    let req: CreateTemplateRequest = serde_json::from_value(args.clone())
        .map_err(|e| WebError::BadRequest(format!("Invalid template: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    let params = crate::models::scheduler::CreateTemplateParams {
        name: req.name,
        content: req.content,
        description: req.description,
        enabled: req.enabled.unwrap_or(true),
    };
    json_result!(repo.create_template(params))
}

fn dispatch_scheduler_update_template(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let template: PromptTemplate = serde_json::from_value(args.get("template").cloned().unwrap_or(Value::Null))
        .map_err(|e| WebError::BadRequest(format!("Invalid template: {}", e)))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.update_template(template))
}

fn dispatch_scheduler_delete_template(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.delete_template(&id))
}

fn dispatch_scheduler_toggle_template(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let enabled = args
        .get("enabled")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| WebError::BadRequest("Missing 'enabled' field".into()))?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.toggle_template(&id, enabled))
}

fn dispatch_scheduler_build_prompt(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let template_id = require_string(args, "templateId")?;
    let task_name = require_string(args, "taskName")?;
    let user_prompt = require_string(args, "userPrompt")?;
    let repo = get_scheduler_repo(state, args)?;
    json_result!(repo.build_prompt_with_template(&template_id, &task_name, &user_prompt))
}

// ═══════════════════════════════════════════════════════════════════════════
// Integrations
// ═══════════════════════════════════════════════════════════════════════════

async fn dispatch_list_integration_instances(state: &AppState) -> Result<Json<Value>, WebError> {
    let manager = state.integration_manager.lock().await;
    let instances = manager.list_instances().await;
    Ok(Json(serde_json::to_value(instances).map_err(|e| {
        WebError::Internal(format!("Serialization error: {}", e))
    })?))
}

async fn dispatch_list_integration_instances_by_platform(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let platform_str = require_string(args, "platform")?;
    let platform: crate::integrations::types::Platform = platform_str
        .parse()
        .map_err(|e: String| WebError::BadRequest(format!("Invalid platform: {}", e)))?;
    let manager = state.integration_manager.lock().await;
    let instances = manager.list_instances_by_platform(platform).await;
    Ok(Json(serde_json::to_value(instances).map_err(|e| {
        WebError::Internal(format!("Serialization error: {}", e))
    })?))
}

async fn dispatch_get_active_integration_instance(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let platform_str = require_string(args, "platform")?;
    let platform: crate::integrations::types::Platform = platform_str
        .parse()
        .map_err(|e: String| WebError::BadRequest(format!("Invalid platform: {}", e)))?;
    let manager = state.integration_manager.lock().await;
    let instance = manager.get_active_instance(platform).await;
    Ok(Json(serde_json::to_value(instance).map_err(|e| {
        WebError::Internal(format!("Serialization error: {}", e))
    })?))
}

async fn dispatch_get_all_integration_status(state: &AppState) -> Result<Json<Value>, WebError> {
    let manager = state.integration_manager.lock().await;
    let statuses: std::collections::HashMap<String, _> = manager
        .all_status()
        .await
        .into_iter()
        .map(|(p, s)| (p.to_string(), s))
        .collect();
    Ok(Json(serde_json::to_value(statuses).map_err(|e| {
        WebError::Internal(format!("Serialization error: {}", e))
    })?))
}

// ═══════════════════════════════════════════════════════════════════════════
// Context Memory
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_context_get_all(_state: &AppState, _args: &Value) -> Result<Json<Value>, WebError> {
    // ContextMemoryStore is an IDE-specific in-memory feature (Tauri managed state),
    // not accessible from web mode. Return empty list.
    Ok(Json(serde_json::json!([])))
}

// ═══════════════════════════════════════════════════════════════════════════
// Config helpers
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_set_work_dir(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let path: Option<String> = args.get("path")
        .and_then(|v| v.as_str())
        .map(String::from);
    let mut store = state.lock_config()?;
    let mut config = store.get().clone();
    config.work_dir = path.map(std::path::PathBuf::from);
    store.update(config).map_err(|e| WebError::Internal(e.to_string()))?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn dispatch_set_claude_cmd(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let cmd = require_string(args, "cmd")?;
    let next_config = {
        let mut store = state.lock_config()?;
        store
            .set_claude_cmd(cmd)
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().clone()
    };
    let mut registry = state.engine_registry.lock().await;
    registry.refresh_all_configs(next_config);
    drop(registry);
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn dispatch_reset_cli_config(state: &AppState) -> Result<Json<Value>, WebError> {
    let next_config = {
        let mut store = state.lock_config()?;
        let mut config = store.get().clone();
        config.claude_code.cli_path = "claude".to_string();
        config.codex_code.cli_path = "codex".to_string();
        store
            .update(config)
            .map_err(|e| WebError::Internal(e.to_string()))?;
        store.get().clone()
    };
    let mut registry = state.engine_registry.lock().await;
    registry.refresh_all_configs(next_config.clone());
    drop(registry);
    Ok(Json(serde_json::json!({ "status": "ok", "config": next_config })))
}

// ═══════════════════════════════════════════════════════════════════════════
// File Explorer — delegate to command functions directly
// ═══════════════════════════════════════════════════════════════════════════

async fn dispatch_read_directory(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    json_result!(crate::commands::file_explorer::read_directory(path).await)
}

async fn dispatch_get_file_content(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    json_result!(crate::commands::file_explorer::get_file_content(path).await)
}

async fn dispatch_create_file(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    let content = args.get("content").and_then(|v| v.as_str()).map(String::from);
    json_result!(crate::commands::file_explorer::create_file(path, content).await)
}

async fn dispatch_create_directory(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    json_result!(crate::commands::file_explorer::create_directory(path).await)
}

async fn dispatch_delete_file(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path")?;
    json_result!(crate::commands::file_explorer::delete_file(path).await)
}

async fn dispatch_rename_file(args: &Value) -> Result<Json<Value>, WebError> {
    let old_path = require_string(args, "oldPath")?;
    let new_name = require_string(args, "newName")?;
    json_result!(crate::commands::file_explorer::rename_file(old_path, new_name).await)
}

async fn dispatch_copy_path(args: &Value) -> Result<Json<Value>, WebError> {
    let source = require_string(args, "source")?;
    let destination = require_string(args, "destination")?;
    json_result!(crate::commands::file_explorer::copy_path(source, destination).await)
}

async fn dispatch_move_path(args: &Value) -> Result<Json<Value>, WebError> {
    let source = require_string(args, "source")?;
    let destination = require_string(args, "destination")?;
    json_result!(crate::commands::file_explorer::move_path(source, destination).await)
}

async fn dispatch_search_files(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path").or_else(|_| require_string(args, "workDir"))?;
    let query = require_string(args, "query")?;
    let max_results = args.get("maxDepth").or_else(|| args.get("maxResults")).and_then(|v| v.as_u64()).map(|n| n as usize);
    json_result!(crate::commands::file_explorer::search_files(path, query, max_results).await)
}

async fn dispatch_search_file_contents(args: &Value) -> Result<Json<Value>, WebError> {
    let path = require_string(args, "path").or_else(|_| require_string(args, "workDir"))?;
    let query = require_string(args, "query")?;
    let case_sensitive = args.get("caseSensitive").and_then(|v| v.as_bool());
    let whole_word = args.get("wholeWord").and_then(|v| v.as_bool());
    let max_results = args.get("maxResults").and_then(|v| v.as_u64()).map(|n| n as usize);
    json_result!(crate::commands::file_explorer::search_file_contents(path, query, case_sensitive, whole_word, max_results).await)
}

async fn dispatch_read_commands(args: &Value) -> Result<Json<Value>, WebError> {
    let work_dir = args.get("workDir").and_then(|v| v.as_str()).map(String::from);
    json_result!(crate::commands::file_explorer::read_commands(work_dir).await)
}

// ═══════════════════════════════════════════════════════════════════════════
// Git — generic helpers for common patterns
// ═══════════════════════════════════════════════════════════════════════════

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
    // Try common second-arg names
    let arg2_key = ["filePath", "name", "commitSha", "sourceBranch", "remoteName", "url", "branch"]
        .iter().find(|&&k| args.get(k).is_some()).copied().unwrap_or("name");
    let arg2 = require_string(args, arg2_key)?;
    let r = f(wp, arg2).map_err(git_err)?;
    Ok(Json(serde_json::to_value(r).unwrap_or_default()))
}

fn dispatch_git_is_repository(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    Ok(Json(Value::Bool(crate::commands::git::git_is_repository(wp).map_err(git_err)?)))
}

fn dispatch_git_get_status(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_status(wp).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_get_diffs(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let base = require_string(args, "baseCommit")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_diffs(wp, base).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_get_log(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let limit = args
        .get("limit")
        .or_else(|| args.get("maxCount"))
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);
    let skip = args.get("skip").and_then(|v| v.as_u64()).map(|n| n as usize);
    let branch = args.get("branch").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_log(wp, limit, skip, branch).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_get_commit_details(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let commit_sha = require_string(args, "commitSha")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_commit_details(wp, commit_sha).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_get_file_history(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let file_path = require_string(args, "filePath")?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    let skip = args.get("skip").and_then(|v| v.as_u64()).map(|n| n as usize);
    let branch = args.get("branch").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_file_history(wp, file_path, limit, skip, branch).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_init_repository(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let ib = args.get("initialBranch").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_init_repository(wp, ib).map_err(git_err)?).unwrap_or_default()))
}

async fn dispatch_git_commit_changes(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let msg = require_string(args, "message")?;
    let stage_all = args.get("stageAll").and_then(|v| v.as_bool()).unwrap_or(false);
    let files = args.get("selectedFiles").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>());
    Ok(Json(serde_json::to_value(crate::commands::git::git_commit_changes(wp, msg, stage_all, files).await.map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_create_branch(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let name = require_string(args, "name")?;
    let checkout = args.get("checkout").and_then(|v| v.as_bool()).unwrap_or(true);
    Ok(Json(serde_json::to_value(crate::commands::git::git_create_branch(wp, name, checkout).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_rename_branch(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let old = require_string(args, "oldName")?;
    let new = require_string(args, "newName")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_rename_branch(wp, old, new).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_create_tag(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let name = require_string(args, "name")?;
    let commitish = args.get("commitish").and_then(|v| v.as_str()).map(String::from);
    let message = args.get("message").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_create_tag(wp, name, commitish, message).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_merge_branch(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let src = require_string(args, "sourceBranch")?;
    let no_ff = args.get("noFF").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(Json(serde_json::to_value(crate::commands::git::git_merge_branch(wp, src, no_ff).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_add_remote(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let name = require_string(args, "name")?;
    let url = require_string(args, "url")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_add_remote(wp, name, url).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_push_branch(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let branch = require_string(args, "branchName")?;
    let remote = args.get("remoteName").and_then(|v| v.as_str()).unwrap_or("origin");
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let remote_branch = args.get("remoteBranchName").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_push_branch(wp, branch, remote.to_string(), force, remote_branch).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_push_set_upstream(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let branch = require_string(args, "branchName")?;
    let remote = args.get("remoteName").and_then(|v| v.as_str()).unwrap_or("origin");
    let remote_branch = args.get("remoteBranchName").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::git::git_push_set_upstream(wp, branch, remote.to_string(), remote_branch).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_batch_stage(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let files = args.get("filePaths").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
    Ok(Json(serde_json::to_value(crate::commands::git::git_batch_stage(wp, files).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_stash_save(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let msg = args.get("message").and_then(|v| v.as_str()).map(String::from);
    let include_untracked = args.get("includeUntracked").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(Json(serde_json::to_value(crate::commands::git::git_stash_save(wp, msg, include_untracked).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_delete_branch(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let name = require_string(args, "name")?;
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(Json(serde_json::to_value(crate::commands::git::git_delete_branch(wp, name, force).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_save_gitignore(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let content = require_string(args, "content")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_save_gitignore(wp, content).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_add_to_gitignore(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let rules = args.get("rules").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
    Ok(Json(serde_json::to_value(crate::commands::git::git_add_to_gitignore(wp, rules).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_get_gitignore_templates() -> Result<Json<Value>, WebError> {
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_gitignore_templates()).unwrap_or_default()))
}

async fn dispatch_git_create_pr(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let options: crate::models::git::CreatePROptions = serde_json::from_value(args.get("options").cloned().unwrap_or(Value::Null))
        .map_err(|e| WebError::BadRequest(format!("Invalid PR options: {}", e)))?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_create_pr(wp, options).map_err(git_err)?).unwrap_or_default()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Todo — uses UnifiedTodoRepository
// ═══════════════════════════════════════════════════════════════════════════

fn get_todo_repo(state: &AppState, args: &Value) -> Result<crate::services::unified_todo_repository::UnifiedTodoRepository, WebError> {
    let config_dir = get_config_dir(state)?;
    let wp = args.get("workspacePath")
        .or_else(|| args.get("params").and_then(|p| p.get("workspacePath")))
        .and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(std::path::PathBuf::from);
    let repo = crate::services::unified_todo_repository::UnifiedTodoRepository::new(config_dir, wp);
    repo.register_workspace().ok();
    Ok(repo)
}

/// Extract a required string field from args, checking both top-level and nested `params`.
fn todo_string(args: &Value, key: &str) -> Result<String, WebError> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
        .or_else(|| args.get("params").and_then(|p| p.get(key)).and_then(|v| v.as_str()).map(String::from))
        .ok_or_else(|| WebError::BadRequest(format!("Missing required field: {}", key)))
}

/// Extract an optional string field from args, checking both top-level and nested `params`.
fn todo_opt_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
        .or_else(|| args.get("params").and_then(|p| p.get(key)).and_then(|v| v.as_str()).map(String::from))
}

fn dispatch_list_todos(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_todo_repo(state, args)?;
    let scope = match args.get("scope").and_then(|v| v.as_str()).unwrap_or("workspace") {
        "all" => crate::models::todo::QueryScope::All, _ => crate::models::todo::QueryScope::Workspace,
    };
    let mut todos = repo.list_todos(scope)?;
    if let Some(s) = args.get("status").and_then(|v| v.as_str()) {
        if let Ok(st) = serde_json::from_value(serde_json::Value::String(s.to_string())) {
            todos.retain(|t| t.status == st);
        }
    }
    if let Some(p) = args.get("priority").and_then(|v| v.as_str()) {
        if let Ok(pr) = serde_json::from_value(serde_json::Value::String(p.to_string())) {
            todos.retain(|t| t.priority == pr);
        }
    }
    if let Some(l) = args.get("limit").and_then(|v| v.as_u64()) { todos.truncate(l as usize); }
    Ok(Json(serde_json::to_value(todos).unwrap_or_default()))
}

fn dispatch_create_todo(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let _repo = get_todo_repo(state, args)?;
    let params: crate::commands::todo::CreateTodoParams = serde_json::from_value(args.get("params").cloned().unwrap_or(Value::Null))
        .map_err(|e| WebError::BadRequest(format!("Invalid params: {}", e)))?;
    let priority = params.priority
        .and_then(|p| serde_json::from_value(serde_json::Value::String(p)).ok())
        .unwrap_or_default();
    let wp = params.workspace_path.clone()
        .filter(|p| !p.trim().is_empty())
        .map(std::path::PathBuf::from);
    let repo = crate::services::unified_todo_repository::UnifiedTodoRepository::new(get_config_dir(state)?, wp);
    if params.workspace_path.is_some() { repo.register_workspace().ok(); }
    let cp = crate::models::todo::TodoCreateParams {
        content: params.content, description: params.description, priority: Some(priority),
        tags: params.tags, related_files: params.related_files, due_date: params.due_date,
        estimated_hours: params.estimated_hours,
        subtasks: params.subtasks.map(|i| i.into_iter().map(|s| crate::models::todo::TodoCreateSubtask { title: s.title }).collect()),
        ..Default::default()
    };
    json_result!(repo.create_todo(cp))
}

fn dispatch_update_todo(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_todo_repo(state, args)?;
    let params: crate::commands::todo::UpdateTodoParams = serde_json::from_value(args.get("params").cloned().unwrap_or(Value::Null))
        .map_err(|e| WebError::BadRequest(format!("Invalid params: {}", e)))?;
    let status = params.status.and_then(|s| serde_json::from_value(serde_json::Value::String(s)).ok());
    let priority = params.priority.and_then(|p| serde_json::from_value(serde_json::Value::String(p)).ok());
    let up = crate::models::todo::TodoUpdateParams {
        content: params.content, description: params.description,
        status, priority,
        tags: params.tags, related_files: params.related_files, due_date: params.due_date,
        estimated_hours: params.estimated_hours, spent_hours: params.spent_hours,
        last_progress: params.last_progress, last_error: params.last_error,
        ..Default::default()
    };
    json_result!(repo.update_todo(&params.id, up))
}

fn dispatch_delete_todo(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = todo_string(args, "id")?;
    json_result!(get_todo_repo(state, args)?.delete_todo(&id))
}
fn dispatch_start_todo(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = todo_string(args, "id")?;
    let p = todo_opt_string(args, "lastProgress");
    json_result!(get_todo_repo(state, args)?.update_todo(&id, crate::models::todo::TodoUpdateParams {
        status: Some(crate::models::todo::TodoStatus::InProgress),
        last_progress: p,
        ..Default::default()
    }))
}
fn dispatch_complete_todo(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = todo_string(args, "id")?;
    let p = todo_opt_string(args, "lastProgress");
    json_result!(get_todo_repo(state, args)?.update_todo(&id, crate::models::todo::TodoUpdateParams {
        status: Some(crate::models::todo::TodoStatus::Completed),
        last_progress: p,
        ..Default::default()
    }))
}
fn dispatch_todo_workspace_breakdown(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    json_result!(get_todo_repo(state, args)?.get_workspace_breakdown())
}

// ═══════════════════════════════════════════════════════════════════════════
// Requirement
// ═══════════════════════════════════════════════════════════════════════════

fn get_req_repo(state: &AppState, args: &Value) -> Result<crate::services::unified_requirement_repository::UnifiedRequirementRepository, WebError> {
    let config_dir = get_config_dir(state)?;
    // Frontend wraps args in { params: { workspacePath, ... } }
    let wp = args.get("workspacePath")
        .or_else(|| args.get("params").and_then(|p| p.get("workspacePath")))
        .and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(std::path::PathBuf::from);
    let repo = crate::services::unified_requirement_repository::UnifiedRequirementRepository::new(config_dir, wp);
    repo.register_workspace().ok();
    Ok(repo)
}

/// Extract a string field from args, checking both top-level and nested `params`.
fn req_string(args: &Value, key: &str) -> Result<String, WebError> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
        .or_else(|| args.get("params").and_then(|p| p.get(key)).and_then(|v| v.as_str()).map(String::from))
        .ok_or_else(|| WebError::BadRequest(format!("Missing required field: {}", key)))
}

fn dispatch_list_requirements(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_req_repo(state, args)?;
    let scope = match args.get("scope").and_then(|v| v.as_str()).unwrap_or("workspace") {
        "all" => crate::models::requirement::QueryScope::All, _ => crate::models::requirement::QueryScope::Workspace,
    };
    let mut reqs = repo.list_requirements(scope)?;
    if let Some(l) = args.get("limit").and_then(|v| v.as_u64()) { reqs.truncate(l as usize); }
    Ok(Json(serde_json::to_value(reqs).unwrap_or_default()))
}
fn dispatch_create_requirement(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let repo = get_req_repo(state, args)?;
    let title = require_string(args, "title")?;
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let priority = args.get("priority").and_then(|v| v.as_str())
        .and_then(|p| serde_json::from_value(serde_json::Value::String(p.to_string())).ok());
    let tags = args.get("tags").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>());
    let cp = crate::models::requirement::RequirementCreateParams {
        title, description, priority, tags,
        ..Default::default()
    };
    json_result!(repo.create_requirement(cp))
}
fn dispatch_update_requirement(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = req_string(args, "id")?;
    let repo = get_req_repo(state, args)?;
    let mut u = crate::models::requirement::RequirementUpdateParams::default();
    // Check both top-level and nested params for all fields
    if let Some(v) = req_string(args, "title").ok() { u.title = Some(v); }
    if let Some(v) = req_string(args, "description").ok() { u.description = Some(v); }
    if let Some(v) = args.get("status").or_else(|| args.get("params").and_then(|p| p.get("status"))).and_then(|v| v.as_str()) {
        u.status = serde_json::from_value(serde_json::Value::String(v.to_string())).ok();
    }
    if let Some(v) = args.get("priority").or_else(|| args.get("params").and_then(|p| p.get("priority"))).and_then(|v| v.as_str()) {
        u.priority = serde_json::from_value(serde_json::Value::String(v.to_string())).ok();
    }
    if let Some(v) = args.get("tags").or_else(|| args.get("params").and_then(|p| p.get("tags"))) { u.tags = Some(serde_json::from_value(v.clone()).unwrap_or_default()); }
    json_result!(repo.update_requirement(&id, u))
}
fn dispatch_delete_requirement(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = req_string(args, "id")?;
    json_result!(get_req_repo(state, args)?.delete_requirement(&id))
}
fn dispatch_save_requirement_prototype(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = req_string(args, "id")?;
    let html = req_string(args, "html")?;
    json_result!(get_req_repo(state, args)?.save_prototype(&id, &html))
}
fn dispatch_read_requirement_prototype(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    // Frontend sends "prototypePath" for the path to read
    let prototype_path = req_string(args, "prototypePath")?;
    let repo = get_req_repo(state, args)?;
    json_result!(repo.read_prototype(&prototype_path))
}
fn dispatch_requirement_workspace_breakdown(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    json_result!(get_req_repo(state, args)?.get_workspace_breakdown())
}


// ═══════════════════════════════════════════════════════════════════════════
// Terminal
// ═══════════════════════════════════════════════════════════════════════════

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn optional_u16(args: &Value, key: &str) -> Result<Option<u16>, WebError> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    let parsed = match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
    .ok_or_else(|| WebError::BadRequest(format!("Invalid numeric field: {}", key)))?;

    u16::try_from(parsed)
        .map(Some)
        .map_err(|_| WebError::BadRequest(format!("{} is out of range for u16", key)))
}

fn optional_string_map(args: &Value, key: &str) -> Result<Option<HashMap<String, String>>, WebError> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|error| WebError::BadRequest(format!("Invalid {} map: {}", key, error)))
}

fn dispatch_terminal_create(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let cols = optional_u16(args, "cols")?.unwrap_or(80);
    let rows = optional_u16(args, "rows")?.unwrap_or(24);
    let env = optional_string_map(args, "env")?;

    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;

    json_result!(manager.create_session(
        crate::commands::terminal::TerminalEventSink::Web(state.event_broadcast.clone()),
        optional_string(args, "name"),
        optional_string(args, "cwd"),
        cols,
        rows,
        optional_string(args, "initialCommand"),
        env,
        optional_string(args, "purpose"),
        optional_string(args, "scriptId"),
    ))
}

/// 查询聊天会话是否仍在任一引擎中运行。
///
/// Web 端断线重连（resume-gap 兜底恢复）后调用，决定前端是否恢复
/// isStreaming 状态：进程仍在 → 继续等待后续事件；已结束 → 标记完成。
async fn dispatch_is_chat_session_running(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let session_id = require_string(args, "sessionId")?;
    let registry = state.engine_registry.lock().await;
    let running = registry.is_session_active(&session_id);
    Ok(Json(serde_json::json!({ "running": running })))
}

fn dispatch_terminal_write(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let session_id = require_string(args, "sessionId")?;
    let data = require_string(args, "data")?;
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;
    json_result!(manager.write(&session_id, &data))
}

fn dispatch_terminal_resize(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let session_id = require_string(args, "sessionId")?;
    let cols = optional_u16(args, "cols")?
        .ok_or_else(|| WebError::BadRequest("Missing required field: cols".into()))?;
    let rows = optional_u16(args, "rows")?
        .ok_or_else(|| WebError::BadRequest("Missing required field: rows".into()))?;
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;
    json_result!(manager.resize(&session_id, cols, rows))
}

fn dispatch_terminal_close(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let session_id = require_string(args, "sessionId")?;
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;
    json_result!(manager.close_session(&session_id))
}

fn dispatch_terminal_list(state: &AppState) -> Result<Json<Value>, WebError> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;
    json_result!(manager.list_sessions())
}

fn dispatch_terminal_get(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let session_id = require_string(args, "sessionId")?;
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|error| WebError::Internal(error.to_string()))?;
    json_result!(manager.get_session(&session_id))
}

async fn dispatch_terminal_discover_scripts(args: &Value) -> Result<Json<Value>, WebError> {
    let workspace_path = require_string(args, "workspacePath")?;
    json_result!(crate::commands::terminal_script::terminal_discover_scripts(workspace_path).await)
}


// ═══════════════════════════════════════════════════════════════════════════
// Other common commands
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_auto_mode_config(state: &AppState) -> Result<Json<Value>, WebError> {
    let p = state.lock_config()?.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string());
    let svc = crate::services::auto_mode_service::AutoModeService::new(p);
    json_result!(svc.get_config())
}
fn dispatch_auto_mode_defaults(state: &AppState) -> Result<Json<Value>, WebError> {
    let p = state.lock_config()?.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string());
    let svc = crate::services::auto_mode_service::AutoModeService::new(p);
    json_result!(svc.get_defaults())
}
fn dispatch_cli_get_agents(state: &AppState) -> Result<Json<Value>, WebError> {
    let p = state.lock_config()?.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string());
    let svc = crate::services::cli_info_service::CliInfoService::new(p);
    json_result!(svc.get_agents())
}
fn dispatch_cli_get_auth_status(state: &AppState) -> Result<Json<Value>, WebError> {
    let p = state.lock_config()?.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string());
    let svc = crate::services::cli_info_service::CliInfoService::new(p);
    json_result!(svc.get_auth_status())
}
fn dispatch_cli_get_version(state: &AppState) -> Result<Json<Value>, WebError> {
    let p = state.lock_config()?.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string());
    let svc = crate::services::cli_info_service::CliInfoService::new(p);
    json_result!(svc.get_version())
}
fn dispatch_cli_check_installed(args: &Value) -> Result<Json<Value>, WebError> {
    let _ = args;
    Ok(Json(Value::Bool(false)))
}
fn dispatch_cli_find_paths(args: &Value) -> Result<Json<Value>, WebError> {
    let cli_name = require_string(args, "cliName")?;
    let paths = crate::services::cli_info_service::find_cli_paths(&cli_name);
    Ok(Json(serde_json::to_value(paths).unwrap_or_default()))
}
fn dispatch_cli_get_version_for(args: &Value) -> Result<Json<Value>, WebError> {
    let _ = args;
    Ok(Json(Value::Null))
}
async fn dispatch_baidu_translate(args: &Value) -> Result<Json<Value>, WebError> {
    let text = require_string(args, "text")?;
    let app_id = require_string(args, "appId")?;
    let secret_key = require_string(args, "secretKey")?;
    let to = args.get("to").and_then(|v| v.as_str()).map(String::from);
    Ok(Json(serde_json::to_value(crate::commands::translate::baidu_translate(text, app_id, secret_key, to).await).unwrap_or_default()))
}
fn dispatch_find_claude_paths() -> Result<Json<Value>, WebError> {
    Ok(Json(serde_json::to_value(crate::services::config_store::ConfigStore::find_claude_paths()).unwrap_or_default()))
}
fn dispatch_validate_claude_path(args: &Value) -> Result<Json<Value>, WebError> {
    let p = require_string(args, "path")?;
    json_result!(crate::services::config_store::ConfigStore::validate_claude_path(p))
}
fn dispatch_detect_claude(state: &AppState) -> Result<Json<Value>, WebError> {
    let store = state.lock_config()?;
    Ok(Json(serde_json::to_value(store.detect_claude()).unwrap_or_default()))
}
async fn dispatch_read_claude_settings() -> Result<Json<Value>, WebError> {
    json_result!(crate::commands::claude_settings::read_claude_settings().await)
}
async fn dispatch_get_claude_settings_path() -> Result<Json<Value>, WebError> {
    json_result!(crate::commands::claude_settings::get_claude_settings_path().await)
}
fn dispatch_write_file_absolute(args: &Value) -> Result<Json<Value>, WebError> {
    let p = require_string(args, "path")?;
    let c = require_string(args, "content")?;
    std::fs::write(&p, c).map_err(|e| WebError::Internal(e.to_string()))?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}
fn dispatch_read_file_absolute(args: &Value) -> Result<Json<Value>, WebError> {
    let p = require_string(args, "path")?;
    let c = std::fs::read_to_string(&p).map_err(|e| WebError::Internal(e.to_string()))?;
    Ok(Json(Value::String(c)))
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler: Run & Protocol (web-compatible implementations)
// ═══════════════════════════════════════════════════════════════════════════

async fn dispatch_scheduler_start(state: &AppState) -> Result<Json<Value>, WebError> {
    use crate::commands::scheduler::SchedulerStatus;
    let pid = std::process::id();

    if crate::utils::is_holding_lock() {
        return Ok(Json(serde_json::to_value(SchedulerStatus {
            is_running: true,
            is_holder: true,
            is_locked_by_other: false,
            pid,
            message: Some("调度器已在运行".to_string()),
        }).unwrap()));
    }

    match crate::utils::acquire_and_hold_lock() {
        Ok(true) => {
            let config_dir = state.app_config_dir.get()
                .cloned()
                .unwrap_or_else(|| {
                    dirs::config_dir()
                        .unwrap_or_else(|| std::path::PathBuf::from("."))
                        .join("claude-code-pro")
                });

            let event_tx = state.event_broadcast.clone();
            let mut daemon = crate::services::scheduler_daemon::SchedulerDaemon::new(config_dir, None);
            daemon.start_with_broadcast(event_tx)
                .map_err(|e| WebError::Internal(format!("启动调度器失败: {}", e)))?;

            let mut scheduler_daemon = state.scheduler_daemon.lock().await;
            *scheduler_daemon = Some(daemon);

            Ok(Json(serde_json::to_value(SchedulerStatus {
                is_running: true,
                is_holder: true,
                is_locked_by_other: false,
                pid,
                message: Some("调度器启动成功".to_string()),
            }).unwrap()))
        }
        Ok(false) => Ok(Json(serde_json::to_value(SchedulerStatus {
            is_running: false,
            is_holder: false,
            is_locked_by_other: true,
            pid,
            message: Some("无法启动：其他实例正在运行调度器".to_string()),
        }).unwrap())),
        Err(e) => Err(WebError::Internal(format!("启动调度器失败: {}", e))),
    }
}

async fn dispatch_scheduler_stop(state: &AppState) -> Result<Json<Value>, WebError> {
    use crate::commands::scheduler::SchedulerStatus;
    let pid = std::process::id();

    if !crate::utils::is_holding_lock() {
        return Ok(Json(serde_json::to_value(SchedulerStatus {
            is_running: false,
            is_holder: false,
            is_locked_by_other: crate::utils::get_lock_status().is_locked_by_other,
            pid,
            message: Some("调度器未在运行".to_string()),
        }).unwrap()));
    }

    {
        let mut scheduler_daemon = state.scheduler_daemon.lock().await;
        if let Some(mut daemon) = scheduler_daemon.take() {
            daemon.stop().ok();
        }
    }

    let _ = crate::utils::release_held_lock();

    Ok(Json(serde_json::to_value(SchedulerStatus {
        is_running: false,
        is_holder: false,
        is_locked_by_other: false,
        pid,
        message: Some("调度器已停止".to_string()),
    }).unwrap()))
}

async fn dispatch_scheduler_run_task(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let workspace_path = args.get("workspacePath").and_then(|v| v.as_str()).map(String::from);
    let workspace_path_buf = workspace_path.filter(|p| !p.trim().is_empty()).map(std::path::PathBuf::from);

    let config_dir = state.app_config_dir.get()
        .cloned()
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("claude-code-pro")
        });

    let repository = crate::services::unified_scheduler_repository::UnifiedSchedulerRepository::new(config_dir, workspace_path_buf);
    let task = repository.update_task_status(&id, crate::models::scheduler::TaskStatus::Running)
        .map_err(|e| WebError::Internal(format!("更新任务状态失败: {}", e)))?;

    Ok(Json(serde_json::to_value(task).unwrap()))
}

async fn dispatch_scheduler_update_run_status(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let id = require_string(args, "id")?;
    let status = require_string(args, "status")?;
    let workspace_path = args.get("workspacePath").and_then(|v| v.as_str()).map(String::from);
    let workspace_path_buf = workspace_path.filter(|p| !p.trim().is_empty()).map(std::path::PathBuf::from);

    let config_dir = state.app_config_dir.get()
        .cloned()
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("claude-code-pro")
        });

    let repository = crate::services::unified_scheduler_repository::UnifiedSchedulerRepository::new(config_dir, workspace_path_buf);
    let task_status = match status.as_str() {
        "success" => crate::models::scheduler::TaskStatus::Success,
        _ => crate::models::scheduler::TaskStatus::Failed,
    };
    let task = repository.update_task_status(&id, task_status)
        .map_err(|e| WebError::Internal(format!("更新任务状态失败: {}", e)))?;

    Ok(Json(serde_json::to_value(task).unwrap()))
}
fn dispatch_scheduler_read_protocol_docs(_state: &AppState, _args: &Value) -> Result<Json<Value>, WebError> {
    Ok(Json(serde_json::json!([])))
}
fn dispatch_scheduler_build_protocol_prompt(_state: &AppState, _args: &Value) -> Result<Json<Value>, WebError> {
    Ok(Json(Value::String(String::new())))
}

fn dispatch_git_pull(args: &Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Json<Value>, WebError>> + Send>> {
    let wp = match require_string(args, "workspacePath") {
        Ok(v) => v,
        Err(e) => return Box::pin(async move { Err(e) }),
    };
    let remote = args.get("remoteName").and_then(|v| v.as_str()).map(String::from);
    let branch = args.get("branchName").and_then(|v| v.as_str()).map(String::from);
    Box::pin(async move {
        Ok(Json(serde_json::to_value(crate::commands::git::git_pull(wp, remote, branch).await.map_err(git_err)?).unwrap_or_default()))
    })
}

fn dispatch_git_stash_pop(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let index = args.get("index").and_then(|v| v.as_u64()).map(|n| n as usize);
    Ok(Json(serde_json::to_value(crate::commands::git::git_stash_pop(wp, index).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_stash_drop(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let index = args.get("index").and_then(|v| v.as_u64())
        .ok_or_else(|| WebError::BadRequest("Missing required field: index".into()))? as usize;
    Ok(Json(serde_json::to_value(crate::commands::git::git_stash_drop(wp, index).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_get_pr_status(args: &Value) -> Result<Json<Value>, WebError> {
    let wp = require_string(args, "workspacePath")?;
    let pr_number = args.get("prNumber").and_then(|v| v.as_u64())
        .ok_or_else(|| WebError::BadRequest("Missing required field: prNumber".into()))?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_get_pr_status(wp, pr_number).map_err(git_err)?).unwrap_or_default()))
}

fn dispatch_git_detect_host(args: &Value) -> Result<Json<Value>, WebError> {
    let remote_url = require_string(args, "remoteUrl")?;
    Ok(Json(serde_json::to_value(crate::commands::git::git_detect_host(remote_url)).unwrap_or_default()))
}

async fn dispatch_write_claude_settings(args: &Value) -> Result<Json<Value>, WebError> {
    let settings: crate::commands::claude_settings::ClaudeSettings = serde_json::from_value(
        args.get("settings").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| WebError::BadRequest(format!("Invalid settings: {}", e)))?;
    crate::commands::claude_settings::write_claude_settings(settings)
        .await
        .map_err(|e| WebError::Internal(format!("Write settings failed: {}", e)))?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ═══════════════════════════════════════════════════════════════════════════
// File Watcher
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_fs_watch_stop(state: &AppState) -> Result<Json<Value>, WebError> {
    let mut manager = state
        .file_watcher_manager
        .lock()
        .map_err(|e| WebError::Internal(e.to_string()))?;
    manager.stop();
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ═══════════════════════════════════════════════════════════════════════════
// Plugin
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_plugin_list(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let available = args.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
    let claude_path = {
        let store = state.lock_config()?;
        store.get().claude_code.cli_path.clone()
    };
    if claude_path.is_empty() {
        return Ok(Json(serde_json::json!({ "installed": [], "available": [] })));
    }
    let service = crate::services::plugin_service::PluginService::new(claude_path);
    json_result!(service.list_plugins(available))
}

fn dispatch_plugin_discover(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = args
        .get("workspacePath")
        .and_then(|value| value.as_str())
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from);

    Ok(Json(serde_json::to_value(
        crate::services::plugin_service::PluginService::discover_installed_plugins(
            &config_dir,
            workspace_path.as_deref(),
        ),
    )
    .unwrap_or_default()))
}

fn plugin_workspace_path(args: &Value) -> Option<std::path::PathBuf> {
    args.get("workspacePath")
        .and_then(|value| value.as_str())
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from)
}

fn dispatch_plugin_install_locations(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);

    Ok(Json(serde_json::to_value(
        crate::services::plugin_service::PluginService::install_locations(
            &config_dir,
            workspace_path.as_deref(),
        ),
    )
    .unwrap_or_default()))
}

fn dispatch_plugin_validate_manifest(args: &Value) -> Result<Json<Value>, WebError> {
    let source_path = require_string(args, "sourcePath")?;
    Ok(Json(serde_json::to_value(
        crate::services::plugin_service::PluginService::validate_plugin_manifest(
            Path::new(&source_path),
        ),
    )
    .unwrap_or_default()))
}

fn dispatch_plugin_install_local(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);
    let source_path = require_string(args, "sourcePath")?;
    let scope = match args.get("scope").and_then(|value| value.as_str()) {
        Some("project") => crate::models::plugin::PluginManifestSourceKind::Project,
        _ => crate::models::plugin::PluginManifestSourceKind::User,
    };

    json_result!(crate::services::plugin_service::PluginService::install_local_plugin(
        &config_dir,
        workspace_path.as_deref(),
        Path::new(&source_path),
        scope,
    ))
}

fn dispatch_plugin_install_package(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);
    let package_path = require_string(args, "packagePath")?;
    let scope = match args.get("scope").and_then(|value| value.as_str()) {
        Some("project") => crate::models::plugin::PluginManifestSourceKind::Project,
        _ => crate::models::plugin::PluginManifestSourceKind::User,
    };

    json_result!(crate::services::plugin_service::PluginService::install_plugin_package(
        &config_dir,
        workspace_path.as_deref(),
        Path::new(&package_path),
        scope,
    ))
}

async fn dispatch_plugin_install_remote(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);
    let source_url = require_string(args, "sourceUrl")?;
    let scope = match args.get("scope").and_then(|value| value.as_str()) {
        Some("project") => crate::models::plugin::PluginManifestSourceKind::Project,
        _ => crate::models::plugin::PluginManifestSourceKind::User,
    };

    json_result!(
        crate::services::plugin_service::PluginService::install_remote_plugin(
            &config_dir,
            workspace_path.as_deref(),
            &source_url,
            scope,
        )
        .await
    )
}

fn dispatch_plugin_uninstall_local(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);
    let install_path = require_string(args, "installPath")?;

    json_result!(crate::services::plugin_service::PluginService::uninstall_local_plugin(
        &config_dir,
        workspace_path.as_deref(),
        Path::new(&install_path),
    ))
}

async fn dispatch_plugin_check_update(args: &Value) -> Result<Json<Value>, WebError> {
    let install_path = require_string(args, "installPath")?;

    Ok(Json(serde_json::to_value(
        crate::services::plugin_service::PluginService::check_local_plugin_update(
            Path::new(&install_path),
        )
        .await,
    )
    .unwrap_or_default()))
}

async fn dispatch_plugin_apply_update(
    state: &AppState,
    args: &Value,
) -> Result<Json<Value>, WebError> {
    let config_dir = get_config_dir(state)?;
    let workspace_path = plugin_workspace_path(args);
    let install_path = require_string(args, "installPath")?;

    json_result!(
        crate::services::plugin_service::PluginService::apply_local_plugin_update(
            &config_dir,
            workspace_path.as_deref(),
            Path::new(&install_path),
        )
        .await
    )
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP Manager
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_plugin_state_load(state: &AppState) -> Result<Json<Value>, WebError> {
    let service =
        crate::services::plugin_state_service::PluginStateService::new(get_config_dir(state)?);
    json_result!(service.load())
}

fn dispatch_plugin_state_save(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let states: crate::models::plugin_state::PluginStateMap =
        serde_json::from_value(args.get("states").cloned().unwrap_or(Value::Null))
            .map_err(|e| WebError::BadRequest(format!("Invalid plugin states: {}", e)))?;
    let service =
        crate::services::plugin_state_service::PluginStateService::new(get_config_dir(state)?);
    json_result!(service.save(&states))
}

fn get_mcp_service(state: &AppState) -> Result<crate::services::mcp_manager_service::McpManagerService, WebError> {
    let claude_path = {
        let store = state.lock_config()?;
        store.get().claude_cmd.clone().unwrap_or_else(|| "claude".to_string())
    };
    Ok(crate::services::mcp_manager_service::McpManagerService::new(claude_path))
}

fn dispatch_mcp_list_servers(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let service = get_mcp_service(state)?;
    let workspace_path = require_string(args, "workspacePath").unwrap_or_default();
    json_result!(service.list_servers(&workspace_path))
}

fn dispatch_mcp_health_check(state: &AppState) -> Result<Json<Value>, WebError> {
    let service = get_mcp_service(state)?;
    json_result!(service.health_check())
}

fn dispatch_mcp_health_check_one(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let name = require_string(args, "name")?;
    let service = get_mcp_service(state)?;
    json_result!(service.health_check_one(&name))
}

fn dispatch_mcp_add_server(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let _ = (state, args);
    // MCP add/remove server requires local filesystem access to config files
    Err(WebError::BadRequest("MCP server management requires local runtime".into()))
}

fn dispatch_mcp_remove_server(state: &AppState, args: &Value) -> Result<Json<Value>, WebError> {
    let _ = (state, args);
    Err(WebError::BadRequest("MCP server management requires local runtime".into()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Network
// ═══════════════════════════════════════════════════════════════════════════

fn dispatch_get_local_ips() -> Result<Json<Value>, WebError> {
    let interfaces = if_addrs::get_if_addrs()
        .map_err(|e| WebError::Internal(format!("Failed to get network interfaces: {}", e)))?;
    let mut ips: Vec<(String, u32)> = interfaces
        .into_iter()
        .filter(|iface| !iface.is_loopback() && iface.addr.ip().is_ipv4())
        .map(|iface| {
            let ip = iface.addr.ip().to_string();
            let priority = crate::ip_interface_priority(&ip, &iface.name);
            (ip, priority)
        })
        .collect();
    ips.sort_by_key(|(_, p)| *p);
    let result: Vec<String> = ips.into_iter().map(|(ip, _)| ip).collect();
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn dispatch_get_web_server_status(state: &AppState) -> Result<Json<Value>, WebError> {
    Ok(Json(serde_json::to_value(crate::current_web_server_status(state).await).unwrap_or_default()))
}
