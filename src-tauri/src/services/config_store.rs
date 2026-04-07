use crate::error::{AppError, Result};
use crate::models::config::{Config, HealthStatus, EngineId};
use std::path::{Path, PathBuf};
use std::env;
use std::process::Command;
use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 配置存储管理器
pub struct ConfigStore {
    config: Config,
    config_path: PathBuf,
}

impl ConfigStore {
    /// 创建新的配置存储
    pub fn new() -> Result<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| AppError::ConfigError("无法获取配置目录".to_string()))?
            .join("claude-code-pro");

        eprintln!("配置目录: {:?}", config_dir);

        // 确保配置目录存在
        std::fs::create_dir_all(&config_dir)?;
        eprintln!("配置目录已创建");

        let config_path = config_dir.join("config.json");
        eprintln!("配置文件路径: {:?}", config_path);

        let mut config = Self::load_from_file(&config_path)?;

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

        Ok(Self { config, config_path })
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

    /// 保存配置到文件（原子写入）
    pub fn save(&self) -> Result<()> {
        // 原子写入：先写临时文件，再重命名
        let temp_path = self.config_path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&self.config)?;
        std::fs::write(&temp_path, content)?;
        std::fs::rename(&temp_path, &self.config_path)?;
        Ok(())
    }

    /// 获取配置
    pub fn get(&self) -> &Config {
        &self.config
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

    /// 设置工作目录
    pub fn set_work_dir(&mut self, path: Option<PathBuf>) -> Result<()> {
        self.config.work_dir = path;
        self.save()
    }

    /// 设置 Claude 命令路径
    pub fn set_claude_cmd(&mut self, cmd: String) -> Result<()> {
        self.config.claude_code.cli_path = cmd;
        self.save()
    }

    /// 设置默认引擎
    pub fn set_engine(&mut self, engine_id: EngineId) -> Result<()> {
        self.config.set_engine_id(engine_id);
        self.save()
    }

    /// 获取会话目录
    pub fn session_dir(&self) -> Result<PathBuf> {
        if let Some(ref dir) = self.config.session_dir {
            Ok(dir.clone())
        } else {
            let data_dir = dirs::data_local_dir()
                .ok_or_else(|| AppError::ConfigError("无法获取数据目录".to_string()))?
                .join("claude-code-pro")
                .join("sessions");

            // 确保目录存在
            std::fs::create_dir_all(&data_dir)?;
            Ok(data_dir)
        }
    }

    /// 检测 Claude CLI 是否可用
    pub fn detect_claude(&self) -> Option<String> {
        let cmd = self.config.get_claude_cmd();
        eprintln!("[detect_claude] 尝试执行: {} --version", cmd);

        #[cfg(windows)]
        let output = Command::new(&cmd)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        #[cfg(not(windows))]
        let output = Command::new(&cmd)
            .arg("--version")
            .output();

        match output {
            Ok(output) => {
                eprintln!("[detect_claude] 进程退出码: {:?}", output.status.code());
                eprintln!("[detect_claude] stdout: {}", String::from_utf8_lossy(&output.stdout));
                eprintln!("[detect_claude] stderr: {}", String::from_utf8_lossy(&output.stderr));

                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.to_string());
                    eprintln!("[detect_claude] 解析成功: {:?}", version);
                    version
                } else {
                    eprintln!("[detect_claude] 命令执行失败");
                    None
                }
            }
            Err(e) => {
                eprintln!("[detect_claude] 启动进程失败: {:?}", e);
                None
            }
        }
    }

    /// 获取健康状态
    pub fn health_status(&self) -> HealthStatus {
        let claude_version = self.detect_claude();
        let claude_available = claude_version.is_some();

        HealthStatus {
            claude_available,
            claude_version,
            work_dir: self.config.work_dir.as_ref()
                .and_then(|p| p.to_str().map(|s| s.to_string())),
            config_valid: true,
        }
    }

    /// 获取当前工作目录
    pub fn current_work_dir(&self) -> PathBuf {
        self.config.work_dir.clone()
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    /// 设置会话目录
    pub fn set_session_dir(&mut self, path: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&path)?;
        self.config.session_dir = Some(path);
        self.save()
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
                    format!(r"{}\scoop\shims\claude.cmd", env::var("USERPROFILE").unwrap_or_default()),
                ];

                for path in common_paths {
                    if Path::new(&path).exists() && Self::validate_path(&path)
                        && !paths.contains(&path) {
                            paths.push(path);
                        }
                }
            }
        }

        #[cfg(not(windows))]
        {
            let home = env::var("HOME").unwrap_or_default();
            let common_paths = vec![
                // macOS Homebrew
                "/opt/homebrew/bin/claude".to_string(),
                "/usr/local/bin/claude".to_string(),
                // Linux 系统路径
                "/usr/bin/claude".to_string(),
                "/usr/local/bin/claude".to_string(),
                // npm 全局路径
                format!("{}/.npm-global/bin/claude", home),
                format!("{}/.local/bin/claude", home),
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
        let output = Command::new(&path)
            .arg("--version")
            .output();

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
            Err(e) => {
                Ok((false, Some(format!("无法执行: {}", e)), None))
            }
        }
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
            language: None,
            claude_code: crate::models::config::ClaudeCodeConfig {
                cli_path: self.claude_cmd,
            },
            qqbot: Default::default(),
            active_qqbot_instance_id: None,
            work_dir: self.work_dir,
            session_dir: self.session_dir,
            git_bin_path: self.git_bin_path,
            floating_window: Default::default(),
            baidu_translate: None,
            window: Default::default(),
            speech: Default::default(),
            tts: Default::default(),
            claude_cmd: Some(claude_cmd_clone),
        }
    }
}

impl Default for ConfigStore {
    fn default() -> Self {
        Self::new().expect("无法创建配置存储")
    }
}
