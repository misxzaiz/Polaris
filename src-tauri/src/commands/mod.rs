pub mod browser;
pub mod chat;
pub mod context;
pub mod data_root_cmd;
pub mod file_clipboard;
pub mod file_explorer;
pub mod git;
pub mod plugin;
pub mod plugin_service;
pub mod plugin_state;
pub mod translate;
pub mod window;
pub mod workspace;
#[cfg(feature = "tauri-app")]
pub use data_root_cmd::{get_data_root_info, open_path_in_explorer, scan_legacy_data_cmd};

pub mod mobile_config;
#[cfg(feature = "tauri-app")]
pub use mobile_config::{get_server_config, set_server_config};

pub mod dialog_storage;
#[cfg(feature = "tauri-app")]
pub use dialog_storage::{dialog_delete, dialog_list, dialog_list_meta, dialog_read, dialog_write};

pub mod agnes;
pub mod diagnostics;
pub mod file_watcher;
pub mod integration;
pub mod prompt_snippet;
pub mod requirement;
pub mod scheduler;
pub mod terminal;
pub mod terminal_script;
pub mod todo;
#[cfg(feature = "tauri-app")]
pub use agnes::{
    agnes_create_video, agnes_generate_image, agnes_get_config, agnes_query_video,
    agnes_save_config,
};

// 重新导出命令函数，确保它们在模块级别可见
pub use workspace::get_directory_info;
pub use workspace::get_home_dir;
pub use workspace::validate_workspace_path;

// 上下文管理命令

// Git 命令

// 翻译命令

// 集成命令

// 终端命令

pub mod lsp;

pub mod auto_mode;
#[cfg(feature = "tauri-app")]
pub use auto_mode::{auto_mode_config, auto_mode_defaults};

pub mod cli_info;
#[cfg(feature = "tauri-app")]
pub use cli_info::{
    cli_extract_structured, cli_get_agents, cli_get_auth_status, cli_get_version,
    cli_run_ultrareview,
};

pub mod engine_install;
#[cfg(feature = "tauri-app")]
pub use engine_install::{engine_detect_version, engine_install, engine_uninstall};

pub mod mcp_manager;
#[cfg(feature = "tauri-app")]
pub use mcp_manager::{
    mcp_add_server, mcp_get_server, mcp_health_check, mcp_health_check_one, mcp_list_servers,
    mcp_remove_server, mcp_start_auth,
};

pub mod claude_settings;
pub use claude_settings::{get_claude_settings_path, read_claude_settings, write_claude_settings};

pub mod model_profile;
#[cfg(feature = "tauri-app")]
pub use model_profile::{fetch_models_for_profile, test_model_profile_connection};

pub mod spring_boot;
