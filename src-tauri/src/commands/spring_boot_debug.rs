//! Spring Boot 内置调试桥
//!
//! 管理一个 JDI 调试代理子进程（`PolarisDebugAgent.java`，随二进制内嵌），
//! 通过 stdin 下发行命令、读取 stdout 的 JSON 事件并转发到前端
//! （Tauri 事件 `spring-boot-debug:event`，每条 payload 为一行 JSON 字符串）。
//!
//! 代理用 JDK 自带 `com.sun.jdi`，以单文件源码模式运行（免编译）：
//!   `java --add-modules jdk.jdi <PolarisDebugAgent.java> <port>`

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};

use crate::error::{AppError, Result};
use crate::state::AppState;

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Emitter};

/// 内嵌的调试代理源码——随二进制走，运行时落地为临时文件。
const AGENT_SOURCE: &str = include_str!("../../resources/debug-agent/PolarisDebugAgent.java");

/// 单个调试会话句柄。
pub struct DebugSession {
    child: Child,
    stdin: ChildStdin,
}

/// 调试会话管理器（AppState 持有；同一时刻仅一个活动会话）。
#[derive(Default)]
pub struct DebugManager {
    session: Option<DebugSession>,
}

impl DebugManager {
    pub fn new() -> Self {
        Self { session: None }
    }
}

/// 解析 `java` 可执行文件：优先 JAVA_HOME，回退 PATH。
fn java_executable() -> String {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let exe = if cfg!(windows) { "java.exe" } else { "java" };
        let candidate = PathBuf::from(home).join("bin").join(exe);
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "java".to_string()
}

/// 将内嵌代理源码落地到临时目录（文件名须匹配 public class 名）。
fn materialize_agent() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("polaris-debug-agent");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::ProcessError(format!("无法创建调试代理目录: {}", e)))?;
    let path = dir.join("PolarisDebugAgent.java");
    std::fs::write(&path, AGENT_SOURCE)
        .map_err(|e| AppError::ProcessError(format!("无法写入调试代理: {}", e)))?;
    Ok(path)
}

/// 终止并清理会话（最佳努力）。
fn terminate(mut session: DebugSession) {
    let _ = session.stdin.write_all(b"disconnect\n");
    let _ = session.stdin.flush();
    let _ = session.child.kill();
    let _ = session.child.wait();
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// 启动调试代理并 attach 到目标 JVM 的 JDWP 端口。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_debug_start(
    app: AppHandle,
    state: tauri::State<AppState>,
    port: u16,
) -> Result<()> {
    let mut mgr = state
        .spring_debug
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;

    // 清理可能存在的旧会话
    if let Some(old) = mgr.session.take() {
        terminate(old);
    }

    let agent_path = materialize_agent()?;
    let java = java_executable();

    let mut child = Command::new(&java)
        .args(["--add-modules", "jdk.jdi"])
        .arg(&agent_path)
        .arg(port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::ProcessError(format!("无法启动调试代理(java): {}", e)))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::ProcessError("无法获取代理 stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::ProcessError("无法获取代理 stderr".to_string()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::ProcessError("无法获取代理 stdin".to_string()))?;

    // stdout：逐行 JSON 事件 → 转发前端
    let app_out = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(|l| l.ok()) {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_out.emit("spring-boot-debug:event", line);
        }
        // EOF：代理退出
        let _ = app_out.emit(
            "spring-boot-debug:event",
            r#"{"event":"terminated"}"#.to_string(),
        );
    });

    // stderr：JVM/代理诊断 → 日志
    let app_err = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(|l| l.ok()) {
            if line.trim().is_empty() {
                continue;
            }
            tracing::warn!("[spring-debug-agent] {}", line);
            let payload =
                serde_json::json!({ "event": "log", "message": line }).to_string();
            let _ = app_err.emit("spring-boot-debug:event", payload);
        }
    });

    mgr.session = Some(DebugSession { child, stdin });
    tracing::info!("[spring-debug] 调试代理已启动，attach 端口 {}", port);
    Ok(())
}

/// 向调试代理发送一行命令（如 `setBreakpoint b1 com.x.Y 23` / `continue`）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_debug_send(state: tauri::State<AppState>, line: String) -> Result<()> {
    let mut mgr = state
        .spring_debug
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    let session = mgr
        .session
        .as_mut()
        .ok_or_else(|| AppError::ProcessError("调试会话未启动".to_string()))?;
    let mut cmd = line;
    if !cmd.ends_with('\n') {
        cmd.push('\n');
    }
    session
        .stdin
        .write_all(cmd.as_bytes())
        .map_err(|e| AppError::ProcessError(format!("写入调试命令失败: {}", e)))?;
    session
        .stdin
        .flush()
        .map_err(|e| AppError::ProcessError(format!("刷新调试命令失败: {}", e)))?;
    Ok(())
}

/// 停止调试会话并清理代理进程。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_debug_stop(state: tauri::State<AppState>) -> Result<()> {
    let mut mgr = state
        .spring_debug
        .lock()
        .map_err(|e| AppError::StateError(e.to_string()))?;
    if let Some(session) = mgr.session.take() {
        terminate(session);
        tracing::info!("[spring-debug] 调试会话已停止");
    }
    Ok(())
}

/// 查询调试代理使用的 `java` 路径（前端可用于诊断）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn spring_boot_debug_java_path(_app: AppHandle) -> Result<String> {
    Ok(java_executable())
}
