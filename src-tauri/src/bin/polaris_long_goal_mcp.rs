//! Long goal MCP Binary Entry Point
//!
//! Usage: polaris-long-goal-mcp <config_dir> [workspace_path]
//!        polaris-long-goal-mcp <workspace_path>  (legacy format, uses default config_dir)

use std::path::PathBuf;

use polaris_lib::services::long_goal_mcp_server::run_long_goal_mcp_server;
use polaris_lib::{AppError, Result};

fn main() {
    if let Err(error) = main_impl() {
        eprintln!("{}", error.to_message());
        std::process::exit(1);
    }
}

fn main_impl() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() < 2 {
        return Err(AppError::ValidationError(
            "缺少参数。用法：polaris-long-goal-mcp <config_dir> [workspace_path]".to_string(),
        ));
    }

    let (config_dir, workspace_path) = parse_args(&args)?;
    run_long_goal_mcp_server(&config_dir, workspace_path)
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
                    .and_then(|name| name.to_str())
                    .map(|name| name.contains("polaris") && name.contains('.'))
                    .unwrap_or(false);
                if has_polaris || !is_app_config {
                    return Ok((default_config_dir()?, Some(arg)));
                }
            }
            Ok((arg.clone(), None))
        }
        3 => Ok((args[1].clone(), Some(&args[2]))),
        _ => Err(AppError::ValidationError(
            "参数过多。用法：polaris-long-goal-mcp <config_dir> [workspace_path]".to_string(),
        )),
    }
}

fn default_config_dir() -> Result<String> {
    dirs::config_dir()
        .map(|path| path.join("com.polaris.app"))
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))
}
