pub mod error;
pub mod models;
pub mod services;
pub mod commands;
mod integrations;
pub mod ai;  // 公开 ai 模块以支持适配层测试
mod state;
mod utils;
pub mod web;

pub use state::AppState;
pub use error::{AppError, Result};

#[cfg(feature = "tauri-app")]
use models::config::{Config, HealthStatus};
use services::config_store::ConfigStore;
use services::logger::Logger;
#[cfg(feature = "tauri-app")]
use commands::chat::{start_chat, continue_chat, interrupt_chat};
#[cfg(feature = "tauri-app")]
use commands::chat::{
    list_sessions, get_session_history, delete_session,
    list_claude_code_sessions, get_claude_code_session_history,
    register_pending_question, answer_question, get_pending_questions, clear_answered_questions,
    // PlanMode 相关
    register_pending_plan, approve_plan, reject_plan, get_pending_plans, clear_processed_plans,
    // stdin 输入
    send_input,
};
#[cfg(feature = "tauri-app")]
use commands::{validate_workspace_path, get_directory_info, get_home_dir};
#[cfg(feature = "tauri-app")]
use commands::window::{
    toggle_devtools,
    set_always_on_top,
    is_always_on_top,
};
#[cfg(feature = "tauri-app")]
use commands::file_explorer::{
    read_directory, get_file_content, create_file, create_directory,
    delete_file, rename_file, path_exists, read_commands, search_files,
    search_file_contents,
    copy_path, move_path,
};
#[cfg(feature = "tauri-app")]
use commands::file_watcher::{
    fs_watch_start, fs_watch_stop, fs_watch_status,
};
#[cfg(feature = "tauri-app")]
use commands::context::{
    context_upsert, context_upsert_many, context_query, context_get_all,
    context_remove, context_clear,
    ide_report_current_file, ide_report_file_structure, ide_report_diagnostics,
};
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
use commands::translate::baidu_translate;
#[cfg(feature = "tauri-app")]
use commands::integration::{
    start_integration, stop_integration, get_integration_status,
    get_all_integration_status, send_integration_message,
    get_integration_sessions, init_integration,
    add_integration_instance, remove_integration_instance,
    list_integration_instances, list_integration_instances_by_platform,
    get_active_integration_instance, switch_integration_instance,
    disconnect_integration_instance, update_integration_instance,
};
#[cfg(feature = "tauri-app")]
use commands::scheduler::{
    scheduler_list_tasks, scheduler_get_task, scheduler_create_task,
    scheduler_update_task, scheduler_delete_task, scheduler_toggle_task,
    scheduler_validate_trigger, scheduler_parse_interval, scheduler_get_workspace_breakdown,
    scheduler_list_tasks_by_category, scheduler_list_tasks_by_mode, scheduler_list_tasks_by_group,
    scheduler_get_lock_status, scheduler_acquire_lock, scheduler_release_lock,
    scheduler_run_task, scheduler_update_run_status,
    scheduler_get_status, scheduler_start, scheduler_stop,
    // Template commands
    scheduler_list_templates, scheduler_get_template, scheduler_create_template,
    scheduler_update_template, scheduler_delete_template, scheduler_toggle_template,
    scheduler_build_prompt,
    // Protocol task commands
    scheduler_read_protocol_documents, scheduler_update_protocol, scheduler_update_supplement,
    scheduler_update_memory_index, scheduler_update_memory_tasks, scheduler_clear_supplement,
    scheduler_backup_supplement, scheduler_backup_document, scheduler_has_supplement_content,
    scheduler_needs_backup, scheduler_extract_user_content,
    // Protocol template commands
    scheduler_list_protocol_templates, scheduler_list_protocol_templates_by_category,
    scheduler_get_protocol_template, scheduler_create_protocol_template,
    scheduler_update_protocol_template, scheduler_delete_protocol_template,
    scheduler_toggle_protocol_template, scheduler_render_protocol_document,
    scheduler_build_protocol_prompt,
};
#[cfg(feature = "tauri-app")]
use commands::terminal::{
    terminal_create, terminal_write, terminal_resize,
    terminal_close, terminal_list, terminal_get,
};
#[cfg(feature = "tauri-app")]
use commands::diagnostics::get_todo_mcp_diagnostics;
#[cfg(feature = "tauri-app")]
use commands::prompt_snippet::{
    snippet_list, snippet_get, snippet_create, snippet_update, snippet_delete,
};

use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use ai::EngineRegistry;
use integrations::IntegrationManager;
#[cfg(feature = "tauri-app")]
use tauri::Manager;

// ============================================================================
// Tauri Commands
// ============================================================================

/// 获取配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Result<Config> {
    let store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().clone())
}

/// 更新配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn update_config(config: Config, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    store.update(config)
}

/// 动态应用 Web 服务器配置：根据当前 config.web 启动或停止服务器。
///
/// 保存 Web 配置后，前端应调用此命令以即时生效，无需重启应用。
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn apply_web_server(state: tauri::State<AppState>) -> std::result::Result<serde_json::Value, error::AppError> {
    let config = {
        let store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        store.get().clone()
    };

    // Case: user disabled the web service — stop running server
    if !config.web.enabled {
        let handle_arc = state.web_server_handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut guard = handle_arc.lock().await;
            if let Some(old_handle) = guard.take() {
                old_handle.shutdown.cancel();
                tracing::info!("[Web] Server stopped by user");
            }
        });
        return Ok(serde_json::json!({ "running": false }));
    }

    let port = web::server::WebServer::resolve_port(config.web.port);
    let addr = format!("{}:{}", config.web.host, port);
    let web_state = Arc::new(state.clone_for_web());
    let web_server = web::server::WebServer::new(web_state);
    let handle_arc = state.web_server_handle.clone();
    let addr_log = addr.clone();

    tauri::async_runtime::spawn(async move {
        // Stop existing server if any (port/host change)
        let mut guard = handle_arc.lock().await;
        if let Some(old_handle) = guard.take() {
            old_handle.shutdown.cancel();
            let _ = old_handle.task.await;
        }

        tracing::info!("[Web] Starting web server on {}", addr_log);
        let handle = web_server.start(&addr);
        *guard = Some(handle);
    });

    Ok(serde_json::json!({ "running": true }))
}

/// 获取本机局域网 IP 地址列表（智能排序：真实 LAN IP 优先，虚拟网卡靠后）
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn get_local_ips() -> std::result::Result<Vec<String>, error::AppError> {
    let interfaces = if_addrs::get_if_addrs()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    let mut ips: Vec<(String, u32)> = interfaces
        .into_iter()
        .filter(|iface| !iface.is_loopback() && iface.addr.ip().is_ipv4())
        .map(|iface| {
            let ip = iface.addr.ip().to_string();
            let priority = ip_interface_priority(&ip, &iface.name);
            (ip, priority)
        })
        .collect();
    // 数值越小优先级越高，真实 LAN IP 排在最前
    ips.sort_by_key(|(_, p)| *p);
    Ok(ips.into_iter().map(|(ip, _)| ip).collect())
}

/// 根据网卡名称和 IP 子网判断优先级。数值越小越优先。
pub(crate) fn ip_interface_priority(ip: &str, iface_name: &str) -> u32 {
    let name_lower = iface_name.to_lowercase();

    // 1. 虚拟网卡名称匹配
    const VIRTUAL_KEYWORDS: &[&str] = &[
        "virtualbox", "vmware", "hyper-v", "wsl", "docker",
        "vethernet", "virbr", "bluestacks", "nox", "memu", "ldplayer",
    ];
    if VIRTUAL_KEYWORDS.iter().any(|k| name_lower.contains(k)) {
        return 100;
    }

    // 2. 已知虚拟网段子网匹配
    //    192.168.56.x  → VirtualBox Host-Only（默认网段）
    //    192.168.153.x → VMware NAT（常见默认）
    //    169.254.x.x   → Link-Local（APIPA，不可路由）
    if ip.starts_with("192.168.56.")
        || ip.starts_with("192.168.153.")
        || ip.starts_with("169.254.")
    {
        return 90;
    }

    // 3. Docker 默认 bridge 网段
    if ip.starts_with("172.17.")
        || ip.starts_with("172.18.")
        || ip.starts_with("172.19.")
    {
        return 80;
    }

    // 4. 常规 LAN/WiFi IP — 最高优先级
    10
}

/// 设置工作目录
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn set_work_dir(path: Option<String>, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    let path_buf = path.map(|p| p.into());
    store.set_work_dir(path_buf)
}

/// 设置 Claude 命令路径
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn set_claude_cmd(cmd: String, state: tauri::State<AppState>) -> Result<()> {
    let mut store = state.config_store.lock()
        .map_err(|e| error::AppError::Unknown(e.to_string()))?;
    store.set_claude_cmd(cmd)
}

/// 查找所有可用的 Claude CLI 路径
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
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


/// 健康检查
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn health_check(state: tauri::State<AppState>) -> HealthStatus {
    let store = state.config_store.lock()
        .unwrap_or_else(|e| {
            e.into_inner()
        });
    store.health_status()
}

/// 检测 Claude CLI
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
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

    // 注册 Claude CLI 引擎
    engine_registry.register(ai::ClaudeEngine::new(config.clone()));

    // 注册 Codex CLI 引擎
    engine_registry.register(ai::CodexEngine::new(config.clone()));

    // 设置默认引擎
    let default_engine = ai::EngineId::parse(&config.default_engine)
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
        .setup(|app| {
            // Store AppHandle in AppState for dual emission (Web API → Tauri webview)
            let state = app.state::<AppState>();
            let _ = state.app_handle.set(app.handle().clone());

            // Store application paths for consistent path resolution across Tauri & Web API
            if let Ok(config_dir) = app.path().app_config_dir() {
                let _ = state.app_config_dir.set(config_dir);
            }
            let _ = state.resource_dir.set(app.path().resource_dir().ok());

            // Conditionally start the web server based on WebConfig.enabled
            let config = {
                let store = state.config_store.lock()
                    .unwrap_or_else(|e: std::sync::PoisonError<std::sync::MutexGuard<'_, ConfigStore>>| e.into_inner());
                store.get().clone()
            };

            if config.web.enabled {
                let port = web::server::WebServer::resolve_port(config.web.port);
                let addr = format!("{}:{}", config.web.host, port);
                let web_state = Arc::new(state.clone_for_web());
                let web_server = web::server::WebServer::new(web_state);
                let handle_arc = state.web_server_handle.clone();
                let addr_log = addr.clone();

                tauri::async_runtime::spawn(async move {
                    tracing::info!("[Web] Starting web server on {}", addr_log);
                    let handle = web_server.start(&addr);
                    let mut guard = handle_arc.lock().await;
                    *guard = Some(handle);
                });
            }

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
            apply_web_server,
            get_local_ips,
            set_work_dir,
            set_claude_cmd,
            find_claude_paths,
            validate_claude_path,
            // 健康检查
            health_check,
            detect_claude,
            // MCP 诊断
            get_todo_mcp_diagnostics,
            // Prompt Snippet 快捷片段
            snippet_list,
            snippet_get,
            snippet_create,
            snippet_update,
            snippet_delete,
            // 聊天相关（统一接口）
            start_chat,
            continue_chat,
            interrupt_chat,
            // 统一会话历史接口（支持分页）
            list_sessions,
            get_session_history,
            delete_session,
            // Claude Code 原生会话历史相关（旧接口，保留兼容）
            list_claude_code_sessions,
            get_claude_code_session_history,
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
            search_file_contents,
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
            scheduler_list_tasks_by_category,
            scheduler_list_tasks_by_mode,
            scheduler_list_tasks_by_group,
            scheduler_get_lock_status,
            scheduler_acquire_lock,
            scheduler_release_lock,
            scheduler_run_task,
            scheduler_update_run_status,
            scheduler_get_status,
            scheduler_start,
            scheduler_stop,
            // Template 相关
            scheduler_list_templates,
            scheduler_get_template,
            scheduler_create_template,
            scheduler_update_template,
            scheduler_delete_template,
            scheduler_toggle_template,
            scheduler_build_prompt,
            // Protocol Task 相关
            scheduler_read_protocol_documents,
            scheduler_update_protocol,
            scheduler_update_supplement,
            scheduler_update_memory_index,
            scheduler_update_memory_tasks,
            scheduler_clear_supplement,
            scheduler_backup_supplement,
            scheduler_backup_document,
            scheduler_has_supplement_content,
            scheduler_needs_backup,
            scheduler_extract_user_content,
            // Protocol Template 相关
            scheduler_list_protocol_templates,
            scheduler_list_protocol_templates_by_category,
            scheduler_get_protocol_template,
            scheduler_create_protocol_template,
            scheduler_update_protocol_template,
            scheduler_delete_protocol_template,
            scheduler_toggle_protocol_template,
            scheduler_render_protocol_document,
            scheduler_build_protocol_prompt,
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
            // Knowledge 相关
            commands::knowledge::knowledge_init,
            commands::knowledge::knowledge_list_modules,
            commands::knowledge::knowledge_get_module,
            commands::knowledge::knowledge_create_module,
            commands::knowledge::knowledge_update_module,
            commands::knowledge::knowledge_delete_module,
            commands::knowledge::knowledge_update_module_document,
            commands::knowledge::knowledge_create_assertion,
            commands::knowledge::knowledge_update_assertion,
            commands::knowledge::knowledge_delete_assertion,
            commands::knowledge::knowledge_create_trap,
            commands::knowledge::knowledge_update_trap,
            commands::knowledge::knowledge_delete_trap,
            commands::knowledge::knowledge_list_domains,
            // Plugin 相关
            commands::plugin::plugin_list,
            commands::plugin::plugin_install,
            commands::plugin::plugin_enable,
            commands::plugin::plugin_disable,
            commands::plugin::plugin_update,
            commands::plugin::plugin_uninstall,
            commands::plugin::marketplace_list,
            commands::plugin::marketplace_add,
            commands::plugin::marketplace_remove,
            commands::plugin::marketplace_update,
            // Auto-Mode 相关
            commands::auto_mode::auto_mode_config,
            commands::auto_mode::auto_mode_defaults,
            // CLI 信息查询相关
            commands::cli_info::cli_get_agents,
            commands::cli_info::cli_get_auth_status,
            commands::cli_info::cli_get_version,
            commands::cli_info::cli_check_installed,
            commands::cli_info::cli_get_version_for,
            // MCP 管理器相关
            commands::mcp_manager::mcp_list_servers,
            commands::mcp_manager::mcp_get_server,
            commands::mcp_manager::mcp_health_check,
            commands::mcp_manager::mcp_health_check_one,
            commands::mcp_manager::mcp_add_server,
            commands::mcp_manager::mcp_remove_server,
            commands::mcp_manager::mcp_start_auth,
            // Claude Settings 相关
            commands::claude_settings::read_claude_settings,
            commands::claude_settings::write_claude_settings,
            commands::claude_settings::get_claude_settings_path,
            // LSP 语言服务器相关
            commands::lsp::lsp_start,
            commands::lsp::lsp_send,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_list_sessions,
            commands::lsp::lsp_config_list,
            commands::lsp::lsp_config_upsert,
            commands::lsp::lsp_config_remove,
            commands::lsp::lsp_config_toggle,

        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ============================================================================
// Standalone Web Server Entry Point (no Tauri desktop dependency)
// ============================================================================

/// 启动独立 Web 服务器（无 Tauri 桌面依赖）
///
/// 用于 WSL/Linux 服务器部署，仅启动 HTTP/WebSocket 服务。
/// Token 默认不检查（WebConfig.token = None），可通过 Web UI Settings 页面配置。
pub fn run_web_server() {
    // 初始化配置存储
    let config_store = ConfigStore::new()
        .expect("无法初始化配置存储");

    // 启用日志系统
    let _logger_guard = Logger::init(true);

    // 初始化 AI 引擎注册表
    let config = config_store.get().clone();
    let mut engine_registry = EngineRegistry::new();
    engine_registry.register(ai::ClaudeEngine::new(config.clone()));
    engine_registry.register(ai::CodexEngine::new(config.clone()));
    let default_engine = ai::EngineId::parse(&config.default_engine)
        .unwrap_or(ai::EngineId::ClaudeCode);
    let _ = engine_registry.set_default(default_engine);
    let engine_registry_arc = Arc::new(AsyncMutex::new(engine_registry));

    // 初始化 IntegrationManager
    let integration_manager = IntegrationManager::new()
        .with_engine_registry(engine_registry_arc.clone());

    // 创建应用状态
    let app_state = state::create_app_state(
        config_store,
        engine_registry_arc,
        integration_manager,
    );

    // 设置 config_dir（替代 Tauri path resolver）
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("claude-code-pro");
    let _ = app_state.app_config_dir.set(config_dir);

    // 启动 Web 服务器
    let port = web::server::WebServer::resolve_port(config.web.port);
    let addr = format!("{}:{}", config.web.host, port);
    let state = Arc::new(app_state);
    let web_server = web::server::WebServer::new(state);

    tracing::info!("[Polaris-Web] Starting standalone web server on {}", addr);

    let rt = tokio::runtime::Runtime::new()
        .expect("Failed to create tokio runtime");
    rt.block_on(async move {
        let handle = web_server.start(&addr);
        // 等待 Ctrl+C 信号以优雅关停
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("[Polaris-Web] Received shutdown signal, stopping...");
        handle.shutdown.cancel();
        let _ = handle.task.await;
    });
}
