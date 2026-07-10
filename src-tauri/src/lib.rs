// Web-only 构建（--no-default-features，无 tauri-app feature）下，大量 import 与符号
// 仅服务于桌面端 Tauri 命令，会产生 unused 噪音；且 rustc 1.95.0 在 early-lint 阶段
// 存在 ICE（core/slice/index 越界 panic），在渲染这些 warning 时会触发编译器崩溃。
// 仅在非 tauri-app（web）模式放宽 lint；桌面 / CI 构建保留完整告警，不受影响。
#![cfg_attr(not(feature = "tauri-app"), allow(warnings))]

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
    respond_plugin_card,
    // PlanMode 相关
    register_pending_plan, approve_plan, reject_plan, get_pending_plans, clear_processed_plans,
    // stdin 输入
    send_input,
};
#[cfg(feature = "tauri-app")]
use commands::{
    get_directory_info, get_home_dir, get_server_config, set_server_config,
    validate_workspace_path,
};
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
    search_file_contents, search_file_contents_detailed,
    copy_path, move_path, copy_path_to_directory, move_path_to_directory, save_dropped_file_to_directory, save_image_bytes, save_codex_image_artifact,
};
#[cfg(feature = "tauri-app")]
use commands::file_clipboard::{
    set_file_clipboard, get_file_clipboard,
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
    git_pull, git_get_log, git_get_commit_details, git_get_file_history, git_batch_stage,
    git_stash_save, git_stash_list, git_stash_pop, git_stash_drop,
    git_rebase_branch, git_rebase_abort, git_rebase_continue,
    git_cherry_pick, git_cherry_pick_abort, git_cherry_pick_continue,
    git_revert, git_revert_abort, git_revert_continue,
    git_checkout_commit, git_reset,
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
    terminal_open_in_external,
};
#[cfg(feature = "tauri-app")]
use commands::terminal_script::terminal_discover_scripts;
#[cfg(feature = "tauri-app")]
use commands::diagnostics::get_todo_mcp_diagnostics;
#[cfg(feature = "tauri-app")]
use commands::prompt_snippet::{
    snippet_list, snippet_get, snippet_create, snippet_update, snippet_delete,
};
#[cfg(feature = "tauri-app")]
use commands::{test_model_profile_connection, fetch_models_for_profile};
#[cfg(feature = "tauri-app")]
use commands::spring_boot::{
    spring_boot_detect_project, spring_boot_start, spring_boot_stop,
    spring_boot_list_apps, spring_boot_get_app, spring_boot_update_status,
    spring_boot_check_port, spring_boot_find_available_port,
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
async fn update_config(config: Config, state: tauri::State<'_, AppState>) -> Result<()> {
    let next_config = {
        let mut store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        store.update(config)?;
        store.get().clone()
    };
    cascade_active_model_profile(&next_config);
    refresh_engine_configs(&state, next_config.clone()).await;
    Ok(())
}

/// 按字段合并更新配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
async fn update_config_patch(patch: serde_json::Value, state: tauri::State<'_, AppState>) -> Result<Config> {
    let saved_config = {
        let mut store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        store.patch(patch)?
    };
    cascade_active_model_profile(&saved_config);
    refresh_engine_configs(&state, saved_config.clone()).await;
    Ok(saved_config)
}

/// 配置保存后将激活的 ModelProfile 凭证级联写入 agent 原生配置文件。
///
/// 仅处理当前激活的 Profile（`active: true` 且 target_engine 适用于 Claude Code）。
/// 级联失败不中断保存流程（仅记录警告日志），因为级联本质是便利功能：
/// 即使写入失败，下次会话启动时仍会通过 settings overlay 注入环境变量。
#[cfg(feature = "tauri-app")]
fn cascade_active_model_profile(config: &Config) {
    let active_profile = config.model_profiles.iter().find(|p| p.active);
    let Some(profile) = active_profile else {
        return;
    };

    // 仅当 Profile 适用于 Claude Code 时才写入 Claude settings.json
    let engines = profile.resolve_target_engines();
    if !engines.is_empty() && !engines.contains(&"claude".to_string()) {
        return;
    }

    if let Err(e) =
        crate::services::ModelProfileService::cascade_to_claude_settings(profile)
    {
        tracing::warn!(
            "[update_config] 级联写入 Claude settings.json 失败 (Profile {}): {}",
            profile.id,
            e
        );
    } else {
        tracing::info!(
            "[update_config] 已级联写入 Claude settings.json (Profile: {})",
            profile.id
        );
    }
}

/// 把最新配置同步到所有已注册 AI 引擎(失效缓存).
///
/// ConfigStore 和 EngineRegistry 是两个独立的锁(同步 + 异步),
/// 调用前请先释放 config_store 锁,避免出现锁顺序问题.
#[cfg(feature = "tauri-app")]
async fn refresh_engine_configs(state: &AppState, new_config: Config) {
    let mut registry = state.engine_registry.lock().await;
    registry.refresh_all_configs(new_config);
}

const LEGACY_WEB_PORT: u16 = 9800;
const DEV_WEB_PORT: u16 = 9830;

#[cfg(feature = "tauri-app")]
fn web_enabled_for_runtime(config_enabled: bool) -> bool {
    config_enabled || cfg!(debug_assertions)
}

fn web_port_for_runtime(config_port: u16) -> u16 {
    let port = if cfg!(debug_assertions) && config_port == LEGACY_WEB_PORT {
        DEV_WEB_PORT
    } else {
        config_port
    };
    web::server::WebServer::resolve_port(port)
}

pub(crate) async fn current_web_server_status(state: &AppState) -> web::server::WebServerStatus {
    let guard = state.web_server_handle.lock().await;
    if let Some(handle) = guard.as_ref() {
        web::server::WebServerStatus::running(handle.host.clone(), handle.port)
    } else {
        web::server::WebServerStatus::stopped()
    }
}

async fn stop_web_server(state: &AppState) -> web::server::WebServerStatus {
    let mut guard = state.web_server_handle.lock().await;
    if let Some(old_handle) = guard.take() {
        old_handle.shutdown.cancel();
        let _ = old_handle.task.await;
        tracing::info!("[Web] Server stopped");
    }
    web::server::WebServerStatus::stopped()
}

async fn start_configured_web_server(
    state: &AppState,
    config: &crate::models::config::Config,
) -> std::result::Result<web::server::WebServerStatus, error::AppError> {
    let port = web_port_for_runtime(config.web.port);
    let web_state = Arc::new(state.clone_for_web());
    let web_server = web::server::WebServer::new(web_state);
    let mut guard = state.web_server_handle.lock().await;

    if let Some(old_handle) = guard.take() {
        old_handle.shutdown.cancel();
        let _ = old_handle.task.await;
    }

    tracing::info!("[Web] Starting web server on {}:{}", config.web.host, port);
    let handle = web_server
        .start_on_available_port(&config.web.host, port)
        .await
        .map_err(|e| error::AppError::NetworkError(e.to_string()))?;
    let status = web::server::WebServerStatus::running(handle.host.clone(), handle.port);
    *guard = Some(handle);

    Ok(status)
}

/// 动态应用 Web 服务器配置：根据当前 config.web 启动或停止服务器。
///
/// 保存 Web 配置后，前端应调用此命令以即时生效，无需重启应用。
#[cfg(feature = "tauri-app")]
#[tauri::command]
async fn apply_web_server(state: tauri::State<'_, AppState>) -> std::result::Result<web::server::WebServerStatus, error::AppError> {
    let config = {
        let store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        store.get().clone()
    };

    // Case: user disabled the web service: stop running server.
    // In debug builds the Web backend is kept on by default for browser-mode testing.
    if !web_enabled_for_runtime(config.web.enabled) {
        return Ok(stop_web_server(&state).await);
    }

    start_configured_web_server(&state, &config).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
async fn get_web_server_status(state: tauri::State<'_, AppState>) -> std::result::Result<web::server::WebServerStatus, error::AppError> {
    Ok(current_web_server_status(&state).await)
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
async fn set_claude_cmd(cmd: String, state: tauri::State<'_, AppState>) -> Result<()> {
    let next_config = {
        let mut store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        store.set_claude_cmd(cmd)?;
        store.get().clone()
    };
    refresh_engine_configs(&state, next_config).await;
    Ok(())
}

/// 重置 CLI 路径(测试/调试用):
/// 将 claude_code.cli_path / codex_code.cli_path 重置为默认占位符,
/// 并刷新引擎缓存.前端随后调用 health_check 可触发"初始检测"流程.
#[cfg(feature = "tauri-app")]
#[tauri::command]
async fn reset_cli_config(state: tauri::State<'_, AppState>) -> Result<Config> {
    let next_config = {
        let mut store = state.config_store.lock()
            .map_err(|e| error::AppError::Unknown(e.to_string()))?;
        let mut config = store.get().clone();
        config.claude_code.cli_path = "claude".to_string();
        config.codex_code.cli_path = "codex".to_string();
        store.update(config)?;
        store.get().clone()
    };
    refresh_engine_configs(&state, next_config.clone()).await;
    Ok(next_config)
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

    // 注册 Simple AI 引擎（轻量级备用引擎，使用模型供应商配置）
    engine_registry.register(ai::SimpleAIEngine::new(config.clone()));

    // 注册 Mimo Code 引擎（mimocode CLI）
    engine_registry.register(ai::MimocodeEngine::new(config.clone()));

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state::create_app_state(
            config_store,
            engine_registry_arc,
            integration_manager,
        ))
        .setup(|app| {
            // Store AppHandle in AppState for dual emission (Web API → Tauri webview)
            let state = app.state::<AppState>();
            let _ = state.app_handle.set(app.handle().clone());
            commands::browser::set_browser_app_handle(app.handle().clone());

            // 索引引擎 → 前端事件桥（IndexStatus 推送）
            {
                let app_handle = app.handle().clone();
                state.lsp_index_service.set_status_listener(move |status| {
                    use tauri::Emitter;
                    if let Err(e) = app_handle.emit("lsp_index:status", status) {
                        tracing::debug!("emit lsp_index:status failed: {}", e);
                    }
                });
            }

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

            // 启动 AskUserQuestion 监听器（TCP 127.0.0.1:N）。
            // 通过 clone_for_web 得到的 state 与原 state 共享 ask_listener (Arc<OnceLock>) 和
            // ask_answer_senders，因此设置一次即对全局生效。
            {
                let state_arc = std::sync::Arc::new(state.clone_for_web());
                tauri::async_runtime::spawn(async move {
                    match services::ask_listener::spawn_ask_listener(state_arc.clone()).await {
                        Ok(handle) => {
                            tracing::info!(
                                "[AskListener] 已绑定 port={}",
                                handle.port
                            );
                            let _ = state_arc.ask_listener.set(handle);
                        }
                        Err(e) => {
                            tracing::error!("[AskListener] 启动失败: {}", e);
                        }
                    }
                });
            }

            if web_enabled_for_runtime(config.web.enabled) {
                let port = web_port_for_runtime(config.web.port);
                let host = config.web.host.clone();
                let web_state = Arc::new(state.clone_for_web());
                let web_server = web::server::WebServer::new(web_state);
                let handle_arc = state.web_server_handle.clone();

                tauri::async_runtime::spawn(async move {
                    tracing::info!("[Web] Starting web server on {}:{}", host, port);
                    match web_server.start_on_available_port(&host, port).await {
                        Ok(handle) => {
                            let mut guard = handle_arc.lock().await;
                            *guard = Some(handle);
                        }
                        Err(e) => {
                            tracing::error!("[Web] Failed to start web server: {}", e);
                        }
                    }
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
            update_config_patch,
            apply_web_server,
            get_web_server_status,
            get_local_ips,
            get_server_config,
            set_server_config,
            set_work_dir,
            set_claude_cmd,
            reset_cli_config,
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
            respond_plugin_card,
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
            save_image_bytes,
            save_codex_image_artifact,
            create_directory,
            delete_file,
            rename_file,
            path_exists,
            read_commands,
            search_files,
            search_file_contents,
            search_file_contents_detailed,
            copy_path,
            move_path,
            copy_path_to_directory,
            move_path_to_directory,
            save_dropped_file_to_directory,
            set_file_clipboard,
            get_file_clipboard,
            // 文件监听相关
            fs_watch_start,
            fs_watch_stop,
            fs_watch_status,
            // 窗口管理相关
            toggle_devtools,
            set_always_on_top,
            is_always_on_top,
            commands::browser::browser_create,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_ai_overlay,
            commands::browser::browser_close,
            commands::browser::browser_clear_data,
            commands::browser::browser_register,
            commands::browser::browser_unregister,
            commands::browser::browser_list_sessions,
            commands::browser::browser_acquire,
            commands::browser::browser_acquire_complete,
            commands::browser::browser_navigate,
            commands::browser::browser_reload,
            commands::browser::browser_history,
            commands::browser::browser_get_page_context,
            commands::browser::browser_get_diagnostics,
            commands::browser::browser_toggle_devtools,
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
            git_checkout_commit,
            git_reset,
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
            git_get_commit_details,
            git_get_file_history,
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
            terminal_discover_scripts,
            terminal_open_in_external,
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
            // Plugin 相关
            commands::plugin::plugin_list,
            commands::plugin::plugin_discover,
            commands::plugin::plugin_install_locations,
            commands::plugin::plugin_validate_manifest,
            commands::plugin::plugin_install_local,
            commands::plugin::plugin_install_package,
            commands::plugin::plugin_install_remote,
            commands::plugin::plugin_check_update,
            commands::plugin::plugin_apply_update,
            commands::plugin::plugin_install,
            commands::plugin::plugin_enable,
            commands::plugin::plugin_disable,
            commands::plugin::plugin_update,
            commands::plugin::plugin_uninstall_local,
            commands::plugin::plugin_uninstall,
            commands::plugin::marketplace_list,
            commands::plugin::marketplace_add,
            commands::plugin::marketplace_remove,
            commands::plugin::marketplace_update,
            commands::plugin_state::plugin_state_load,
            commands::plugin_state::plugin_state_save,
            // 插件服务管理
            commands::plugin_service::plugin_service_start,
            commands::plugin_service::plugin_service_stop,
            commands::plugin_service::plugin_service_restart,
            commands::plugin_service::plugin_service_list_status,
            commands::plugin_service::plugin_service_stop_for_plugin,
            commands::plugin_service::plugin_service_autostart,
            // Auto-Mode 相关
            commands::auto_mode::auto_mode_config,
            commands::auto_mode::auto_mode_defaults,
            // Agnes 多模态插件面板命令
            commands::agnes::agnes_get_config,
            commands::agnes::agnes_save_config,
            commands::agnes::agnes_generate_image,
            commands::agnes::agnes_create_video,
            commands::agnes::agnes_query_video,
            // CLI 信息查询相关
            commands::cli_info::cli_get_agents,
            commands::cli_info::cli_get_auth_status,
            commands::cli_info::cli_get_version,
            commands::cli_info::cli_check_installed,
            commands::cli_info::cli_find_paths,
            commands::cli_info::cli_get_version_for,
            commands::cli_info::cli_run_ultrareview,
            commands::cli_info::cli_extract_structured,
            // 引擎安装 / 卸载 / 检测
            commands::engine_install::engine_detect_version,
            commands::engine_install::engine_install,
            commands::engine_install::engine_uninstall,
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
            commands::claude_settings::add_claude_permission_rules,
            // 数据根（DataRoot）相关
            commands::data_root_cmd::get_data_root_info,
            commands::data_root_cmd::scan_legacy_data_cmd,
            commands::data_root_cmd::open_path_in_explorer,
            commands::data_root_cmd::migrate_legacy_data,
            commands::data_root_cmd::validate_data_root_target,
            commands::data_root_cmd::set_data_root,
            // 历史对话存储
            commands::dialog_storage::dialog_list,
            commands::dialog_storage::dialog_list_meta,
            commands::dialog_storage::dialog_read,
            commands::dialog_storage::dialog_write,
            commands::dialog_storage::dialog_delete,
            // LSP 语言服务器相关
            commands::lsp::lsp_start,
            commands::lsp::lsp_send,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_list_sessions,
            commands::lsp::lsp_config_list,
            commands::lsp::lsp_config_upsert,
            commands::lsp::lsp_config_remove,
            commands::lsp::lsp_config_toggle,
            commands::lsp::lsp_check_command,
            commands::lsp::lsp_index_references,
            commands::lsp::lsp_index_definition,
            commands::lsp::lsp_index_open,
            commands::lsp::lsp_index_close,
            commands::lsp::lsp_index_rebuild,
            commands::lsp::lsp_index_status,
            commands::lsp::lsp_index_update_file,
            // 模型 Profile 命令
            test_model_profile_connection,
            fetch_models_for_profile,
            // Spring Boot 调试运行相关
            spring_boot_detect_project,
            spring_boot_start,
            spring_boot_stop,
            spring_boot_list_apps,
            spring_boot_get_app,
            spring_boot_update_status,
            spring_boot_check_port,
            spring_boot_find_available_port,
            // 文件下载
            commands::file_explorer::download_file_binary,
            commands::file_explorer::download_directory_to_zip,
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
///
/// 参数优先级: cli_* > 环境变量 > 配置文件
pub fn run_web_server(cli_port: Option<u16>, cli_host: Option<String>, cli_token: Option<String>) {
    // 初始化配置存储
    let mut config_store = ConfigStore::new()
        .expect("无法初始化配置存储");

    // 启用日志系统
    let _logger_guard = Logger::init(true);

    // CLI token 覆盖（优先级: CLI args > 环境变量 > 配置文件）。
    // 仅内存覆盖，不持久化到 config.json。
    if let Some(ref t) = cli_token {
        config_store.get_mut().web.token = Some(t.clone());
        tracing::info!("[Polaris-Web] Token auth enabled via CLI/env (not persisted)");
    }

    // 初始化 AI 引擎注册表
    let config = config_store.get().clone();
    let mut engine_registry = EngineRegistry::new();
    engine_registry.register(ai::ClaudeEngine::new(config.clone()));
    engine_registry.register(ai::CodexEngine::new(config.clone()));
    engine_registry.register(ai::SimpleAIEngine::new(config.clone()));
    engine_registry.register(ai::MimocodeEngine::new(config.clone()));
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
    let config_dir = services::data_root::data_root().config_dir();
    let _ = app_state.app_config_dir.set(config_dir.clone());

    // 设置 resource_dir 为可执行文件所在目录。
    // Web 独立部署没有 Tauri 的资源解析器，若不设置 resource_dir，内置 MCP 二进制的解析会
    // 回退到编译期常量 CARGO_MANIFEST_DIR 推导的开发路径——该路径在部署机上通常不存在，
    // 导致 required 的 polaris-todo-mcp 定位失败并使对话接口返回 500。
    // 以可执行文件目录作为资源根后，只要 MCP 二进制与 polaris-web 同目录即可被发现，
    // 支持脱离编译目录的可移植部署；若仍未找到，解析逻辑会继续回退到环境变量与开发路径。
    match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        Some(exe_dir) => {
            tracing::info!("[Polaris-Web] resource_dir 设为可执行文件目录: {:?}", exe_dir);
            let _ = app_state.resource_dir.set(Some(exe_dir));
        }
        None => {
            tracing::warn!(
                "[Polaris-Web] 无法确定可执行文件目录，resource_dir 未设置，MCP 二进制将回退到开发路径解析"
            );
        }
    }

    // 预先准备调度器守护进程所需数据（app_state 即将被 Arc 包装而 move）
    let event_tx = app_state.event_broadcast.clone();
    let scheduler_config_dir = config_dir;

    // 启动 Web 服务器（优先级: CLI > 环境变量 > 配置文件）
    let port = cli_port
        .or_else(|| std::env::var("POLARIS_WEB_PORT").ok().and_then(|v| v.parse().ok()))
        .unwrap_or_else(|| web_port_for_runtime(config.web.port));
    let host = cli_host
        .unwrap_or_else(|| config.web.host.clone());
    let state = Arc::new(app_state);
    let web_server = web::server::WebServer::new(state);

    tracing::info!("[Polaris-Web] Starting standalone web server on {}:{}", host, port);

    let rt = tokio::runtime::Runtime::new()
        .expect("Failed to create tokio runtime");
    rt.block_on(async move {
        // 调度器守护进程内部使用 tokio::spawn，必须在 Tokio runtime 上下文内启动，
        // 否则会 panic "there is no reactor running"。
        let mut scheduler_daemon = services::scheduler_daemon::SchedulerDaemon::new(
            scheduler_config_dir,
            None,
        );
        if let Err(e) = scheduler_daemon.start_with_broadcast(event_tx) {
            tracing::warn!("[Polaris-Web] 调度器守护进程启动失败: {}", e);
        } else {
            tracing::info!("[Polaris-Web] 调度器守护进程已启动");
        }

        let handle = web_server
            .start_on_available_port(&host, port)
            .await
            .expect("Failed to start standalone web server");
        // 等待 Ctrl+C 信号以优雅关停
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("[Polaris-Web] Received shutdown signal, stopping...");
        scheduler_daemon.stop().ok();
        handle.shutdown.cancel();
        let _ = handle.task.await;
    });
}
