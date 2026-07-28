//! Personal Hub MCP Binary Entry Point
//!
//! Usage: polaris-ph-mcp <config_dir> [workspace_path]
//!
//! Provides CRUD tools for Personal Hub links (bookmarks, todos, notes, navigation).
//! Authentication token is read from the Personal Hub config in config.json.

use polaris_lib::services::personal_hub_mcp_server::run_ph_mcp_server;
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
            "缺少参数。用法：polaris-ph-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let config_dir = args[1].clone();
    let workspace_path = args.get(2).map(String::as_str);

    run_ph_mcp_server(&config_dir, workspace_path)
}