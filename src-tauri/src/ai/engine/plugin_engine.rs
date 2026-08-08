/*! 插件引擎运行器
 *
 * 通用 AI 引擎适配器，根据 PluginEngineConfig 中的协议类型自动选择通信方式。
 * 目前支持 PiRpc 协议（与 PiEngine 兼容的 --mode rpc JSONL 协议）。
 *
 * 插件引擎通过 PluginRegistry.register_plugin_engine() 注册，
 * 由前端插件系统的 `contributes.engines` 声明触发。
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineId, EngineMetadata, EngineDistribution, EngineCapabilities,
    EnvKeyMapping, EngineCliConfig, RpcProtocol, PluginEngineConfig, PluginEngineCapabilities,
    SessionOptions, ImageAttachment,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::AIEvent;
use crate::services::data_root::data_root;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 插件引擎运行器
pub struct PluginEngineRunner {
    /// 插件引擎配置
    config: PluginEngineConfig,
    /// 引擎能力
    capabilities: PluginEngineCapabilities,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
    /// 泄漏到 &'static str 的引擎名称
    leaked_name: &'static str,
    /// 泄漏到 &'static str 的引擎描述
    leaked_description: &'static str,
}

impl PluginEngineRunner {
    /// 创建新的插件引擎运行器
    pub fn new(config: PluginEngineConfig) -> Self {
        let capabilities = config.capabilities;
        // 将名称和描述泄漏到 &'static str（引擎存活于整个应用生命周期，安全）
        let leaked_name: &'static str = Box::leak(config.name.clone().into_boxed_str());
        let leaked_description: &'static str = Box::leak(config.description.clone().into_boxed_str());
        Self {
            config,
            capabilities,
            sessions: SessionManager::new(),
            cli_path: None,
            leaked_name,
            leaked_description,
        }
    }

    /// 获取 CLI 路径
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        let cli = &self.config.cli;
        let cmd = &cli.command;

        // 检查命令是否在 PATH 中（通过 which/where）
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut check = Command::new(which_cmd);
        check.arg(cmd);
        #[cfg(windows)]
        check.creation_flags(CREATE_NO_WINDOW);

        if check.output().map(|o| o.status.success()).unwrap_or(false) {
            self.cli_path = Some(cmd.clone());
            return Ok(cmd.clone());
        }

        // 检查路径是否存在
        if Path::new(cmd).exists() {
            self.cli_path = Some(cmd.clone());
            return Ok(cmd.clone());
        }

        tracing::warn!("[PluginEngine:{}] CLI 未找到: {}", self.config.id, cmd);
        // 返回默认值，让 spawn 时再尝试
        Ok(cmd.clone())
    }

    /// 检查 CLI 是否可用
    fn check_cli_available(&mut self) -> bool {
        let cli_path = match self.get_cli_path() {
            Ok(p) => p,
            Err(_) => return false,
        };
        if Path::new(&cli_path).exists() {
            return true;
        }
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut cmd = Command::new(which_cmd);
        cmd.arg(&cli_path);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 创建基础 Command（Windows .cmd 需 cmd /c 包装）
    fn create_command(cli_path: &str) -> Command {
        #[cfg(windows)]
        {
            let lower = cli_path.to_ascii_lowercase();
            if lower.ends_with(".cmd") || lower.ends_with(".bat") {
                let mut c = Command::new("cmd");
                c.arg("/c").arg(cli_path);
                return c;
            }
        }
        Command::new(cli_path)
    }

    /// 构建 RPC 命令
    fn build_command(&self, session_id: &str, resume: bool) -> Result<Command> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError(format!("CLI 路径未初始化: {}", self.config.id)))?;

        let mut cmd = Self::create_command(cli_path);

        // 添加--mode rpc 参数
        cmd.arg("--mode").arg("rpc");

        // 添加用户自定义 args
        if let Some(ref args) = self.config.cli.args {
            for arg in args {
                cmd.arg(arg);
            }
        }

        // Session 持久化
        let session_dir = self.plugin_session_dir()?;
        fs::create_dir_all(&session_dir)?;
        cmd.arg("--session-dir").arg(&session_dir);

        if resume {
            cmd.arg("--session").arg(session_id);
        } else {
            cmd.arg("--session-id").arg(session_id);
        }

        // 无 session 模式（不持久化历史）
        // 插件引擎默认不持久化，由配置决定
        // 但会话落盘到 plugin-sessions 目录，支持 resume

        Ok(cmd)
    }

    /// 配置命令（工作目录、环境变量、stdio）
    fn configure_command(&self, cmd: &mut Command, work_dir: Option<&str>, env_overrides: &HashMap<String, String>) {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        }

        // 应用环境变量覆盖
        for (key, value) in env_overrides {
            cmd.env(key, value);
        }
    }

    /// 插件引擎的 session 落盘目录
    fn plugin_session_dir(&self) -> Result<PathBuf> {
        let dir = data_root().root().join("plugin-sessions").join(&self.config.id);
        Ok(dir)
    }

    /// 启动后台线程读取 RPC stdout 事件
    fn spawn_event_reader(
        &self,
        mut child: Child,
        session_id: String,
        pid: u32,
        options: SessionOptions,
        initial_prompt: Option<String>,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let current_session_id = session_id.clone();

        let (input_sender, input_receiver) = std::sync::mpsc::channel::<String>();
        let input_sender_for_return = input_sender.clone();
        let engine_id = self.config.id.clone();

        std::thread::spawn(move || {
            let engine_id = engine_id.clone();
            let (stdout, stdin) = match (child.stdout.take(), child.stdin.take()) {
                (Some(s), Some(i)) => (s, i),
                _ => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程输入/输出流".to_string());
                    }
                    event_callback(AIEvent::session_end(&current_session_id));
                    if let Some(ref cb) = on_complete {
                        cb(0);
                    }
                    return;
                }
            };
            let stderr = match child.stderr.take() {
                Some(s) => s,
                None => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程错误流".to_string());
                    }
                    event_callback(AIEvent::session_end(&current_session_id));
                    if let Some(ref cb) = on_complete {
                        cb(0);
                    }
                    return;
                }
            };

            // stderr 读取线程
            let engine_id_err = engine_id.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[PluginEngine:{}] stderr: {}", engine_id_err, line);
                }
            });

            // stdin 写入线程
            let engine_id_stdin = engine_id.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let mut stdin_writer = stdin;

                if let Some(prompt) = initial_prompt {
                    let cmd_line = super::pi_parser::build_prompt_command(&prompt, "init", &[]);
                    if let Err(e) = stdin_writer.write_all(cmd_line.as_bytes())
                        .and_then(|_| stdin_writer.flush())
                    {
                        tracing::error!("[PluginEngine:{}] 发送初始 prompt 失败: {}", engine_id_stdin, e);
                        return;
                    }
                }

                // 保持 stdin 打开，转发后续命令
                while let Ok(input) = input_receiver.recv() {
                    if let Err(e) = stdin_writer.write_all(input.as_bytes()) {
                        tracing::warn!("[PluginEngine:{}] stdin 写入失败: {}", engine_id_stdin, e);
                        break;
                    }
                    if let Err(e) = stdin_writer.flush() {
                        tracing::warn!("[PluginEngine:{}] stdin flush 失败: {}", engine_id_stdin, e);
                        break;
                    }
                }
            });

            // 读取 stdout JSONL，翻译为 AIEvent
            let mut reader = BufReader::new(stdout);
            let mut line_count: usize = 0;
            let mut known_event_count: usize = 0;
            let mut message_event_count: usize = 0;
            let mut agent_ended = false;
            let mut line_buf = String::new();

            loop {
                line_buf.clear();
                match reader.read_line(&mut line_buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let trimmed = line_buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                line_count += 1;

                let Some(pi_line) = super::pi_parser::PiRpcLine::parse_line(trimmed) else {
                    let preview: String = trimmed.chars().take(300).collect();
                    tracing::warn!("[PluginEngine:{}] 无法解析 stdout 行: {}", engine_id, preview);
                    continue;
                };
                known_event_count += 1;

                if pi_line.line_type == "agent_end" {
                    agent_ended = true;
                }

                if pi_line.line_type == "message_update" || pi_line.line_type == "message_end" {
                    message_event_count += 1;
                }

                let parsed = super::pi_parser::pi_line_to_ai_events(&pi_line, &current_session_id);
                for ev in parsed.events {
                    event_callback(ev);
                }

                if pi_line.line_type == "agent_end" || pi_line.line_type == "agent_settled" {
                    if message_event_count == 0 {
                        tracing::warn!(
                            "[PluginEngine:{}] agent_end 但全程 0 个 message 事件，session={}",
                            engine_id, current_session_id
                        );
                        event_callback(AIEvent::error(
                            &current_session_id,
                            format!("{} 引擎未生成任何回复：模型调用可能超时或 provider 配置有误。", engine_id),
                        ));
                    }
                    break;
                }
            }

            // 收尾
            if !agent_ended && line_count > 0 {
                tracing::warn!(
                    "[PluginEngine:{}] reader 循环退出但未收到 agent_end，session={}",
                    engine_id, current_session_id
                );
            }
            if line_count == 0 {
                tracing::warn!("[PluginEngine:{}] CLI 未产生任何 stdout 输出", engine_id);
                event_callback(AIEvent::error(
                    &current_session_id,
                    format!("{} CLI 未产生任何输出，请检查是否已安装及 provider 配置", engine_id),
                ));
            } else if known_event_count == 0 {
                tracing::warn!("[PluginEngine:{}] CLI 产生 {} 行输出但无法解析任何事件", engine_id, line_count);
                event_callback(AIEvent::error(
                    &current_session_id,
                    format!("{} CLI 输出无法解析（{} 行）", engine_id, line_count),
                ));
            }

            // 清理进程
            let mut child = child;
            if let Ok(mut s) = sessions.lock() {
                s.remove(&current_session_id);
            }

            let max_wait = std::time::Duration::from_secs(5);
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() >= max_wait {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }

            event_callback(AIEvent::session_end(&current_session_id));

            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }
}

impl AIEngine for PluginEngineRunner {
    fn id(&self) -> EngineId {
        EngineId::Custom(self.config.id.clone())
    }

    fn name(&self) -> &'static str {
        self.leaked_name
    }

    fn description(&self) -> &'static str {
        self.leaked_description
    }

    fn metadata(&self) -> EngineMetadata {
        let caps = EngineCapabilities {
            tools: self.capabilities.tools,
            image_input: false,
            streaming: self.capabilities.streaming,
            interrupt: self.capabilities.interrupt,
            resume: self.capabilities.resume,
            stdin_input: true,
            fork_session: false,
        };
        EngineMetadata {
            id: self.id(),
            name: self.config.name.clone(),
            description: Some(self.config.description.clone()),
            distribution: EngineDistribution::CustomPath {
                path: self.config.cli.command.clone(),
                available: self.is_available(),
            },
            capabilities: caps,
            env_keys: EnvKeyMapping::default(),
            supports_model_provider: false,
        }
    }

    fn is_available(&self) -> bool {
        // 简单检查：CLI 命令是否在 PATH 中
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut cmd = Command::new(which_cmd);
        cmd.arg(&self.config.cli.command);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn unavailable_reason(&self) -> Option<String> {
        if !self.is_available() {
            let guide = self.config.cli.install_guide.as_deref()
                .unwrap_or("请安装 CLI 工具");
            Some(format!("{} 未安装。{}", self.config.cli.command, guide))
        } else {
            None
        }
    }

    fn start_session(&mut self, message: &str, mut options: SessionOptions) -> Result<String> {
        let engine_id = self.config.id.clone();
        tracing::info!("[PluginEngine:{}] 启动会话，消息长度: {}", engine_id, message.len());

        if !self.check_cli_available() {
            let guide = self.config.cli.install_guide.as_deref().unwrap_or("");
            return Err(AppError::ProcessError(format!(
                "{} CLI 不可用。{}",
                self.config.cli.command, guide
            )));
        }

        let temp_id = uuid::Uuid::new_v4().to_string();

        let mut cmd = self.build_command(&temp_id, false)?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        tracing::info!("[PluginEngine:{}] 执行命令: {} {}", engine_id, self.config.cli.command, self.config.cli.args.as_ref().map(|a| a.join(" ")).unwrap_or_default());

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 {} 进程失败: {}", self.config.cli.command, e)))?;
        let pid = child.id();
        tracing::info!("[PluginEngine:{}] 进程启动，PID: {}, 临时 ID: {}", engine_id, pid, temp_id);

        let input_sender = self.spawn_event_reader(
            child, temp_id.clone(), pid, options, Some(message.to_string()),
        );
        self.sessions.register_with_sender(
            temp_id.clone(), pid, engine_id, Some(input_sender),
        )?;

        Ok(temp_id)
    }

    fn continue_session(&mut self, session_id: &str, message: &str, mut options: SessionOptions) -> Result<()> {
        let engine_id = self.config.id.clone();
        tracing::info!("[PluginEngine:{}] 继续会话: {}", engine_id, session_id);

        if !self.check_cli_available() {
            return Err(AppError::ProcessError(format!("{} CLI 不可用", self.config.cli.command)));
        }

        // Kill 旧进程（如果有）
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[PluginEngine:{}] 找到会话，真实 ID: {}, PID: {}", engine_id, info.id, info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone()
        } else {
            session_id.to_string()
        };

        let mut cmd = self.build_command(&real_session_id, true)?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 {} 会话失败: {}", self.config.cli.command, e)))?;
        let pid = child.id();

        let input_sender = self.spawn_event_reader(
            child, real_session_id.clone(), pid, options, Some(message.to_string()),
        );
        self.sessions.register_with_sender(
            real_session_id.clone(), pid, engine_id, Some(input_sender),
        )?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        let engine_id = &self.config.id;
        tracing::info!("[PluginEngine:{}] 中断会话: {}", engine_id, session_id);

        let abort_cmd = super::pi_parser::build_abort_command();
        if let Ok(true) = self.sessions.send_input(session_id, &abort_cmd) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[PluginEngine:{}] 会话已中断: {}", engine_id, session_id);
                Ok(())
            }
            Ok(false) => {
                Err(AppError::ProcessError(format!(
                    "会话不存在或 kill 失败: {}", session_id
                )))
            }
            Err(e) => Err(e),
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }
}