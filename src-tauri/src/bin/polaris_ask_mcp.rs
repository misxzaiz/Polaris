//! PolarIS AskUserQuestion MCP Binary Entry Point
//!
//! This MCP companion process intercepts Claude CLI's ask_user_question tool calls,
//! forwards them to the main Tauri process via TCP, and blocks until the user answers.
//!
//! Usage: polaris-ask-mcp --polaris-port <N> --polaris-token <UUID> [--session-id <ID>]

use polaris_lib::services::ask_mcp_server::run_ask_mcp_server;
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

    let mut polaris_port: Option<u16> = None;
    let mut polaris_token: Option<String> = None;
    let mut session_id: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--polaris-port" => {
                i += 1;
                if i >= args.len() {
                    return Err(AppError::ValidationError(
                        "--polaris-port 需要一个端口号".to_string(),
                    ));
                }
                polaris_port = Some(
                    args[i]
                        .parse()
                        .map_err(|_| AppError::ValidationError("端口号必须是数字".to_string()))?,
                );
            }
            "--polaris-token" => {
                i += 1;
                if i >= args.len() {
                    return Err(AppError::ValidationError(
                        "--polaris-token 需要一个 token".to_string(),
                    ));
                }
                polaris_token = Some(args[i].clone());
            }
            "--session-id" => {
                i += 1;
                if i >= args.len() {
                    return Err(AppError::ValidationError(
                        "--session-id 需要一个会话 ID".to_string(),
                    ));
                }
                session_id = Some(args[i].clone());
            }
            _ => {
                return Err(AppError::ValidationError(format!(
                    "未知参数: {}",
                    args[i]
                )));
            }
        }
        i += 1;
    }

    let port = polaris_port
        .ok_or_else(|| AppError::ValidationError("缺少 --polaris-port 参数".to_string()))?;
    let token = polaris_token
        .ok_or_else(|| AppError::ValidationError("缺少 --polaris-token 参数".to_string()))?;

    run_ask_mcp_server(port, &token, session_id.as_deref())
}
