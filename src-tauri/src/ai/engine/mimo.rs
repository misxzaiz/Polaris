/*! Mimo Code 引擎
 *
 * 实现 AIEngine 接口，作为 Mimo (Mimocode) CLI 的适配器。
 * Mimo 通过 `--format json` 输出 JSON 事件流，采用与 Claude Code
 * stream-json 类似的 stdin 输入模式。
 *
 * 通信模式：
 * - 启动: `mimo run --format json --never-ask-questions`
 * - 输入: stdin 发送 stream-json 格式消息
 * - 输出: stdout 输出 JSON 事件行
 * - 中断: kill 进程
 */

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::ai::event_parser::EventParser;
use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions, ImageAttachment};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::events::StreamEvent;
use crate::models::AIEvent;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// Mimo Code 引擎
pub struct MimocodeEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
}

impl MimocodeEngine {
    /// 创建新的 Mimocode 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
        }
    }

    /// 获取 Mimo CLI 路径
    fn get_cli_path(&mut self) -> Result<&str> {
        if self.cli_path.is_none() {
            self.cli_path = Some(self.config.get_mimo_cmd());
        }
        Ok(self.cli_path.as_ref().unwrap())
    }

    /// 检查 CLI 是否可用
    fn check_cli_available(&self) -> bool {
        let cli_path = self.config.get_mimo_cmd();
        if Path::new(&cli_path).exists() {
            return true;
        }
        // 跨平台查找：Windows 用 where，Unix 用 which
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        std::process::Command::new(which_cmd)
            .arg(&cli_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 构建命令
    fn build_command(
        &self,
        _message: &str,
        system_prompt: Option<&str>,
        append_system_prompt: Option<&str>,
        session_id: Option<&str>,
        mcp_config_path: Option<&str>,
        additional_dirs: &[String],
        agent: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        allowed_tools: &[String],
        _image_attachments: &[ImageAttachment],
        fork_session: bool,
        _settings_overlay_path: Option<&str>,
    ) -> Result<Command> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

        let mut cmd = Command::new(cli_path);

        // Mimo 使用 --continue 和 --fork 进行会话管理
        if let Some(sid) = session_id {
            cmd.arg("--continue").arg("-s").arg(sid);
            if fork_session {
                cmd.arg("--fork");
            }
        }

        // 附加关联工作区目录
        for dir in additional_dirs {
            if !dir.is_empty() {
                cmd.arg("--dir").arg(dir);
            }
        }

        // 系统提示词
        if let Some(prompt) = system_prompt {
            if !prompt.is_empty() {
                cmd.arg("--prompt").arg(prompt);
            }
        }

        // 追加系统提示词
        if let Some(prompt) = append_system_prompt {
            if !prompt.is_empty() {
                tracing::warn!(
                    "[MimocodeEngine] append_system_prompt 未传递给 CLI（Mimo 不支持 --append-system-prompt），长度: {}",
                    prompt.len()
                );
            }
        }

        if let Some(path) = mcp_config_path {
            if !path.is_empty() {
                tracing::warn!(
                    "[MimocodeEngine] mcp_config_path 未传递给 CLI（Mimo 不使用 MCP 配置文件）: {}",
                    path
                );
            }
        }

        // Agent 选择
        if let Some(a) = agent {
            if !a.is_empty() {
                cmd.arg("--agent").arg(a);
            }
        }

        // 模型选择
        if let Some(m) = model {
            if !m.is_empty() {
                cmd.arg("--model").arg(m);
            }
        }

        // 努力级别
        if let Some(e) = effort {
            if !e.is_empty() {
                cmd.arg("--variant").arg(e);
            }
        }

        // 权限模式
        if let Some(pm) = permission_mode {
            if !pm.is_empty() {
                // Mimo 使用 --dangerously-skip-permissions 跳过权限确认
                if pm == "bypassPermissions" || pm.contains("skip") {
                    cmd.arg("--dangerously-skip-permissions");
                }
            }
        }

        // 允许的工具列表
        if !allowed_tools.is_empty() {
            // Mimo 可能没有直接的工具白名单参数，暂略
        }

        // 统一使用 --format json 输出 JSON 事件流
        // 消息通过 stdin 发送（stream-json 格式），避免命令行长度限制
        cmd.arg("--format")
            .arg("json")
            .arg("--never-ask-questions");

        Ok(cmd)
    }

    /// 配置命令（设置工作目录、环境变量等）
    fn configure_command(&self, cmd: &mut Command, work_dir: Option<&str>, env_overrides: &std::collections::HashMap<String, String>) {
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

        // 应用环境变量覆盖（如 API Key 等）
        for (key, value) in env_overrides {
            cmd.env(key, value);
        }
    }

    /// 通过 stdin 发送 stream-json 格式的用户消息
    fn send_stream_json_message(
        stdin: &mut impl std::io::Write,
        message: &str,
        _image_attachments: &[ImageAttachment],
    ) -> Result<()> {
        let user_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": message
            }
        });

        let json_line = serde_json::to_string(&user_msg)
            .map_err(|e| AppError::ProcessError(format!("序列化 stream-json 失败: {}", e)))?;

        stdin.write_all(json_line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| AppError::ProcessError(format!("写入 stdin 失败: {}", e)))?;

        Ok(())
    }

    /// 启动后台线程读取事件
    fn spawn_event_reader(
        &self,
        child: Child,
        temp_id: String,
        pid: u32,
        options: SessionOptions,
        initial_stdin_data: Option<String>,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let current_session_id = temp_id.clone();

        // 创建 stdin 输入 channel
        let (input_sender, input_receiver) = std::sync::mpsc::channel::<String>();
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

            // 启动 stderr 读取
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[MimocodeEngine] stderr: {}", line);
                }
            });

            // 启动 stdin 写入线程
            std::thread::spawn(move || {
                use std::io::Write;
                let mut stdin_writer = stdin;

                // 如果有初始数据，立即发送
                if let Some(initial) = initial_stdin_data {
                    if let Err(e) = stdin_writer.write_all(initial.as_bytes())
                        .and_then(|_| stdin_writer.write_all(b"\n"))
                        .and_then(|_| stdin_writer.flush())
                    {
                        tracing::error!("[MimocodeEngine] 发送初始 stdin 数据失败: {}", e);
                        return;
                    }
                    // 单次交互模式：关闭 stdin 使进程正常退出
                    drop(stdin_writer);
                    return;
                }

                // 交互式模式：stdin 保持打开
                while let Ok(input) = input_receiver.recv() {
                    match stdin_writer.write_all(input.as_bytes()) {
                        Ok(_) => {
                            if let Err(e) = stdin_writer.flush() {
                                tracing::warn!("[MimocodeEngine] stdin flush 失败: {}", e);
                                break;
                            }
                        }
                        Err(e) => {
                            tracing::warn!("[MimocodeEngine] stdin 写入失败: {}", e);
                            break;
                        }
                    }
                }
            });

            // 创建事件解析器
            let mut parser = EventParser::new(&current_session_id);
            let skip_init_session_id = options.fork_session_id.is_some();

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
                    if let StreamEvent::System { subtype, extra } = &raw_event {
                        let is_init = subtype.as_deref() == Some("init");
                        let should_skip = is_init && skip_init_session_id;
                        if !should_skip {
                            if let Some(serde_json::Value::String(real_id)) = extra.get("session_id") {
                                parser.set_session_id(real_id);
                                SessionManager::update_session_id_shared(
                                    &sessions, &temp_id, real_id, pid, "mimo", Some(input_sender.clone())
                                );
                                tracing::info!("[MimocodeEngine] session_id 更新: {} -> {}", temp_id, real_id);

                                if let Some(ref cb) = on_session_id_update {
                                    cb(real_id.clone());
                                }
                            }
                        }
                    }

                    if matches!(raw_event, StreamEvent::SessionEnd) {
                        received_session_end = true;
                    }

                    for ai_event in parser.parse(raw_event) {
                        event_callback(ai_event);
                    }
                }
            }

            if !received_session_end {
                event_callback(AIEvent::session_end(&current_session_id));
            }

            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }
}

impl AIEngine for MimocodeEngine {
    fn id(&self) -> EngineId {
        EngineId::MimoCode
    }

    fn name(&self) -> &'static str {
        "Mimo Code"
    }

    fn description(&self) -> &'static str {
        "Mimo (Mimocode) CLI - 多提供商 AI 编程助手"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        tracing::info!("[MimocodeEngine] 启动会话，消息长度: {}", message.len());

        let cli_path = self.get_cli_path()?.to_string();

        if !self.check_cli_available() {
            return Err(AppError::ProcessError(format!(
                "Mimo CLI 不可用，路径: {}。请确保 Mimo 已正确安装。",
                cli_path
            )));
        }

        // 构建初始 stdin 数据
        let initial_stdin_data = {
            let mut json_bytes = Vec::new();
            Self::send_stream_json_message(&mut json_bytes, message, &options.image_attachments)?;
            json_bytes.extend_from_slice(b"\n");
            Some(String::from_utf8(json_bytes)
                .map_err(|e| AppError::ProcessError(format!("stream-json 数据包含非 UTF-8: {}", e)))?)
        };

        // 构建命令
        let (resume_sid, fork_flag) = if let Some(ref fork_sid) = options.fork_session_id {
            (Some(fork_sid.as_str()), true)
        } else {
            (None, false)
        };

        let mut cmd = self.build_command(
            message,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            resume_sid,
            options.mcp_config_path.as_deref(),
            &options.additional_dirs,
            options.agent.as_deref(),
            options.model.as_deref(),
            options.effort.as_deref(),
            options.permission_mode.as_deref(),
            &options.allowed_tools,
            &options.image_attachments,
            fork_flag,
            options.settings_overlay_path.as_deref(),
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = format!("{:?} {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());
        tracing::info!("[MimocodeEngine] 执行命令: {}", cmd_str);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 Mimo 进程失败: {}", e)))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[MimocodeEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        let input_sender = self.spawn_event_reader(child, temp_id.clone(), pid, options, initial_stdin_data);
        self.sessions.register_with_sender(temp_id.clone(), pid, "mimo".to_string(), Some(input_sender))?;

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[MimocodeEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Mimo CLI 不可用".to_string()));
        }

        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[MimocodeEngine] 找到会话，真实 ID: {}, PID: {}", info.id, info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone()
        } else {
            tracing::warn!("[MimocodeEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        let initial_stdin_data = {
            let mut json_bytes = Vec::new();
            Self::send_stream_json_message(&mut json_bytes, message, &options.image_attachments)?;
            json_bytes.extend_from_slice(b"\n");
            Some(String::from_utf8(json_bytes)
                .map_err(|e| AppError::ProcessError(format!("stream-json 数据包含非 UTF-8: {}", e)))?)
        };

        let mut cmd = self.build_command(
            message,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            Some(&real_session_id),
            options.mcp_config_path.as_deref(),
            &options.additional_dirs,
            options.agent.as_deref(),
            options.model.as_deref(),
            options.effort.as_deref(),
            options.permission_mode.as_deref(),
            &options.allowed_tools,
            &options.image_attachments,
            false,
            options.settings_overlay_path.as_deref(),
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 Mimo 会话失败: {}", e)))?;

        let pid = child.id();
        let input_sender = self.spawn_event_reader(child, real_session_id.clone(), pid, options, initial_stdin_data);
        self.sessions.register_with_sender(real_session_id.clone(), pid, "mimo".to_string(), Some(input_sender))?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[MimocodeEngine] 中断会话: {}", session_id);

        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[MimocodeEngine] 会话已中断: {}", session_id);
                Ok(())
            }
            Ok(false) => {
                tracing::warn!("[MimocodeEngine] kill_process 返回 false: {}", session_id);
                Err(AppError::ProcessError(format!(
                    "会话不存在或 kill 失败: {}",
                    session_id
                )))
            }
            Err(e) => {
                tracing::warn!("[MimocodeEngine] kill_process 返回 Err: {} ({})", e, session_id);
                Err(e)
            }
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        tracing::info!("[MimocodeEngine] 向会话 {} 发送输入: {} bytes", session_id, input.len());
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }

    fn update_config(&mut self, new_config: Config) {
        tracing::info!("[MimocodeEngine] 应用新配置,失效 CLI 路径缓存");
        self.config = new_config;
        self.cli_path = None;
    }
}
