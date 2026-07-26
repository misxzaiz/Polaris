//! Dispatch MCP Binary Entry Point
//!
//! Usage: polaris-dispatch-mcp --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
//!
//! This binary is launched by an AI CLI as an MCP server (stdio JSON-RPC 2.0).
//! It exposes `dispatch_task` / `check_dispatched_task` tools that forward
//! sub-tasks to new background Polaris sessions via a local TCP socket, then
//! return immediately (fire-and-forget) so the calling session keeps going.
//!
//! Arguments:
//!   --polaris-port <PORT>      Local TCP port of the main Polaris process
//!   --polaris-token <TOKEN>    Per-launch UUID for auth with the main process
//!   --polaris-session <ID>     Optional session id of the calling session
//!                              (used for engine/workspace inheritance and
//!                              dispatch-depth limiting)

use polaris_lib::services::dispatch_mcp_server::{run_dispatch_mcp_server, DispatchMcpConfig};
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
    run_dispatch_mcp_server(config)
}

fn parse_args(args: &[String]) -> Result<DispatchMcpConfig> {
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
                    "未知参数: {}。用法：polaris-dispatch-mcp --polaris-port <PORT> --polaris-token <TOKEN>",
                    other
                )));
            }
        }
    }

    let port = port.ok_or_else(|| AppError::ValidationError("缺少 --polaris-port".into()))?;
    let token = token.ok_or_else(|| AppError::ValidationError("缺少 --polaris-token".into()))?;

    Ok(DispatchMcpConfig {
        port,
        token,
        session_id,
    })
}
