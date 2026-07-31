/*! Pi 引擎
 *
 * 实现 AIEngine 接口，作为 earendil-works pi-coding-agent CLI 的适配器。
 *
 * 通信模式（基于 pi.dev/docs/latest/rpc 与本机实测）：
 * - 启动: `pi --mode rpc --no-session [--provider <p>] [--model <m>]
 *          [--api-key <k>] [--system-prompt <s>] [--append-system-prompt <a>]
 *          [--thinking <level>] [--no-extensions] [--no-skills] [--no-context-files]`
 * - 输入: 通过 stdin 发送 JSONL 命令行，如
 *          `{"id":"req-1","type":"prompt","message":"..."}\n`
 * - 输出: stdout 输出三类 JSONL 行（严格 LF 分隔，不能跨平台用 Node readline）：
 *   1. 会话头 `{"type":"session","id":"<pi-session-uuid>",...}`
 *   2. 命令响应 `{"type":"response","id":..,"command":..,"success":..,"data":..}`
 *   3. 事件 `{"type":"agent_start"|"turn_start"|"message_start"|
 *      "message_update"|"message_end"|"turn_end"|"agent_end"|
 *      "tool_execution_start"|"tool_execution_update"|"tool_execution_end"|...}`
 * - 续聊: session 落盘到 `<DataRoot>/pi-sessions`，通过 `--session-dir` +
 *   `--session-id <id>`(创建) / `--session <id>`(resume) 让 pi 跨进程恢复上文。
 *   start_session 用临时 ID + --session-id 创建；continue_session 用从 session
 *   头读回的真实 ID + --session（partial UUID 命中 <ts>_<id>.jsonl 并回放历史）。
 *   每轮仍 kill+respawn 新进程（与 Mimo 同构），上下文由 pi 的 resume 机制恢复，而非进程常驻。
 * - 中断: 向 stdin 发 `{"type":"abort"}\n` 命令（优雅中断），失败则 kill 进程
 *
 * 不支持/首版未启用的能力：
 * - MCP 配置文件：pi 用 auth.json + extensions 体系，不走 --mcp-config（见 M4 桥接方案）
 * - 多目录：pi 无 --add-dir 等价参数
 * - 运行时压缩：pi_parser 已透出 compaction 事件，但 pi 本体触发能力待实测
 *
 * 已支持：
 * - 图片附件：通过 prompt 命令的 images 字段传递（media_type + 纯 base64 data）
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineId, SessionOptions, ImageAttachment,
    EngineMetadata, EngineDistribution, EngineCapabilities, EnvKeyMapping,
    PiProviderConfig,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::AIEvent;
use crate::services::data_root::data_root;

use super::pi_parser::{
    PiRpcLine, pi_line_to_ai_events, extract_session_id_from_state,
    build_prompt_command, build_abort_command,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// Pi Code 引擎
pub struct PiEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
}

impl PiEngine {
    /// 创建新的 Pi 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
        }
    }

    /// 获取 Pi CLI 路径
    ///
    /// 查找顺序（与 CodexEngine / MimocodeEngine 对齐）：
    /// 1. 配置文件中的 pi_code.cli_path（用户自定义）
    /// 2. Windows: %APPDATA%\npm\pi.cmd / %PNPM_HOME%\pi.cmd / %LOCALAPPDATA%\pnpm\pi.cmd
    /// 3. where/which pi（PATH 查找，取完整路径）
    /// 4. 默认 "pi"
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        // 1. 配置文件中的路径（用户自定义）
        let config_path = self.config.get_pi_cmd();
        if config_path != "pi" && !config_path.is_empty() {
            tracing::info!("[PiEngine] 使用配置路径: {}", config_path);
            self.cli_path = Some(config_path.clone());
            return Ok(config_path);
        }

        // 2. Windows: 探测 npm/pnpm 全局安装路径
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let p = PathBuf::from(&appdata).join("npm").join("pi.cmd");
                if p.exists() {
                    let s = p.to_string_lossy().to_string();
                    tracing::info!("[PiEngine] 在 APPDATA\\npm 找到: {}", s);
                    self.cli_path = Some(s.clone());
                    return Ok(s);
                }
            }
            if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
                let p = PathBuf::from(&pnpm_home).join("pi.cmd");
                if p.exists() {
                    let s = p.to_string_lossy().to_string();
                    tracing::info!("[PiEngine] 在 PNPM_HOME 找到: {}", s);
                    self.cli_path = Some(s.clone());
                    return Ok(s);
                }
            }
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                let p = PathBuf::from(&localappdata).join("pnpm").join("pi.cmd");
                if p.exists() {
                    let s = p.to_string_lossy().to_string();
                    tracing::info!("[PiEngine] 在 LOCALAPPDATA\\pnpm 找到: {}", s);
                    self.cli_path = Some(s.clone());
                    return Ok(s);
                }
            }
            // where pi
            if let Ok(output) = Command::new("where")
                .arg("pi")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let best = stdout.lines()
                        .map(|l| l.trim())
                        .filter(|l| !l.is_empty() && Path::new(l).exists())
                        .max_by_key(|l| {
                            let lower = l.to_ascii_lowercase();
                            if lower.ends_with(".exe") { 2 }
                            else if lower.ends_with(".cmd") || lower.ends_with(".bat") { 1 }
                            else { 0 }
                        });
                    if let Some(s) = best {
                        let s = s.to_string();
                        tracing::info!("[PiEngine] 通过 where 找到: {}", s);
                        self.cli_path = Some(s.clone());
                        return Ok(s);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            if let Ok(output) = Command::new("which")
                .arg("pi")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first) = stdout.lines().next() {
                        let s = first.trim().to_string();
                        if !s.is_empty() && Path::new(&s).exists() {
                            tracing::info!("[PiEngine] 通过 which 找到: {}", s);
                            self.cli_path = Some(s.clone());
                            return Ok(s);
                        }
                    }
                }
            }
        }

        tracing::warn!("[PiEngine] 未找到 pi CLI，将使用默认 'pi'（依赖 PATH）");
        let default_path = "pi".to_string();
        self.cli_path = Some(default_path.clone());
        Ok(default_path)
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

    /// 写入 `~/.pi/agent/models.json` 注册自定义 provider。
    ///
    /// pi 通过 `~/.pi/agent/models.json` 发现自定义 provider 端点，
    /// 格式为 `{ "providers": { "<name>": { "baseUrl": ... } } }`。
    /// 以追加/合并方式写入，不覆盖已有 provider。
    ///
    /// 参考：https://github.com/earendil-works/pi-mono/blob/main/packages/pi/docs/models.md
    fn write_models_json(provider_cfg: &PiProviderConfig) -> Result<()> {
        let pi_dir = Self::pi_agent_dir();
        fs::create_dir_all(&pi_dir)?;
        let models_path = pi_dir.join("models.json");

        // 读取现有 models.json（若存在）
        let existing = fs::read_to_string(&models_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

        let provider_entry = serde_json::json!({
            "baseUrl": provider_cfg.base_url,
            "api": provider_cfg.api,
            "apiKey": provider_cfg.api_key,
            "models": [
                {
                    "id": provider_cfg.name,
                    "name": provider_cfg.name,
                    "reasoning": false,
                    "input": ["text"],
                    "contextWindow": provider_cfg.context_window,
                    "maxTokens": provider_cfg.max_tokens,
                }
            ]
        });

        let updated = if let Some(mut existing) = existing {
            // 确保 providers 对象存在
            if !existing.is_object() {
                existing = serde_json::json!({});
            }
            if existing.get("providers").is_none() {
                existing["providers"] = serde_json::json!({});
            }
            existing["providers"][&provider_cfg.name] = provider_entry;
            existing
        } else {
            let mut providers = serde_json::Map::new();
            providers.insert(provider_cfg.name.clone(), provider_entry);
            serde_json::json!({
                "providers": providers
            })
        };

        let content = serde_json::to_string_pretty(&updated)?;
        fs::write(&models_path, content)?;
        tracing::info!(
            "[PiEngine] 已写入 models.json: provider={}, baseUrl={}",
            provider_cfg.name, provider_cfg.base_url
        );
        Ok(())
    }

    /// 获取 pi agent 配置目录（PI_CODING_AGENT_DIR 或 ~/.pi/agent）
    fn pi_agent_dir() -> PathBuf {
        if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
            PathBuf::from(dir)
        } else {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".pi")
                .join("agent")
        }
    }

    /// 写入 pi extensions 配置（auth.json），把 Polaris MCP server 注册为 pi extension。
    ///
    /// ⚠️ 路径 A（auth.json extensions 注入）：pi extensions 协议未公开稳定，
    /// 本函数按 pi auth.json 的 extensions 数组格式写入 stdio MCP server
    /// （name + command + args）。是否真能被 pi 加载并桥接 MCP 工具，**需实测确认**。
    /// 若 pi 不支持 stdio MCP extension，应回退到路径 B（自研 Pi Extension 桥接）。
    ///
    /// 只在 config.pi_code.enable_extensions = true 时调用。
    /// 以追加/合并方式写入，不覆盖非 polaris-mcp 的 extension 项。
    fn write_extensions_config(servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer]) -> Result<()> {
        let pi_dir = Self::pi_agent_dir();
        fs::create_dir_all(&pi_dir)?;
        let auth_path = pi_dir.join("auth.json");

        let existing = fs::read_to_string(&auth_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

        // polaris-mcp extension 项前缀，便于识别与更新（不破坏用户其他 extension）
        const POLARIS_PREFIX: &str = "polaris-mcp-";

        let mut extensions_arr: Vec<serde_json::Value> = Vec::new();
        if let Some(ref existing) = existing {
            if let Some(arr) = existing.get("extensions").and_then(|v| v.as_array()) {
                // 保留非 polaris-mcp 的 extension 项
                for item in arr {
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !name.starts_with(POLARIS_PREFIX) {
                        extensions_arr.push(item.clone());
                    }
                }
            }
        }

        // 追加 polaris-mcp extension 项（每个 MCP server 一个 extension）
        for srv in servers {
            let ext_name = format!("{}{}", POLARIS_PREFIX, srv.server_name);
            extensions_arr.push(serde_json::json!({
                "name": ext_name,
                "command": srv.command,
                "args": srv.args,
                // stdio 传输（pi extension 默认 stdio）
                "transport": "stdio",
            }));
        }

        let mut updated = existing.unwrap_or_else(|| serde_json::json!({}));
        if !updated.is_object() {
            updated = serde_json::json!({});
        }
        updated["extensions"] = serde_json::Value::Array(extensions_arr);

        let content = serde_json::to_string_pretty(&updated)?;
        fs::write(&auth_path, content)?;
        tracing::info!(
            "[PiEngine] 已写入 auth.json extensions: {} 个 polaris-mcp server",
            servers.len()
        );
        Ok(())
    }

    /// pi session 落盘目录：`<DataRoot>/pi-sessions`
    ///
    /// 用 `--session-dir` 指定后，pi 会在此目录下按 session-id 持久化
    /// 对话历史（jsonl），供跨进程 resume。
    fn pi_session_dir() -> Result<PathBuf> {
        let dir = data_root().root().join("pi-sessions");
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 构建 `pi --mode rpc` 命令
    ///
    /// `resume=false`（start_session）用 `--session-id <id>`：精确 ID，不存在则创建。
    /// `resume=true`（continue_session）改用 `--session <id>`：按 partial UUID 匹配已落盘的
    /// `<timestamp>_<id>.jsonl` 并加载历史上下文。
    ///
    /// 实测发现：`--session-id` 的语义是"精确 ID，不存在就新建"——它在 session-dir 下
    /// 查找时**不匹配带时间戳前缀的落盘文件名 `<ts>_<id>.jsonl`**，因此即便该 id 的
    /// session 文件已存在，pi 仍报 "No project session found; creating a new session"，
    /// 导致续聊每轮都是空 session、LLM 看不到上文。`--session <id>` 才会真正 resume
    /// 已有 session（按 partial UUID 命中文件 + 回放历史消息 + 追加新轮次）。
    #[allow(clippy::too_many_arguments)]
    fn build_command(
        &self,
        session_id: &str,
        resume: bool,
        system_prompt: Option<&str>,
        append_system_prompt: Option<&str>,
        model: Option<&str>,
        pi_model: Option<&str>,
        provider: Option<&str>,
        api_key: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        allowed_tools: &[String],
        disallowed_tools: &[String],
        _image_attachments: &[ImageAttachment],
    ) -> Result<Command> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

        let mut cmd = Self::create_command(cli_path);
        cmd.arg("--mode").arg("rpc");

        // 持久化 session：落盘到 <DataRoot>/pi-sessions，用 --session-id 绑定 Polaris
        // 会话 ID。start_session 时 pi 会创建该 session；continue_session 时 pi 会
        // 从落盘文件 resume 恢复上下文。每轮仍 kill+respawn 新进程，上下文由 pi
        // 的 resume 机制恢复，而非进程常驻（与 Mimo --session <id> 同构）。
        let session_dir = Self::pi_session_dir()?;
        cmd.arg("--session-dir").arg(&session_dir);
        if resume {
            // 续聊：--session 按 partial UUID 命中 <ts>_<id>.jsonl 并回放历史
            cmd.arg("--session").arg(session_id);
        } else {
            // 首轮：--session-id 精确 ID，不存在则创建
            cmd.arg("--session-id").arg(session_id);
        }

        // 自定义 provider：通过 models.json 注册后，用 --provider 选择
        // 优先使用 pi_model（已剥离 CLI 私有后缀），否则用 model 原值
        let final_model = pi_model.or(model);
        if let Some(provider_name) = provider {
            if !provider_name.is_empty() {
                cmd.arg("--provider").arg(provider_name);
            }
        }
        if let Some(m) = final_model {
            if !m.is_empty() {
                cmd.arg("--model").arg(m);
            }
        }

        // --api-key：对于自定义 provider 稳定传递 API key
        if let Some(k) = api_key {
            if !k.is_empty() {
                cmd.arg("--api-key").arg(k);
            }
        }

        // 努力级别 → --thinking（pi: off/minimal/low/medium/high/xhigh/max）
        if let Some(e) = effort {
            if !e.is_empty() {
                cmd.arg("--thinking").arg(Self::map_effort_to_thinking(e));
            }
        }

        // 系统提示词：pi 支持 --system-prompt 与 --append-system-prompt
        if let Some(prompt) = system_prompt {
            if !prompt.is_empty() {
                cmd.arg("--system-prompt").arg(prompt);
            }
        }
        if let Some(prompt) = append_system_prompt {
            if !prompt.is_empty() {
                cmd.arg("--append-system-prompt").arg(prompt);
            }
        }

        // 权限模式：pi 默认信任项目本地文件需 --approve；bypass/skip 透传
        if let Some(pm) = permission_mode {
            if !pm.is_empty() && (pm == "bypassPermissions" || pm.contains("skip")) {
                // pi 无 --dangerously-skip-permissions 等价物；--approve 信任项目文件
                cmd.arg("--approve");
            }
        }

        // 工具白名单：pi 的 --tools 是允许列表
        if !allowed_tools.is_empty() {
            cmd.arg("--tools").arg(allowed_tools.join(","));
        }
        if !disallowed_tools.is_empty() {
            cmd.arg("--exclude-tools").arg(disallowed_tools.join(","));
        }

        // 图片附件：不通过 CLI 启动参数传递，而是在 prompt 命令的 images 字段传递
        // （见 spawn_event_reader → build_prompt_command）。此处无需处理。

        // 禁用 pi 扩展/skills/context 发现，避免污染（与最小引擎语义一致）
        // 注：这会禁用 pi 的 prompt-templates/skills，但内置 read/bash/edit/write 工具仍可用
        // MCP 桥接：当 enable_extensions 开启时，移除 --no-extensions 以加载 auth.json extensions
        // （Polaris 把 MCP server 写入 extensions，让 pi 能消费 Polaris MCP 生态）
        if !self.config.pi_code.enable_extensions {
            cmd.arg("--no-extensions");
        }
        cmd.arg("--no-skills");

        Ok(cmd)
    }

    /// 把 Polaris effort 映射到 pi thinking level
    ///
    /// Polaris effort 通常为 low/medium/high；pi 支持 off/minimal/low/medium/high/xhigh/max。
    /// 未知值降级到 medium。
    fn map_effort_to_thinking(e: &str) -> &'static str {
        match e.to_ascii_lowercase().as_str() {
            "off" | "none" | "0" => "off",
            "minimal" => "minimal",
            "low" => "low",
            "high" => "high",
            "xhigh" | "extra" => "xhigh",
            "max" | "ultra" => "max",
            _ => "medium",
        }
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
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }

        // 应用环境变量覆盖（API key / base URL 等）
        // pi 支持 ANTHROPIC_API_KEY / OPENAI_API_KEY 等 env，与 Polaris env_overrides 路径同构
        for (key, value) in env_overrides {
            cmd.env(key, value);
        }
    }

    /// 启动后台线程读取 RPC stdout 事件
    fn spawn_event_reader(
        &self,
        child: Child,
        temp_id: String,
        pid: u32,
        options: SessionOptions,
        initial_prompt: Option<String>,
        initial_images: Vec<ImageAttachment>,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let current_session_id = temp_id.clone();

        let (input_sender, input_receiver) = std::sync::mpsc::channel::<String>();
        let input_sender_for_return = input_sender.clone();

        // [P0] session 头就绪信号：stdout 读取线程收到 session 头后发信号，
        // stdin 写入线程等待此信号再发送初始 prompt 命令，避免在 Pi RPC 状态机
        // 尚未就绪时即发出 prompt（见 pi.responder 在 stdin 就绪但 stdout
        // 尚未输出 session 头时的竞态，会导致 Pi 静默退出）。
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

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

            // stderr 读取线程：收集前若干条 stderr 行，在 stdout 无有效事件时作为错误
            // 透传，便于诊断 Pi 启动失败/模型不可用等真实原因。
            let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let stderr_buf_clone = stderr_buf.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                let mut count = 0;
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[PiEngine] stderr: {}", line);
                    if let Ok(mut buf) = stderr_buf_clone.lock() {
                        buf.push(line);
                    }
                    count += 1;
                    // 防止 stderr 持续刷屏撑大内存（pi 启动慢时会大量输出 debug）
                    if count >= 50 {
                        break;
                    }
                }
            });

            // stdin 写入线程：等待 session 头就绪信号后，才发送初始 prompt 命令。
            const READY_TIMEOUT_SECS: u64 = 60;
            let stderr_buf_for_stdin = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut stdin_writer = stdin;

                // 等待 Pi RPC 状态机就绪（session 头到达）
                let session_ready = ready_rx.recv_timeout(Duration::from_secs(READY_TIMEOUT_SECS));
                match session_ready {
                    Ok(()) => {
                        tracing::info!("[PiEngine] Pi 已就绪（session 头已接收），发送初始 prompt");
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        tracing::error!(
                            "[PiEngine] 等待 Pi session 头就绪超时（{}s），进程 PID={}；\
                             请检查 pi 安装、provider 配置与网络连接",
                            READY_TIMEOUT_SECS,
                            pid,
                        );
                        let stderr_lines = stderr_buf_for_stdin
                            .lock()
                            .ok()
                            .map(|b| b.iter().cloned().collect::<Vec<_>>())
                            .unwrap_or_default();
                        let stderr_hint = if !stderr_lines.is_empty() {
                            format!(
                                "\nstderr 关键输出:\n{}",
                                stderr_lines.iter().take(10).map(|l| format!("  {}", l)).collect::<Vec<_>>().join("\n")
                            )
                        } else {
                            String::new()
                        };
                        if let Some(ref cb) = on_error {
                            cb(format!(
                                "等待 Pi 就绪超时（{}s），未收到 session 头。请检查 pi 是否已正确安装、provider 是否配置有效（~/.pi/agent/models.json）以及网络连接。{}",
                                READY_TIMEOUT_SECS, stderr_hint
                            ));
                        }
                        return;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // ready_tx 已销毁（reader 线程异常退出），进程 stdout 已关闭，
                        // 不在 stdin 侧重复报告——reader 主线程会发出收尾错误。
                        tracing::warn!(
                            "[PiEngine] ready_tx 已断开（reader 线程已退出），跳过初始 prompt"
                        );
                        return;
                    }
                }

                if let Some(prompt) = initial_prompt {
                    let cmd_line = build_prompt_command(&prompt, "init", &initial_images);
                    if let Err(e) = stdin_writer.write_all(cmd_line.as_bytes())
                        .and_then(|_| stdin_writer.flush())
                    {
                        tracing::error!("[PiEngine] 发送初始 prompt 命令失败: {}", e);
                        return;
                    }
                }

                // 保持 stdin 打开，转发后续命令（abort / steer / follow_up）
                while let Ok(input) = input_receiver.recv() {
                    if let Err(e) = stdin_writer.write_all(input.as_bytes()) {
                        tracing::warn!("[PiEngine] stdin 写入失败: {}", e);
                        break;
                    }
                    if let Err(e) = stdin_writer.flush() {
                        tracing::warn!("[PiEngine] stdin flush 失败: {}", e);
                        break;
                    }
                }
                // stdin 关闭后 pi 进程会退出
            });

            // 读取 stdout JSONL，翻译为 AIEvent
            let reader = BufReader::new(stdout);
            let mut real_session_id = current_session_id.clone();
            let mut line_count: usize = 0;
            let mut known_event_count: usize = 0;
            let mut agent_ended = false;
            let mut session_header_received = false;

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

                let Some(pi_line) = PiRpcLine::parse_line(trimmed) else {
                    let preview: String = trimmed.chars().take(300).collect();
                    tracing::warn!("[PiEngine] 无法解析 stdout 行: {}", preview);
                    continue;
                };
                known_event_count += 1;

                // 会话头 / get_state 响应里可能携带 pi 真实 sessionId
                let mut sid_hint: Option<String> = None;
                if pi_line.line_type == "session" {
                    // [P0] 收到 session 头后通知 stdin 线程：Pi RPC 状态机已就绪，
                    // 可以安全发送初始 prompt 命令。忽略 ready_tx 发送失败（reader 线程
                    // 自身 panic 或 stdin 线程已超时的退化情况）——不影响 Pi 行为。
                    let _ = ready_tx.send(());
                    session_header_received = true;

                    sid_hint = pi_line.data.get("id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                } else if pi_line.line_type == "response" && pi_line.command.as_deref() == Some("get_state") {
                    sid_hint = extract_session_id_from_state(&pi_line.data);
                }
                if let Some(ref sid) = sid_hint {
                    if *sid != real_session_id {
                        SessionManager::update_session_id_shared(
                            &sessions, &real_session_id, sid, pid, "pi", Some(input_sender.clone())
                        );
                        real_session_id = sid.clone();
                        if let Some(ref cb) = on_session_id_update {
                            cb(real_session_id.clone());
                        }
                        event_callback(AIEvent::session_start(&real_session_id));
                    }
                }

                if pi_line.line_type == "agent_end" {
                    agent_ended = true;
                }

                // Pi RPC：agent_end（或 agent_settled）后当前 prompt 处理已完全结束。
                // 首版无状态模式不保留进程做续聊——收到 agent_end 后发 session_end
                // 并退出 reader 循环，让 stdin channel 关闭、pi 进程退出，前端
                // streaming 状态才能结束。用户续聊走 continue_session（重新 spawn）。
                if pi_line.line_type == "agent_end" {
                    tracing::info!(
                        "[PiEngine] 收到 agent_end，结束当前 turn，session={}",
                        real_session_id
                    );
                } else if pi_line.line_type == "agent_settled" {
                    tracing::info!(
                        "[PiEngine] 收到 agent_settled，session={}",
                        real_session_id
                    );
                }

                let parsed = pi_line_to_ai_events(&pi_line, &real_session_id);
                for ev in parsed.events {
                    event_callback(ev);
                }

                if pi_line.line_type == "agent_end" || pi_line.line_type == "agent_settled" {
                    break;
                }
            }

            // 收尾
            if !agent_ended && line_count > 0 {
                tracing::warn!(
                    "[PiEngine] reader 循环退出但未收到 agent_end，session={}",
                    real_session_id
                );
            }
            if line_count == 0 {
                // [P0] stdout 完全无输出：区分"Pi 尚未就绪"与"纯空"
                if !session_header_received {
                    let stderr_lines = stderr_buf.lock().ok().map(|b| b.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
                    let stderr_hint = if !stderr_lines.is_empty() {
                        format!(
                            "\nstderr 关键输出:\n{}",
                            stderr_lines.iter().take(10).map(|l| format!("  {}", l)).collect::<Vec<_>>().join("\n")
                        )
                    } else {
                        String::new()
                    };
                    tracing::warn!("[PiEngine] CLI 未产生任何 stdout 输出（session 头也未收到）");
                    event_callback(AIEvent::error(
                        &real_session_id,
                        format!("Pi CLI 未产生任何输出，未收到 session 头。请检查 pi 是否已正确安装（npm install -g --ignore-scripts @earendil-works/pi-coding-agent）、provider 是否已配置（~/.pi/agent/models.json）以及网络连接。{}", stderr_hint),
                    ));
                } else {
                    tracing::warn!("[PiEngine] CLI 未产生任何 stdout 输出");
                    event_callback(AIEvent::error(
                        &real_session_id,
                        "Pi CLI 未产生任何输出，请检查 pi 是否已安装（npm install -g --ignore-scripts @earendil-works/pi-coding-agent）及 provider 是否已配置".to_string(),
                    ));
                }
            } else if known_event_count == 0 {
                tracing::warn!("[PiEngine] CLI 产生 {} 行输出但无法解析任何事件", line_count);
                event_callback(AIEvent::error(
                    &real_session_id,
                    format!("Pi CLI 输出无法解析（{} 行）。请检查 pi 版本兼容性", line_count),
                ));
            }
            event_callback(AIEvent::session_end(&real_session_id));

            if !agent_ended {
                tracing::warn!("[PiEngine] 进程退出但未收到 agent_end 事件");
            }
            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }
}

impl AIEngine for PiEngine {
    fn id(&self) -> EngineId {
        EngineId::Pi
    }

    fn name(&self) -> &'static str {
        "Pi"
    }

    fn description(&self) -> &'static str {
        "earendil-works pi-coding-agent CLI - 多提供商终端编码助手"
    }

    fn metadata(&self) -> EngineMetadata {
        EngineMetadata {
            id: EngineId::Pi,
            name: "Pi".into(),
            description: Some("Pi (pi-coding-agent) CLI — 支持多模型提供商、工具调用、流式输出、思考级别".into()),
            distribution: EngineDistribution::PackageRunner {
                package: "@earendil-works/pi-coding-agent".into(),
                cmd: "pi".into(),
                args: vec!["--mode".into(), "rpc".into()],
                runtime_min_version: None,
            },
            capabilities: EngineCapabilities {
                tools: true,
                image_input: false, // 首版未接 RPC images
                streaming: true,
                interrupt: true,
                resume: true, // --session-dir + --session-id 跨进程 resume
                stdin_input: true, // 可发 steer/abort
                fork_session: false,
            },
            env_keys: EnvKeyMapping::default(), // 多提供商，走通用 env_overrides
            supports_model_provider: false,
        }
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
        tracing::info!("[PiEngine] 启动会话，消息长度: {}", message.len());

        let cli_path = self.get_cli_path()?;
        if !self.check_cli_available() {
            return Err(AppError::ProcessError(format!(
                "Pi CLI 不可用，路径: {}。请确保 pi 已正确安装（npm install -g --ignore-scripts @earendil-works/pi-coding-agent）。",
                cli_path
            )));
        }

        // 自定义 provider：写入 models.json 注册端点
        if let Some(ref provider_cfg) = options.pi_provider_config {
            Self::write_models_json(provider_cfg)?;
            tracing::info!(
                "[PiEngine] 将使用自定义 provider: {} (baseUrl={})",
                provider_cfg.name, provider_cfg.base_url
            );
        }

        // 先生成 temp_id：build_command 需要用它作为 --session-id，让 pi 创建 session
        let temp_id = uuid::Uuid::new_v4().to_string();

        // MCP 桥接（路径 A）：enable_extensions 时把 Polaris MCP server 写入 auth.json
        // extensions，并移除 --no-extensions 让 pi 加载。⚠️ 需实测 pi 是否支持 stdio MCP extension。
        if self.config.pi_code.enable_extensions && !options.mcp_servers.is_empty() {
            if let Err(e) = Self::write_extensions_config(&options.mcp_servers) {
                tracing::warn!("[PiEngine] 写入 auth.json extensions 失败: {}，MCP 桥接未生效", e);
            }
        }

        let mut cmd = self.build_command(
            &temp_id,
            false,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            options.model.as_deref(),
            options.pi_model.as_deref(),
            options.pi_provider_config.as_ref().map(|c| c.name.as_str()),
            options.pi_provider_config.as_ref().map(|c| c.api_key.as_str()),
            options.effort.as_deref(),
            options.permission_mode.as_deref(),
            &options.allowed_tools,
            &options.disallowed_tools,
            &options.image_attachments,
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = format!("{:?} {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());
        tracing::info!("[PiEngine] 执行命令: {}", cmd_str);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 pi 进程失败: {}", e)))?;
        let pid = child.id();
        tracing::info!("[PiEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        // 初始 prompt 附带的图片（move options 前克隆）
        let initial_images = options.image_attachments.clone();
        let input_sender = self.spawn_event_reader(
            child, temp_id.clone(), pid, options, Some(message.to_string()), initial_images,
        );
        self.sessions.register_with_sender(
            temp_id.clone(), pid, "pi".to_string(), Some(input_sender),
        )?;

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[PiEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Pi CLI 不可用".to_string()));
        }

        // 自定义 provider：写入 models.json 注册端点
        if let Some(ref provider_cfg) = options.pi_provider_config {
            Self::write_models_json(provider_cfg)?;
        }

        // MCP 桥接（路径 A）：enable_extensions 时刷新 auth.json extensions
        if self.config.pi_code.enable_extensions && !options.mcp_servers.is_empty() {
            if let Err(e) = Self::write_extensions_config(&options.mcp_servers) {
                tracing::warn!("[PiEngine] 写入 auth.json extensions 失败: {}，MCP 桥接未生效", e);
            }
        }

        // pi 持久化 session：继续会话即 kill 旧进程 + spawn 新进程，用从 session 头
        // 读回的真实 session-id 让 pi 从落盘文件 resume 恢复上文。若未读到真实 ID
        // （如首轮就异常退出），回退到传入的 session_id——pi 会按该 ID 创建新 session。
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[PiEngine] 找到会话，真实 ID: {}, PID: {}", info.id, info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone()
        } else {
            tracing::warn!("[PiEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        let mut cmd = self.build_command(
            &real_session_id,
            true,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            options.model.as_deref(),
            options.pi_model.as_deref(),
            options.pi_provider_config.as_ref().map(|c| c.name.as_str()),
            options.pi_provider_config.as_ref().map(|c| c.api_key.as_str()),
            options.effort.as_deref(),
            options.permission_mode.as_deref(),
            &options.allowed_tools,
            &options.disallowed_tools,
            &options.image_attachments,
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = format!("{:?} {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());
        tracing::info!("[PiEngine] 执行命令: {}", cmd_str);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 pi 会话失败: {}", e)))?;
        let pid = child.id();

        // 续聊 prompt 附带的图片（move options 前克隆）
        let initial_images = options.image_attachments.clone();
        let input_sender = self.spawn_event_reader(
            child, real_session_id.clone(), pid, options, Some(message.to_string()), initial_images,
        );
        self.sessions.register_with_sender(
            real_session_id.clone(), pid, "pi".to_string(), Some(input_sender),
        )?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[PiEngine] 中断会话: {}", session_id);

        // 优先发 abort 命令（优雅中断，pi 会停止当前 LLM 调用并收尾）
        if let Ok(true) = self.sessions.send_input(session_id, &build_abort_command()) {
            tracing::info!("[PiEngine] 已发送 abort 命令: {}", session_id);
            // 给 pi 一点收尾时间，再 kill 兜底
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[PiEngine] 会话已中断: {}", session_id);
                Ok(())
            }
            Ok(false) => {
                tracing::warn!("[PiEngine] kill_process 返回 false: {}", session_id);
                Err(AppError::ProcessError(format!(
                    "会话不存在或 kill 失败: {}", session_id
                )))
            }
            Err(e) => {
                tracing::warn!("[PiEngine] kill_process 返回 Err: {} ({})", e, session_id);
                Err(e)
            }
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        tracing::info!("[PiEngine] 向会话 {} 发送输入: {} bytes", session_id, input.len());
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }

    fn update_config(&mut self, new_config: Config) {
        tracing::info!("[PiEngine] 应用新配置，失效 CLI 路径缓存");
        self.config = new_config;
        self.cli_path = None;
    }
}
