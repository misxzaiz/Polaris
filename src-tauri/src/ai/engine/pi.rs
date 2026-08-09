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
 *   每轮仍 kill+respawn 新进程，上下文由 pi 的 resume 机制恢复，而非进程常驻。
 * - 中断: 向 stdin 发 `{"type":"abort"}\n` 命令（优雅中断），失败则 kill 进程
 *
 * 不支持/首版未启用的能力：
 * - MCP --mcp-config：pi 无 --mcp-config 参数，改用 Pi Extension 桥接
 * - 多目录：pi 无 --add-dir 等价参数
 * - 运行时压缩：pi_parser 已透出 compaction 事件，但 pi 本体触发能力待实测
 *
 * 已支持：
 * - 图片附件：通过 prompt 命令的 images 字段传递（media_type + 纯 base64 data）
 * - MCP 桥接（路径 B）：enable_extensions 开启时，通过 Pi Extension 加载 stdio
 *   MCP server，把 MCP 工具注册为 Pi 可调用的 LLM 工具。Extension 源码内置于
 *   EXTENSION_SOURCE 常量，运行时写入 ~/.pi/agent/extensions/polaris-mcp-bridge/，
 *   通过显式 --extension 注入（始终保留 --no-extensions 禁止用户扩展自动发现）。
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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
use super::simple_ai_protocol::strip_cli_model_suffix;

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
    /// 查找顺序（与 CodexEngine 对齐）：
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

    /// 从 self.config 中解析活跃模型 Profile，构造 PiProviderConfig 及 env_overrides。
    ///
    /// 当 options 中未显式传入 pi_provider_config 时（如 IM 集成调用），
    /// 自动降级使用 Polaris 配置中的活跃模型 Profile，确保 Pi 引擎始终
    /// 能获得 provider/model/api-key 参数，避免静默使用 Pi 默认配置导致
    /// LLM 调用失败。
    fn resolve_provider_config_from_config(
        &self,
    ) -> Option<(PiProviderConfig, String, std::collections::HashMap<String, String>)> {
        // ★ DIAG: 记录配置解析过程
        let active_id = match self.config.active_model_profile_id.as_ref() {
            Some(id) => {
                tracing::info!("[PiEngine-DIAG] resolve_provider_config: active_model_profile_id={}", id);
                id
            }
            None => {
                tracing::warn!("[PiEngine-DIAG] resolve_provider_config: active_model_profile_id 未设置，无法解析 provider");
                return None;
            }
        };
        let profile = self.config.model_profiles.iter()
            .find(|p| &p.id == active_id);
        let profile = match profile {
            Some(p) => {
                tracing::info!("[PiEngine-DIAG] resolve_provider_config: 找到 profile: name={}, model={}, baseUrl={}", p.name, p.model, p.base_url);
                p
            }
            None => {
                tracing::warn!("[PiEngine-DIAG] resolve_provider_config: 未找到 profile id={}，可用 profiles: {:?}", active_id, self.config.model_profiles.iter().map(|p| &p.id).collect::<Vec<_>>());
                return None;
            }
        };

        // 剥离 CLI 私有后缀
        let stripped = strip_cli_model_suffix(&profile.model);
        let clean_model = stripped.base_model.clone().unwrap_or_else(|| profile.model.clone());

        // 确定 pi 的 api 类型
        let pi_api = match profile.wire_api.as_deref() {
            Some("openai-chat-completions") => "openai-completions",
            Some("openai-responses") => "openai-responses",
            _ => "anthropic-messages",
        };

        let provider_name = format!("polaris-{}", profile.id);
        let ctx_window = profile.context_window.unwrap_or(128000);

        let config = PiProviderConfig {
            name: provider_name,
            base_url: profile.base_url.clone(),
            api_key: profile.api_key.clone(),
            api: pi_api.to_string(),
            context_window: ctx_window,
            max_tokens: 16384,
        };

        // 构建环境变量覆盖（与 chat.rs 对齐）
        let mut env_overrides = std::collections::HashMap::new();
        if let Some(custom) = &profile.custom_env {
            for (k, v) in custom {
                env_overrides.insert(k.clone(), v.clone());
            }
        }
        if !profile.api_key.is_empty() {
            let env_name = match profile.wire_api.as_deref() {
                Some("openai-chat-completions" | "openai-responses") => "OPENAI_API_KEY",
                _ => "ANTHROPIC_API_KEY",
            };
            env_overrides.entry(env_name.to_string())
                .or_insert_with(|| profile.api_key.clone());
        }

        tracing::info!(
            "[PiEngine] 从配置中解析 provider: {} (model={}, baseUrl={})",
            config.name, clean_model, config.base_url
        );

        Some((config, clean_model, env_overrides))
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

    /// 获取 pi extension 桥接目录（`~/.pi/agent/extensions/polaris-mcp-bridge/`）
    fn bridge_dir() -> PathBuf {
        Self::pi_agent_dir().join("extensions").join("polaris-mcp-bridge")
    }

    /// 写入 Pi Extension 桥接文件（index.js + config.json）。
    ///
    /// 把 Polaris 的 MCP server 列表写入 `~/.pi/agent/extensions/polaris-mcp-bridge/`，
    /// 供 Pi Extension 在启动时加载并桥接为 LLM 工具。
    ///
    /// 只在 config.pi_code.enable_extensions = true 时调用。
    /// 委托到共享模块 `super::mcp_bridge::write_extension_bridge`。
    fn write_extension_bridge(servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer]) -> Result<()> {
        let bridge_dir = Self::bridge_dir();
        super::mcp_bridge::write_extension_bridge(&bridge_dir, servers)
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
        // 的 resume 机制恢复，而非进程常驻。
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
        // MCP 桥接：始终保留 --no-extensions 禁止用户扩展自动发现；
        // 当 enable_extensions 开启时，用显式 --extension 注入 Polaris MCP 桥接 Extension。
        cmd.arg("--no-extensions");
        if self.config.pi_code.enable_extensions {
            let bridge_dir = Self::bridge_dir();
            if bridge_dir.exists() {
                cmd.arg("--extension").arg(&bridge_dir);
                tracing::info!("[PiEngine] 注入 MCP 桥接 Extension: {}", bridge_dir.display());
            } else {
                tracing::warn!(
                    "[PiEngine] enable_extensions 开启但 Extension 文件不存在，跳过 MCP 桥接"
                );
            }
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
        mut child: Child,
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

        std::thread::spawn(move || {
            // 取出 stdio 句柄但保留 child 所有权：agent_end 后需 child.kill()
            // 兜底，避免修复 EPIPE 后进程残留。
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

            // stderr 读取线程（日志）
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[PiEngine] stderr: {}", line);
                }
            });

            // stdin 写入线程：先发初始 prompt（若有），再保持 stdin 打开供后续 abort/steer
            std::thread::spawn(move || {
                use std::io::Write;
                let mut stdin_writer = stdin;

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
            // 使用 read_line 手动循环而非 reader.lines()，以便保留 reader 所有权
            // 避免循环退出后 reader 被 drop 导致 stdout 管道关闭、pi 进程写入时 EPIPE
            let mut reader = BufReader::new(stdout);
            let mut real_session_id = current_session_id.clone();
            let mut line_count: usize = 0;
            let mut known_event_count: usize = 0;
            let mut message_event_count: usize = 0;
            let mut agent_ended = false;
            let mut line_buf = String::new();

            loop {
                line_buf.clear();
                match reader.read_line(&mut line_buf) {
                    Ok(0) => break,  // EOF
                    Ok(_) => {}
                    Err(_) => break,
                }
                let trimmed = line_buf.trim();
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

                // 统计 message 增量事件，用于 agent_end 时诊断"无响应中断"
                if pi_line.line_type == "message_update" || pi_line.line_type == "message_end" {
                    message_event_count += 1;
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

                let parsed = pi_line_to_ai_events(&pi_line, &real_session_id, "pi");
                for ev in parsed.events {
                    event_callback(ev);
                }

                if pi_line.line_type == "agent_end" || pi_line.line_type == "agent_settled" {
                    // 诊断：agent_end 时若全程无 message 事件，说明 Pi 在模型调用阶段
                    // 就直接结束（常见于 MCP 加载慢 + provider 超时），非正常完成。
                    if message_event_count == 0 {
                        tracing::warn!(
                            "[PiEngine] agent_end 但全程 0 个 message 事件，session={}（疑似 provider 超时或模型调用失败）",
                            real_session_id
                        );
                        // 发射 error 事件告知上层 LLM 调用失败，避免 IntegrationManager
                        // 静默跳过空回复，用户收不到任何反馈。
                        event_callback(AIEvent::error(
                            &real_session_id,
                            "Pi 引擎未生成任何回复：模型调用可能超时或 provider 配置有误。请检查 API Key、模型名称及网络连接。".to_string(),
                        ));
                    }
                    break;
                }
            }

            // 收尾
            // ★ DIAG: 输出事件统计摘要
            tracing::info!(
                "[PiEngine-DIAG] 事件统计: session={}, line_count={}, known_event_count={}, message_event_count={}, agent_ended={}",
                real_session_id, line_count, known_event_count, message_event_count, agent_ended
            );

            if !agent_ended && line_count > 0 {
                tracing::warn!(
                    "[PiEngine] reader 循环退出但未收到 agent_end，session={}",
                    real_session_id
                );
            }
            if line_count == 0 {
                tracing::warn!("[PiEngine] CLI 未产生任何 stdout 输出");
                event_callback(AIEvent::error(
                    &real_session_id,
                    "Pi CLI 未产生任何输出，请检查 pi 是否已安装（npm install -g @earendil-works/pi-coding-agent）及 provider 是否已配置".to_string(),
                ));
            } else if known_event_count == 0 {
                tracing::warn!("[PiEngine] CLI 产生 {} 行输出但无法解析任何事件", line_count);
                event_callback(AIEvent::error(
                    &real_session_id,
                    format!("Pi CLI 输出无法解析（{} 行）。请检查 pi 版本兼容性", line_count),
                ));
            }

            if !agent_ended {
                tracing::warn!("[PiEngine] 进程退出但未收到 agent_end 事件");
            }

            // 主动收尾进程：先移除 session（释放 input_sender 让 stdin 线程退出），
            // pi 收到 stdin EOF 后自然退出，避免 EPIPE。
            //
            // 之前的问题：try_wait 循环中只 sleep(100ms) 不读取 stdout 管道，
            // pi 的 output-guard.js 写缓冲区满 → EPIPE crash。
            // 现在先关闭 stdin（通过释放 input_sender），pi 自然退出后再等 wait，
            // 管道写端关闭后 read_line 不会阻塞，也无缓冲区满的问题。
            let mut child = child;
            // 从 sessions 中移除，释放 input_sender 让 stdin 线程退出
            if let Ok(mut s) = sessions.lock() {
                s.remove(&real_session_id);
            }

            // 等待进程退出（最多 5 秒）
            let max_wait = std::time::Duration::from_secs(5);
            let start = std::time::Instant::now();
            let child_exited = loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        tracing::debug!("[PiEngine] 进程已自然退出，pid={}, status={:?}", pid, status.code());
                        break true;
                    }
                    Ok(None) => {
                        if start.elapsed() >= max_wait {
                            tracing::debug!("[PiEngine] 等待 {}s 后进程仍在运行，执行 kill 兜底，pid={}", max_wait.as_secs(), pid);
                            let _ = child.kill();
                            let _ = child.wait();
                            break false;
                        }
                        // 进程仍在运行，短暂休眠后重试
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(e) => {
                        tracing::warn!("[PiEngine] try_wait 失败 {}: {}", pid, e);
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                }
            };

            // 进程已退出后，排空 stdout 剩余数据（此时管道已关闭，read_line 不会阻塞）
            if child_exited {
                use std::io::BufRead;
                let mut drain = String::new();
                while let Ok(n) = reader.read_line(&mut drain) {
                    if n == 0 {
                        break;  // EOF
                    }
                    if !drain.trim().is_empty() {
                        tracing::trace!("[PiEngine] 收尾 stdout: {}", drain.trim());
                    }
                    drain.clear();
                }
            }

            // 子进程已退出，现在安全关闭 stdout 管道
            // 延迟 drop 确保 pi 进程的 output-guard 在管道关闭前完成所有写入
            drop(reader);

            // session_end 在清理完成后发送，确保前端在收到结束信号前已收到所有数据
            event_callback(AIEvent::session_end(&real_session_id));

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
            install_guide: None,
            npm_package: None,
            install_url: None,
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
        mut options: SessionOptions,
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
        // 优先使用 options 中显式传入的 provider 配置（AI 对话路径），
        // 否则从 self.config 的活跃模型 Profile 自动解析（IM 集成路径）。
        let (resolved_provider, resolved_model) = if let Some(ref cfg) = options.pi_provider_config {
            tracing::info!(
                "[PiEngine] 使用显式传入的 provider: {} (baseUrl={})",
                cfg.name, cfg.base_url
            );
            (Some(cfg.clone()), options.pi_model.clone())
        } else if let Some((cfg, model, envs)) = self.resolve_provider_config_from_config() {
            tracing::info!(
                "[PiEngine] 从配置自动解析 provider: {} (model={})",
                cfg.name, model
            );
            // 注入 env_overrides（API Key 等），确保 Pi 子进程能读到环境变量
            for (k, v) in envs {
                options.env_overrides.entry(k).or_insert(v);
            }
            (Some(cfg), Some(model))
        } else {
            tracing::warn!(
                "[PiEngine] 无 provider 配置，Pi 将使用默认 provider（可能未配置导致 LLM 调用失败）"
            );
            (None, None)
        };

        if let Some(ref cfg) = resolved_provider {
            Self::write_models_json(cfg)?;
        }

        // 先生成 temp_id：build_command 需要用它作为 --session-id，让 pi 创建 session
        let temp_id = uuid::Uuid::new_v4().to_string();

        // MCP 桥接（路径 B：Pi Extension 桥接）：enable_extensions 时把 Polaris
        // MCP server 列表写入 ~/.pi/agent/extensions/polaris-mcp-bridge/，Pi 通过
        // 显式 -e 加载该 Extension，把 MCP 工具桥接为 LLM 可调工具。
        if self.config.pi_code.enable_extensions && !options.mcp_servers.is_empty() {
            if let Err(e) = Self::write_extension_bridge(&options.mcp_servers) {
                tracing::warn!("[PiEngine] 写入 Extension 桥接失败: {}，MCP 桥接未生效", e);
            }
        }

        let mut cmd = self.build_command(
            &temp_id,
            false,
            options.system_prompt.as_deref(),
            options.append_system_prompt.as_deref(),
            options.model.as_deref(),
            resolved_model.as_deref(),
            resolved_provider.as_ref().map(|c| c.name.as_str()),
            resolved_provider.as_ref().map(|c| c.api_key.as_str()),
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
        mut options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[PiEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Pi CLI 不可用".to_string()));
        }

        // 自定义 provider：写入 models.json 注册端点
        // 优先使用 options 中显式传入的 provider 配置（AI 对话路径），
        // 否则从 self.config 的活跃模型 Profile 自动解析（IM 集成路径）。
        let (resolved_provider, resolved_model) = if let Some(ref cfg) = options.pi_provider_config {
            tracing::info!(
                "[PiEngine] 使用显式传入的 provider: {} (baseUrl={})",
                cfg.name, cfg.base_url
            );
            (Some(cfg.clone()), options.pi_model.clone())
        } else if let Some((cfg, model, envs)) = self.resolve_provider_config_from_config() {
            tracing::info!(
                "[PiEngine] 从配置自动解析 provider: {} (model={})",
                cfg.name, model
            );
            // 注入 env_overrides（API Key 等），确保 Pi 子进程能读到环境变量
            for (k, v) in envs {
                options.env_overrides.entry(k).or_insert(v);
            }
            (Some(cfg), Some(model))
        } else {
            tracing::warn!(
                "[PiEngine] 无 provider 配置，Pi 将使用默认 provider（可能未配置导致 LLM 调用失败）"
            );
            (None, None)
        };

        if let Some(ref cfg) = resolved_provider {
            Self::write_models_json(cfg)?;
        }

        // MCP 桥接（路径 B）：enable_extensions 时刷新 Extension 桥接
        if self.config.pi_code.enable_extensions && !options.mcp_servers.is_empty() {
            if let Err(e) = Self::write_extension_bridge(&options.mcp_servers) {
                tracing::warn!("[PiEngine] 写入 Extension 桥接失败: {}，MCP 桥接未生效", e);
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
            resolved_model.as_deref(),
            resolved_provider.as_ref().map(|c| c.name.as_str()),
            resolved_provider.as_ref().map(|c| c.api_key.as_str()),
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
