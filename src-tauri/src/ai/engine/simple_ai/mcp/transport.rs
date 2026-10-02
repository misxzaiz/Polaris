/*! MCP 传输层（简化版）
 *
 * 只保留 StdioTransport（子进程 stdin/stdout 交换 JSON 行）。
 * ProtocolVersion 保留 2025-06-18（当前）和 2026-07-28（未来升级目标）。
 */

use std::fmt::Debug;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

/// MCP 协议版本。
///
/// 当前使用 2025-06-18（有状态，需 initialize 握手）。
/// 2026-07-28 为 GA 版本，移除 initialize 握手 + Mcp-Session-Id（未来升级目标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolVersion {
    V2025_06_18,
    V2026_07_28,
}

impl ProtocolVersion {
    /// 当前客户端请求的协议版本。
    pub const fn current() -> Self {
        ProtocolVersion::V2025_06_18
    }

    /// 协议版本字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            ProtocolVersion::V2025_06_18 => "2025-06-18",
            ProtocolVersion::V2026_07_28 => "2026-07-28",
        }
    }

    /// 从 server 返回的协议版本字符串协商降级。
    pub fn from_server(version: &str) -> Self {
        match version {
            "2026-07-28" => ProtocolVersion::V2026_07_28,
            "2025-06-18" => ProtocolVersion::V2025_06_18,
            _ => {
                tracing::warn!("[MCP] 未知协议版本 '{}'，降级到 2025-06-18", version);
                ProtocolVersion::V2025_06_18
            }
        }
    }

    /// 是否需要 initialize 握手（2026-07-28 无状态协议移除）。
    pub fn needs_handshake(&self) -> bool {
        matches!(self, ProtocolVersion::V2025_06_18)
    }
}

/// MCP 传输层抽象（仅 stdio）。
///
/// 实现者保证：写一行 JSON 到 stdin，stdout 由调用方起后台 reader task 路由。
#[async_trait]
pub trait McpTransport: Debug + Send + Sync {
    /// 发送一行 JSON-RPC 2.0 请求/通知。
    async fn send_line(&self, line: &str) -> Result<()>;

    /// 同步终止底层资源（Drop 等同步上下文调用；stdio kill 子进程）。
    fn shutdown_sync(&self) {}

    /// 关闭传输层（释放资源）。
    async fn shutdown(&mut self) -> Result<()>;
}

/// stdio 传输层实现：通过子进程 stdin/stdout 交换 JSON 行。
///
/// 设计：`spawn_with_reader` 返回 `(Self, ChildStdout)`——stdin 写入由 transport
/// 独占管理（`send_line`），stdout 由调用方接管用于后台 reader task（按 id 路由）。
#[derive(Debug)]
pub struct StdioTransport {
    server_name: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

impl StdioTransport {
    /// 创建新的 StdioTransport，返回 transport + stdout（供调用方起后台 reader task）。
    pub async fn spawn_with_reader(
        server_name: String,
        command: &str,
        args: &[String],
        env: &std::collections::HashMap<String, String>,
    ) -> Result<(Self, ChildStdout)> {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            AppError::ProcessError(format!(
                "spawn MCP server '{}' ({}) failed: {}",
                server_name, command, e
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::ProcessError("MCP server stdin not captured".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::ProcessError("MCP server stdout not captured".to_string()))?;

        Ok((
            Self {
                server_name,
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
            },
            stdout,
        ))
    }

    /// 同步终止子进程（trait `shutdown_sync` 的实现；供 Drop 用）。
    pub(crate) fn kill_sync(&self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }

    /// server 名称（诊断用）。
    pub(crate) fn server_name(&self) -> &str {
        &self.server_name
    }
}

#[async_trait]
impl McpTransport for StdioTransport {
    async fn send_line(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "write to MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "write newline to MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        stdin
            .flush()
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "flush MCP '{}' stdin: {}",
                    self.server_name, e
                ))
            })?;
        Ok(())
    }

    /// 同步 kill 子进程（Drop 时调用）。
    fn shutdown_sync(&self) {
        self.kill_sync();
    }

    async fn shutdown(&mut self) -> Result<()> {
        let mut child = self.child.lock().await;
        child
            .kill()
            .await
            .map_err(|e| AppError::ProcessError(format!("kill MCP '{}': {}", self.server_name, e)))?;
        child
            .wait()
            .await
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "wait MCP '{}' after kill: {}",
                    self.server_name, e
                ))
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_roundtrip() {
        assert_eq!(ProtocolVersion::V2025_06_18.as_str(), "2025-06-18");
        assert_eq!(ProtocolVersion::V2026_07_28.as_str(), "2026-07-28");
        assert_eq!(ProtocolVersion::from_server("2026-07-28"), ProtocolVersion::V2026_07_28);
        assert_eq!(ProtocolVersion::from_server("unknown"), ProtocolVersion::V2025_06_18);
    }

    #[test]
    fn protocol_version_handshake_requirement() {
        assert!(ProtocolVersion::V2025_06_18.needs_handshake());
        assert!(!ProtocolVersion::V2026_07_28.needs_handshake());
    }

    #[test]
    fn sanitize_filename_replaces_illegal_chars() {
        let clean = |s: &str| {
            s.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect::<String>()
        };
        assert_eq!(clean("browser-1786989169353-atpos6k"), "browser-1786989169353-atpos6k");
        assert_eq!(clean("session/with\\weird:id"), "session_with_weird_id");
    }
}
