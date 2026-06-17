pub mod config_store;
pub mod data_root;
pub mod file_watcher;
pub mod git;
pub mod logger;
pub mod mcp_config_service;
pub mod mcp_diagnostics_service;
pub mod plugin_service;
pub mod plugin_state_service;
pub mod prompt_store;
pub mod prompt_snippet_service;
pub mod scheduler;
pub mod scheduler_daemon;
pub mod scheduler_mcp_server;
pub mod todo_mcp_server;
pub mod unified_todo_repository;
pub mod unified_requirement_repository;
pub mod unified_scheduler_repository;
pub mod requirements_mcp_server;

#[cfg(windows)]
pub mod computer_control;
#[cfg(windows)]
pub mod computer_mcp_server;


pub mod auto_mode_service;
pub use auto_mode_service::AutoModeService;

pub mod cli_info_service;
pub use cli_info_service::CliInfoService;

pub mod cli_resolver;

pub mod lsp;
pub mod lsp_config_repository;

pub mod mcp_manager_service;
pub use mcp_manager_service::McpManagerService;

pub mod model_profile_service;
pub use model_profile_service::{ConnectionTestResult, ModelProfileService};

pub mod proxy;
pub use proxy::ProxyManager;
