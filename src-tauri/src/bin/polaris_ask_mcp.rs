//! Ask MCP Binary Entry Point
//!
//! Usage: polaris-ask-mcp --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
//!
//! This binary is launched by Claude CLI as an MCP server (stdio JSON-RPC 2.0).
//! It exposes a single tool `ask_user_question` that, when called, connects to
//! the main Polaris process via a local TCP socket and blocks until the user
//! answers (or declines). The answer is returned as a tool_result so the CLI
//! can continue the same turn — no new user message is injected.
//!
//! Arguments:
//!   --polaris-port <PORT>      Local TCP port of the main Polaris process
//!   --polaris-token <TOKEN>    Per-launch UUID for auth with the main process
//!   --polaris-session <ID>     Optional Claude session id for routing

use polaris_lib::services::ask_mcp_server::{run_ask_mcp_server, AskMcpConfig};
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
    let config = parse_args(&args)?;
    run_ask_mcp_server(config)
}

fn parse_args(args: &[String]) -> Result<AskMcpConfig> {
    let mut port: Option<u16> = None;
    let mut token: Option<String> = None;
    let mut session_id: Option<String> = None;

    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--polaris-port" => {
                let v = iter
                    .next()
                    .ok_or_else(|| AppError::ValidationError("--polaris-port 缺少值".into()))?;
                port = Some(v.parse::<u16>().map_err(|e| {
                    AppError::ValidationError(format!("--polaris-port 无效: {}", e))
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
                    "未知参数: {}。用法：polaris-ask-mcp --polaris-port <PORT> --polaris-token <TOKEN>",
                    other
                )));
            }
        }
    }

    let port = port.ok_or_else(|| AppError::ValidationError("缺少 --polaris-port".into()))?;
    let token = token.ok_or_else(|| AppError::ValidationError("缺少 --polaris-token".into()))?;

    Ok(AskMcpConfig {
        port,
        token,
        session_id,
    })
}
