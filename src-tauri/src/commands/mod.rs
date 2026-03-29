pub mod chat;
pub mod workspace;
pub mod file_explorer;
pub mod window;
pub mod context;
pub mod git;
pub mod translate;
pub mod openai_proxy;
pub mod integration;
pub mod scheduler;
pub mod terminal;
pub mod file_watcher;
pub mod diagnostics;
pub mod todo;

// 重新导出命令函数，确保它们在模块级别可见
pub use workspace::validate_workspace_path;
pub use workspace::get_directory_info;
pub use workspace::get_home_dir;

// 上下文管理命令

// Git 命令

// 翻译命令

// OpenAI Proxy 命令

// 集成命令

// 终端命令
