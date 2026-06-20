//! Port Manager MCP Binary Entry Point
//!
//! Usage: polaris-port-manager-mcp <config_dir> [workspace_path]

use polaris_lib::services::port_manager_mcp_server::run_port_manager_mcp_server;
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
            "缺少参数。用法：polaris-port-manager-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let (config_dir, workspace_path) = parse_args(&args)?;

    run_port_manager_mcp_server(&config_dir, workspace_path)
}

fn parse_args(args: &[String]) -> Result<(String, Option<&str>)> {
    match args.len() {
        2 => {
            let arg = &args[1];
            let path = PathBuf::from(arg);

            if path.exists() && path.is_dir() {
                let has_polaris = path.join(".polaris").exists();
                let is_app_config = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains("polaris") && n.contains('.'))
                    .unwrap_or(false);

                if has_polaris || !is_app_config {
                    let config_dir = get_default_config_dir()?;
                    return Ok((config_dir, Some(arg)));
                }
            }

            Ok((arg.clone(), None))
        }
        3 => Ok((args[1].clone(), Some(&args[2]))),
        _ => Err(AppError::ValidationError(
            "参数过多。用法：polaris-port-manager-mcp <config_dir> [workspace_path]".to_string(),
        )),
    }
}

fn get_default_config_dir() -> Result<String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))?
        .join("com.polaris.app");

    Ok(config_dir.to_string_lossy().to_string())
}
