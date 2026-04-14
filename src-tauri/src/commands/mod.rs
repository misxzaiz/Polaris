pub mod chat;
pub mod workspace;
pub mod file_explorer;
pub mod window;
pub mod context;
pub mod git;
pub mod translate;
pub mod plugin;

pub mod integration;
pub mod scheduler;
pub mod terminal;
pub mod file_watcher;
pub mod diagnostics;
pub mod todo;
pub mod requirement;
pub mod prompt_snippet;

// 重新导出命令函数，确保它们在模块级别可见
pub use workspace::validate_workspace_path;
pub use workspace::get_directory_info;
pub use workspace::get_home_dir;

// 上下文管理命令

// Git 命令

// 翻译命令


// 集成命令

// 终端命令

pub mod auto_mode;
pub use auto_mode::{auto_mode_config, auto_mode_defaults};

pub mod claude_settings;
pub use claude_settings::{read_claude_settings, write_claude_settings, get_claude_settings_path};
