//! Agnes AI MCP Binary Entry Point
//!
//! Usage: polaris-agnes-mcp <config_dir> [workspace_path]
//!
//! Provides image and video generation tools via Agnes AI APIs.
//! Credentials are read from `<config_dir>/agnes/config.json` (written by the
//! Agnes plugin settings panel), falling back to the AGNES_API_KEY env var.

use polaris_lib::services::agnes_mcp_server::run_agnes_mcp_server;
use polaris_lib::{AppError, Result};

fn main() {
    if let Err(error) = main_impl() {
        eprintln!("{}", error.to_message());
        std::process::exit(1);
    }
}

fn main_impl() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        return Err(AppError::ValidationError(
            "缺少参数。用法：polaris-agnes-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let config_dir = args[1].clone();
    let workspace_path = args.get(2).map(String::as_str);

    run_agnes_mcp_server(&config_dir, workspace_path)
}
