//! Browser MCP Binary Entry Point
//!
//! Usage:
//!   polaris-browser-mcp --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]

use polaris_lib::services::browser_mcp_server::{run_browser_mcp_server, BrowserMcpConfig};
use polaris_lib::{AppError, Result};

fn main() {
    if let Err(error) = main_impl() {
        eprintln!("{}", error.to_message());
        std::process::exit(1);
    }
}

fn main_impl() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let config = parse_args(&args)?;
    run_browser_mcp_server(config)
}

fn parse_args(args: &[String]) -> Result<BrowserMcpConfig> {
    let mut port: Option<u16> = None;
    let mut token: Option<String> = None;
    let mut session_id: Option<String> = None;

    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--polaris-port" => {
                let value = iter
                    .next()
                    .ok_or_else(|| AppError::ValidationError("--polaris-port 缺少值".into()))?;
                port = Some(value.parse::<u16>().map_err(|error| {
                    AppError::ValidationError(format!("--polaris-port 无效: {error}"))
                })?);
            }
            "--polaris-token" => {
                token = Some(
                    iter.next()
                        .ok_or_else(|| AppError::ValidationError("--polaris-token 缺少值".into()))?
                        .clone(),
                );
            }
            "--polaris-session" => {
                session_id = Some(
                    iter.next()
                        .ok_or_else(|| {
                            AppError::ValidationError("--polaris-session 缺少值".into())
                        })?
                        .clone(),
                );
            }
            other => {
                return Err(AppError::ValidationError(format!(
                    "未知参数: {other}。用法：polaris-browser-mcp --polaris-port <PORT> --polaris-token <TOKEN>"
                )));
            }
        }
    }

    let port = port.ok_or_else(|| AppError::ValidationError("缺少 --polaris-port".into()))?;
    let token = token.ok_or_else(|| AppError::ValidationError("缺少 --polaris-token".into()))?;

    Ok(BrowserMcpConfig {
        port,
        token,
        session_id,
    })
}
