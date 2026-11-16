pub mod dispatch;
pub mod file_explorer;
pub mod file_clipboard;
pub mod window;
// 浏览器域已整体出仓（2026-11-14，方案 D）：commands/browser.rs、browser_scripts.rs、
// services/browser_mcp_server.rs、simple_ai tools/browser.rs 全部删除，浏览器能力
// 移入 browser-desk 插件（CDP 驱动系统 Chrome）。cap/命令层零残留。
// Git 域已整体出仓（2026-11-12，架构方案 C）：commands/git.rs、services/git/、
// cap.git、models/git.rs 全部删除，Git 引擎移入 polaris-git 插件 service。仅存的
// write_file_absolute / read_file_absolute / test_param_serialization（无 git
// 业务关联）迁往 commands/file_io.rs。
pub mod file_io;
// translate 域已整体出仓（2026-11-14，B2-4）：commands/translate.rs 删除，
// 百度 API 调用在 translate 插件 service 内实现（语义等价搬移）。
// plugin.rs（PluginDiscovery 管理面命令层）+ plugin_service.rs（PluginServiceManager
// 命令层）已整体删除，管理面迁入 cap.pluginDiscovery / cap.pluginServiceManager
// （services/router/plugin_discovery_capability.rs / plugin_service_manager_capability.rs）。
// plugin_state/plugin_config 为独立域保留。
#[cfg(feature = "tauri-app")]
pub mod provider_diagnostics;
pub mod plugin_state;
pub mod plugin_config;
pub mod data_root_cmd;
#[cfg(feature = "tauri-app")]
pub use data_root_cmd::open_path_in_explorer;

pub mod agent_corpus;
pub mod nexus;
#[cfg(feature = "tauri-app")]
pub use nexus::{nexus_dispatch_group, nexus_list_pipelines, nexus_resolve_escalation, nexus_start_roster};

#[cfg(feature = "tauri-app")]
pub use agent_corpus::{
    agent_corpus_rosters, custom_agent_delete, custom_agent_list,
    custom_agent_save, simple_ai_list_agents, user_roster_delete, user_roster_save,
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

pub mod session_messages;
#[cfg(feature = "tauri-app")]
pub use session_messages::{
    message_append, message_delete_by_conversation, message_get_latest, message_read,
    message_read_history, message_revise,
};

pub mod session_state_commands;
#[cfg(feature = "tauri-app")]
pub use session_state_commands::{
    session_append_message, session_delete, session_event_append, session_event_current_seq,
    session_event_delete_by_conversation, session_event_read, session_event_read_after_seq,
    session_get, session_get_status, session_list, session_reconcile, session_register,
    session_request_interrupt, session_request_start, session_update_metadata,
};

pub mod terminal;
pub mod terminal_script;
pub mod file_watcher;

// 上下文管理命令

// Git 命令

// 翻译命令


// 集成命令

// 终端命令

pub mod cli_info;
#[cfg(feature = "tauri-app")]
pub use cli_info::{cli_get_agents, cli_get_auth_status, cli_get_version};

pub mod engine_install;
#[cfg(feature = "tauri-app")]
pub use engine_install::{engine_detect_version, engine_install, engine_uninstall};

pub mod engine_metadata;
#[cfg(feature = "tauri-app")]
pub use engine_metadata::get_engine_metadata_list;

pub mod plugin_engine;
#[cfg(feature = "tauri-app")]
pub use plugin_engine::{register_plugin_engine, unregister_plugin_engine, list_plugin_engines};

pub mod mcp_manager;
#[cfg(feature = "tauri-app")]
pub use mcp_manager::{mcp_list_servers, mcp_get_server, mcp_health_check, mcp_health_check_one, mcp_add_server, mcp_remove_server, mcp_start_auth};

pub mod claude_settings;
pub use claude_settings::{read_claude_settings, write_claude_settings, get_claude_settings_path};

pub mod model_profile;
#[cfg(feature = "tauri-app")]
pub mod usage;
#[cfg(feature = "tauri-app")]
pub use model_profile::{test_model_profile_connection, fetch_models_for_profile};

pub mod router;
#[cfg(feature = "tauri-app")]
pub use router::{router_dispatch, router_list_caps};
