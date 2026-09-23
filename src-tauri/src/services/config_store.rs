use crate::error::{AppError, Result};
use crate::models::config::{Config, EngineId, HealthStatus};
use crate::services::data_root::data_root;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 配置存储管理器
pub struct ConfigStore {
    config: Config,
    config_path: PathBuf,
}

impl ConfigStore {
    /// 创建新的配置存储
    pub fn new() -> Result<Self> {
        let config_dir = data_root().config_dir();

        eprintln!("配置目录: {:?}", config_dir);

        // 确保配置目录存在（DataRoot::ensure 已创建，此处兜底）
        std::fs::create_dir_all(&config_dir)?;
        eprintln!("配置目录已创建");

        let config_path = config_dir.join("config.json");
        eprintln!("配置文件路径: {:?}", config_path);

        let mut config = Self::load_from_file(&config_path)?;

        // 迁移：老版本 interaction.askMcpEnabled=false 被 General 设置开关控制；
        // v10.5.3 起该开关归属 polaris.ask 插件，需要一次性映射到插件禁用状态。
        let legacy_ask_disabled = Self::detect_legacy_ask_disabled(&config_path);
        if legacy_ask_disabled {
            Self::migrate_legacy_ask_disabled_to_plugin(&config_dir);
        }

        // 验证配置
        config.validate();

        eprintln!("当前引擎: {}", config.default_engine);
        eprintln!("当前 claude_code.cli_path: {}", config.claude_code.cli_path);

        // 如果 claude_code.cli_path 是默认值，尝试解析完整路径
        if config.claude_code.cli_path == "claude" {
            eprintln!("尝试解析 Claude 路径...");
            if let Some(full_path) = Self::resolve_claude_path() {
                config.claude_code.cli_path = full_path.clone();
                eprintln!("找到 Claude 路径: {}", full_path);
                // 立即保存配置
                if let Err(e) = Self::save_config_to_path(&config, &config_path) {
                    eprintln!("保存配置失败: {}", e);
                } else {
                    eprintln!("Claude 路径已解析并保存: {}", full_path);
                }
            } else {
                eprintln!("无法解析 Claude 路径");
            }
        }

        Ok(Self {
            config,
            config_path,
        })
    }

    /// 查找 claude 命令的完整路径
    fn resolve_claude_path() -> Option<String> {
        #[cfg(windows)]
        {
            // Windows 上先尝试 PowerShell 的 Get-Command
            let ps_output = Command::new("powershell")
                .args(["-Command", "Get-Command claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok();

            if let Some(output) = ps_output {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    // PowerShell 可能返回 .ps1 文件，我们需要 .cmd 文件
                    if path.ends_with(".ps1") {
                        let cmd_path = path.replace(".ps1", ".cmd");
                        if std::path::Path::new(&cmd_path).exists() {
                            return Some(cmd_path);
                        }
                    }
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        return Some(path);
                    }
                }
            }

            // 后备：使用 where 命令
            let output = Command::new("cmd")
                .args(["/C", "where", "claude"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()?;

            if output.status.success() {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        }

        #[cfg(not(windows))]
        {
            // Unix 上使用 which 命令
            let output = Command::new("sh")
                .args(["-c", "which claude"])
                .output()
                .ok()?;

            if output.status.success() {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        }
    }

    /// 保存配置到指定路径
    fn save_config_to_path(config: &Config, path: &Path) -> Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    /// 从文件加载配置
    fn load_from_file(path: &Path) -> Result<Config> {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            // 先尝试按新格式解析
            if let Ok(mut config) = serde_json::from_str::<Config>(&content) {
                // 验证配置
                config.validate();
                return Ok(config);
            }
            // 如果失败，尝试按旧格式解析然后迁移
            if let Ok(old_config) = serde_json::from_str::<OldConfig>(&content) {
                return Ok(old_config.migrate_to_new());
            }
            // 都失败，返回默认配置
            Ok(Config::default())
        } else {
            Ok(Config::default())
        }
    }

    /// 保存配置到文件（原子写入 + 跨进程互斥）
    ///
    /// 多实例下 config.json 由所有 polaris.exe 共享。原子写只保证内容完整，
    /// 不保证互斥——两个实例同时写会静默覆盖。写入前获取命名 Mutex
    /// 锁，超时（3s）后打 warn 并降级为直接写入。
    pub fn save(&self) -> Result<()> {
        // 跨进程配置写锁：命名 Mutex（内核级），进程崩溃自动释放。
        // 超时（3s）降级为无锁写入并告警（见 CrossProcessLock::acquire）。
        let lock_path = self.config_path.with_extension("json.lock");
        let _lock = CrossProcessLock::acquire(
            &lock_path,
            std::time::Duration::from_secs(3),
        );

        // 原子写入：先写临时文件，再重命名
        let temp_path = self.config_path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&self.config)?;
        std::fs::write(&temp_path, &content)?;

        // Restrict file permissions to owner-only (0600) on Unix to protect the web token
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600))?;
        }

        std::fs::rename(&temp_path, &self.config_path)?;
        Ok(())
    }

    /// 检测旧版配置里 `interaction.askMcpEnabled=false` 是否出现过。
    ///
    /// v10.5.3 起该开关被移除，语义下沉到 polaris.ask 插件禁用状态；
    /// 若不迁移，曾显式关闭 AI 提问的用户会在升级后"无声"重开，属于体验回归。
    /// 用 `Value` 宽松读取，因为新 `Config` 类型已不含该字段，serde 会忽略。
    fn detect_legacy_ask_disabled(path: &Path) -> bool {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return false,
        };
        value
            .get("interaction")
            .and_then(|v| v.get("askMcpEnabled"))
            .and_then(|v| v.as_bool())
            == Some(false)
    }

    /// 一次性迁移：把老 `interaction.askMcpEnabled=false` 映射到 polaris.ask 插件禁用。
    ///
    /// 幂等：
    ///   1. 覆盖 plugin_states["polaris.ask"] 的启用状态，其余字段按插件默认值补齐
    ///   2. 清理 config.json 里的 `interaction.askMcpEnabled` 字段，避免下次启动重复迁移
    /// 老 `interaction` 整个 block 若空则删除，非空则保留其余字段（防御未来扩展）。
    fn migrate_legacy_ask_disabled_to_plugin(config_dir: &Path) {
        let state_service = crate::services::plugin_state_service::PluginStateService::new(
            config_dir.to_path_buf(),
        );
        let mut states = match state_service.load() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ConfigStore] 迁移 ask 开关：读取插件状态失败 {}", e);
                return;
            }
        };
        use crate::models::plugin_state::PluginState;
        let entry = states.entry("polaris.ask".to_string()).or_insert(PluginState {
            enabled: true,
            ui_enabled: true,
            mcp_enabled: true,
            mcp_servers: Default::default(),
        });
        let already_disabled = !entry.enabled;
        entry.enabled = false;
        entry.mcp_enabled = false;
        if state_service.save(&states).is_err() {
            return;
        }
        if !already_disabled {
            eprintln!(
                "[ConfigStore] 已把 legacy interaction.askMcpEnabled=false 迁移到 polaris.ask 插件禁用"
            );
        }

        // 清理 config.json 里的老字段，避免每次启动重复迁移
        Self::remove_legacy_ask_field_from_config(config_dir);
    }

    /// 从 config.json 里删除 `interaction.askMcpEnabled`。
    /// 若 `interaction` block 清空则整个删除；解析失败静默跳过。
    fn remove_legacy_ask_field_from_config(config_dir: &Path) {
        let path = config_dir.join("config.json");
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return,
        };
        let interaction_obj = match value.get_mut("interaction") {
            Some(v) => v.as_object_mut(),
            None => return,
        };
        let interaction = match interaction_obj {
            Some(obj) => obj,
            None => return,
        };
        interaction.remove("askMcpEnabled");
        if interaction.is_empty() {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("interaction");
            }
        }
        let new_content = match serde_json::to_string_pretty(&value) {
            Ok(s) => s,
            Err(_) => return,
        };
        let tmp_path = path.with_extension("json.tmp");
        if std::fs::write(&tmp_path, &new_content).is_err() {
            return;
        }
        let _ = std::fs::rename(&tmp_path, &path);
    }

    /// 获取配置
    pub fn get(&self) -> &Config {
        &self.config
    }

    /// Mutable reference to the in-memory config (does not persist to disk).
    /// Call `save()` explicitly if persistence is needed.
    pub fn get_mut(&mut self) -> &mut Config {
        &mut self.config
    }

    /// 更新配置（带回滚机制）
    pub fn update(&mut self, config: Config) -> Result<()> {
        // 保存旧配置以便回滚
        let old_config = self.config.clone();
        self.config = config;

        match self.save() {
            Ok(()) => {
                eprintln!("[ConfigStore] 配置保存成功");
                Ok(())
            }
            Err(e) => {
                // 保存失败，恢复旧配置
                eprintln!("[ConfigStore] 配置保存失败，回滚: {:?}", e);
                self.config = old_config;
                Err(e)
            }
        }
    }

    /// 按顶层字段合并更新配置（带回滚机制）
    pub fn patch(&mut self, patch: serde_json::Value) -> Result<Config> {
        let patch_object = patch
            .as_object()
            .ok_or_else(|| AppError::ConfigError("配置 patch 必须是对象".to_string()))?;

        if patch_object.is_empty() {
            return Ok(self.config.clone());
        }

        let old_config = self.config.clone();
        let mut merged = serde_json::to_value(&self.config)?;
        merge_json_object(&mut merged, &patch);
        let mut next_config: Config = serde_json::from_value(merged)?;
        next_config.validate();
        self.config = next_config;

        match self.save() {
            Ok(()) => {
                eprintln!("[ConfigStore] 配置 patch 保存成功");
                Ok(self.config.clone())
            }
            Err(e) => {
                eprintln!("[ConfigStore] 配置 patch 保存失败，回滚: {:?}", e);
                self.config = old_config;
                Err(e)
            }
        }
    }

    /// 设置工作目录
    pub fn set_work_dir(&mut self, path: Option<PathBuf>) -> Result<()> {
        let old = self.config.clone();
        self.config.work_dir = path;
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.config = old;
                Err(e)
            }
        }
    }

    /// 设置 Claude 命令路径
    pub fn set_claude_cmd(&mut self, cmd: String) -> Result<()> {
        let old = self.config.clone();
        self.config.claude_code.cli_path = cmd;
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.config = old;
                Err(e)
            }
        }
    }

    /// 设置默认引擎
    pub fn set_engine(&mut self, engine_id: EngineId) -> Result<()> {
        let old = self.config.clone();
        self.config.set_engine_id(engine_id);
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.config = old;
                Err(e)
            }
        }
    }

    /// 获取会话目录
    pub fn session_dir(&self) -> Result<PathBuf> {
        if let Some(ref dir) = self.config.session_dir {
            Ok(dir.clone())
        } else {
            let data_dir = data_root().cache_dir().join("sessions");

            // 确保目录存在
            std::fs::create_dir_all(&data_dir)?;
            Ok(data_dir)
        }
    }

    /// 检测 Claude CLI 是否可用
    pub fn detect_claude(&self) -> Option<String> {
        let cmd = self.config.get_claude_cmd();
        Self::detect_cli_version(&cmd, "detect_claude")
    }

    /// 检测 Codex CLI 是否可用
    pub fn detect_codex(&self) -> Option<String> {
        let cmd = self.config.get_codex_cmd();
        Self::detect_cli_version(&cmd, "detect_codex")
    }

    /// 检测 Pi CLI 是否可用
    pub fn detect_pi(&self) -> Option<String> {
        let cmd = self.config.get_pi_cmd();
        Self::detect_cli_version(&cmd, "detect_pi")
    }

    fn detect_cli_version(cmd: &str, log_prefix: &str) -> Option<String> {
        eprintln!("[{}] 尝试执行: {} --version", log_prefix, cmd);

        let output = Self::run_cli_version_command(cmd);

        match output {
            Ok(output) => {
                eprintln!("[{}] 进程退出码: {:?}", log_prefix, output.status.code());
                eprintln!(
                    "[{}] stdout: {}",
                    log_prefix,
                    String::from_utf8_lossy(&output.stdout)
                );
                eprintln!(
                    "[{}] stderr: {}",
                    log_prefix,
                    String::from_utf8_lossy(&output.stderr)
                );

                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.to_string());
                    eprintln!("[{}] 解析成功: {:?}", log_prefix, version);
                    version
                } else {
                    eprintln!("[{}] 命令执行失败", log_prefix);
                    None
                }
            }
            Err(e) => {
                eprintln!("[{}] 启动进程失败: {:?}", log_prefix, e);
                None
            }
        }
    }

    #[cfg(windows)]
    fn run_cli_version_command(cmd: &str) -> std::io::Result<std::process::Output> {
        let lower = cmd.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            return Self::run_windows_cmd_script(cmd);
        }

        match Command::new(cmd)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => Ok(output),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if let Some(shim_path) = Self::resolve_windows_cmd_shim(cmd) {
                    return Self::run_windows_cmd_script(&shim_path);
                }
                Err(err)
            }
            Err(err) => Err(err),
        }
    }

    #[cfg(windows)]
    fn run_windows_cmd_script(cmd: &str) -> std::io::Result<std::process::Output> {
        Command::new("cmd")
            .arg("/c")
            .arg(cmd)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    /// 查询 npm 真实全局安装前缀（`npm prefix -g`）。
    ///
    /// 在用户 home 目录下执行，避免项目级 `.npmrc`（如 pnpm 的 `node-linker`）
    /// 干扰前缀解析。Windows 下 `npm` 为 `.cmd`，经 `cmd /c` 调用。
    #[cfg(windows)]
    fn query_npm_global_prefix() -> Option<String> {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("npm").arg("prefix").arg("-g");
        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
        let output = cmd.creation_flags(CREATE_NO_WINDOW).output().ok()?;
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

    #[cfg(windows)]
    fn resolve_windows_cmd_shim(cmd: &str) -> Option<String> {
        if cmd.contains('\\') || cmd.contains('/') || Path::new(cmd).extension().is_some() {
            return None;
        }

        let shim_name = format!("{}.cmd", cmd);
        let mut candidates = Vec::new();

        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm").join(&shim_name));
        }
        if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
            candidates.push(PathBuf::from(pnpm_home).join(&shim_name));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(localappdata).join("pnpm").join(&shim_name));
        }

        // npm 真实全局前缀（覆盖 nvm-windows / fnm / volta / 自定义 prefix 等
        // 非 %APPDATA%\npm 的情况）。Windows 下 npm 把 .cmd shim 直接放在 prefix 目录。
        if let Some(prefix) = Self::query_npm_global_prefix() {
            candidates.push(PathBuf::from(&prefix).join(&shim_name));
        }

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }

        let output = Command::new("where")
            .arg(&shim_name)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && Path::new(line).exists())
            .map(str::to_string)
    }

    #[cfg(not(windows))]
    fn run_cli_version_command(cmd: &str) -> std::io::Result<std::process::Output> {
        Command::new(cmd).arg("--version").output()
    }

    /// 获取健康状态（同步版）。
    pub fn health_status(&self) -> HealthStatus {
        let claude_version = self.detect_claude();
        let claude_available = claude_version.is_some();
        let codex_version = self.detect_codex();
        let codex_available = codex_version.is_some();
        let pi_version = self.detect_pi();
        let pi_available = pi_version.is_some();

        HealthStatus {
            claude_available,
            claude_version,
            codex_available,
            codex_version,
            pi_available,
            pi_version,
            work_dir: self
                .config
                .work_dir
                .as_ref()
                .and_then(|p| p.to_str().map(|s| s.to_string())),
            config_valid: true,
        }
    }

    /// 异步并行版健康检测。
    ///
    /// 在独立线程池中同时 spawn claude / codex / pi 三个子进程，各加 5s 超时，
    /// 总耗时从 O(T_c + T_codex + T_pi) 降为 O(max(T_c, T_codex, T_pi, 5s))。
    pub async fn health_status_async(config: Config) -> HealthStatus {
        let claude_path = config.claude_code.cli_path.clone();
        let codex_path = config.codex_code.cli_path.clone();
        let pi_path = config.pi_code.cli_path.clone();
        let work_dir = config.work_dir.as_ref().and_then(|p| p.to_str().map(|s| s.to_string()));

        // 将三次 CLI 探测以 spawn_blocking 并发提交，各带 5s 超时。
        // 任何单 CLI 超时/异常均降级为 unavailable，不阻塞其它 CLI 的结果。
        let c1_fut = tokio::task::spawn_blocking(move || {
            Self::detect_cli_version(&claude_path, "detect_claude")
        });
        let c2_fut = tokio::task::spawn_blocking(move || {
            Self::detect_cli_version(&codex_path, "detect_codex")
        });
        let c3_fut = tokio::task::spawn_blocking(move || {
            Self::detect_cli_version(&pi_path, "detect_pi")
        });

        let c1 = match tokio::time::timeout(std::time::Duration::from_secs(5), c1_fut).await {
            Ok(Ok(r)) => r,
            _ => None,
        };
        let c2 = match tokio::time::timeout(std::time::Duration::from_secs(5), c2_fut).await {
            Ok(Ok(r)) => r,
            _ => None,
        };
        let c3 = match tokio::time::timeout(std::time::Duration::from_secs(5), c3_fut).await {
            Ok(Ok(r)) => r,
            _ => None,
        };

        HealthStatus {
            claude_available: c1.is_some(), claude_version: c1,
            codex_available:  c2.is_some(), codex_version: c2,
            pi_available:     c3.is_some(), pi_version:   c3,
            work_dir,
            config_valid: true,
        }
    }

    /// 获取当前工作目录
    pub fn current_work_dir(&self) -> PathBuf {
        self.config
            .work_dir
            .clone()
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    /// 设置会话目录
    pub fn set_session_dir(&mut self, path: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&path)?;
        let old = self.config.clone();
        self.config.session_dir = Some(path);
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.config = old;
                Err(e)
            }
        }
    }

    /// 查找所有可用的 Claude CLI 路径
    pub fn find_claude_paths() -> Vec<String> {
        let mut paths = Vec::new();

        // 1. 尝试 which/where 命令
        if let Some(system_path) = Self::resolve_claude_path() {
            if !paths.contains(&system_path) {
                paths.push(system_path);
            }
        }

        // 2. 检查常见安装路径
        #[cfg(windows)]
        {
            if let Ok(username) = env::var("USERNAME") {
                let common_paths = vec![
                    // npm 全局安装路径
                    format!(r"{}\AppData\Roaming\npm\claude.cmd", username),
                    format!(r"{}\AppData\Local\Programs\claude\claude.exe", username),
                    format!(r"{}\AppData\Local\Programs\claude\claude.cmd", username),
                    // Program Files
                    r"C:\Program Files\claude\claude.exe".to_string(),
                    r"C:\Program Files\claude\claude.cmd".to_string(),
                    r"C:\Program Files (x86)\claude\claude.exe".to_string(),
                    r"C:\Program Files (x86)\claude\claude.cmd".to_string(),
                    // Scoop 安装路径
                    format!(
                        r"{}\scoop\shims\claude.cmd",
                        env::var("USERPROFILE").unwrap_or_default()
                    ),
                ];

                for path in common_paths {
                    if Path::new(&path).exists()
                        && Self::validate_path(&path)
                        && !paths.contains(&path)
                    {
                        paths.push(path);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            let home = env::var("HOME").unwrap_or_default();
            let common_paths = vec![
                // macOS Homebrew (Apple Silicon)
                "/opt/homebrew/bin/claude".to_string(),
                // macOS Homebrew (Intel)
                "/usr/local/bin/claude".to_string(),
                // Linux 系统路径
                "/usr/bin/claude".to_string(),
                // npm 全局路径
                format!("{}/.npm-global/bin/claude", home),
                format!("{}/.local/bin/claude", home),
                // Volta（跨平台 Node 版本管理器）
                format!("{}/.volta/bin/claude", home),
                // Snap（Ubuntu 等）
                "/snap/bin/claude".to_string(),
                // nvm 默认版本
                format!("{}/.nvm/versions/node/current/bin/claude", home),
            ];

            for path in common_paths {
                if Path::new(&path).exists() && Self::validate_path(&path) {
                    if !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }

        paths
    }

    /// 验证路径是否为有效的 Claude CLI
    fn validate_path(path: &str) -> bool {
        #[cfg(windows)]
        let result = Command::new(path)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);

        #[cfg(not(windows))]
        let result = Command::new(path)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);

        result
    }

    /// 验证指定路径并返回详细信息
    pub fn validate_claude_path(path: String) -> Result<(bool, Option<String>, Option<String>)> {
        let path_obj = Path::new(&path);

        // 检查文件是否存在
        if !path_obj.exists() {
            return Ok((false, Some("文件不存在".to_string()), None));
        }

        // 尝试执行 --version
        #[cfg(windows)]
        let output = Command::new(&path)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        #[cfg(not(windows))]
        let output = Command::new(&path).arg("--version").output();

        match output {
            Ok(output) => {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.to_string());
                    Ok((true, None, version))
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Ok((false, Some(format!("执行失败: {}", stderr)), None))
                }
            }
            Err(e) => Ok((false, Some(format!("无法执行: {}", e)), None)),
        }
    }
}

fn merge_json_object(target: &mut serde_json::Value, patch: &serde_json::Value) {
    if let (Some(target_object), Some(patch_object)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_object {
            target_object.insert(key.clone(), value.clone());
        }
    }
}

// ============================================================================
// 跨进程配置写锁
// ============================================================================
//
// 多实例下 config.json 是所有 polaris.exe 共享的同一份文件。原子写（tmp +
// rename）只保证文件内容完整，**不保证互斥**：两个实例同时 save() 会静默地
// 后写覆盖先写，配置漂移且无痕迹。
//
// 这里用内核级互斥原语实现跨进程互斥：
// - Windows：命名 Mutex（`CreateMutexW`）。与调度器锁（utils/mod.rs 的
//   `SchedulerLock`）同源，动态加载 kernel32 调用，不涉及文件句柄/OVERLAPPED。
//   进程崩溃时内核自动释放锁，比文件锁更健壮。
// - Unix：    `flock(LOCK_EX)`（sidecar 锁文件）
//
// 锁等待 3 秒。超时后**打 warn 并继续写入**（降级不静默）——配置写入必须
// 响应，宁可偶尔竞态也不能让设置页卡死。锁本身是 best-effort 的。

#[cfg(windows)]
pub struct CrossProcessLock {
    handle: std::os::windows::raw::HANDLE,
}

#[cfg(windows)]
impl CrossProcessLock {
    /// 尝试获取排他锁，最多等待 `timeout`。
    /// 成功返回 `Some(lock)`；超时返回 `None`（调用方应自行告警）。
    pub fn acquire(path: &Path, timeout: std::time::Duration) -> Option<Self> {
        use std::os::windows::ffi::OsStrExt;

        // 命名 Mutex 名称按锁文件路径派生：取锁文件路径的文件名（含扩展名）
        // 作为命名空间段，避免路径分隔符问题，也保证不同配置路径互不干扰。
        let stem = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "config.json.lock".to_string());
        let name = format!("PolarisConfigWrite_{}", stem);
        let wide_name: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // 动态加载 kernel32.dll，获取 CreateMutexW / GetLastError / WaitForSingleObject
        // libloading 的 new/get 均为 unsafe（动态库符号解析的调用约定风险）
        let kernel32 = unsafe { libloading::Library::new("kernel32.dll").ok()? };
        let create_mutex: libloading::Symbol<
            unsafe extern "system" fn(
                *mut std::ffi::c_void,
                i32,
                *const u16,
            ) -> *mut std::ffi::c_void,
        > = unsafe { kernel32.get(b"CreateMutexW").ok()? };
        let get_last_error: libloading::Symbol<unsafe extern "system" fn() -> u32> =
            unsafe { kernel32.get(b"GetLastError").ok()? };

        let handle = unsafe { create_mutex(std::ptr::null_mut(), 0, wide_name.as_ptr()) };
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            tracing::warn!("[Config] 创建配置写锁 Mutex 失败 ({}): {}", name, err);
            return None;
        }

        // ERROR_ALREADY_EXISTS(183)：Mutex 已存在——要么是其他实例持有，
        // 要么是本进程已创建过（再次 CreateMutexW 返回同一句柄）。
        let already_exists = unsafe { get_last_error() } == 183;

        // 等待锁：最多 `timeout`。WaitForSingleObject 返回 WAIT_OBJECT_0(0) 表示获得。
        let wait_for_single_object: libloading::Symbol<
            unsafe extern "system" fn(*mut std::ffi::c_void, u32) -> u32,
        > = unsafe { kernel32.get(b"WaitForSingleObject").ok()? };

        // 将 timeout 转为 ms（最小 1ms；0 则只做非阻塞尝试）
        let wait_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX).max(1);

        let wait_result = unsafe { wait_for_single_object(handle, wait_ms) };

        if wait_result == 0 {
            // WAIT_OBJECT_0：获得锁
            // 若 already_exists 且是我们本次新建的 Mutex（非本进程此前持有），
            // 说明锁被其他进程占用——但 WaitForSingleObject 成功说明其已释放，
            // 我们即为当前持有者。二者统一：现在持有锁。
            tracing::info!(
                "[Config] 获得配置写锁 {}（已存在={}）",
                name,
                already_exists
            );
            return Some(Self { handle });
        }

        // WAIT_TIMEOUT(258) 或失败：释放句柄并返回 None（调用方降级写入）
        let close_handle: libloading::Symbol<
            unsafe extern "system" fn(*mut std::ffi::c_void) -> i32,
        > = match unsafe { kernel32.get(b"CloseHandle") } {
            Ok(sym) => sym,
            Err(_) => return None,
        };
        unsafe { close_handle(handle) };
        tracing::warn!(
            "[Config] 配置写锁等待超时（{}ms），降级为无锁写入: {}",
            wait_ms,
            path.display()
        );
        None
    }
}

#[cfg(windows)]
impl Drop for CrossProcessLock {
    fn drop(&mut self) {
        use libloading::Library;
        // 释放 Mutex：ReleaseMutex + CloseHandle（libloading new/get 为 unsafe）
        if let Ok(kernel32) = unsafe { Library::new("kernel32.dll") } {
            if let Ok(release_mutex) = unsafe {
                kernel32.get::<unsafe extern "system" fn(*mut std::ffi::c_void) -> i32>(
                    b"ReleaseMutex",
                )
            } {
                unsafe { release_mutex(self.handle) };
            }
            if let Ok(close_handle) = unsafe {
                kernel32.get::<unsafe extern "system" fn(*mut std::ffi::c_void) -> i32>(
                    b"CloseHandle",
                )
            } {
                unsafe { close_handle(self.handle) };
            }
        }
    }
}

/// Unix 实现：`flock(LOCK_EX)` 跨进程排他锁。
#[cfg(unix)]
pub struct CrossProcessLock {
    file: std::fs::File,
}

#[cfg(unix)]
impl CrossProcessLock {
    /// 尝试获取锁，最多等待 `timeout`。
    pub fn acquire(path: &Path, timeout: std::time::Duration) -> Option<Self> {
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("[Config] 打开配置锁文件失败 {}: {}", path.display(), e);
                return None;
            }
        };

        let deadline = std::time::Instant::now() + timeout;
        let poll = std::time::Duration::from_millis(50);
        loop {
            if libc::flock(file.as_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 {
                return Some(Self { file });
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(poll);
        }
        None
    }
}

#[cfg(unix)]
impl Drop for CrossProcessLock {
    fn drop(&mut self) {
        let _ = libc::flock(self.file.as_fd(), libc::LOCK_UN);
    }
}
/// 旧版配置格式（用于迁移）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldConfig {
    claude_cmd: String,
    work_dir: Option<PathBuf>,
    session_dir: Option<PathBuf>,
    git_bin_path: Option<String>,
}

impl OldConfig {
    /// 迁移到新配置格式
    fn migrate_to_new(self) -> Config {
        let claude_cmd_clone = self.claude_cmd.clone();
        Config {
            default_engine: "claude-code".to_string(),
            auxiliary_engine: None,
            permissions: None,
            language: None,
            theme: None,
            active_theme_id: None,
            claude_code: crate::models::config::ClaudeCodeConfig {
                cli_path: self.claude_cmd,
            },
            codex_code: Default::default(),
            pi_code: Default::default(),
            qqbot: Default::default(),
            feishu: Default::default(),
            dingtalk: Default::default(),
            work_dir: self.work_dir,
            session_dir: self.session_dir,
            git_bin_path: self.git_bin_path,
            floating_window: Default::default(),
            baidu_translate: None,
            personal_hub: Default::default(),
            window: Default::default(),
            speech: Default::default(),
            tts: Default::default(),
            wake_word: None,
            voice_notification: None,
            voice_commands: None,
            web: Default::default(),
            dispatch: Default::default(),
            spiderman_theme: None,
            chat_display: Default::default(),
            workspaces: Vec::new(),
            current_workspace_id: None,
            terminal_scripts: Default::default(),
            model_profiles: Vec::new(),
            active_model_profile_id: None,
            provider_groups: Vec::new(),
            active_provider_group_id: None,
            performance: Default::default(),
            skill_paths: Vec::new(),
            perf_migration_dismissed: false,
            plugins: std::collections::BTreeMap::new(),
            claude_cmd: Some(claude_cmd_clone),
        }
    }
}

impl Default for ConfigStore {
    fn default() -> Self {
        Self::new().expect("无法创建配置存储")
    }
}

#[cfg(test)]
impl ConfigStore {
    pub(crate) fn new_test(config: Config, path: PathBuf) -> Self {
        Self {
            config,
            config_path: path,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn resolves_windows_cmd_shim_from_appdata_npm() {
        let temp_root = tempfile::tempdir().unwrap();
        let appdata = temp_root.path().join("Roaming");
        let npm_dir = appdata.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();
        let shim = npm_dir.join("codex.cmd");
        std::fs::write(&shim, "@echo off").unwrap();

        let previous = std::env::var("APPDATA").ok();
        std::env::set_var("APPDATA", &appdata);

        let resolved = ConfigStore::resolve_windows_cmd_shim("codex");

        if let Some(value) = previous {
            std::env::set_var("APPDATA", value);
        } else {
            std::env::remove_var("APPDATA");
        }

        assert_eq!(resolved, Some(shim.to_string_lossy().to_string()));
    }

    #[test]
    #[cfg(windows)]
    fn does_not_resolve_windows_cmd_shim_for_explicit_paths() {
        assert!(ConfigStore::resolve_windows_cmd_shim("C:\\tools\\codex").is_none());
        assert!(ConfigStore::resolve_windows_cmd_shim("codex.exe").is_none());
    }

    #[test]
    fn patch_preserves_unrelated_config_fields() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let mut config = Config::default();
        config.default_engine = "claude-code".to_string();
        config.codex_code.cli_path = "custom-codex".to_string();
        config.window.normal_opacity = 70;

        let mut store = ConfigStore::new_test(config, config_path);

        let saved = store
            .patch(serde_json::json!({
                "defaultEngine": "codex"
            }))
            .unwrap();

        assert_eq!(saved.default_engine, "codex");
        assert_eq!(saved.codex_code.cli_path, "custom-codex");
        assert_eq!(saved.window.normal_opacity, 70);
    }

    #[test]
    fn patch_can_clear_optional_fields_with_null() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let mut config = Config::default();
        config.git_bin_path = Some("D:\\Git\\bin".to_string());

        let mut store = ConfigStore::new_test(config, config_path);

        let saved = store
            .patch(serde_json::json!({
                "gitBinPath": null
            }))
            .unwrap();

        assert_eq!(saved.git_bin_path, None);
    }

    #[test]
    fn set_engine_rollback_on_save_failure() {
        // 验证 set_engine 在 save 失败时回滚内存配置。
        // 用不存在的目录构造 store，save 会失败 → 内存应恢复旧值。
        let config = Config::default();
        // config_path 指向一个不存在的父目录，使 save 的 rename 失败
        let config_path = std::path::PathBuf::from("/nonexistent/dir/config.json");
        let mut store = ConfigStore::new_test(config, config_path);
        let original_engine = store.get().default_engine.clone();

        let result = store.set_engine(crate::ai::EngineId::parse_any("codex"));

        // save 失败 → 返回 Err
        assert!(result.is_err());
        // 内存回滚 → default_engine 恢复为原值
        assert_eq!(store.get().default_engine, original_engine);
    }

    #[test]
    fn set_work_dir_rollback_on_save_failure() {
        let config = Config::default();
        let config_path = std::path::PathBuf::from("/nonexistent/dir/config.json");
        let mut store = ConfigStore::new_test(config, config_path);
        let original_work_dir = store.get().work_dir.clone();

        let result = store.set_work_dir(Some(std::path::PathBuf::from("/tmp/test")));

        assert!(result.is_err());
        assert_eq!(store.get().work_dir, original_work_dir);
    }

    #[test]
    fn set_claude_cmd_rollback_on_save_failure() {
        let config = Config::default();
        let config_path = std::path::PathBuf::from("/nonexistent/dir/config.json");
        let mut store = ConfigStore::new_test(config, config_path);
        let original_cli = store.get().claude_code.cli_path.clone();

        let result = store.set_claude_cmd("/usr/local/bin/claude".to_string());

        assert!(result.is_err());
        assert_eq!(store.get().claude_code.cli_path, original_cli);
    }
}
