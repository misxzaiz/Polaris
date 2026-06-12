/*! Mimo Code 引擎
 *
 * 实现 AIEngine 接口，作为 Mimo (Mimocode) CLI 的适配器。
 *
 * 通信模式（基于 `mimo run --help` 实测，mimo v0.1.0）：
 * - 启动: `mimo run --format json [-s <sid>] [--fork] [--agent] [--model] [--variant]`
 * - 输入: 通过 stdin 发送纯文本消息（无 positional message 时 mimo 读取 stdin 至 EOF，
 *   规避命令行长度限制；注意不是 Claude 的 stream-json 包装格式）
 * - 输出: stdout 输出 Mimo 自有 JSON 事件行：
 *   `{"type":"step_start"|"reasoning"|"text"|"tool_use"|"step_finish","sessionID":"ses_..","part":{..}}`
 * - 续聊: `-s <sid>`（实测不能与 --continue 同用：--continue 会忽略 -s 改为继续最近会话）
 * - 中断: kill 进程
 *
 * run 子命令不支持的能力（传入时 warn 并忽略）：
 * - 系统提示词（--prompt 仅 TUI 模式支持）、--append-system-prompt
 * - MCP 配置文件、多目录（--dir 为单值运行目录）、工具白名单
 * - base64 图片附件（-f 仅支持文件路径）
 */

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions, ImageAttachment};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::{AIEvent, ToolCallStartEvent, ToolCallEndEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::PathBuf;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// Mimo CLI 输出的 JSON 事件行
///
/// 顶层结构: `{"type": "...", "timestamp": ..., "sessionID": "ses_..", "part": {...}}`
#[derive(Debug, serde::Deserialize)]
struct MimoStreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default)]
    part: serde_json::Value,
}

impl MimoStreamEvent {
    fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}

/// 将 Mimo 事件翻译为标准化 AIEvent
///
/// 事件形态均为实测捕获：
/// - `text`: `part.text` 为完整文本块
/// - `reasoning`: `part.text` 为思考内容（需 --thinking）
/// - `tool_use`: `part.{tool, callID, state:{status, input, output}}`，到达时已执行完成
/// - `step_start` / `step_finish`: 轮次边界，无需透出
fn mimo_event_to_ai_events(event: &MimoStreamEvent, sid: &str) -> Vec<AIEvent> {
    match event.event_type.as_str() {
        "text" => {
            match event.part.get("text").and_then(|t| t.as_str()) {
                Some(text) if !text.is_empty() => {
                    vec![AIEvent::assistant_message(sid, text, false)]
                }
                _ => vec![],
            }
        }
        "reasoning" => {
            match event.part.get("text").and_then(|t| t.as_str()) {
                Some(text) if !text.is_empty() => vec![AIEvent::thinking(sid, text)],
                _ => vec![],
            }
        }
        "tool_use" => {
            let tool = event.part.get("tool")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();
            let call_id = event.part.get("callID")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string());
            let state = event.part.get("state").cloned().unwrap_or(serde_json::Value::Null);

            let args: HashMap<String, serde_json::Value> = state.get("input")
                .and_then(|i| i.as_object())
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            // tool_use 事件到达时已是终态，status != completed 视为失败
            let success = state.get("status").and_then(|s| s.as_str()) == Some("completed");

            let mut start = ToolCallStartEvent::new(sid, tool.clone(), args);
            let mut end = ToolCallEndEvent::new(sid, tool, success);
            if let Some(output) = state.get("output").cloned() {
                if !output.is_null() {
                    end = end.with_result(output);
                }
            }
            if let Some(cid) = call_id {
                start = start.with_call_id(cid.clone());
                end = end.with_call_id(cid);
            }
            vec![AIEvent::ToolCallStart(start), AIEvent::ToolCallEnd(end)]
        }
        // 轮次边界事件，结束统一由 stdout EOF 触发 session_end
        "step_start" | "step_finish" => vec![],
        "error" => {
            // 防御性提取：错误事件形态未实测，按候选字段降级取值
            let message = event.part.get("text")
                .or_else(|| event.part.get("message"))
                .or_else(|| event.part.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("Mimo CLI 报告了未知错误")
                .to_string();
            vec![AIEvent::error(sid, message)]
        }
        other => {
            tracing::warn!("[MimocodeEngine] 未知事件类型: {}", other);
            vec![]
        }
    }
}

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
    ///
    /// 查找顺序（与 CodexEngine 对齐）：
    /// 1. 配置文件中的 mimo_code.cli_path（用户自定义）
    /// 2. Windows: %APPDATA%\npm\mimo.cmd / %PNPM_HOME%\mimo.cmd / %LOCALAPPDATA%\pnpm\mimo.cmd
    /// 3. where/which mimo（PATH 查找，取完整路径）
    /// 4. 默认 "mimo"
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        // 1. 配置文件中的路径（用户自定义）
        let config_path = self.config.get_mimo_cmd();
        if config_path != "mimo" && !config_path.is_empty() {
            tracing::info!("[MimocodeEngine] 使用配置路径: {}", config_path);
            self.cli_path = Some(config_path.clone());
            return Ok(config_path);
        }

        // 2. Windows: 探测 npm/pnpm 全局安装路径
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_mimo = PathBuf::from(&appdata).join("npm").join("mimo.cmd");
                if npm_mimo.exists() {
                    let path_str = npm_mimo.to_string_lossy().to_string();
                    tracing::info!("[MimocodeEngine] 在 APPDATA\\npm 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
                let pnpm_mimo = PathBuf::from(&pnpm_home).join("mimo.cmd");
                if pnpm_mimo.exists() {
                    let path_str = pnpm_mimo.to_string_lossy().to_string();
                    tracing::info!("[MimocodeEngine] 在 PNPM_HOME 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                let pnpm_mimo = PathBuf::from(&localappdata).join("pnpm").join("mimo.cmd");
                if pnpm_mimo.exists() {
                    let path_str = pnpm_mimo.to_string_lossy().to_string();
                    tracing::info!("[MimocodeEngine] 在 LOCALAPPDATA\\pnpm 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            // where mimo（PATH 查找）
            if let Ok(output) = Command::new("where")
                .arg("mimo")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    // 优先 .cmd/.exe 行（where 可能先输出无扩展名的 shell 脚本）
                    let best = stdout.lines()
                        .map(|l| l.trim())
                        .filter(|l| !l.is_empty() && Path::new(l).exists())
                        .max_by_key(|l| {
                            let lower = l.to_ascii_lowercase();
                            if lower.ends_with(".exe") { 2 }
                            else if lower.ends_with(".cmd") || lower.ends_with(".bat") { 1 }
                            else { 0 }
                        });
                    if let Some(path_str) = best {
                        tracing::info!("[MimocodeEngine] 通过 where 找到: {}", path_str);
                        let path_str = path_str.to_string();
                        self.cli_path = Some(path_str.clone());
                        return Ok(path_str);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            if let Ok(output) = Command::new("which")
                .arg("mimo")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first_line) = stdout.lines().next() {
                        let path_str = first_line.trim().to_string();
                        if !path_str.is_empty() && Path::new(&path_str).exists() {
                            tracing::info!("[MimocodeEngine] 通过 which 找到: {}", path_str);
                            self.cli_path = Some(path_str.clone());
                            return Ok(path_str);
                        }
                    }
                }
            }
        }

        // 4. 默认使用 PATH 中的 mimo
        tracing::warn!("[MimocodeEngine] 未找到 mimo CLI，将使用默认 'mimo'（依赖 PATH）");
        let default_path = "mimo".to_string();
        self.cli_path = Some(default_path.clone());
        Ok(default_path)
    }

    /// 创建基础 Command
    ///
    /// Windows 下 .cmd/.bat 无法被 CreateProcess 直接执行，需要 cmd /c 包装
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

    /// 检查 CLI 是否可用
    fn check_cli_available(&mut self) -> bool {
        let cli_path = match self.get_cli_path() {
            Ok(p) => p,
            Err(_) => return false,
        };
        if Path::new(&cli_path).exists() {
            return true;
        }
        // 跨平台查找：Windows 用 where，Unix 用 which
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut cmd = Command::new(which_cmd);
        cmd.arg(&cli_path);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 构建 `mimo run` 命令
    #[allow(clippy::too_many_arguments)]
    fn build_command(
        &self,
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
        image_attachments: &[ImageAttachment],
        fork_session: bool,
    ) -> Result<Command> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

        let mut cmd = Self::create_command(cli_path);
        cmd.arg("run");

        // 续聊指定会话：仅用 -s（实测 --continue 会忽略 -s 改为继续最近会话）
        if let Some(sid) = session_id {
            cmd.arg("-s").arg(sid);
            if fork_session {
                cmd.arg("--fork");
            }
        }

        // run 子命令不支持系统提示词（--prompt 仅 TUI 模式有效，传入会触发 yargs 报错）
        if let Some(prompt) = system_prompt {
            if !prompt.is_empty() {
                tracing::warn!(
                    "[MimocodeEngine] system_prompt 未传递给 CLI（mimo run 不支持 --prompt），长度: {}",
                    prompt.len()
                );
            }
        }
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

        // --dir 为单值"运行目录"参数，无法表达多个关联目录；工作目录已由 current_dir 设置
        if !additional_dirs.is_empty() {
            tracing::warn!(
                "[MimocodeEngine] additional_dirs 未传递给 CLI（mimo run 的 --dir 为单值运行目录）: {:?}",
                additional_dirs
            );
        }

        // Agent 选择
        if let Some(a) = agent {
            if !a.is_empty() {
                cmd.arg("--agent").arg(a);
            }
        }

        // 模型选择（provider/model 格式）
        if let Some(m) = model {
            if !m.is_empty() {
                cmd.arg("--model").arg(m);
            }
        }

        // 努力级别 → --variant（provider-specific reasoning effort: high/max/minimal）
        if let Some(e) = effort {
            if !e.is_empty() {
                cmd.arg("--variant").arg(e);
            }
        }

        // 权限模式
        if let Some(pm) = permission_mode {
            if !pm.is_empty() && (pm == "bypassPermissions" || pm.contains("skip")) {
                cmd.arg("--dangerously-skip-permissions");
            }
        }

        // 工具白名单：mimo run 无对应参数
        if !allowed_tools.is_empty() {
            tracing::warn!(
                "[MimocodeEngine] allowed_tools 未传递给 CLI（mimo run 无工具白名单参数）: {:?}",
                allowed_tools
            );
        }

        // base64 图片附件：mimo 的 -f 仅接受文件路径
        if !image_attachments.is_empty() {
            tracing::warn!(
                "[MimocodeEngine] 暂不支持图片附件（mimo run -f 仅接受文件路径），已忽略 {} 个附件",
                image_attachments.len()
            );
        }

        // JSON 事件流输出 + 透出思考块
        cmd.arg("--format").arg("json").arg("--thinking");

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

    /// 构建 stdin 消息负载
    ///
    /// mimo run 无 positional message 时把整个 stdin（至 EOF）作为纯文本消息，
    /// 注意不能使用 Claude 的 stream-json JSON 包装（会被当作消息内容混入对话）
    fn build_stdin_payload(message: &str) -> String {
        let mut payload = message.to_string();
        if !payload.ends_with('\n') {
            payload.push('\n');
        }
        payload
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
                        .and_then(|_| stdin_writer.flush())
                    {
                        tracing::error!("[MimocodeEngine] 发送初始 stdin 数据失败: {}", e);
                        return;
                    }
                    // 单次交互模式：关闭 stdin（EOF）使 mimo 开始处理消息
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

            // 读取 stdout，翻译 Mimo JSON 事件为 AIEvent
            let reader = BufReader::new(stdout);
            let mut real_session_id = current_session_id.clone();
            let mut line_count: usize = 0;
            let mut known_event_count: usize = 0;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                line_count += 1;

                let Some(mimo_event) = MimoStreamEvent::parse_line(trimmed) else {
                    let preview: String = trimmed.chars().take(300).collect();
                    tracing::warn!("[MimocodeEngine] 无法解析 stdout 行: {}", preview);
                    continue;
                };
                known_event_count += 1;

                // 每个事件都携带 sessionID：首次出现真实 ID 时更新映射
                if let Some(ref sid) = mimo_event.session_id {
                    if !sid.is_empty() && *sid != real_session_id {
                        SessionManager::update_session_id_shared(
                            &sessions, &real_session_id, sid, pid, "mimo", Some(input_sender.clone())
                        );
                        tracing::info!("[MimocodeEngine] session_id 更新: {} -> {}", real_session_id, sid);
                        real_session_id = sid.clone();

                        if let Some(ref cb) = on_session_id_update {
                            cb(real_session_id.clone());
                        }
                        event_callback(AIEvent::session_start(&real_session_id));
                    }
                }

                for ai_event in mimo_event_to_ai_events(&mimo_event, &real_session_id) {
                    event_callback(ai_event);
                }
            }

            // mimo run 单轮执行完即退出，无显式 session_end 事件，统一在 EOF 收尾
            if line_count == 0 {
                tracing::warn!("[MimocodeEngine] CLI 未产生任何 stdout 输出");
                event_callback(AIEvent::error(
                    &real_session_id,
                    "Mimo CLI 未产生任何输出，请检查 CLI 是否正确安装（npm install -g mimocode）及 provider 是否已配置（mimo providers）".to_string(),
                ));
            } else if known_event_count == 0 {
                tracing::warn!(
                    "[MimocodeEngine] CLI 产生了 {} 行输出但无法解析任何事件",
                    line_count
                );
                event_callback(AIEvent::error(
                    &real_session_id,
                    format!("Mimo CLI 输出无法解析（{} 行）。请检查 Mimo CLI 版本兼容性", line_count),
                ));
            }
            event_callback(AIEvent::session_end(&real_session_id));

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

        let cli_path = self.get_cli_path()?;

        if !self.check_cli_available() {
            return Err(AppError::ProcessError(format!(
                "Mimo CLI 不可用，路径: {}。请确保 Mimo 已正确安装。",
                cli_path
            )));
        }

        // 消息通过 stdin 以纯文本发送
        let initial_stdin_data = Some(Self::build_stdin_payload(message));

        // 构建命令
        let (resume_sid, fork_flag) = if let Some(ref fork_sid) = options.fork_session_id {
            (Some(fork_sid.as_str()), true)
        } else {
            (None, false)
        };

        let mut cmd = self.build_command(
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

        let initial_stdin_data = Some(Self::build_stdin_payload(message));

        let mut cmd = self.build_command(
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
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = format!("{:?} {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());
        tracing::info!("[MimocodeEngine] 执行命令: {}", cmd_str);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> MimoStreamEvent {
        MimoStreamEvent::parse_line(line).expect("应能解析实测捕获的事件行")
    }

    /// 实测捕获的 text 事件
    #[test]
    fn test_parse_text_event() {
        let line = r#"{"type":"text","timestamp":1781264045893,"sessionID":"ses_14463c683ffec856zhbCb7o0jZ","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_14463c683ffec856zhbCb7o0jZ","type":"text","text":"pong","time":{"start":1,"end":2}}}"#;
        let event = parse(line);
        assert_eq!(event.event_type, "text");
        assert_eq!(event.session_id.as_deref(), Some("ses_14463c683ffec856zhbCb7o0jZ"));

        let events = mimo_event_to_ai_events(&event, "sid");
        assert_eq!(events.len(), 1);
        match &events[0] {
            AIEvent::AssistantMessage(e) => assert_eq!(e.content, "pong"),
            other => panic!("应为 AssistantMessage，实际: {}", other.event_type()),
        }
    }

    /// 实测捕获的 tool_use 事件（到达时已是终态）
    #[test]
    fn test_parse_tool_use_event() {
        let line = r#"{"type":"tool_use","timestamp":1781264349883,"sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"call_1dcf","state":{"status":"completed","input":{"command":"echo hello > test.txt","description":"Create test.txt"},"output":"(no output)","metadata":{"exit":0},"title":"Create test.txt","time":{"start":1,"end":2}},"id":"prt_2","sessionID":"ses_1","messageID":"msg_1"}}"#;
        let event = parse(line);
        let events = mimo_event_to_ai_events(&event, "sid");
        assert_eq!(events.len(), 2);
        match &events[0] {
            AIEvent::ToolCallStart(e) => {
                assert_eq!(e.tool, "bash");
                assert_eq!(e.call_id.as_deref(), Some("call_1dcf"));
                assert!(e.args.contains_key("command"));
            }
            other => panic!("应为 ToolCallStart，实际: {}", other.event_type()),
        }
        match &events[1] {
            AIEvent::ToolCallEnd(e) => {
                assert_eq!(e.tool, "bash");
                assert!(e.success);
                assert!(e.result.is_some());
            }
            other => panic!("应为 ToolCallEnd，实际: {}", other.event_type()),
        }
    }

    /// 实测捕获的 reasoning 事件（--thinking）
    #[test]
    fn test_parse_reasoning_event() {
        let line = r#"{"type":"reasoning","timestamp":1781264783514,"sessionID":"ses_1","part":{"id":"prt_3","messageID":"msg_1","sessionID":"ses_1","type":"reasoning","text":"思考内容","time":{"start":1,"end":2}}}"#;
        let event = parse(line);
        let events = mimo_event_to_ai_events(&event, "sid");
        assert_eq!(events.len(), 1);
        match &events[0] {
            AIEvent::Thinking(e) => assert_eq!(e.content, "思考内容"),
            other => panic!("应为 Thinking，实际: {}", other.event_type()),
        }
    }

    /// step_start / step_finish 为轮次边界，不透出
    #[test]
    fn test_step_events_are_ignored() {
        let start = parse(r#"{"type":"step_start","timestamp":1,"sessionID":"ses_1","part":{"type":"step-start"}}"#);
        let finish = parse(r#"{"type":"step_finish","timestamp":1,"sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","tokens":{"total":1}}}"#);
        assert!(mimo_event_to_ai_events(&start, "sid").is_empty());
        assert!(mimo_event_to_ai_events(&finish, "sid").is_empty());
    }

    /// 未知事件类型不应 panic
    #[test]
    fn test_unknown_event_type() {
        let event = parse(r#"{"type":"future_event","sessionID":"ses_1","part":{}}"#);
        assert!(mimo_event_to_ai_events(&event, "sid").is_empty());
    }

    /// 非 JSON 行返回 None
    #[test]
    fn test_parse_line_rejects_non_json() {
        assert!(MimoStreamEvent::parse_line("").is_none());
        assert!(MimoStreamEvent::parse_line("plain text").is_none());
        assert!(MimoStreamEvent::parse_line("{broken json").is_none());
    }

    /// stdin 负载为纯文本 + 换行（不能用 Claude stream-json 包装）
    #[test]
    fn test_stdin_payload_is_raw_text() {
        assert_eq!(MimocodeEngine::build_stdin_payload("hello"), "hello\n");
        assert_eq!(MimocodeEngine::build_stdin_payload("hello\n"), "hello\n");
        let payload = MimocodeEngine::build_stdin_payload("多行\n消息");
        assert_eq!(payload, "多行\n消息\n");
        assert!(!payload.contains("\"type\":\"user\""));
    }
}
