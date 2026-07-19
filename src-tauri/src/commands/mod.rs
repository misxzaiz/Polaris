pub mod chat;
pub mod dispatch;
pub mod workspace;
pub mod file_explorer;
pub mod file_clipboard;
pub mod window;
pub mod browser;
pub mod context;
pub mod git;
pub mod translate;
pub mod plugin;
pub mod plugin_state;
pub mod plugin_service;
pub mod data_root_cmd;
#[cfg(feature = "tauri-app")]
pub use data_root_cmd::{get_data_root_info, scan_legacy_data_cmd, open_path_in_explorer};

pub mod agent_corpus;
pub mod nexus;
#[cfg(feature = "tauri-app")]
pub use nexus::nexus_start_roster;

#[cfg(feature = "tauri-app")]
pub use agent_corpus::{
    agent_corpus_catalog, agent_corpus_divisions, agent_corpus_install, agent_corpus_status,
    agent_corpus_uninstall, simple_ai_list_agents,
};

pub mod mobile_config;
#[cfg(feature = "tauri-app")]
pub use mobile_config::{get_server_config, set_server_config};

pub mod dialog_storage;
#[cfg(feature = "tauri-app")]
pub use dialog_storage::{
    dialog_append, dialog_delete, dialog_list, dialog_list_meta, dialog_read, dialog_read_page,
    dialog_write,
};

pub mod history_index;
#[cfg(feature = "tauri-app")]
pub use history_index::{history_mark, history_query, history_search};

pub mod integration;
pub mod scheduler;
pub mod terminal;
pub mod terminal_script;
pub mod file_watcher;
pub mod diagnostics;
pub mod todo;
pub mod requirement;
pub mod prompt_snippet;
pub mod agnes;
#[cfg(feature = "tauri-app")]
pub use agnes::{
    agnes_create_video, agnes_generate_image, agnes_get_config, agnes_query_video, agnes_save_config,
};

// 重新导出命令函数，确保它们在模块级别可见
pub use workspace::validate_workspace_path;
pub use workspace::get_directory_info;
pub use workspace::get_home_dir;

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
pub use cli_info::{cli_get_agents, cli_get_auth_status, cli_get_version, cli_run_ultrareview, cli_extract_structured};

pub mod engine_install;
#[cfg(feature = "tauri-app")]
pub use engine_install::{engine_detect_version, engine_install, engine_uninstall};

pub mod mcp_manager;
#[cfg(feature = "tauri-app")]
pub use mcp_manager::{mcp_list_servers, mcp_get_server, mcp_health_check, mcp_health_check_one, mcp_add_server, mcp_remove_server, mcp_start_auth};

pub mod claude_settings;
pub use claude_settings::{read_claude_settings, write_claude_settings, get_claude_settings_path};

pub mod model_profile;
#[cfg(feature = "tauri-app")]
pub use model_profile::{test_model_profile_connection, fetch_models_for_profile};
