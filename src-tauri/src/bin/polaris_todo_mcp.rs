//! Todo MCP Binary Entry Point
//!
//! Usage: polaris-todo-mcp <config_dir> [workspace_path]
//!
//! Arguments:
//!   config_dir     - Application config directory for global storage
//!   workspace_path - Current workspace path (optional)

use polaris_lib::services::todo_mcp_server::run_todo_mcp_server;
use polaris_lib::{AppError, Result};

fn main() {
    if let Err(error) = main_impl() {
        let message = error.to_message();
        eprintln!("{}", message);
        std::process::exit(1);
    }
}

fn main_impl() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        return Err(AppError::ValidationError(
            "缺少配置目录参数。用法：polaris-todo-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let config_dir = &args[1];
    let workspace_path = args.get(2).map(|s| s.as_str());

    run_todo_mcp_server(config_dir, workspace_path)
}
