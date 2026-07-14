/*! 终端 PTY 模块
 *
 * 使用 portable-pty 提供终端仿真支持
 */

use std::collections::{HashMap, HashSet};
#[cfg(not(target_os = "android"))]
use std::io::{Read as _, Write as _};
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "android"))]
use std::thread;

#[cfg(not(target_os = "android"))]
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(all(feature = "tauri-app", not(target_os = "android")))]
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::AppState;

/// 终端会话信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    /// 会话 ID
    pub id: String,
    /// 会话名称
    pub name: String,
    /// 工作目录
    pub cwd: Option<String>,
    /// 是否已关闭
    pub closed: bool,
    /// 会话用途
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// 关联脚本 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_id: Option<String>,
}

/// 终端输出事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    /// 会话 ID
    pub session_id: String,
    /// 输出数据 (base64 编码)
    pub data: String,
}

/// 终端退出事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    /// 会话 ID
    pub session_id: String,
    /// 退出码
    pub exit_code: Option<i32>,
}

/// 终端事件输出目标。
///
/// 桌面端通过 Tauri event system 通知 WebView；Web 模式通过 broadcast channel
/// 转发到 WebSocket。事件 payload 保持和前端现有类型一致。
#[derive(Clone)]
pub enum TerminalEventSink {
    #[cfg(all(feature = "tauri-app", not(target_os = "android")))]
    Tauri(AppHandle),
    Web(crate::web::EventBroadcaster),
}

impl TerminalEventSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        match self {
            #[cfg(all(feature = "tauri-app", not(target_os = "android")))]
            TerminalEventSink::Tauri(app_handle) => {
                let _ = app_handle.emit("terminal:output", event);
            }
            TerminalEventSink::Web(tx) => {
                let payload = serde_json::json!({
                    "event": "terminal:output",
                    "payload": event,
                });
                let _ = tx.send(payload.to_string());
            }
        }
    }

    fn emit_exit(&self, event: TerminalExitEvent) {
        match self {
            #[cfg(all(feature = "tauri-app", not(target_os = "android")))]
            TerminalEventSink::Tauri(app_handle) => {
                let _ = app_handle.emit("terminal:exit", event);
            }
            TerminalEventSink::Web(tx) => {
                let payload = serde_json::json!({
                    "event": "terminal:exit",
                    "payload": event,
                });
                let _ = tx.send(payload.to_string());
            }
        }
    }
}

/// 终端会话管理器
pub struct TerminalManager {
    /// PTY 会话映射
    #[cfg(not(target_os = "android"))]
    sessions: Mutex<HashMap<String, PtySession>>,
    /// 已退出但尚未被显式关闭的会话
    closed_sessions: Arc<Mutex<HashSet<String>>>,
}

/// PTY 会话内部结构
#[cfg(not(target_os = "android"))]
struct PtySession {
    /// PTY pair
    #[allow(dead_code)]
    pair: PtyPair,
    /// 输入写入器
    writer: Box<dyn std::io::Write + Send>,
    /// 线程句柄
    thread_handle: Option<thread::JoinHandle<()>>,
    /// 会话信息
    info: TerminalSession,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    /// 创建新的终端管理器
    pub fn new() -> Self {
        Self {
            #[cfg(not(target_os = "android"))]
            sessions: Mutex::new(HashMap::new()),
            closed_sessions: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 创建新的终端会话
    #[cfg(not(target_os = "android"))]
    pub fn create_session(
        &self,
        event_sink: TerminalEventSink,
        name: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        initial_command: Option<String>,
        env: Option<HashMap<String, String>>,
        purpose: Option<String>,
        script_id: Option<String>,
    ) -> Result<TerminalSession> {
        let pty_system = native_pty_system();

        // 创建 PTY
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::ProcessError(format!("无法创建 PTY: {}", e)))?;

        let session_id = Uuid::new_v4().to_string();
        let session_name = name.unwrap_or_else(|| {
            let count = self.sessions.lock().map(|s| s.len() + 1).unwrap_or(1);
            format!("Terminal {}", count)
        });

        // 构建命令 - 使用系统默认 shell
        let initial_command = initial_command
            .map(|command| command.trim().to_string())
            .filter(|command| !command.is_empty());

        let mut cmd = if cfg!(windows) {
            // Windows: 使用 cmd 并设置 UTF-8 编码解决中文乱码
            let mut c = CommandBuilder::new("cmd");
            c.arg("/K");
            if let Some(command) = &initial_command {
                c.arg(format!("chcp 65001 >nul && {}", command));
            } else {
                c.arg("chcp 65001 >nul");
            }
            c
        } else {
            // Unix (Linux/macOS): 使用用户登录 shell
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let mut c = CommandBuilder::new(&shell);
            if let Some(command) = &initial_command {
                c.arg("-lc");
                c.arg(format!("{}; exec {}", command, shell));
            }
            c
        };
        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }
        if let Some(env) = env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        // 启动子进程
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::ProcessError(format!("无法启动 shell: {}", e)))?;

        // 获取读取器和写入器
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::ProcessError(format!("无法获取读取器: {}", e)))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::ProcessError(format!("无法获取写入器: {}", e)))?;

        // 创建会话信息
        let session_info = TerminalSession {
            id: session_id.clone(),
            name: session_name,
            cwd: cwd.clone(),
            closed: false,
            purpose,
            script_id,
        };

        // 启动读取线程
        let session_id_clone = session_id.clone();
        let event_sink_clone = event_sink.clone();
        let closed_sessions = Arc::clone(&self.closed_sessions);
        let thread_handle = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        // EOF - 进程已退出
                        tracing::debug!("[Terminal] 会话 {} 读取到 EOF", session_id_clone);
                        // 发送退出事件
                        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);
                        if let Ok(mut closed) = closed_sessions.lock() {
                            closed.insert(session_id_clone.clone());
                        }
                        event_sink_clone.emit_exit(TerminalExitEvent {
                            session_id: session_id_clone.clone(),
                            exit_code,
                        });
                        break;
                    }
                    Ok(n) => {
                        // 发送输出数据
                        let data = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &buffer[..n],
                        );
                        event_sink_clone.emit_output(TerminalOutputEvent {
                            session_id: session_id_clone.clone(),
                            data,
                        });
                    }
                    Err(e) => {
                        tracing::error!("[Terminal] 会话 {} 读取错误: {}", session_id_clone, e);
                        break;
                    }
                }
            }
        });

        // 存储会话
        let session = PtySession {
            pair,
            writer,
            thread_handle: Some(thread_handle),
            info: session_info.clone(),
        };

        self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?
            .insert(session_id, session);

        tracing::info!("[Terminal] 创建会话成功: {:?}", session_info);
        Ok(session_info)
    }

    /// 写入数据到终端
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(session) = sessions.get_mut(session_id) {
            // 解码 base64 数据
            let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
                .map_err(|e| AppError::ParseError(format!("Base64 解码失败: {}", e)))?;

            session
                .writer
                .write_all(&decoded)
                .map_err(|e| AppError::ProcessError(format!("写入失败: {}", e)))?;

            session
                .writer
                .flush()
                .map_err(|e| AppError::ProcessError(format!("刷新失败: {}", e)))?;

            Ok(())
        } else {
            Err(AppError::SessionNotFound(session_id.to_string()))
        }
    }

    /// 调整终端大小
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(session) = sessions.get(session_id) {
            session
                .pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| AppError::ProcessError(format!("调整大小失败: {}", e)))?;

            Ok(())
        } else {
            Err(AppError::SessionNotFound(session_id.to_string()))
        }
    }

    /// 关闭终端会话
    pub fn close_session(&self, session_id: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(mut session) = sessions.remove(session_id) {
            if let Ok(mut closed) = self.closed_sessions.lock() {
                closed.remove(session_id);
            }
            // 关闭写入器
            let _ = session.writer.write_all(&[3]); // 发送 Ctrl+C

            // 等待线程结束（最多等待 1 秒）
            if let Some(handle) = session.thread_handle.take() {
                // 简单处理，不等待
                drop(handle);
            }

            session.info.closed = true;
            tracing::info!("[Terminal] 会话已关闭: {}", session_id);
            Ok(())
        } else {
            Err(AppError::SessionNotFound(session_id.to_string()))
        }
    }

    /// 获取所有会话
    pub fn list_sessions(&self) -> Result<Vec<TerminalSession>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        let closed = self
            .closed_sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        Ok(sessions
            .values()
            .filter(|s| !closed.contains(&s.info.id))
            .map(|s| s.info.clone())
            .collect())
    }

    /// 获取单个会话
    pub fn get_session(&self, session_id: &str) -> Result<TerminalSession> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        let closed = self
            .closed_sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        sessions
            .get(session_id)
            .map(|s| {
                let mut info = s.info.clone();
                info.closed = closed.contains(session_id);
                info
            })
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// 创建终端会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_create(
    app_handle: AppHandle,
    state: tauri::State<AppState>,
    name: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    initial_command: Option<String>,
    env: Option<HashMap<String, String>>,
    purpose: Option<String>,
    script_id: Option<String>,
) -> Result<TerminalSession> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.create_session(
        TerminalEventSink::Tauri(app_handle),
        name,
        cwd,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        initial_command,
        env,
        purpose,
        script_id,
    )
}

/// 写入终端
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_write(
    state: tauri::State<AppState>,
    session_id: String,
    data: String,
) -> Result<()> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.write(&session_id, &data)
}

/// 调整终端大小
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.resize(&session_id, cols, rows)
}

/// 关闭终端会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_close(state: tauri::State<AppState>, session_id: String) -> Result<()> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.close_session(&session_id)
}

/// 获取所有终端会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_list(state: tauri::State<AppState>) -> Result<Vec<TerminalSession>> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.list_sessions()
}

/// 获取单个终端会话
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_get(state: tauri::State<AppState>, session_id: String) -> Result<TerminalSession> {
    let manager = state
        .terminal_manager
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.get_session(&session_id)
}

/// 在外部系统终端中运行命令
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn terminal_open_in_external(
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<()> {
    use std::process::Command;

    let cwd = cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    #[cfg(windows)]
    {
        use std::io::Write;

        // 创建临时 .bat 文件，避免 start 命令的引号解析问题
        let bat_dir = std::env::temp_dir();
        let bat_path = bat_dir.join(format!(
            "polaris_external_terminal_{}.bat",
            std::process::id()
        ));

        let mut bat_content = format!(
            "@echo off\r\n\
             chcp 65001 >nul\r\n\
             cd /d \"{}\"\r\n\
             {}\r\n",
            cwd, command
        );

        // 追加 pause 让窗口保持打开，方便查看输出
        bat_content.push_str("pause\r\n");

        // 写入临时 .bat 文件
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| AppError::ProcessError(format!("无法创建临时脚本: {}", e)))?;
        bat_file
            .write_all(bat_content.as_bytes())
            .map_err(|e| AppError::ProcessError(format!("无法写入临时脚本: {}", e)))?;
        drop(bat_file);

        let mut cmd = Command::new("cmd");
        cmd.args([
            "/C",
            "start",
            "cmd",
            "/K",
            bat_path.to_string_lossy().as_ref(),
        ]);

        if let Some(ref env_map) = env {
            for (key, value) in env_map {
                cmd.env(key, value);
            }
        }

        cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("无法启动外部终端: {}", e)))?;

        tracing::info!(
            "[Terminal] 已启动外部终端: cwd={}, command={}, bat={}",
            cwd,
            command,
            bat_path.display()
        );
    }

    #[cfg(not(windows))]
    {
        // Linux/macOS: 尝试常见的终端模拟器
        let mut spawned = false;

        #[cfg(target_os = "macos")]
        {
            // macOS: 使用 open -a Terminal
            let result = Command::new("open").args(["-a", "Terminal", &cwd]).spawn();
            if result.is_ok() {
                spawned = true;
                tracing::info!(
                    "[Terminal] 已启动外部终端 (macOS Terminal.app): cwd={}",
                    cwd
                );
            }
        }

        #[cfg(target_os = "linux")]
        {
            let shell_cmd = format!("cd \"{}\" && exec \"$SHELL\"", cwd);
            let terminal_candidates = vec![
                (
                    "gnome-terminal",
                    vec!["--", "/bin/sh", "-c", shell_cmd.as_str()],
                ),
                ("konsole", vec!["-e", "/bin/sh", "-c", shell_cmd.as_str()]),
                ("xfce4-terminal", vec!["-e", shell_cmd.as_str()]),
                ("xterm", vec!["-e", shell_cmd.as_str()]),
                ("x-terminal-emulator", vec!["-e", shell_cmd.as_str()]),
            ];

            for (terminal, args) in &terminal_candidates {
                let result = Command::new(terminal).args(args).current_dir(&cwd).spawn();
                if result.is_ok() {
                    spawned = true;
                    tracing::info!("[Terminal] 已启动外部终端 ({}): cwd={}", terminal, cwd);
                    break;
                }
            }
        }

        if !spawned {
            return Err(AppError::ProcessError(
                "未找到可用的外部终端模拟器，请手动安装 gnome-terminal、konsole 或 xterm"
                    .to_string(),
            ));
        }
    }

    Ok(())
}
