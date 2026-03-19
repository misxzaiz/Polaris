/*! 终端 PTY 模块
 *
 * 使用 portable-pty 提供终端仿真支持
 */

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
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

/// 终端会话管理器
pub struct TerminalManager {
    /// PTY 会话映射
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// PTY 会话内部结构
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

impl TerminalManager {
    /// 创建新的终端管理器
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 创建新的终端会话
    pub fn create_session(
        &self,
        app_handle: AppHandle,
        name: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
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
            let count = self.sessions.lock()
                .map(|s| s.len() + 1)
                .unwrap_or(1);
            format!("Terminal {}", count)
        });

        // 构建命令 - 使用系统默认 shell
        // 使用 /K 参数执行 chcp 65001 设置 UTF-8 编码，解决中文乱码问题
        let mut cmd = CommandBuilder::new("cmd");
        cmd.arg("/K");
        cmd.arg("chcp 65001 >nul");
        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
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
        };

        // 启动读取线程
        let session_id_clone = session_id.clone();
        let app_handle_clone = app_handle.clone();
        let thread_handle = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        // EOF - 进程已退出
                        tracing::debug!("[Terminal] 会话 {} 读取到 EOF", session_id_clone);
                        // 发送退出事件
                        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);
                        let _ = app_handle_clone.emit("terminal:exit", TerminalExitEvent {
                            session_id: session_id_clone.clone(),
                            exit_code,
                        });
                        break;
                    }
                    Ok(n) => {
                        // 发送输出数据
                        let data = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &buffer[..n]
                        );
                        let _ = app_handle_clone.emit("terminal:output", TerminalOutputEvent {
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
        let mut sessions = self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(session) = sessions.get_mut(session_id) {
            // 解码 base64 数据
            let decoded = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                data
            ).map_err(|e| AppError::ParseError(format!("Base64 解码失败: {}", e)))?;

            session.writer
                .write_all(&decoded)
                .map_err(|e| AppError::ProcessError(format!("写入失败: {}", e)))?;

            session.writer
                .flush()
                .map_err(|e| AppError::ProcessError(format!("刷新失败: {}", e)))?;

            Ok(())
        } else {
            Err(AppError::SessionNotFound(session_id.to_string()))
        }
    }

    /// 调整终端大小
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(session) = sessions.get(session_id) {
            session.pair.master
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
        let mut sessions = self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        if let Some(mut session) = sessions.remove(session_id) {
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
        let sessions = self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        Ok(sessions.values().map(|s| s.info.clone()).collect())
    }

    /// 获取单个会话
    pub fn get_session(&self, session_id: &str) -> Result<TerminalSession> {
        let sessions = self.sessions
            .lock()
            .map_err(|e| AppError::StateError(format!("无法获取锁: {}", e)))?;

        sessions
            .get(session_id)
            .map(|s| s.info.clone())
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// 创建终端会话
#[tauri::command]
pub fn terminal_create(
    app_handle: AppHandle,
    state: tauri::State<AppState>,
    name: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSession> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.create_session(
        app_handle,
        name,
        cwd,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
    )
}

/// 写入终端
#[tauri::command]
pub fn terminal_write(
    state: tauri::State<AppState>,
    session_id: String,
    data: String,
) -> Result<()> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.write(&session_id, &data)
}

/// 调整终端大小
#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.resize(&session_id, cols, rows)
}

/// 关闭终端会话
#[tauri::command]
pub fn terminal_close(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<()> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.close_session(&session_id)
}

/// 获取所有终端会话
#[tauri::command]
pub fn terminal_list(
    state: tauri::State<AppState>,
) -> Result<Vec<TerminalSession>> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.list_sessions()
}

/// 获取单个终端会话
#[tauri::command]
pub fn terminal_get(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<TerminalSession> {
    let manager = state.terminal_manager.lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    manager.get_session(&session_id)
}
