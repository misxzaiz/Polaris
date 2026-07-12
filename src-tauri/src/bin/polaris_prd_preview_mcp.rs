//! PRD Preview MCP Binary Entry Point
//!
//! Usage: polaris-prd-preview-mcp <config_dir> [workspace_path]
//!
//! Provides a lightweight artifact surface for Claude/Codex to create
//! self-contained HTML previews that Polaris can render in chat and web mode.

use polaris_lib::services::prd_preview_mcp_server::run_prd_preview_mcp_server;
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
            "缺少参数。用法：polaris-prd-preview-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let config_dir = args[1].clone();
    let workspace_path = args.get(2).map(String::as_str);

    run_prd_preview_mcp_server(&config_dir, workspace_path)
}
