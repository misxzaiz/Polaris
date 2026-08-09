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
use std::sync::Arc;

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineId, EngineMetadata, EngineDistribution, EngineCapabilities,
    EnvKeyMapping, McpConsumptionStrategy, PluginEngineConfig, PluginEngineCapabilities,
    SessionFlags, SessionOptions,
};
use crate::error::{AppError, Result};
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
    /// Polaris 会话 ID -> omp 落盘文件路径的持久映射
    ///
    /// omp 新会话自动生成 session id 并落盘，且不通过 stdout 回传。
    /// agent_end 后扫描 --session-dir 捕获文件路径，存入此 map，
    /// 供 continue_session 用 --resume <path> 精确续聊。
    ///
    /// 不放 SessionManager：SessionManager 在进程退出时会被清理，
    /// 而此映射必须跨进程生命周期存活（每轮 kill+respawn）。
    ///
    /// 持久化到 session_paths.json 文件，避免应用重启后丢失。
    session_paths: Arc<std::sync::Mutex<HashMap<String, String>>>,
    /// session_paths 持久化文件路径
    session_paths_file: Option<PathBuf>,
}

impl PluginEngineRunner {
    /// 创建新的插件引擎运行器
    pub fn new(config: PluginEngineConfig) -> Self {
        let capabilities = config.capabilities;
        // 将名称和描述泄漏到 &'static str（引擎存活于整个应用生命周期，安全）
        let leaked_name: &'static str = Box::leak(config.name.clone().into_boxed_str());
        let leaked_description: &'static str = Box::leak(config.description.clone().into_boxed_str());

        // 尝试从磁盘加载持久化的 session_paths 映射（应用重启后仍可续聊）
        let mut session_paths = HashMap::new();
        let session_paths_file = Self::session_paths_file_path(&config.id);
        if let Some(path) = &session_paths_file {
            if let Ok(content) = fs::read_to_string(path) {
                match serde_json::from_str::<HashMap<String, String>>(&content) {
                    Ok(map) => {
                        session_paths = map;
                        tracing::info!(
                            "[PluginEngine:{}] 从磁盘加载 session_paths 映射: {} 条",
                            config.id,
                            session_paths.len()
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[PluginEngine:{}] session_paths 持久化文件解析失败，忽略: {}",
                            config.id, e
                        );
                    }
                }
            }
        }

        Self {
            config,
            capabilities,
            sessions: SessionManager::new(),
            cli_path: None,
            leaked_name,
            leaked_description,
            session_paths: Arc::new(std::sync::Mutex::new(session_paths)),
            session_paths_file,
        }
    }

    /// session_paths 持久化文件路径
    ///
    /// 位于 plugin-sessions/<engine_id>/session_paths.json，与 omp 落盘文件同目录。
    fn session_paths_file_path(engine_id: &str) -> Option<PathBuf> {
        let dir = data_root().root().join("plugin-sessions").join(engine_id);
        Some(dir.join("session_paths.json"))
    }

    /// 获取 CLI 路径
    ///
    /// 查找顺序（与 PiEngine 对齐）：
    /// 1. Windows: %APPDATA%\npm\{cmd}.cmd / %PNPM_HOME%\pnpm\{cmd}.cmd / %LOCALAPPDATA%\pnpm\{cmd}.cmd
    /// 2. Windows: %USERPROFILE%\.bun\bin\{cmd}.exe（bun 全局）
    /// 3. where/which {cmd}（PATH 查找）
    /// 4. 默认 "{cmd}"
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        let cmd = &self.config.cli.command;

        // 直接路径存在
        if Path::new(cmd).exists() {
            self.cli_path = Some(cmd.clone());
            return Ok(cmd.clone());
        }

        // Windows: 探测 npm/pnpm/bun 全局安装路径
        #[cfg(windows)]
        {
            let candidates = [
                // npm 全局
                std::env::var("APPDATA").ok()
                    .map(|d| PathBuf::from(&d).join("npm").join(format!("{}.cmd", cmd))),
                // pnpm 全局
                std::env::var("PNPM_HOME").ok()
                    .map(|d| PathBuf::from(&d).join(format!("{}.cmd", cmd))),
                std::env::var("LOCALAPPDATA").ok()
                    .map(|d| PathBuf::from(&d).join("pnpm").join(format!("{}.cmd", cmd))),
                // bun 全局
                std::env::var("USERPROFILE").ok()
                    .map(|d| PathBuf::from(&d).join(".bun").join("bin").join(format!("{}.exe", cmd))),
            ];
            for candidate in candidates.into_iter().flatten() {
                if candidate.exists() {
                    let s = candidate.to_string_lossy().to_string();
                    tracing::info!("[PluginEngine:{}] 在 {} 找到 CLI: {}", self.config.id, candidate.display(), s);
                    self.cli_path = Some(s.clone());
                    return Ok(s);
                }
            }
        }

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
    fn build_command(
        &self,
        session_id: &str,
        resume: bool,
        provider_name: Option<&str>,
        model: Option<&str>,
        bridge_dir: Option<&PathBuf>,
    ) -> Result<Command> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError(format!("CLI 路径未初始化: {}", self.config.id)))?;

        let mut cmd = Self::create_command(cli_path);
        // 累积完整参数列表用于诊断日志（Command 不暴露已设参数）
        let mut argv: Vec<String> = Vec::new();

        // 添加--mode rpc 参数
        cmd.arg("--mode").arg("rpc");
        argv.push("--mode".into());
        argv.push("rpc".into());

        // 添加用户自定义 args
        if let Some(ref args) = self.config.cli.args {
            for arg in args {
                cmd.arg(arg);
                argv.push(arg.clone());
            }
        }

        // Provider 选择（声明式：manifest 声明了 providerArg 才传）
        // 必须在 --session-dir 之前传，避免某些 CLI 参数顺序敏感
        if let Some(decl) = self.config.provider_config.as_ref() {
            if let Some(ref p_arg) = decl.provider_arg {
                if let Some(name) = provider_name {
                    if !name.is_empty() {
                        cmd.arg(p_arg).arg(name);
                        argv.push(p_arg.clone());
                        argv.push(name.to_string());
                    }
                }
            }
            if let Some(ref m_arg) = decl.model_arg {
                if let Some(m) = model {
                    if !m.is_empty() {
                        cmd.arg(m_arg).arg(m);
                        argv.push(m_arg.clone());
                        argv.push(m.to_string());
                    }
                }
            }
        }

        // Session 持久化
        let session_dir = self.plugin_session_dir()?;
        fs::create_dir_all(&session_dir)?;
        cmd.arg("--session-dir").arg(&session_dir);
        argv.push("--session-dir".into());
        argv.push(session_dir.display().to_string());

        // 根据 CLI 的 session 标志风格选择参数
        // - Pi 风格：--session-id <id>（新会话）/ --session <id>（恢复）
        // - omp 风格：无 session-id（新会话）/ --resume <id>（恢复）
        let flags_label = match self.config.session_flags {
            SessionFlags::Pi => {
                if resume {
                    cmd.arg("--session").arg(session_id);
                    argv.push("--session".into());
                    argv.push(session_id.to_string());
                } else {
                    cmd.arg("--session-id").arg(session_id);
                    argv.push("--session-id".into());
                    argv.push(session_id.to_string());
                }
                "pi"
            }
            SessionFlags::Omp => {
                if resume {
                    cmd.arg("--resume").arg(session_id);
                    argv.push("--resume".into());
                    argv.push(session_id.to_string());
                }
                // 新会话无需指定 session-id，omp 自动生成
                "omp"
            }
        };

        // MCP 桥接：根据消费策略注入 CLI 参数
        // 受 mcp_enabled 门控：关闭时注入 --no-extensions 但跳过 --extension
        match (self.config.mcp_consumption, self.config.mcp_enabled) {
            (McpConsumptionStrategy::PiExtension, _) => {
                // Pi/OMP 风格：始终禁用自动扩展发现，显式注入桥接扩展
                cmd.arg("--no-extensions");
                argv.push("--no-extensions".into());
                if self.config.mcp_enabled {
                    if let Some(dir) = bridge_dir {
                        if dir.exists() {
                            cmd.arg("--extension").arg(dir);
                            argv.push("--extension".into());
                            argv.push(dir.to_string_lossy().to_string());
                            tracing::info!(
                                "[PluginEngine:{}] 注入 MCP 桥接 Extension: {}",
                                self.config.id, dir.display()
                            );
                        } else {
                            tracing::warn!(
                                "[PluginEngine:{}] PiExtension 策略但桥接目录不存在，跳过 --extension",
                                self.config.id
                            );
                        }
                    }
                } else {
                    tracing::info!(
                        "[PluginEngine:{}] mcp_enabled=false，注入 --no-extensions 但不注入 --extension",
                        self.config.id
                    );
                }
            }
            // McpServers/McpConfigPath/None：无需 CLI 参数注入
            _ => {}
        }

        tracing::info!(
            "[PluginEngine:{}] build_command: session_flags={}, resume={}, session_id={}, provider={}, model={}, argv=[{}]",
            self.config.id, flags_label, resume, session_id,
            provider_name.unwrap_or(""), model.unwrap_or(""), argv.join(" ")
        );

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

    /// 在落盘目录中查找最新的 session 文件（.jsonl）
    ///
    /// omp 新会话自动生成 id 并落盘，文件名形如 `<时间戳>_<uuid>.jsonl`。
    /// 按修改时间取最新一个，作为 resume 的真实 id。
    fn find_latest_session_file(dir: &Path) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        let mut latest: Option<(PathBuf, std::time::SystemTime)> = None;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            match &latest {
                Some((_, t)) if *t >= modified => {}
                _ => latest = Some((path, modified)),
            }
        }
        latest.map(|(p, _)| p)
    }

    /// CLI 配置根目录（如 ~/.omp/、~/.pi/）
    ///
    /// 优先读 manifest 声明的 configDirEnv 环境变量，否则按 CLI id 推断 ~/.<id>/
    fn cli_config_root(&self) -> PathBuf {
        if let Some(ref decl) = self.config.provider_config {
            if let Some(ref env_name) = decl.config_dir_env {
                if let Ok(dir) = std::env::var(env_name) {
                    return PathBuf::from(dir);
                }
            }
        }
        // 按 CLI command 推断 ~/.<command>/（omp 命令 → ~/.omp/）
        let dir_name = format!(".{}", self.config.cli.command);
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(&dir_name)
    }

    /// MCP Extension 桥接目录（`~/.<cli_command>/agent/extensions/polaris-mcp-bridge/`）
    ///
    /// 仅 PiExtension 策略使用。目录生成后由 `write_extension_bridge` 填充，
    /// `build_command` 通过 `--extension <dir>` 注入子进程。
    fn mcp_bridge_dir(&self) -> PathBuf {
        self.cli_config_root()
            .join("agent")
            .join("extensions")
            .join("polaris-mcp-bridge")
    }

    /// 根据配置的 MCP 消费策略，写入 MCP 桥接文件。
    ///
    /// 当前实现：
    /// - `PiExtension`：调用 `mcp_bridge::write_extension_bridge` 写 JS Extension + config.json
    /// - 其他策略：无操作（默认 `McpServers` 由引擎自身消费，`None` 禁用）
    ///
    /// 受 `mcp_enabled` 门控：当 false 时，即使策略为 PiExtension 也跳过。
    fn write_mcp_bridge(&self, servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer]) -> Result<()> {
        if !self.config.mcp_enabled {
            tracing::info!(
                "[PluginEngine:{}] mcp_enabled=false，跳过 MCP 桥接",
                self.config.id
            );
            return Ok(());
        }
        match self.config.mcp_consumption {
            McpConsumptionStrategy::PiExtension => {
                if servers.is_empty() {
                    tracing::info!(
                        "[PluginEngine:{}] PiExtension 策略但无 MCP server，跳过桥接",
                        self.config.id
                    );
                    return Ok(());
                }
                let bridge_dir = self.mcp_bridge_dir();
                super::mcp_bridge::write_extension_bridge(&bridge_dir, servers)?;
                tracing::info!(
                    "[PluginEngine:{}] PiExtension 桥接已写入: {}",
                    self.config.id,
                    bridge_dir.display()
                );
                Ok(())
            }
            // McpServers：由引擎自身通过 stdio 消费，PluginEngineRunner 无需桥接
            // McpConfigPath：暂未实现（留待未来 Claude Code 风格插件引擎）
            // None：显式禁用
            McpConsumptionStrategy::McpServers
            | McpConsumptionStrategy::McpConfigPath
            | McpConsumptionStrategy::None => Ok(()),
        }
    }

    /// 写入 provider 配置文件，注册自定义 provider 端点
    ///
    /// 根据 manifest 声明的 providerConfig：
    /// - 格式 yaml：写 models.yml（omp）
    /// - 格式 json：写 models.json（Pi 风格）
    /// api_value 由声明决定（omp: openai-completions, Pi: openai-chat-completions）
    ///
    /// model_id 是注册到 models[].id 的模型标识，CLI 的 --model 用它匹配。
    /// 对 omp：--model 必须命中 models[].id，所以 model_id = 真实模型名（如 deepseek-v4-flash）
    fn write_provider_config(
        &self,
        provider_cfg: &crate::ai::PiProviderConfig,
        model_id: &str,
    ) -> Result<()> {
        let decl = match self.config.provider_config.as_ref() {
            Some(d) => d,
            None => return Ok(()), // 引擎未声明 provider 注册方式，跳过
        };
        let config_root = self.cli_config_root();
        let config_file_path = std::path::Path::new(&decl.config_file);
        let config_dir = config_root.join(
            config_file_path
                .parent()
                .unwrap_or(std::path::Path::new("")),
        );
        fs::create_dir_all(&config_dir)?;
        let file_path = config_root.join(&decl.config_file);

        // 实际写入的 api 值：优先用 manifest 声明的 apiValue，否则回退 PiProviderConfig.api
        let api_value = if !decl.api_value.is_empty() {
            decl.api_value.as_str()
        } else if !provider_cfg.api.is_empty() {
            provider_cfg.api.as_str()
        } else {
            "openai-completions"
        };

        // models[].id：omp 的 --model 匹配它，必须用真实模型名
        // 若 model_id 为空，回退到 provider 名（Pi 兼容行为）
        let model_entry_id = if model_id.is_empty() {
            &provider_cfg.name
        } else {
            model_id
        };

        let provider_entry = serde_json::json!({
            "baseUrl": provider_cfg.base_url,
            "api": api_value,
            "apiKey": provider_cfg.api_key,
            "models": [{
                "id": model_entry_id,
                "name": model_entry_id,
                "reasoning": false,
                "input": ["text"],
                "contextWindow": provider_cfg.context_window,
                "maxTokens": provider_cfg.max_tokens,
            }]
        });

        match decl.format {
            crate::ai::ProviderConfigFormat::Yaml => {
                // 覆盖式写入（omp 的 models.yml 由 Polaris 单独管理）
                let mut providers = std::collections::HashMap::new();
                providers.insert(provider_cfg.name.clone(), provider_entry);
                let yaml = Self::render_models_yaml(&providers);
                fs::write(&file_path, yaml)?;
            }
            crate::ai::ProviderConfigFormat::Json => {
                // JSON 格式：合并到现有 models.json 的 providers 对象（Pi 风格，多 provider 共存）
                let existing = fs::read_to_string(&file_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                let mut root = existing.unwrap_or_else(|| serde_json::json!({}));
                if !root.is_object() {
                    root = serde_json::json!({});
                }
                if root.get("providers").is_none() {
                    root["providers"] = serde_json::json!({});
                }
                root["providers"][&provider_cfg.name] = provider_entry;
                let content = serde_json::to_string_pretty(&root)?;
                fs::write(&file_path, content)?;
            }
        }
        tracing::info!(
            "[PluginEngine:{}] 已写入 provider 配置: file={}, provider={}, model_id={}, api={}, baseUrl={}",
            self.config.id, file_path.display(), provider_cfg.name, model_entry_id, api_value, provider_cfg.base_url
        );
        Ok(())
    }

    /// 渲染 models.yml（providers 顶层 + 每个 provider 的字段）
    fn render_models_yaml(
        providers: &std::collections::HashMap<String, serde_json::Value>,
    ) -> String {
        let mut out = String::from("providers:\n");
        for (name, entry) in providers {
            out.push_str(&format!("  {}:\n", name));
            if let Some(obj) = entry.as_object() {
                if let Some(v) = obj.get("baseUrl").and_then(|v| v.as_str()) {
                    out.push_str(&format!("    baseUrl: \"{}\"\n", v));
                }
                if let Some(v) = obj.get("api").and_then(|v| v.as_str()) {
                    out.push_str(&format!("    api: \"{}\"\n", v));
                }
                if let Some(v) = obj.get("apiKey").and_then(|v| v.as_str()) {
                    out.push_str(&format!("    apiKey: \"{}\"\n", v));
                }
                if let Some(models) = obj.get("models").and_then(|v| v.as_array()) {
                    out.push_str("    models:\n");
                    for m in models {
                        if let Some(mo) = m.as_object() {
                            let id = mo.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let nm = mo.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let cw = mo.get("contextWindow").and_then(|v| v.as_u64()).unwrap_or(0);
                            let mt = mo.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            out.push_str(&format!("      - id: \"{}\"\n", id));
                            out.push_str(&format!("        name: \"{}\"\n", nm));
                            out.push_str("        reasoning: false\n");
                            out.push_str("        input: [\"text\"]\n");
                            out.push_str(&format!("        contextWindow: {}\n", cw));
                            out.push_str(&format!("        maxTokens: {}\n", mt));
                        }
                    }
                }
            }
        }
        out
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
        // 预取 session 落盘目录（闭包 move 后无法再借 &self）
        let session_dir = self.plugin_session_dir().unwrap_or_default();
        let engine_id_for_session = self.config.id.clone();
        // session_paths 持久映射的共享引用（跨进程生命周期存活）
        let session_paths = self.session_paths.clone();
        // session_paths 持久化文件路径（同闭包 move）
        let session_paths_file = self.session_paths_file.clone();

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
                    tracing::info!(
                        "[PluginEngine:{}] 准备发送初始 prompt 到 stdin，长度={} 字节，内容={}",
                        engine_id_stdin, cmd_line.len(), cmd_line.trim()
                    );
                    if let Err(e) = stdin_writer.write_all(cmd_line.as_bytes())
                        .and_then(|_| stdin_writer.flush())
                    {
                        tracing::error!("[PluginEngine:{}] 发送初始 prompt 失败: {}", engine_id_stdin, e);
                        return;
                    }
                    tracing::info!("[PluginEngine:{}] 初始 prompt 已写入 stdin 并 flush", engine_id_stdin);
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
            let mut read_attempts: u32 = 0;

            loop {
                line_buf.clear();
                read_attempts += 1;
                match reader.read_line(&mut line_buf) {
                    Ok(0) => {
                        tracing::info!(
                            "[PluginEngine:{}] stdout read_line 返回 0 (EOF)，attempts={}, lines_parsed={}",
                            engine_id, read_attempts, line_count
                        );
                        break;
                    }
                    Ok(n) => {
                        tracing::info!(
                            "[PluginEngine:{}] stdout read_line 返回 {} 字节: {:?}",
                            engine_id, n, line_buf.chars().take(200).collect::<String>()
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[PluginEngine:{}] stdout read_line 错误: {}, attempts={}",
                            engine_id, e, read_attempts
                        );
                        break;
                    }
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
                    // 会话结束后，扫描落盘目录找到 omp 自动生成的 session 文件，
                    // 记录其路径作为 resume 的真实 id（omp 不回传 session id）。
                    // 存入 session_paths 持久 map（不进 SessionManager，避免被收尾清理抹掉）。
                    if let Some(file_path) = Self::find_latest_session_file(&session_dir) {
                        let fp = file_path.to_string_lossy().to_string();
                        tracing::info!(
                            "[PluginEngine:{}] 捕获 omp 会话落盘文件: {} (原 id: {})",
                            engine_id, fp, current_session_id
                        );
                        if let Ok(mut m) = session_paths.lock() {
                            m.insert(current_session_id.clone(), fp);
                            // 持久化到磁盘，应用重启后仍可续聊
                            if let Some(path) = &session_paths_file {
                                if let Ok(map_str) = serde_json::to_string_pretty(&*m) {
                                    if let Err(e) = fs::write(path, map_str) {
                                        tracing::warn!(
                                            "[PluginEngine:{}] 写入 session_paths 持久化文件失败: {}",
                                            engine_id, e
                                        );
                                    }
                                }
                            }
                        }
                    } else {
                        tracing::warn!(
                            "[PluginEngine:{}] 会话结束后未在 {} 找到落盘文件",
                            engine_id, session_dir.display()
                        );
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
            install_guide: self.config.cli.install_guide.clone(),
            npm_package: self.config.npm_package.clone(),
            install_url: self.config.install_url.clone(),
        }
    }

    fn is_available(&self) -> bool {
        let cmd = &self.config.cli.command;
        // 直接路径存在
        if Path::new(cmd).exists() {
            return true;
        }
        // Windows: 探测 npm/pnpm/bun 全局安装路径
        #[cfg(windows)]
        {
            let candidates = [
                std::env::var("APPDATA").ok()
                    .map(|d| PathBuf::from(&d).join("npm").join(format!("{}.cmd", cmd))),
                std::env::var("PNPM_HOME").ok()
                    .map(|d| PathBuf::from(&d).join(format!("{}.cmd", cmd))),
                std::env::var("LOCALAPPDATA").ok()
                    .map(|d| PathBuf::from(&d).join("pnpm").join(format!("{}.cmd", cmd))),
                std::env::var("USERPROFILE").ok()
                    .map(|d| PathBuf::from(&d).join(".bun").join("bin").join(format!("{}.exe", cmd))),
            ];
            for candidate in candidates.into_iter().flatten() {
                if candidate.exists() {
                    return true;
                }
            }
        }
        // PATH 查找
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut check = Command::new(which_cmd);
        check.arg(cmd);
        #[cfg(windows)]
        check.creation_flags(CREATE_NO_WINDOW);
        check.output().map(|o| o.status.success()).unwrap_or(false)
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

        // 写入 provider 配置文件（如 manifest 声明了 providerConfig）
        let (provider_name, clean_model) = if let Some(ref pcfg) = options.pi_provider_config {
            let model_str = options.model.as_deref().unwrap_or("");
            self.write_provider_config(pcfg, model_str)?;
            (Some(pcfg.name.clone()), options.model.clone())
        } else {
            (None, options.model.clone())
        };

        // 写入 MCP 桥接文件（根据 mcpConsumption 策略）
        self.write_mcp_bridge(&options.mcp_servers)?;
        // PiExtension 策略时，构建命令需注入 --extension 指向桥接目录
        let bridge_dir = match self.config.mcp_consumption {
            McpConsumptionStrategy::PiExtension => Some(self.mcp_bridge_dir()),
            _ => None,
        };

        let temp_id = uuid::Uuid::new_v4().to_string();

        let mut cmd = self.build_command(
            &temp_id,
            false,
            provider_name.as_deref(),
            clean_model.as_deref(),
            bridge_dir.as_ref(),
        )?;
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
        if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[PluginEngine:{}] 找到活跃进程，PID: {}，尝试中断", engine_id, info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // 续聊的真实 id：优先从 session_paths 查 omp 落盘文件路径（omp 不回传 session id，
        // agent_end 后由 spawn_event_reader 扫描 --session-dir 捕获）。
        // 该映射是持久的，不受 SessionManager 进程退出清理影响。
        let real_session_id = if let Ok(m) = self.session_paths.lock() {
            if let Some(fp) = m.get(session_id) {
                tracing::info!("[PluginEngine:{}] 续聊用落盘文件路径: {} (原 id: {})", engine_id, fp, session_id);
                fp.clone()
            } else {
                tracing::warn!(
                    "[PluginEngine:{}] session_paths 中未找到 {} 的落盘文件，回退用原 id（omp 可能报 not found）",
                    engine_id, session_id
                );
                session_id.to_string()
            }
        } else {
            session_id.to_string()
        };

        // 续聊同样需要写 provider 配置 + 传 provider/model
        let (provider_name, clean_model) = if let Some(ref pcfg) = options.pi_provider_config {
            let model_str = options.model.as_deref().unwrap_or("");
            self.write_provider_config(pcfg, model_str)?;
            (Some(pcfg.name.clone()), options.model.clone())
        } else {
            (None, options.model.clone())
        };

        // 续聊同样写 MCP 桥接 + 注入 --extension（保持与首轮一致）
        self.write_mcp_bridge(&options.mcp_servers)?;
        let bridge_dir = match self.config.mcp_consumption {
            McpConsumptionStrategy::PiExtension => Some(self.mcp_bridge_dir()),
            _ => None,
        };

        let mut cmd = self.build_command(
            &real_session_id,
            true,
            provider_name.as_deref(),
            clean_model.as_deref(),
            bridge_dir.as_ref(),
        )?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 {} 会话失败: {}", self.config.cli.command, e)))?;
        let pid = child.id();

        // spawn_event_reader 用 session_id（前端 temp_id），事件回填用 temp_id，
        // agent_end 后 session_paths 用 temp_id 作 key 存本轮落盘文件路径
        let input_sender = self.spawn_event_reader(
            child, session_id.to_string(), pid, options, Some(message.to_string()),
        );
        self.sessions.register_with_sender(
            session_id.to_string(), pid, engine_id, Some(input_sender),
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