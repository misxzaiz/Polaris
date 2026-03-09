/// Codex CLI 服务
///
/// 管理 OpenAI Codex CLI 进程和会话文件监控

use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::events::StreamEvent;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio, Child};
use std::time::Duration;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Codex 会话
pub struct CodexSession {
    pub id: String,
    pub child: Child,
    pub session_id: String,
}

impl CodexSession {
    /// 创建 CodexSession 实例
    pub fn new(id: String, child: Child, session_id: String) -> Self {
        Self { id, child, session_id }
    }
}

/// Codex CLI 服务
pub struct CodexService;

impl CodexService {
    /// 获取 Codex 配置目录
    fn get_codex_config_dir() -> Result<PathBuf> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| AppError::ConfigError("无法获取用户目录".to_string()))?;

        let config_dir = PathBuf::from(home).join(".codex");

        if !config_dir.exists() {
            return Err(AppError::ConfigError("Codex 配置目录不存在".to_string()));
        }

        Ok(config_dir)
    }

    /// 获取 Codex CLI 路径
    fn get_codex_cmd(config: &Config) -> Result<String> {
        if let Some(ref cli_path) = config.codex.cli_path {
            Ok(cli_path.clone())
        } else {
            // 尝试查找 Codex
            if let Some(path) = Self::find_codex_path() {
                Ok(path)
            } else {
                Err(AppError::ConfigError("未找到 Codex CLI，请在设置中配置路径".to_string()))
            }
        }
    }

    /// 查找 Codex CLI 路径
    pub fn find_codex_path() -> Option<String> {
        // 尝试常见路径
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let codex_cmd = PathBuf::from(&appdata)
                    .join("npm")
                    .join("codex.cmd");
                if codex_cmd.exists() {
                    return Some(codex_cmd.to_string_lossy().to_string());
                }
            }

            // 使用 where 命令查找
            if let Ok(output) = Command::new("where").arg("codex").output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string());
                    if let Some(p) = path {
                        return Some(p);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            if let Ok(output) = Command::new("which").arg("codex").output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string());
                    if let Some(p) = path {
                        return Some(p);
                    }
                }
            }
        }

        None
    }

    /// 检查 Codex 是否可用
    pub fn check_available(config: &Config) -> (bool, Option<String>) {
        let codex_cmd = match Self::get_codex_cmd(config) {
            Ok(cmd) => cmd,
            Err(_) => return (false, None),
        };

        #[cfg(windows)]
        let output = Command::new(&codex_cmd)
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        #[cfg(not(windows))]
        let output = Command::new(&codex_cmd)
            .arg("--version")
            .output();

        match output {
            Ok(o) if o.status.success() => {
                let version = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .map(|s| s.trim().to_string());
                (true, version)
            }
            _ => (false, None),
        }
    }

    /// 启动新的 Codex 聊天会话
    pub fn start_chat(config: &Config, message: &str) -> Result<CodexSession> {
        eprintln!("[CodexService::start_chat] 启动 Codex 会话");
        eprintln!("[CodexService::start_chat] 消息内容: {}", message);

        let work_dir = config.work_dir.as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string())
            });

        let codex_cmd = Self::get_codex_cmd(config)?;
        let mut cmd = Self::build_codex_command(&codex_cmd, &work_dir, message, None);

        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        eprintln!("[CodexService] 执行命令: {}", program);
        eprintln!("[CodexService] 命令参数: {:?}", args);
        eprintln!("[CodexService] 工作目录: {}", work_dir);

        let child = cmd.spawn()
            .map_err(|e| {
                let error_msg = format!(
                    "启动 Codex 失败: {}\n命令: {}\n参数: {:?}\n工作目录: {}",
                    e, program, args, work_dir
                );
                eprintln!("[CodexService] {}", error_msg);
                AppError::ProcessError(error_msg)
            })?;

        let process_id = child.id();
        eprintln!("[CodexService] 进程 PID: {:?}", process_id);

        let temp_id = Uuid::new_v4().to_string();

        Ok(CodexSession::new(temp_id, child, String::new()))
    }

    /// 构建 Codex 命令
    fn build_codex_command(codex_cmd: &str, work_dir: &str, message: &str, session_id: Option<&str>) -> Command {
        let mut cmd = Command::new(codex_cmd);

        // 如果是恢复会话，使用 resume 子命令
        if let Some(id) = session_id {
            // codex resume --json <SESSION_ID> <PROMPT>
            // 注意: --last 和 SESSION_ID 不能同时使用
            cmd.arg("resume")
                .arg("--json")        // JSON 输出模式，避免终端检测
                .arg(id)              // 会话 ID
                .arg("--full-auto");  // 自动执行模式
            
            // 消息作为参数传递
            if !message.is_empty() {
                cmd.arg(message);
            }
        } else {
            // 新会话使用 exec 子命令
            cmd.arg("exec")
                .arg("--json")
                .arg("--skip-git-repo-check");

            // 消息作为参数传递
            if !message.is_empty() {
                cmd.arg(message);
            }
        }

        cmd.current_dir(work_dir);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        cmd
    }

    /// 继续聊天会话
    pub fn continue_chat(config: &Config, session_id: &str, message: &str) -> Result<Child> {
        eprintln!("[CodexService::continue_chat] 继续会话: {}", session_id);
        eprintln!("[CodexService::continue_chat] 消息内容: {}", message);

        let work_dir = config.work_dir.as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string())
            });

        let codex_cmd = Self::get_codex_cmd(config)?;
        let mut cmd = Self::build_codex_command(&codex_cmd, &work_dir, message, Some(session_id));

        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        eprintln!("[CodexService] 执行命令: {}", program);
        eprintln!("[CodexService] 命令参数: {:?}", args);
        eprintln!("[CodexService] 工作目录: {}", work_dir);

        cmd.spawn()
            .map_err(|e| {
                let error_msg = format!(
                    "继续 Codex 会话失败: {}\n命令: {}\n参数: {:?}\n工作目录: {}\n会话ID: {}",
                    e, program, args, work_dir, session_id
                );
                eprintln!("[CodexService] {}", error_msg);
                AppError::ProcessError(error_msg)
            })
    }

    /// 监控进程输出并发送事件
    pub fn monitor_output<F>(
        mut child: Child,
        session_id: String,
        mut callback: F,
    ) -> std::thread::JoinHandle<()>
    where
        F: FnMut(StreamEvent) + Send + 'static,
    {
        std::thread::spawn(move || {
            eprintln!("[CodexService] 开始监控进程输出");

            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    callback(StreamEvent::Error {
                        error: "无法获取进程输出流".to_string(),
                    });
                    return;
                }
            };

            let stderr = match child.stderr.take() {
                Some(s) => s,
                None => {
                    callback(StreamEvent::Error {
                        error: "无法获取进程错误流".to_string(),
                    });
                    return;
                }
            };

            // 启动单独的线程读取 stderr
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        eprintln!("[codex stderr] {}", l);
                    }
                }
            });

            let reader = BufReader::new(stdout);
            let mut has_session_end = false;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[CodexService] 读取行错误: {}", e);
                        break;
                    }
                };

                let line_trimmed = line.trim();
                if line_trimmed.is_empty() {
                    continue;
                }

                eprintln!("[CodexService] 输出: {}", line_trimmed.chars().take(100).collect::<String>());

                // 解析 JSONL 事件
                if let Some(stream_event) = Self::parse_codex_jsonl(line_trimmed) {
                    let is_session_end = matches!(stream_event, StreamEvent::SessionEnd);
                    callback(stream_event);

                    if is_session_end {
                        has_session_end = true;
                        eprintln!("[CodexService] 检测到会话结束");
                        break;
                    }
                }
            }

            // 等待进程结束
            let _ = child.wait();

            // 如果没有收到 session_end 事件，发送一个
            if !has_session_end {
                eprintln!("[CodexService] 进程结束，发送 session_end 事件");
                callback(StreamEvent::SessionEnd);
            }

            eprintln!("[CodexService] 监控结束");
        })
    }

    /// 解析 Codex JSONL 输出
    /// 
    /// Codex exec 输出格式:
    /// - {"type":"thread.started","thread_id":"xxx"}
    /// - {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    /// - {"type":"turn.completed","usage":{...}}
    fn parse_codex_jsonl(line: &str) -> Option<StreamEvent> {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;

        let event_type = value.get("type")?.as_str()?;

        match event_type {
            "thread.started" => {
                // 线程开始，提取 thread_id 作为会话 ID
                let thread_id = value.get("thread_id")?.as_str()?.to_string();
                let mut extra = HashMap::new();
                extra.insert("session_id".to_string(), serde_json::json!(thread_id));
                Some(StreamEvent::System {
                    subtype: Some("thread_started".to_string()),
                    extra,
                })
            }

            "item.completed" => {
                let item = value.get("item")?;
                let item_type = item.get("type")?.as_str()?;

                match item_type {
                    "agent_message" => {
                        let text = item.get("text")?.as_str()?.to_string();
                        let message = serde_json::json!({
                            "content": [{
                                "type": "text",
                                "text": text
                            }],
                            "model": "codex",
                            "id": item.get("id").and_then(|v| v.as_str()).unwrap_or("")
                        });
                        Some(StreamEvent::Assistant { message })
                    }
                    "tool_use" => {
                        let tool_id = item.get("id")?.as_str()?.to_string();
                        let tool_name = item.get("name")?.as_str()?.to_string();
                        let tool_input = item.get("input").cloned().unwrap_or(serde_json::Value::Null);

                        Some(StreamEvent::ToolStart {
                            tool_use_id: tool_id,
                            tool_name,
                            input: tool_input,
                        })
                    }
                    _ => None,
                }
            }

            "turn.completed" => {
                // 轮次完成，发送会话结束事件
                Some(StreamEvent::SessionEnd)
            }

            _ => None,
        }
    }

    /// 查找会话对应的 JSONL 文件
    pub fn find_session_jsonl(config: &Config, session_id: &str) -> Result<PathBuf> {
        let config_dir = Self::get_codex_config_dir()?;
        let sessions_dir = config_dir.join("sessions");

        if !sessions_dir.exists() {
            return Err(AppError::ProcessError("Codex sessions 目录不存在".to_string()));
        }

        // 遍历最近 7 天的目录查找匹配的会话文件
        let today = chrono::Local::now();
        for i in 0..7 {
            let date = today - chrono::Duration::days(i);
            let date_path = sessions_dir
                .join(date.format("%Y").to_string())
                .join(date.format("%m").to_string())
                .join(date.format("%d").to_string());

            if !date_path.exists() {
                continue;
            }

            let entries = std::fs::read_dir(&date_path)
                .map_err(|e| AppError::ProcessError(format!("读取目录失败: {}", e)))?;

            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
                    // Codex 会话文件名格式: rollout-{ts}-{ulid}.jsonl
                    if filename.contains(session_id) && filename.ends_with(".jsonl") {
                        return Ok(path);
                    }
                }
            }
        }

        Err(AppError::ProcessError(format!("未找到会话文件: {}", session_id)))
    }
}
