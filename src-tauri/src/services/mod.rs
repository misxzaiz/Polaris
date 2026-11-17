pub mod autolaunch;
pub mod auto_update;
pub mod config_store;
pub mod data_root;
pub mod legacy_storage_migrate;
pub mod instance;
pub mod dialog_index;
pub mod file_watcher;
pub mod session_db;
pub mod session_state;
pub mod turn_persist;
pub mod logger;
pub mod mcp_config_service;
pub mod mcp_server_common;
pub mod plugin_service;
pub mod supervisor;
pub mod plugin_state_service;
pub mod plugin_capability_assembly;
pub mod plugin_skills;
pub mod plugin_events;
pub mod adapter_discovery;
pub mod hook_registry;
pub mod mcp_tool_gates;
pub mod storage;
pub mod ask_listener_meta;
pub mod ask_mcp_server;
pub mod ask_listener;
pub mod bus_mcp_server;
pub mod nexus_verdict;
pub mod nexus_pipeline;
pub mod ai_chat_core;
pub mod context_core;
pub use form::core as form_core;
pub use form::flow as form_flow;
pub use form::template as form_template;
pub mod form;
pub mod ai_history_core;
pub mod router;

pub mod usage_db;
pub use usage_db::UsageDb;

#[cfg(windows)]
pub mod computer_control;
#[cfg(windows)]
pub mod computer_mcp_server;


pub mod cli_info_service;
pub use cli_info_service::CliInfoService;


pub mod mcp_manager_service;
pub use mcp_manager_service::McpManagerService;

pub mod model_profile_service;
pub use model_profile_service::{ConnectionTestResult, ModelProfileService};

pub mod provider_router;
pub use provider_router::{FailoverError, ProviderRouter, RouteLogEntry, RouteLogKind, RouteSelection, TriedPair};

pub mod provider_stats_collector;
pub use provider_stats_collector::{
    FailedCallCollector, FailedCallFilter, FailedCallKind, FailedCallLog,
    ProfileStatsCollector, ProviderStatsSnapshot,
};

pub mod proxy;
pub use proxy::ProxyManager;
