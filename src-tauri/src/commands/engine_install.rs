//! 引擎安装 / 卸载 / 检测 Tauri 命令
//!
//! 面向「npm / npx 分发」的 AI 引擎（Claude Code、Codex），提供：
//! - `engine_detect_version`：检测本地是否已安装及版本
//! - `engine_install`：`npm install -g <pkg>[@version]`（流式日志）
//! - `engine_uninstall`：`npm uninstall -g <pkg>`（流式日志）
//!
//! 安装/卸载过程通过 `engine-install:event` 事件向前端推送实时日志，
//! 前端按 `task_id` 区分不同安装会话。
//!
//! Web 模式（HTTP + WebSocket）通过 `EventBroadcaster` 推送事件，
//! Tauri 桌面端通过 `AppHandle.emit()` 推送。两者共享 `run_npm_streaming_with_emit`。

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Emitter};

use std::sync::Arc;

use crate::error::{AppError, Result};
use crate::services::cli_info_service::{check_cli_installed, find_cli_paths, get_cli_version};

/// 引擎本地安装状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallStatus {
    /// 是否检测到已安装
    pub installed: bool,
    /// 版本号（`<cli> --version` 输出，可能为 None）
    pub version: Option<String>,
    /// 解析到的可执行文件路径（可能为 None）
    pub path: Option<String>,
}

/// 安装/卸载过程事件载荷
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallEvent {
    /// 安装会话标识（前端用以区分并发安装）
    pub task_id: String,
    /// 事件类型："started" | "log" | "done" | "error"
    pub kind: String,
    /// 日志/消息内容
    pub line: String,
}

/// 检测引擎本地安装状态（命令名传入 `claude` / `codex`）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn engine_detect_version(cli_name: String) -> EngineInstallStatus {
    let paths = find_cli_paths(&cli_name);
    let installed = !paths.is_empty() || check_cli_installed(&cli_name);
    let version = if installed {
        get_cli_version(&cli_name).ok()
    } else {
        None
    };
    EngineInstallStatus {
        installed,
        version,
        path: paths.into_iter().next(),
    }
}

/// Web 模式下的 engine_detect_version 实现（不依赖 Tauri）。
/// 直接调用 `engine_detect_version_inner` 保持桌面端与 Web 端行为一致。
pub fn engine_detect_version_impl(cli_name: &str) -> EngineInstallStatus {
    let paths = find_cli_paths(cli_name);
    let installed = !paths.is_empty() || check_cli_installed(cli_name);
    let version = if installed {
        get_cli_version(cli_name).ok()
    } else {
        None
    };
    EngineInstallStatus {
        installed,
        version,
        path: paths.into_iter().next(),
    }
}

/// 安装（或更新）引擎：`npm install -g <package>[@version]`
///
/// `version` 为空时安装 `@latest`（亦即「更新到最新」）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn engine_install(
    app: AppHandle,
    npm_package: String,
    version: Option<String>,
    task_id: String,
) -> Result<String> {
    let spec = match version.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => format!("{}@{}", npm_package, v),
        _ => format!("{}@latest", npm_package),
    };
    run_npm_streaming_with_emit(
        &task_id,
        vec!["install".to_string(), "-g".to_string(), spec.clone()],
        &spec,
        {
            let app = app.clone();
            Arc::new(move |task_id: &str, kind: &str, line: &str| {
                let _ = app.emit(
                    "engine-install:event",
                    InstallEvent {
                        task_id: task_id.to_string(),
                        kind: kind.to_string(),
                        line: line.to_string(),
                    },
                );
            })
        },
    )
    .await
}

/// 卸载引擎：`npm uninstall -g <package>`
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn engine_uninstall(
    app: AppHandle,
    npm_package: String,
    task_id: String,
) -> Result<String> {
    run_npm_streaming_with_emit(
        &task_id,
        vec!["uninstall".to_string(), "-g".to_string(), npm_package.clone()],
        &npm_package,
        {
            let app = app.clone();
            Arc::new(move |task_id: &str, kind: &str, line: &str| {
                let _ = app.emit(
                    "engine-install:event",
                    InstallEvent {
                        task_id: task_id.to_string(),
                        kind: kind.to_string(),
                        line: line.to_string(),
                    },
                );
            })
        },
    )
    .await
}

/// 全局安装应使用的中性工作目录。
///
/// **关键**：若沿用应用进程的 cwd（dev 模式下即 Polaris 项目目录），
/// npm 会逐级读取该目录的 `.npmrc`（含 pnpm 的 `node-linker` 等设置），
/// 导致 `-g` 全局安装行为异常、甚至把包落到项目内。固定到用户 home
/// 目录可隔离项目级 npm 配置，并确保绝不污染用户工程。
fn neutral_cwd() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// 查询 npm 真实全局安装前缀（`npm prefix -g`），用于安装后回显与定位。
fn query_npm_global_prefix() -> Option<String> {
    let mut cmd = build_npm_command(&["prefix".to_string(), "-g".to_string()]);
    cmd.current_dir(neutral_cwd());
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(prefix)
    }
}

/// 构建跨平台 npm 命令。
///
/// Windows 下 `npm` 实为 `npm.cmd`，CreateProcess 无法直接执行，需经 `cmd /c`。
fn build_npm_command(args: &[String]) -> std::process::Command {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/c").arg("npm");
        for a in args {
            c.arg(a);
        }
        c.creation_flags(crate::utils::CREATE_NO_WINDOW);
        c
    }

    #[cfg(not(windows))]
    {
        let mut c = Command::new("npm");
        for a in args {
            c.arg(a);
        }
        c
    }
}

/// 执行 npm 命令并将 stdout/stderr 逐行流式推送到前端。
///
/// 放入 `spawn_blocking`：子进程读管道为阻塞 IO，避免阻塞 async runtime。
///
/// 通过 `emit_fn` 回调推送事件，解耦 Tauri `AppHandle.emit` 与 Web `EventBroadcaster.send`。
pub async fn run_npm_streaming_with_emit<F>(
    task_id: &str,
    args: Vec<String>,
    spec: &str,
    emit_fn: Arc<F>,
) -> Result<String>
where
    F: Fn(&str, &str, &str) + Send + Sync + 'static,
{
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let task_id = task_id.to_string();
    let spec = spec.to_string();

    tokio::task::spawn_blocking(move || {
        emit_fn(&task_id, "started", &spec);

        // 在中性目录（用户 home）下执行，隔离项目级 .npmrc 对 -g 全局安装的干扰
        let cwd = neutral_cwd();
        if let Some(prefix) = query_npm_global_prefix() {
            emit_fn(&task_id, "log", &format!("npm 全局目录: {}", prefix));
        }

        let mut cmd = build_npm_command(&args);
        cmd.current_dir(&cwd);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("启动 npm 失败: {}（请确认已安装 Node.js / npm 并在 PATH 中）", e);
            emit_fn(&task_id, "error", &msg);
            AppError::ProcessError(msg)
        })?;

        // 并行读取 stdout / stderr，逐行推送
        let mut handles = Vec::new();
        if let Some(out) = child.stdout.take() {
            let tid = task_id.clone();
            let emit = emit_fn.clone();
            handles.push(std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
                    emit(&tid, "log", &line);
                }
            }));
        }
        if let Some(err) = child.stderr.take() {
            let tid = task_id.clone();
            let emit = emit_fn.clone();
            handles.push(std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(|l| l.ok()) {
                    emit(&tid, "log", &line);
                }
            }));
        }

        let status = child.wait().map_err(|e| {
            let msg = format!("等待 npm 进程失败: {}", e);
            emit_fn(&task_id, "error", &msg);
            AppError::ProcessError(msg)
        })?;

        for h in handles {
            let _ = h.join();
        }

        if status.success() {
            emit_fn(&task_id, "done", &spec);
            Ok(spec)
        } else {
            let msg = format!("npm 命令执行失败（退出码 {:?}）", status.code());
            emit_fn(&task_id, "error", &msg);
            Err(AppError::ProcessError(msg))
        }
    })
    .await
    .map_err(|e| AppError::Unknown(format!("安装任务执行失败: {}", e)))?
}