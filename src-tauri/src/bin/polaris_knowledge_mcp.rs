//! Project Knowledge MCP Binary Entry Point
//!
//! Usage: polaris-knowledge-mcp <config_dir> <workspace_path>
//!
//! Arguments:
//!   config_dir     - Application config directory (unused, kept for consistency)
//!   workspace_path - Current workspace path (required, contains .polaris/knowledge/)

use polaris_lib::services::project_knowledge_mcp_server::run_knowledge_mcp_server;
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
            "缺少参数。用法：polaris-knowledge-mcp <config_dir> <workspace_path>".to_string(),
        ));
    }

    let (config_dir, workspace_path) = parse_args(&args)?;

    run_knowledge_mcp_server(&config_dir, workspace_path)
}

/// Parse command line arguments
fn parse_args(args: &[String]) -> Result<(String, Option<&str>)> {
    match args.len() {
        2 => {
            // Single argument: treat as workspace_path (knowledge always needs workspace)
            let config_dir = get_default_config_dir()?;
            Ok((config_dir, Some(&args[1])))
        }
        3 => {
            // Two arguments: config_dir and workspace_path
            Ok((args[1].clone(), Some(&args[2])))
        }
        _ => Err(AppError::ValidationError(
            "参数过多。用法：polaris-knowledge-mcp <config_dir> <workspace_path>".to_string(),
        )),
    }
}

/// Get the default config directory for the application
fn get_default_config_dir() -> Result<String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))?
        .join("com.polaris.app");

    Ok(config_dir.to_string_lossy().to_string())
}
