/**
 * Codex 引擎实现
 *
 * 封装 OpenAI Codex CLI 的调用逻辑。
 */

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
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

/// Codex 引擎
pub struct CodexEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
}

impl CodexEngine {
    /// 创建新的 Codex 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
        }
    }

    /// 获取 Codex CLI 路径
    fn get_cli_path(&mut self) -> Result<&str> {
        if self.cli_path.is_none() {
            self.cli_path = if let Some(ref path) = self.config.codex.cli_path {
                Some(path.clone())
            } else if let Some(path) = Self::find_codex_path() {
                Some(path)
            } else {
                return Err(AppError::ConfigError("未找到 Codex CLI".to_string()));
            };
        }
        Ok(self.cli_path.as_ref().unwrap())
    }

    /// 查找 Codex CLI 路径
    fn find_codex_path() -> Option<String> {
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

            if let Ok(output) = Command::new("where")
                .arg("codex")
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                if output.status.success() {
                    return String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string());
                }
            }
        }

        #[cfg(not(windows))]
        {
            if let Ok(output) = Command::new("which").arg("codex").output() {
                if output.status.success() {
                    return String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string());
                }
            }
        }

        None
    }

    /// 检查 CLI 是否可用
    fn check_cli_available(&mut self) -> bool {
        self.get_cli_path().is_ok()
    }

    /// 构建 Codex 命令
    fn build_command(&self, message: &str, session_id: Option<&str>) -> Command {
        let cli_path = self.cli_path.as_ref().unwrap();
        let mut cmd = Command::new(cli_path);

        if let Some(sid) = session_id {
            // 继续会话
            cmd.arg("exec")
                .arg("resume")
                .arg(sid)
                .arg("--json")
                .arg("--skip-git-repo-check");

            if self.config.codex.dangerous_bypass {
                cmd.arg("--dangerously-bypass-approvals-and-sandbox");
            } else {
                cmd.arg("--full-auto");
            }
        } else {
            // 新会话
            cmd.arg("exec")
                .arg("--json")
                .arg("--skip-git-repo-check");

            if self.config.codex.dangerous_bypass {
                cmd.arg("--dangerously-bypass-approvals-and-sandbox");
            } else {
                cmd.arg("--sandbox")
                    .arg(&self.config.codex.sandbox_mode)
                    .arg("-c")
                    .arg(format!("approval_policy=\"{}\"", self.config.codex.approval_policy));
            }
        }

        if !message.is_empty() {
            cmd.arg(message);
        }

        cmd
    }

    /// 配置命令
    fn configure_command(&self, cmd: &mut Command, work_dir: Option<&str>) {
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }
    }

    /// 解析 Codex JSONL 输出
    fn parse_codex_jsonl(line: &str) -> Vec<StreamEvent> {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        let event_type = match value.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => return Vec::new(),
        };

        let result = match event_type {
            "thread.started" => {
                if let Some(thread_id) = value.get("thread_id").and_then(|t| t.as_str()) {
                    let mut extra = HashMap::new();
                    extra.insert("session_id".to_string(), serde_json::json!(thread_id));
                    Some(StreamEvent::System {
                        subtype: Some("thread_started".to_string()),
                        extra,
                    })
                } else {
                    None
                }
            }

            "item.completed" => {
                let item = match value.get("item") {
                    Some(v) => v,
                    None => return Vec::new(),
                };
                let item_type = match item.get("type").and_then(|t| t.as_str()) {
                    Some(v) => v,
                    None => return Vec::new(),
                };

                match item_type {
                    "agent_message" => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            let message = serde_json::json!({
                                "content": [{
                                    "type": "text",
                                    "text": text
                                }],
                                "model": "codex",
                                "id": item.get("id").and_then(|v| v.as_str()).unwrap_or("")
                            });
                            Some(StreamEvent::Assistant { message })
                        } else {
                            None
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            Some(StreamEvent::Thinking {
                                id,
                                thinking: text.to_string(),
                            })
                        } else {
                            None
                        }
                    }
                    "tool_use" => {
                        let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let tool_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let tool_input = item.get("input").cloned().unwrap_or(serde_json::Value::Null);
                        let tool_output = item.get("output")
                            .or_else(|| item.get("result"))
                            .and_then(|v| if v.is_string() { v.as_str().map(|s| s.to_string()) } else { Some(v.to_string()) });

                        if let Some(output) = tool_output {
                            return vec![
                                StreamEvent::ToolStart {
                                    tool_use_id: tool_id.to_string(),
                                    tool_name: tool_name.to_string(),
                                    input: tool_input,
                                },
                                StreamEvent::ToolEnd {
                                    tool_use_id: tool_id.to_string(),
                                    tool_name: Some(tool_name.to_string()),
                                    output: Some(output),
                                },
                            ];
                        }

                        Some(StreamEvent::ToolStart {
                            tool_use_id: tool_id.to_string(),
                            tool_name: tool_name.to_string(),
                            input: tool_input,
                        })
                    }
                    "command_execution" => {
                        let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let exit_code = item.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(-1);
                        let output = item.get("combined_output")
                            .or_else(|| item.get("output"))
                            .or_else(|| item.get("stdout"))
                            .or_else(|| item.get("stderr"))
                            .or_else(|| item.get("result"))
                            .and_then(|v| if v.is_string() { v.as_str().map(|s| s.to_string()) } else { Some(v.to_string()) });

                        let final_output = output.or_else(|| {
                            if exit_code == 0 {
                                Some("✓ 命令执行成功".to_string())
                            } else {
                                Some(format!("⚠ 命令执行失败 (exit_code: {})", exit_code))
                            }
                        });

                        Some(StreamEvent::ToolEnd {
                            tool_use_id: tool_id.to_string(),
                            tool_name: Some("command_execution".to_string()),
                            output: final_output,
                        })
                    }
                    _ => None,
                }
            }

            "item.started" => {
                let item = match value.get("item") {
                    Some(v) => v,
                    None => return Vec::new(),
                };
                let item_type = match item.get("type").and_then(|t| t.as_str()) {
                    Some(v) => v,
                    None => return Vec::new(),
                };

                if item_type == "command_execution" {
                    let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let input = serde_json::json!({ "command": command });

                    Some(StreamEvent::ToolStart {
                        tool_use_id: tool_id.to_string(),
                        tool_name: "command_execution".to_string(),
                        input,
                    })
                } else {
                    None
                }
            }

            "turn.completed" => {
                Some(StreamEvent::SessionEnd)
            }

            _ => None,
        };

        result.into_iter().collect()
    }

    /// 启动后台线程读取事件
    fn spawn_event_reader(
        &self,
        mut child: Child,
        temp_id: String,
        pid: u32,
        options: SessionOptions,
    ) {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let current_session_id = temp_id.clone();

        std::thread::spawn(move || {
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程输出流".to_string());
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
                    return;
                }
            };

            // 读取 stderr
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    tracing::debug!("[codex stderr] {}", line);
                }
            });

            // 创建事件解析器
            let mut parser = EventParser::new(&current_session_id);

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

                for stream_event in Self::parse_codex_jsonl(trimmed) {
                    // 更新 session_id 映射
                    if let StreamEvent::System { extra, .. } = &stream_event {
                        if let Some(serde_json::Value::String(real_id)) = extra.get("session_id") {
                            parser.set_session_id(real_id);
                            SessionManager::update_session_id_shared(
                                &sessions, &temp_id, real_id, pid, "codex"
                            );
                            tracing::info!("[CodexEngine] session_id 更新: {} -> {}", temp_id, real_id);

                            // 通知外部 session_id 已更新
                            if let Some(ref cb) = on_session_id_update {
                                cb(real_id.clone());
                            }
                        }
                    }

                    if matches!(stream_event, StreamEvent::SessionEnd) {
                        received_session_end = true;
                    }

                    // 使用 EventParser 转换为 AIEvent
                    for ai_event in parser.parse(stream_event) {
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
    }
}

impl AIEngine for CodexEngine {
    fn id(&self) -> EngineId {
        EngineId::Codex
    }

    fn name(&self) -> &'static str {
        "Codex"
    }

    fn description(&self) -> &'static str {
        "OpenAI Codex CLI 代码生成助手"
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
        tracing::info!("[CodexEngine] 启动会话，消息长度: {}", message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Codex CLI 不可用".to_string()));
        }

        // 构建命令
        let mut cmd = self.build_command(message, None);
        self.configure_command(&mut cmd, options.work_dir.as_deref());

        // 启动进程
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 Codex 进程失败: {}", e)))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[CodexEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        // 注册会话
        self.sessions.register(temp_id.clone(), pid, "codex".to_string())?;

        // 启动事件读取
        self.spawn_event_reader(child, temp_id.clone(), pid, options);

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[CodexEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("Codex CLI 不可用".to_string()));
        }

        // 终止旧进程
        let _ = self.sessions.kill_process(session_id);

        // 构建命令
        let mut cmd = self.build_command(message, Some(session_id));
        self.configure_command(&mut cmd, options.work_dir.as_deref());

        // 启动进程
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 Codex 会话失败: {}", e)))?;

        let pid = child.id();

        tracing::info!("[CodexEngine] 进程启动，PID: {}", pid);

        // 更新会话 PID
        self.sessions.register(session_id.to_string(), pid, "codex".to_string())?;

        // 启动事件读取
        self.spawn_event_reader(child, session_id.to_string(), pid, options);

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[CodexEngine] 中断会话: {}", session_id);

        if self.sessions.kill_process(session_id)? {
            tracing::info!("[CodexEngine] 会话已中断: {}", session_id);
            Ok(())
        } else {
            // 找不到会话，返回错误让调用者尝试其他引擎
            Err(AppError::ProcessError(format!("会话不存在: {}", session_id)))
        }
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }
}
