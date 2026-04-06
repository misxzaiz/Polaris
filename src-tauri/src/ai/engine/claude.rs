use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::ai::event_parser::EventParser;
use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::events::StreamEvent;
use crate::models::AIEvent;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Claude Code 引擎
pub struct ClaudeEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
    /// Node.js 路径 (Windows)
    #[cfg(windows)]
    node_exe: Option<String>,
    /// cli.js 路径 (Windows)
    #[cfg(windows)]
    cli_js: Option<String>,
}

impl ClaudeEngine {
    /// 创建新的 Claude 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
            #[cfg(windows)]
            node_exe: None,
            #[cfg(windows)]
            cli_js: None,
        }
    }

    /// 获取 Claude CLI 路径
    fn get_cli_path(&mut self) -> Result<&str> {
        if self.cli_path.is_none() {
            self.cli_path = Some(self.config.get_claude_cmd());
        }
        Ok(self.cli_path.as_ref().unwrap())
    }

    /// 检查 CLI 是否可用
    fn check_cli_available(&mut self) -> bool {
        #[cfg(windows)]
        {
            if self.node_exe.is_none() || self.cli_js.is_none() {
                let cli_path = match self.get_cli_path() {
                    Ok(p) => p,
                    Err(_) => return false,
                };

                match resolve_node_and_cli(cli_path) {
                    Ok((node, cli)) => {
                        self.node_exe = Some(node);
                        self.cli_js = Some(cli);
                    }
                    Err(_) => return false,
                }
            }

            // 检查文件是否存在
            self.node_exe.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false)
                && self.cli_js.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false)
        }

        #[cfg(not(windows))]
        {
            let cli_path = match self.get_cli_path() {
                Ok(p) => p,
                Err(_) => return false,
            };

            // Unix/Linux/Mac: 检查文件是否存在或使用 which 查找
            Path::new(cli_path).exists() ||
                std::process::Command::new("which")
                    .arg(cli_path)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
        }
    }

    /// 构建命令
    fn build_command(
        &self,
        message: &str,
        system_prompt: Option<&str>,
        append_system_prompt: Option<&str>,
        session_id: Option<&str>,
        mcp_config_path: Option<&str>,
    ) -> Result<Command> {
        #[cfg(windows)]
        {
            let node_exe = self.node_exe.as_ref()
                .ok_or_else(|| AppError::ProcessError("Node.js 路径未初始化".to_string()))?;
            let cli_js = self.cli_js.as_ref()
                .ok_or_else(|| AppError::ProcessError("cli.js 路径未初始化".to_string()))?;

            let mut cmd = Command::new(node_exe);
            cmd.arg(cli_js);

            if let Some(sid) = session_id {
                cmd.arg("--resume").arg(sid);
            }

            // 先追加工作区信息（始终追加）
            if let Some(prompt) = append_system_prompt {
                if !prompt.is_empty() {
                    cmd.arg("--append-system-prompt").arg(prompt);
                }
            }

            // 再处理用户自定义系统提示词（会覆盖默认部分）
            if let Some(prompt) = system_prompt {
                if !prompt.is_empty() {
                    cmd.arg("--system-prompt").arg(prompt);
                }
            }

            if let Some(path) = mcp_config_path {
                if !path.is_empty() {
                    cmd.arg("--mcp-config").arg(path);
                }
            }

            cmd.arg("--print")
                .arg("--verbose")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--permission-mode")
                .arg("bypassPermissions")
                .arg(message);

            Ok(cmd)
        }

        #[cfg(not(windows))]
        {
            let cli_path = self.cli_path.as_ref()
                .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

            let mut cmd = Command::new(cli_path);

            if let Some(sid) = session_id {
                cmd.arg("--resume").arg(sid);
            }

            // 先追加工作区信息（始终追加）
            if let Some(prompt) = append_system_prompt {
                if !prompt.is_empty() {
                    cmd.arg("--append-system-prompt").arg(prompt);
                }
            }

            // 再处理用户自定义系统提示词（会覆盖默认部分）
            if let Some(prompt) = system_prompt {
                if !prompt.is_empty() {
                    cmd.arg("--system-prompt").arg(prompt);
                }
            }

            if let Some(path) = mcp_config_path {
                if !path.is_empty() {
                    cmd.arg("--mcp-config").arg(path);
                }
            }

            cmd.arg("--print")
                .arg("--verbose")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--permission-mode")
                .arg("bypassPermissions")
                .arg(message);

            Ok(cmd)
        }
    }

    /// 配置命令（设置工作目录、环境变量等）
    fn configure_command(&self, cmd: &mut Command, work_dir: Option<&str>) {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // 设置工作目录
        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }

        // 设置 Git Bash 环境变量 (Windows)
        if let Some(ref git_bash_path) = self.config.git_bin_path {
            cmd.env("CLAUDE_CODE_GIT_BASH_PATH", git_bash_path);
        }
    }

    /// 启动后台线程读取事件
    ///
    /// 返回 input_sender，用于向进程 stdin 发送输入
    fn spawn_event_reader(
        &self,
        child: Child,
        temp_id: String,
        pid: u32,
        options: SessionOptions,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let current_session_id = temp_id.clone();

        // 创建 stdin 输入 channel
        let (input_sender, input_receiver) = std::sync::mpsc::channel::<String>();

        // 克隆 input_sender 用于返回给调用者
        let input_sender_for_return = input_sender.clone();

        std::thread::spawn(move || {
            let (stdout, stdin) = match (child.stdout, child.stdin) {
                (Some(s), Some(i)) => (s, i),
                _ => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程输入/输出流".to_string());
                    }
                    return;
                }
            };

            let stderr = match child.stderr {
                Some(s) => s,
                None => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程错误流".to_string());
                    }
                    return;
                }
            };

            // 启动 stdin 写入线程
            std::thread::spawn(move || {
                use std::io::Write;
                let mut stdin_writer = stdin;
                while let Ok(input) = input_receiver.recv() {
                    match stdin_writer.write_all(input.as_bytes()) {
                        Ok(_) => {
                            if let Err(e) = stdin_writer.flush() {
                                tracing::warn!("[ClaudeEngine] stdin flush 失败: {}", e);
                                break;
                            }
                            tracing::debug!("[ClaudeEngine] 已写入 stdin: {} bytes", input.len());
                        }
                        Err(e) => {
                            tracing::warn!("[ClaudeEngine] stdin 写入失败: {}", e);
                            break;
                        }
                    }
                }
            });

            // 读取 stderr
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    // 使用 warn 级别，确保 stderr 错误被记录
                    tracing::warn!("[ClaudeEngine] stderr: {}", line);
                }
            });

            // 创建事件解析器
            let mut parser = EventParser::new(&current_session_id);
            let sender_for_update = input_sender.clone();

            // 读取 stdout
            let reader = BufReader::new(stdout);
            let mut received_session_end = false;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if let Some(raw_event) = StreamEvent::parse_line(trimmed) {
                    // 更新 session_id 映射
                    if let StreamEvent::System { extra, .. } = &raw_event {
                        if let Some(serde_json::Value::String(real_id)) = extra.get("session_id") {
                            parser.set_session_id(real_id);
                            SessionManager::update_session_id_shared(
                                &sessions, &temp_id, real_id, pid, "claude", Some(sender_for_update.clone())
                            );
                            tracing::info!("[ClaudeEngine] session_id 更新: {} -> {}", temp_id, real_id);

                            // 通知外部 session_id 已更新
                            if let Some(ref cb) = on_session_id_update {
                                cb(real_id.clone());
                            }
                        }
                    }

                    // 检查会话结束
                    if matches!(raw_event, StreamEvent::SessionEnd) {
                        received_session_end = true;
                    }

                    // 使用 EventParser 转换为 AIEvent 并调用回调
                    for ai_event in parser.parse(raw_event) {
                        event_callback(ai_event);
                    }
                }
            }

            // 如果没有收到 session_end，发送一个
            if !received_session_end {
                event_callback(AIEvent::session_end(&current_session_id));
            }

            // 完成回调
            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }
}

impl AIEngine for ClaudeEngine {
    fn id(&self) -> EngineId {
        EngineId::ClaudeCode
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn description(&self) -> &'static str {
        "Anthropic 官方 Claude CLI"
    }

    fn is_available(&self) -> bool {
        // 需要可变引用来检查 CLI
        true // 简化实现，实际检查在 start_session 时进行
    }

    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        tracing::info!("[ClaudeEngine] 启动会话，消息长度: {}", message.len());
        tracing::info!("[ClaudeEngine] 系统提示词: {:?}", options.system_prompt);
        tracing::info!("[ClaudeEngine] 拓展系统提示词: {:?}", options.append_system_prompt);
        tracing::info!("[ClaudeEngine] 工作目录: {:?}", options.work_dir);
        tracing::info!("[ClaudeEngine] MCP 配置路径: {:?}", options.mcp_config_path);

        // 检查 CLI 可用性
        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Claude CLI 不可用".to_string()));
        }

        // 构建命令
        let mut cmd = self.build_command(
            message,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            None,
            options.mcp_config_path.as_deref(),
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref());

        // 启动进程
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 Claude 进程失败: {}", e)))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[ClaudeEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        // 启动事件读取，获取 input_sender
        let input_sender = self.spawn_event_reader(child, temp_id.clone(), pid, options);

        // 注册会话（带 stdin 发送器）
        self.sessions.register_with_sender(temp_id.clone(), pid, "claude".to_string(), Some(input_sender))?;

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[ClaudeEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());
        tracing::info!("[ClaudeEngine] 系统提示词: {:?}", options.system_prompt);
        tracing::info!("[ClaudeEngine] 拓展系统提示词: {:?}", options.append_system_prompt);
        tracing::info!("[ClaudeEngine] 工作目录: {:?}", options.work_dir);
        tracing::info!("[ClaudeEngine] MCP 配置路径: {:?}", options.mcp_config_path);

        // 检查 CLI 可用性（确保 node_exe 和 cli_js 已初始化）
        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Claude CLI 不可用".to_string()));
        }

        // 获取会话信息，找到真实的 session_id
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[ClaudeEngine] 找到会话，真实 ID: {}, PID: {}", info.id, info.pid);
            // 终止旧进程
            tracing::info!("[ClaudeEngine] 终止旧进程 PID: {}", info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone() // 使用真实 ID
        } else {
            tracing::warn!("[ClaudeEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        // 确定工作目录
        let work_dir = options.work_dir.clone()
            .or_else(|| self.config.work_dir.as_ref().map(|p| p.to_string_lossy().to_string()));

        tracing::info!("[ClaudeEngine] 工作目录: {:?}", work_dir);
        tracing::info!("[ClaudeEngine] 使用 --resume 参数，session_id: {}", real_session_id);

        // 构建命令（带 --resume，使用真实 session_id）
        let mut cmd = self.build_command(
            message,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            Some(&real_session_id),
            options.mcp_config_path.as_deref(),
        )?;
        self.configure_command(&mut cmd, work_dir.as_deref());

        tracing::info!("[ClaudeEngine] 命令构建完成，准备启动进程...");

        // 启动进程
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 Claude 会话失败: {}", e)))?;

        let pid = child.id();

        tracing::info!("[ClaudeEngine] 进程启动，PID: {}", pid);

        // 启动事件读取，获取 input_sender
        let input_sender = self.spawn_event_reader(child, real_session_id.clone(), pid, options);

        // 更新会话 PID（使用真实 session_id，带 stdin 发送器）
        self.sessions.register_with_sender(real_session_id.clone(), pid, "claude".to_string(), Some(input_sender))?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[ClaudeEngine] 中断会话: {}", session_id);

        if self.sessions.kill_process(session_id)? {
            tracing::info!("[ClaudeEngine] 会话已中断: {}", session_id);
            Ok(())
        } else {
            // 找不到会话，返回错误让调用者尝试其他引擎
            Err(AppError::ProcessError(format!("会话不存在: {}", session_id)))
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        tracing::info!("[ClaudeEngine] 向会话 {} 发送输入: {} bytes", session_id, input.len());
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }
}

// ============================================================================
// Windows 辅助函数
// ============================================================================

#[cfg(windows)]
fn resolve_node_and_cli(claude_cmd_path: &str) -> Result<(String, String)> {
    let cmd_path = Path::new(claude_cmd_path);
    let npm_dir = cmd_path.parent()
        .ok_or_else(|| AppError::ProcessError("无法获取 claude.cmd 的父目录".to_string()))?;

    let node_exe = find_node_exe(npm_dir)?;
    let cli_js = find_cli_js(npm_dir)?;

    Ok((node_exe, cli_js))
}

#[cfg(windows)]
fn find_node_exe(npm_dir: &Path) -> Result<String> {
    // 检查 npm 目录下是否有 node.exe
    let local_node = npm_dir.join("node.exe");
    if local_node.exists() {
        return Ok(local_node.to_string_lossy().to_string());
    }

    // 使用 where 命令查找
    let output = Command::new("where")
        .args(["node"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::ProcessError(format!("查找 node.exe 失败: {}", e)))?;

    if output.status.success() {
        let node_path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string());

        if let Some(path) = node_path {
            return Ok(path);
        }
    }

    // 尝试常见路径
    let common_paths = vec![
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];

    for path in common_paths {
        if Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    Err(AppError::ProcessError("无法找到 node.exe".to_string()))
}

#[cfg(windows)]
fn find_cli_js(npm_dir: &Path) -> Result<String> {
    let cli_js = npm_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");

    if cli_js.exists() {
        return Ok(cli_js.to_string_lossy().to_string());
    }

    // 尝试全局 node_modules
    if let Ok(appdata) = std::env::var("APPDATA") {
        let global_cli = PathBuf::from(appdata)
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");

        if global_cli.exists() {
            return Ok(global_cli.to_string_lossy().to_string());
        }
    }

    Err(AppError::ProcessError(format!(
        "无法找到 cli.js，预期位置: {}",
        cli_js.display()
    )))
}

#[cfg(windows)]
use std::path::PathBuf;
