//! Todo MCP Binary Entry Point
//!
//! Usage: polaris-todo-mcp <config_dir> [workspace_path]
//!        polaris-todo-mcp <workspace_path>  (legacy format, uses default config_dir)
//!
//! Arguments:
//!   config_dir     - Application config directory for global storage
//!   workspace_path - Current workspace path (optional)

use polaris_lib::services::todo_mcp_server::run_todo_mcp_server;
use polaris_lib::{AppError, Result};
use std::path::PathBuf;

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
            "缺少参数。用法：polaris-todo-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let (config_dir, workspace_path) = parse_args(&args)?;

    run_todo_mcp_server(&config_dir, workspace_path)
}

/// Parse command line arguments with backward compatibility
fn parse_args(args: &[String]) -> Result<(String, Option<&str>)> {
    match args.len() {
        2 => {
            // Single argument: could be workspace_path (legacy) or config_dir
            // Check if it looks like a workspace path (contains separator and is a directory)
            let arg = &args[1];
            let path = PathBuf::from(arg);

            // If the path exists as a directory and contains .polaris or is not named "todo"
            // treat it as workspace_path (legacy format)
            if path.exists() && path.is_dir() {
                let has_polaris = path.join(".polaris").exists();
                let is_app_config = path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains("polaris") && n.contains("."))
                    .unwrap_or(false);

                if has_polaris || !is_app_config {
                    // Legacy format: single workspace_path argument
                    // Use default config_dir
                    let config_dir = get_default_config_dir()?;
                    return Ok((config_dir, Some(arg)));
                }
            }

            // Otherwise treat as config_dir (new format without workspace)
            Ok((arg.clone(), None))
        }
        3 => {
            // Two arguments: config_dir and workspace_path
            Ok((args[1].clone(), Some(&args[2])))
        }
        _ => {
            Err(AppError::ValidationError(
                "参数过多。用法：polaris-todo-mcp <config_dir> [workspace_path]".to_string(),
            ))
        }
    }
}

/// Get the default config directory for the application
fn get_default_config_dir() -> Result<String> {
    // Try to get the app config directory using dirs crate
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))?
        .join("com.polaris.app");

    Ok(config_dir.to_string_lossy().to_string())
}
