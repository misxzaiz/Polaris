/*! LSP 语言服务器进程管理器
 *
 * 轻量管道架构：Rust 只做 stdin/stdout 字节流转发，零 JSON-RPC 解析。
 * LSP 协议由前端 @codemirror/lsp-client 完整处理。
 *
 * 读线程：Content-Length header → 读 N 字节 body → emit 完整 JSON 字符串
 * 写入：组装 Content-Length 帧头 + JSON body → stdin
 */

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 在 PATH 中解析可执行文件的真实路径。
///
/// 返回 `(完整路径, 是否为批处理脚本)`。Windows 上会按 `PATHEXT` 依次补全扩展名，
/// 因此能命中 npm 全局安装的 `*.cmd`，也能命中原生 `*.exe`。
///
/// 解析出真实路径后，原生可执行文件可直接 spawn（避免 `cmd /C` 包装带来的
/// 额外进程与"路径含空格被拆词"问题）；仅 `.cmd/.bat` 才需要 `cmd` 解释执行。
fn resolve_executable(command: &str) -> Option<(std::path::PathBuf, bool)> {
    use std::path::{Path, PathBuf};

    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect();

    fn is_batch(p: &Path) -> bool {
        #[cfg(windows)]
        {
            matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
                    .as_deref(),
                Some("cmd") | Some("bat")
            )
        }
        #[cfg(not(windows))]
        {
            let _ = p;
            false
        }
    }

    // 给定一个候选基路径，返回真实存在的文件路径（Windows 下尝试补全 PATHEXT）
    let try_path = |base: &Path| -> Option<PathBuf> {
        if base.is_file() {
            return Some(base.to_path_buf());
        }
        #[cfg(windows)]
        {
            for ext in &exts {
                let cand = PathBuf::from(format!("{}{}", base.display(), ext));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
        None
    };

    // 1) 命令本身带路径分隔符 → 按绝对/相对路径直接解析
    if command.contains('/') || command.contains('\\') {
        return try_path(Path::new(command)).map(|p| {
            let b = is_batch(&p);
            (p, b)
        });
    }

    // 2) 在 PATH 各目录中查找
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if let Some(found) = try_path(&dir.join(command)) {
            let b = is_batch(&found);
            return Some((found, b));
        }
    }
    None
}

/// 检查命令是否可在 PATH 中找到，返回解析到的完整路径（供设置页校验用）。
pub fn which_command(command: &str) -> Option<String> {
    resolve_executable(command).map(|(p, _)| p.to_string_lossy().to_string())
}

/// LSP 会话：持有子进程和 stdin 句柄
struct LspSession {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl LspSession {
    /// 检查子进程是否仍在运行
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        // 先关闭 stdin 管道，通知 LSP 服务器退出
        self.stdin.take();
        // 强制终止 + 回收资源
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// LSP 进程管理器
pub struct LspManager {
    sessions: HashMap<String, LspSession>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// 启动语言服务器进程
    ///
    /// spawn 后启动独立读线程，将 stdout 中的完整 JSON-RPC 消息
    /// 通过 Tauri event 转发到前端
    #[cfg(feature = "tauri-app")]
    pub fn start(
        &mut self,
        id: String,
        command: &str,
        args: &[String],
        app_handle: AppHandle,
    ) -> Result<()> {
        // 幂等：如果 session 已存在且进程仍活着，直接返回成功
        if let Some(session) = self.sessions.get_mut(&id) {
            if session.is_alive() {
                return Ok(());
            }
            // 进程已退出，清理僵尸条目（Drop 会自动 kill+wait）
            let _ = self.sessions.remove(&id);
        }

        // 解析真实可执行路径：
        // - 原生可执行（.exe / Unix 二进制）→ 直接 spawn 完整路径，避免 cmd.exe 包装
        //   与"路径含空格被拆词"的问题；
        // - npm 全局包脚本（.cmd/.bat）→ 用 cmd /C 执行已解析的完整路径；
        // - 解析失败 → Windows 回退旧的 cmd /C 行为（再让系统试一次），其它平台直接 spawn
        //   原命令以暴露清晰的 "not found" 错误。
        let (actual_command, actual_args) = match resolve_executable(command) {
            Some((path, is_batch)) => {
                let path_str = path.to_string_lossy().to_string();
                if is_batch {
                    let mut v = vec!["/C".to_string(), path_str];
                    v.extend(args.iter().cloned());
                    ("cmd".to_string(), v)
                } else {
                    (path_str, args.to_vec())
                }
            }
            None => {
                #[cfg(windows)]
                {
                    let full_args: Vec<String> = std::iter::once(command.to_string())
                        .chain(args.iter().cloned())
                        .collect();
                    let mut v = vec!["/C".to_string()];
                    v.extend(full_args);
                    ("cmd".to_string(), v)
                }
                #[cfg(not(windows))]
                {
                    (command.to_string(), args.to_vec())
                }
            }
        };

        let mut cmd = Command::new(&actual_command);
        cmd.args(&actual_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Windows 下不创建控制台窗口
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            AppError::ProcessError(format!("Failed to spawn LSP server '{}': {}", command, e))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::ProcessError("Failed to get stdin handle".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::ProcessError("Failed to get stdout handle".to_string())
        })?;
        let stderr = child.stderr.take();

        let session_id = id.clone();
        let exit_app = app_handle.clone();

        // stderr 读线程：转发 LS 诊断日志到前端
        if let Some(stderr) = stderr {
            let sid = id.clone();
            let ea = app_handle.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let _ = ea.emit(
                                &format!("lsp-stderr-{}", sid),
                                line.trim_end(),
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // 读线程：Content-Length 帧边界识别 → emit 完整 JSON
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);

            loop {
                // 步骤 1: 逐字节读 header，直到 \r\n\r\n
                let mut header_buf = Vec::with_capacity(256);
                let mut prev: [u8; 4] = [0; 4];

                loop {
                    let mut byte = [0u8; 1];
                    match reader.read_exact(&mut byte) {
                        Ok(()) => {
                            header_buf.push(byte[0]);
                            // 检测 \r\n\r\n (0x0D 0x0A 0x0D 0x0A)
                            prev[0] = prev[1];
                            prev[1] = prev[2];
                            prev[2] = prev[3];
                            prev[3] = byte[0];
                            if prev == [b'\r', b'\n', b'\r', b'\n'] {
                                break;
                            }
                        }
                        Err(_) => {
                            // 进程退出或读取错误
                            let _ =
                                exit_app.emit(&format!("lsp-exit-{}", session_id), "process exited");
                            return;
                        }
                    }
                }

                // 步骤 2: 从 header 解析 Content-Length（纯 ASCII 解析，非 JSON）
                let header_str = String::from_utf8_lossy(&header_buf);
                let content_length: usize = header_str
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);

                if content_length == 0 || content_length > 10_000_000 {
                    continue; // 跳过无效帧
                }

                // 步骤 3: 读取恰好 N 字节的 body
                let mut body = vec![0u8; content_length];
                if reader.read_exact(&mut body).is_err() {
                    let _ = exit_app.emit(&format!("lsp-exit-{}", session_id), "read error");
                    return;
                }

                // 步骤 4: 转发完整 JSON 字符串到前端
                let json_str = String::from_utf8_lossy(&body).to_string();
                let _ = exit_app.emit(&format!("lsp-data-{}", session_id), &json_str);
            }
        });

        self.sessions.insert(id, LspSession { child, stdin: Some(stdin) });
        Ok(())
    }

    /// 发送 JSON-RPC 消息到语言服务器
    ///
    /// 组装 Content-Length 帧头 + JSON body → 写入 stdin
    pub fn send(&mut self, id: &str, json: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;

        let stdin = session.stdin.as_mut().ok_or_else(|| {
            AppError::ProcessError("LSP stdin closed".to_string())
        })?;

        let frame = format!("Content-Length: {}\r\n\r\n{}", json.len(), json);
        stdin
            .write_all(frame.as_bytes())
            .map_err(|e| AppError::ProcessError(format!("LSP stdin write failed: {}", e)))?;
        stdin
            .flush()
            .map_err(|e| AppError::ProcessError(format!("LSP stdin flush failed: {}", e)))?;
        Ok(())
    }

    /// 停止语言服务器进程
    pub fn stop(&mut self, id: &str) -> Result<()> {
        if let Some(_session) = self.sessions.remove(id) {
            // Drop impl handles kill + wait
        }
        Ok(())
    }

    /// 列出所有活跃会话
    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}
