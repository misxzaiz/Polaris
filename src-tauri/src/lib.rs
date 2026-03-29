pub mod error;
pub mod models;
pub mod services;
pub mod commands;
mod integrations;
mod ai;
mod state;
mod utils;

pub use state::AppState;
pub use error::{AppError, Result};

use models::config::{Config, HealthStatus};
use services::config_store::ConfigStore;
use services::logger::Logger;
use commands::chat::{start_chat, continue_chat, interrupt_chat};
use commands::chat::{
    list_sessions, get_session_history, delete_session,
    list_iflow_sessions, get_iflow_session_history,
    get_iflow_file_contexts, get_iflow_token_stats,
    list_claude_code_sessions, get_claude_code_session_history,
    find_codex_paths, validate_codex_path,
    list_codex_sessions, get_codex_session_history,
    register_pending_question, answer_question, get_pending_questions, clear_answered_questions,
    // PlanMode 相关
    register_pending_plan, approve_plan, reject_plan, get_pending_plans, clear_processed_plans,
    // stdin 输入
    send_input,
};
use commands::{validate_workspace_path, get_directory_info, get_home_dir};
use commands::window::{
    toggle_devtools,
    set_always_on_top,
    is_always_on_top,
};
use commands::file_explorer::{
    read_directory, get_file_content, create_file, create_directory,
    delete_file, rename_file, path_exists, read_commands, search_files,
    copy_path, move_path,
};
use commands::file_watcher::{
    fs_watch_start, fs_watch_stop, fs_watch_status,
};
use commands::context::{
    context_upsert, context_upsert_many, context_query, context_get_all,
    context_remove, context_clear,
    ide_report_current_file, ide_report_file_structure, ide_report_diagnostics,
};
use commands::git::{
    git_is_repository, git_init_repository, git_get_status, git_get_diffs,
    git_get_worktree_diff, git_get_index_diff, git_get_worktree_file_diff, git_get_index_file_diff,
    git_get_branches,
    git_create_branch, git_checkout_branch, git_delete_branch, git_rename_branch, git_merge_branch, git_commit_changes,
    git_stage_file, git_unstage_file, git_discard_changes,
    git_get_remotes, git_add_remote, git_remove_remote, git_detect_host, git_push_branch, git_push_set_upstream, git_create_pr, git_get_pr_status,
    git_pull, git_get_log, git_batch_stage,
    git_stash_save, git_stash_list, git_stash_pop, git_stash_drop,
    git_rebase_branch, git_rebase_abort, git_rebase_continue,
    git_cherry_pick, git_cherry_pick_abort, git_cherry_pick_continue,
    git_revert, git_revert_abort, git_revert_continue,
    git_get_tags, git_create_tag, git_delete_tag, git_blame_file,
    git_get_gitignore, git_save_gitignore, git_add_to_gitignore, git_get_gitignore_templates,
    test_param_serialization, write_file_absolute, read_file_absolute,
};
use commands::translate::baidu_translate;
use commands::openai_proxy::start_openai_chat;
use commands::integration::{
    start_integration, stop_integration, get_integration_status,
    get_all_integration_status, send_integration_message,
    get_integration_sessions, init_integration,
    add_integration_instance, remove_integration_instance,
    list_integration_instances, list_integration_instances_by_platform,
    get_active_integration_instance, switch_integration_instance,
    disconnect_integration_instance, update_integration_instance,
};
use commands::scheduler::{
    scheduler_list_tasks, scheduler_get_task, scheduler_create_task,
    scheduler_update_task, scheduler_delete_task, scheduler_toggle_task,
    scheduler_validate_trigger, scheduler_parse_interval, scheduler_get_workspace_breakdown,
    scheduler_get_lock_status, scheduler_acquire_lock, scheduler_release_lock,
    scheduler_run_task, scheduler_update_run_status,
};
use commands::terminal::{
    terminal_create, terminal_write, terminal_resize,
    terminal_close, terminal_list, terminal_get,
};
use commands::diagnostics::get_todo_mcp_diagnostics;

use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use tauri::Manager;
use ai::EngineRegistry;
use integrations::IntegrationManager;

// ============================================================================
// Tauri Commands
// ============================================================================

/// 获取配置
#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Result<Config> {
    let store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().clone())
}

/// 更新配置
#[tauri::command]
fn update_config(config: Config, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    store.update(config)
}

/// 设置工作目录
#[tauri::command]
fn set_work_dir(path: Option<String>, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    let path_buf = path.map(|p| p.into());
    store.set_work_dir(path_buf)
}

/// 设置 Claude 命令路径
#[tauri::command]
fn set_claude_cmd(cmd: String, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    store.set_claude_cmd(cmd)
}

/// 查找所有可用的 Claude CLI 路径
#[tauri::command]
fn find_claude_paths() -> Vec<String> {
    ConfigStore::find_claude_paths()
}

/// 路径验证结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidationResult {
    /// 路径是否有效
    pub valid: bool,
    /// 错误信息
    pub error: Option<String>,
    /// Claude 版本
    pub version: Option<String>,
}

/// 验证 Claude CLI 路径
#[tauri::command]
fn validate_claude_path(path: String) -> PathValidationResult {
    match ConfigStore::validate_claude_path(path) {
        Ok((valid, error, version)) => PathValidationResult {
            valid,
            error,
            version,
        },
        Err(_) => PathValidationResult {
            valid: false,
            error: Some("验证过程中发生错误".to_string()),
            version: None,
        },
    }
}

/// 查找所有可用的 IFlow CLI 路径
#[tauri::command]
fn find_iflow_paths() -> Vec<String> {
    ConfigStore::find_iflow_paths()
}

/// 验证 IFlow CLI 路径
#[tauri::command]
fn validate_iflow_path(path: String) -> PathValidationResult {
    match ConfigStore::validate_iflow_path(path) {
        Ok((valid, error, version)) => PathValidationResult {
            valid,
            error,
            version,
        },
        Err(_) => PathValidationResult {
            valid: false,
            error: Some("验证过程中发生错误".to_string()),
            version: None,
        },
    }
}


/// 健康检查
#[tauri::command]
fn health_check(state: tauri::State<AppState>) -> HealthStatus {
    let store = state.config_store.lock()
        .unwrap_or_else(|e| {
            e.into_inner()
        });
    store.health_status()
}

/// 检测 Claude CLI
#[tauri::command]
fn detect_claude(state: tauri::State<AppState>) -> Option<String> {
    let store = state.config_store.lock()
        .unwrap_or_else(|e| e.into_inner());
    store.detect_claude()
}

// ============================================================================
// Tauri App Builder
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化配置存储
    let config_store = ConfigStore::new()
        .expect("无法初始化配置存储");

    // 启用日志系统（使用 RUST_LOG 环境变量控制日志级别）
    // 开发: RUST_LOG=polaris=debug
    // 生产: RUST_LOG=polaris=info
    let _logger_guard = Logger::init(true);

    // 初始化 AI 引擎注册表
    let config = config_store.get().clone();
    let mut engine_registry = EngineRegistry::new();

    // 注册引擎
    engine_registry.register(ai::ClaudeEngine::new(config.clone()));
    engine_registry.register(ai::IFlowEngine::new(config.clone()));
    engine_registry.register(ai::CodexEngine::new(config.clone()));

    // 注册 OpenAI 引擎（如果配置了 Provider）
    if !config.openai_providers.is_empty() {
        let mut openai_engine = ai::OpenAIEngine::new();
        openai_engine.set_providers(
            config.openai_providers.clone(),
            config.active_provider_id.clone(),
        );
        engine_registry.register(openai_engine);
        tracing::info!("[EngineRegistry] OpenAI 引擎已注册，共 {} 个 Provider", config.openai_providers.len());
    }

    // 设置默认引擎
    let default_engine = ai::EngineId::from_str(&config.default_engine)
        .unwrap_or(ai::EngineId::ClaudeCode);
    let _ = engine_registry.set_default(default_engine);

    // 使用 Arc 共享 engine_registry (使用 tokio::sync::Mutex 支持异步)
    let engine_registry_arc = Arc::new(AsyncMutex::new(engine_registry));

    // 初始化 IntegrationManager，共享 engine_registry
    let integration_manager = IntegrationManager::new()
        .with_engine_registry(engine_registry_arc.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state::create_app_state(
            config_store,
            engine_registry_arc,
            integration_manager,
        ))
        .setup(|_app| {
            Ok(())
        })
        .on_window_event(|window, event| {
            // 处理窗口关闭事件
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                tracing::info!("[Window] 窗口关闭请求: {}", label);

                // 主窗口关闭时，退出整个应用
                if label == "main" {
                    tracing::info!("[Window] 主窗口关闭，退出应用");
                    // 退出整个应用
                    std::process::exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 配置相关
            get_config,
            update_config,
            set_work_dir,
            set_claude_cmd,
            find_claude_paths,
            validate_claude_path,
            find_iflow_paths,
            validate_iflow_path,
            // 健康检查
            health_check,
            detect_claude,
            // MCP 诊断
            get_todo_mcp_diagnostics,
            // 聊天相关（统一接口）
            start_chat,
            continue_chat,
            interrupt_chat,
            // 统一会话历史接口（支持分页）
            list_sessions,
            get_session_history,
            delete_session,
            // IFlow 会话历史相关（旧接口，保留兼容）
            list_iflow_sessions,
            get_iflow_session_history,
            get_iflow_file_contexts,
            get_iflow_token_stats,
            // Claude Code 原生会话历史相关（旧接口，保留兼容）
            list_claude_code_sessions,
            get_claude_code_session_history,
            // Codex 相关
            find_codex_paths,
            validate_codex_path,
            list_codex_sessions,
            get_codex_session_history,
            // AskUserQuestion 相关
            register_pending_question,
            answer_question,
            get_pending_questions,
            clear_answered_questions,
            // PlanMode 相关
            register_pending_plan,
            approve_plan,
            reject_plan,
            get_pending_plans,
            clear_processed_plans,
            // stdin 输入
            send_input,
            // 工作区相关
            validate_workspace_path,
            get_directory_info,
            get_home_dir,
            // 文件浏览器相关
            read_directory,
            get_file_content,
            create_file,
            create_directory,
            delete_file,
            rename_file,
            path_exists,
            read_commands,
            search_files,
            copy_path,
            move_path,
            // 文件监听相关
            fs_watch_start,
            fs_watch_stop,
            fs_watch_status,
            // 窗口管理相关
            toggle_devtools,
            set_always_on_top,
            is_always_on_top,
            // 上下文管理相关
            context_upsert,
            context_upsert_many,
            context_query,
            context_get_all,
            context_remove,
            context_clear,
            ide_report_current_file,
            ide_report_file_structure,
            ide_report_diagnostics,
            // Git 相关
            git_is_repository,
            git_init_repository,
            git_get_status,
            git_get_diffs,
            git_get_worktree_diff,
            git_get_index_diff,
            git_get_worktree_file_diff,
            git_get_index_file_diff,
            git_get_branches,
            git_create_branch,
            git_checkout_branch,
            git_delete_branch,
            git_rename_branch,
            git_merge_branch,
            git_rebase_branch,
            git_rebase_abort,
            git_rebase_continue,
            git_cherry_pick,
            git_cherry_pick_abort,
            git_cherry_pick_continue,
            git_revert,
            git_revert_abort,
            git_revert_continue,
            git_get_tags,
            git_create_tag,
            git_delete_tag,
            git_blame_file,
            git_get_gitignore,
            git_save_gitignore,
            git_add_to_gitignore,
            git_get_gitignore_templates,
            git_commit_changes,
            git_stage_file,
            git_unstage_file,
            git_discard_changes,
            git_get_remotes,
            git_add_remote,
            git_remove_remote,
            git_detect_host,
            git_push_branch,
            git_push_set_upstream,
            git_create_pr,
            git_get_pr_status,
            git_pull,
            git_get_log,
            git_batch_stage,
            git_stash_save,
            git_stash_list,
            git_stash_pop,
            git_stash_drop,
            test_param_serialization,
            write_file_absolute,
            read_file_absolute,
            // 翻译相关
            baidu_translate,
            // OpenAI Proxy 相关
            start_openai_chat,
            // 集成相关
            start_integration,
            stop_integration,
            get_integration_status,
            get_all_integration_status,
            send_integration_message,
            get_integration_sessions,
            init_integration,
            // 实例管理
            add_integration_instance,
            remove_integration_instance,
            list_integration_instances,
            list_integration_instances_by_platform,
            get_active_integration_instance,
            switch_integration_instance,
            disconnect_integration_instance,
            update_integration_instance,
            // 定时任务相关
            scheduler_list_tasks,
            scheduler_get_task,
            scheduler_create_task,
            scheduler_update_task,
            scheduler_delete_task,
            scheduler_toggle_task,
            scheduler_validate_trigger,
            scheduler_parse_interval,
            scheduler_get_workspace_breakdown,
            scheduler_get_lock_status,
            scheduler_acquire_lock,
            scheduler_release_lock,
            scheduler_run_task,
            scheduler_update_run_status,
            // 终端相关
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_list,
            terminal_get,
            // Todo 相关
            commands::todo::list_todos,
            commands::todo::create_todo,
            commands::todo::update_todo,
            commands::todo::delete_todo,
            commands::todo::start_todo,
            commands::todo::complete_todo,
            commands::todo::get_todo_workspace_breakdown,
            // Requirement 相关
            commands::requirement::list_requirements,
            commands::requirement::create_requirement,
            commands::requirement::update_requirement,
            commands::requirement::delete_requirement,
            commands::requirement::save_requirement_prototype,
            commands::requirement::read_requirement_prototype,
            commands::requirement::get_requirement_workspace_breakdown,

        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
