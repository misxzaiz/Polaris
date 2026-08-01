//! Unified MCP Binary Entry Point
//!
//! 将 11 个独立的 MCP server 二进制合并为一个，通过子命令调度。
//! 大幅减少编译目标数（11→1），降低链接时间与磁盘占用。
//!
//! # 用法
//!
//! ## 独立 MCP server（直接处理请求）
//! ```shell
//! polaris-mcp todo <config_dir> [workspace_path]
//! polaris-mcp requirements <config_dir> [workspace_path]
//! polaris-mcp scheduler <config_dir> [workspace_path]
//! polaris-mcp prd-preview <config_dir> [workspace_path]
//! polaris-mcp agnes <config_dir> [workspace_path]
//! polaris-mcp ph <config_dir> [workspace_path]
//! polaris-mcp computer <config_dir> [workspace_path]
//! ```
//!
//! ## Bridge MCP server（通过 TCP 连接主进程）
//! ```shell
//! polaris-mcp ask --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
//! polaris-mcp browser --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
//! polaris-mcp dispatch --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
//! ```

use std::path::PathBuf;

use polaris_lib::services::{
    agnes_mcp_server::run_agnes_mcp_server,
    ask_mcp_server::{run_ask_mcp_server, AskMcpConfig},
    browser_mcp_server::{run_browser_mcp_server, BrowserMcpConfig},
    dispatch_mcp_server::{run_dispatch_mcp_server, DispatchMcpConfig},
    personal_hub_mcp_server::run_ph_mcp_server,
    prd_preview_mcp_server::run_prd_preview_mcp_server,
    requirements_mcp_server::run_requirements_mcp_server,
    scheduler_mcp_server::run_scheduler_mcp_server,
    todo_mcp_server::run_todo_mcp_server,
};
use polaris_lib::{AppError, Result};

// ── 条件编译：computer-mcp 仅 Windows ────────────────────────────────────
#[cfg(windows)]
use polaris_lib::services::computer_mcp_server::run_computer_mcp_server;

fn main() {
    if let Err(error) = main_impl() {
        let message = error.to_message();
        eprintln!("{}", message);
        std::process::exit(1);
    }
}

fn main_impl() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let subcommand = args.get(1).ok_or_else(|| {
        AppError::ValidationError(
            "缺少子命令。用法：polaris-mcp <subcommand> [args...]\n\
             可用子命令：todo, requirements, scheduler, prd-preview, agnes, ph, computer, ask, browser, dispatch"
                .to_string(),
        )
    })?;

    let sub_args = &args[2..];

    match subcommand.as_str() {
        // ── 独立 MCP server（ConfigDirAndWorkspace 模式） ──────────
        "todo" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "todo")?;
            run_todo_mcp_server(&config_dir, workspace_path)
        }
        "requirements" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "requirements")?;
            run_requirements_mcp_server(&config_dir, workspace_path)
        }
        "scheduler" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "scheduler")?;
            run_scheduler_mcp_server(&config_dir, workspace_path)
        }
        "prd-preview" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "prd-preview")?;
            run_prd_preview_mcp_server(&config_dir, workspace_path)
        }
        "agnes" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "agnes")?;
            run_agnes_mcp_server(&config_dir, workspace_path)
        }
        "ph" => {
            let (config_dir, workspace_path) = parse_config_dir_args(sub_args, "ph")?;
            run_ph_mcp_server(&config_dir, workspace_path)
        }
        "computer" => {
            run_computer_mcp(sub_args)
        }

        // ── Bridge MCP server（AskListener 模式） ──────────────────
        "ask" => {
            let cfg = parse_ask_listener_args(sub_args, "ask")?;
            run_ask_mcp_server(cfg)
        }
        "browser" => {
            let cfg = parse_ask_listener_args(sub_args, "browser")?;
            run_browser_mcp_server(BrowserMcpConfig {
                port: cfg.port,
                token: cfg.token,
                session_id: cfg.session_id,
            })
        }
        "dispatch" => {
            let cfg = parse_ask_listener_args(sub_args, "dispatch")?;
            run_dispatch_mcp_server(DispatchMcpConfig {
                port: cfg.port,
                token: cfg.token,
                session_id: cfg.session_id,
            })
        }

        other => Err(AppError::ValidationError(format!(
            "未知子命令：{other}。可用子命令：todo, requirements, scheduler, prd-preview, agnes, ph, computer, ask, browser, dispatch"
        ))),
    }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────

/// 解析 ConfigDirAndWorkspace 模式的参数：
///   <config_dir> [workspace_path]
/// 兼容旧版单参数格式（只传 workspace_path，使用默认 config_dir）。
fn parse_config_dir_args<'a>(args: &'a [String], subcommand: &'a str) -> Result<(String, Option<&'a str>)> {
    match args.len() {
        0 => Err(AppError::ValidationError(format!(
            "缺少参数。用法：polaris-mcp {subcommand} <config_dir> [workspace_path]"
        ))),
        1 => {
            // 单参数：可能是 workspace_path（旧版）或 config_dir
            let arg = &args[0];
            let path = PathBuf::from(arg);
            if path.exists() && path.is_dir() {
                let has_polaris = path.join(".polaris").exists();
                let is_app_config = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains("polaris") && n.contains("."))
                    .unwrap_or(false);
                if has_polaris || !is_app_config {
                    // 旧版格式：单参数是 workspace_path
                    let config_dir = get_default_config_dir()?;
                    return Ok((config_dir, Some(arg)));
                }
            }
            // 作为 config_dir 处理
            Ok((arg.clone(), None))
        }
        2 => Ok((args[0].clone(), Some(&args[1]))),
        _ => Err(AppError::ValidationError(format!(
            "参数过多。用法：polaris-mcp {subcommand} <config_dir> [workspace_path]"
        ))),
    }
}

/// 解析 AskListener 模式的参数：
///   --polaris-port <PORT> --polaris-token <TOKEN> [--polaris-session <ID>]
fn parse_ask_listener_args(args: &[String], subcommand: &str) -> Result<AskMcpConfig> {
    let mut port: Option<u16> = None;
    let mut token: Option<String> = None;
    let mut session_id: Option<String> = None;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--polaris-port" => {
                let v = iter.next().ok_or_else(|| {
                    AppError::ValidationError("--polaris-port 缺少值".into())
                })?;
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
                        .ok_or_else(|| AppError::ValidationError("--polaris-session 缺少值".into()))?
                        .clone(),
                );
            }
            other => {
                return Err(AppError::ValidationError(format!(
                    "未知参数: {other}。用法：polaris-mcp {subcommand} --polaris-port <PORT> --polaris-token <TOKEN>"
                )));
            }
        }
    }

    let port = port.ok_or_else(|| AppError::ValidationError("缺少 --polaris-port".into()))?;
    let token = token.ok_or_else(|| AppError::ValidationError("缺少 --polaris-token".into()))?;

    // 复用 AskMcpConfig（字段名相同，传给 browser/dispatch 也 OK）
    Ok(AskMcpConfig {
        port,
        token,
        session_id,
    })
}

/// 电脑操作 MCP server：仅 Windows 可用
#[cfg(windows)]
fn run_computer_mcp(args: &[String]) -> Result<()> {
    let config_dir = args.first().map(String::as_str).unwrap_or("");
    let workspace_path = args.get(1).map(String::as_str);
    run_computer_mcp_server(config_dir, workspace_path)
}

#[cfg(not(windows))]
fn run_computer_mcp(_args: &[String]) -> Result<()> {
    Err(AppError::ProcessError(
        "polaris-mcp computer 仅支持 Windows（电脑操作依赖 Windows UI Automation 等平台能力）"
            .to_string(),
    ))
}

/// 获取默认配置目录
fn get_default_config_dir() -> Result<String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))?
        .join("com.polaris.app");
    Ok(config_dir.to_string_lossy().to_string())
}