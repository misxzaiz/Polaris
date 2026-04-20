//! Project Knowledge MCP Binary Entry Point
//!
//! This is a thin wrapper around the standalone polaris-knowledge-mcp crate.
//! The actual implementation lives in crates/polaris-knowledge-mcp/.
//!
//! Usage: polaris-knowledge-mcp <config_dir> <workspace_path>
//!
//! Arguments:
//!   config_dir     - Application config directory (unused, kept for consistency)
//!   workspace_path - Current workspace path (required, contains .polaris/knowledge/)

use polaris_knowledge_mcp::run_server_with_workspace;

fn main() {
    if let Err(error) = main_impl() {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}

fn main_impl() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        eprintln!("用法：polaris-knowledge-mcp <config_dir> <workspace_path>");
        std::process::exit(1);
    }

    let (config_dir, workspace_path) = parse_args(&args)?;
    run_server_with_workspace(&config_dir, workspace_path.as_deref())?;
    Ok(())
}

/// Parse command line arguments
fn parse_args(args: &[String]) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    match args.len() {
        2 => {
            // Single argument: treat as workspace_path (knowledge always needs workspace)
            let config_dir = get_default_config_dir()?;
            Ok((config_dir, Some(args[1].clone())))
        }
        3 => {
            // Two arguments: config_dir and workspace_path
            Ok((args[1].clone(), Some(args[2].clone())))
        }
        _ => {
            Err("参数过多。用法：polaris-knowledge-mcp <config_dir> <workspace_path>".into())
        }
    }
}

/// Get the default config directory for the application
fn get_default_config_dir() -> Result<String, Box<dyn std::error::Error>> {
    let config_dir = dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("com.polaris.app");

    Ok(config_dir.to_string_lossy().to_string())
}
