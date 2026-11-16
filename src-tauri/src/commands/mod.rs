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
pub mod plugin_config;
pub mod data_root_cmd;
#[cfg(feature = "tauri-app")]
pub use data_root_cmd::open_path_in_explorer;

pub mod agent_corpus;
pub mod nexus;
#[cfg(feature = "tauri-app")]
pub use nexus::nexus_start_roster;


pub mod mobile_config;
#[cfg(feature = "tauri-app")]
pub use mobile_config::{get_server_config, set_server_config};

pub mod dialog_storage;

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

pub mod engine_install;
#[cfg(feature = "tauri-app")]
pub use engine_install::{engine_install, engine_uninstall};

pub mod plugin_engine;
#[cfg(feature = "tauri-app")]
pub use plugin_engine::{register_plugin_engine, unregister_plugin_engine};

pub mod claude_settings;
pub use claude_settings::{read_claude_settings, write_claude_settings, get_claude_settings_path};

pub mod router;
#[cfg(feature = "tauri-app")]
pub use router::{router_dispatch, router_list_caps};
