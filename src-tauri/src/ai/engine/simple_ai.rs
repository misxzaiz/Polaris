/*! Simple AI 引擎
 *
 * 轻量级 AI 引擎，使用用户在「模型供应商」设置中配置的 OpenAI 兼容 API。
 * 内置 bash / 文件读写工具，可作为 Claude Code CLI 未安装时的备用方案。
 *
 * 核心流程：
 * 1. 从激活的 ModelProfile 获取 baseUrl / apiKey / model
 * 2. 调用 OpenAI Chat Completions API（流式）
 * 3. 如果 AI 请求工具调用 → 执行工具 → 将结果回传 API → 继续循环
 * 4. 通过 event_callback 将 AIEvent 推送给前端
 */

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    ErrorEvent, SessionEndEvent, SessionStartEvent, ThinkingEvent, TokenEvent,
    ToolCallEndEvent, ToolCallStartEvent, UserMessageEvent, ProgressEvent,
};
use crate::models::config::Config;
use crate::models::AIEvent;

// ============================================================================
// 工具定义
// ============================================================================

/// 返回内置工具的 JSON Schema 定义（OpenAI function calling 格式）
fn builtin_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a shell command and return its output. Use this to run scripts, install packages, check system state, etc.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        },
                        "workdir": {
                            "type": "string",
                            "description": "Working directory for the command (optional, defaults to session work_dir)"
                        }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or relative file path"
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file (creates parent directories if needed)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or relative file path"
                        },
                        "content": {
                            "type": "string",
                            "description": "Content to write"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List files and directories at the given path",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory path to list"
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
    ]
}

// ============================================================================
// 工具执行
// ============================================================================

/// 执行 bash 命令
fn execute_bash(command: &str, workdir: Option<&str>, default_dir: &str) -> String {
    let cwd = workdir.unwrap_or(default_dir);

    let shell;
    let flag;
    #[cfg(windows)]
    {
        shell = "cmd";
        flag = "/C";
    }
    #[cfg(not(windows))]
    {
        shell = "sh";
        flag = "-c";
    }

    let output = std::process::Command::new(shell)
        .args([flag, command])
        .current_dir(cwd)
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let exit_code = o.status.code().unwrap_or(-1);

            let mut result = String::new();
            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[stderr]\n{}", stderr));
            }
            if exit_code != 0 {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&format!("[exit code: {}]", exit_code));
            }
            if result.is_empty() {
                "(no output)".to_string()
            } else {
                const MAX_OUTPUT: usize = 32_768;
                if result.len() > MAX_OUTPUT {
                    format!(
                        "{}\n... (truncated, total {} chars)",
                        &result[..MAX_OUTPUT],
                        result.len()
                    )
                } else {
                    result
                }
            }
        }
        Err(e) => format!("Failed to execute command: {}", e),
    }
}

/// 读取文件
fn execute_read_file(path: &str, workdir: &str) -> String {
    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        std::path::PathBuf::from(workdir).join(path)
    };

    match std::fs::read_to_string(&full_path) {
        Ok(content) => {
            const MAX_FILE: usize = 65_536;
            if content.len() > MAX_FILE {
                format!(
                    "{}\n... (truncated, total {} chars)",
                    &content[..MAX_FILE],
                    content.len()
                )
            } else {
                content
            }
        }
        Err(e) => format!("Failed to read file '{}': {}", full_path.display(), e),
    }
}

/// 写入文件
fn execute_write_file(path: &str, content: &str, workdir: &str) -> String {
    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        std::path::PathBuf::from(workdir).join(path)
    };

    if let Some(parent) = full_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return format!("Failed to create directory '{}': {}", parent.display(), e);
        }
    }

    match std::fs::write(&full_path, content) {
        Ok(_) => format!("File written successfully: {}", full_path.display()),
        Err(e) => format!("Failed to write file '{}': {}", full_path.display(), e),
    }
}

/// 列出目录
fn execute_list_directory(path: &str, workdir: &str) -> String {
    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        std::path::PathBuf::from(workdir).join(path)
    };

    match std::fs::read_dir(&full_path) {
        Ok(entries) => {
            let mut items: Vec<String> = Vec::new();
            for entry in entries {
                match entry {
                    Ok(e) => {
                        let name = e.file_name().to_string_lossy().to_string();
                        let is_dir = e.metadata().map(|m| m.is_dir()).unwrap_or(false);
                        if is_dir {
                            items.push(format!("{}/", name));
                        } else {
                            items.push(name);
                        }
                    }
                    Err(e) => items.push(format!("<error: {}>", e)),
                }
            }
            items.sort();
            if items.is_empty() {
                "(empty directory)".to_string()
            } else {
                items.join("\n")
            }
        }
        Err(e) => format!("Failed to list directory '{}': {}", full_path.display(), e),
    }
}

/// 执行工具调用
fn execute_tool(name: &str, args: &Value, workdir: &str) -> String {
    match name {
        "bash" => {
            let command = args["command"].as_str().unwrap_or("");
            let workdir_override = args["workdir"].as_str();
            execute_bash(command, workdir_override, workdir)
        }
        "read_file" => {
            let path = args["path"].as_str().unwrap_or("");
            execute_read_file(path, workdir)
        }
        "write_file" => {
            let path = args["path"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            execute_write_file(path, content, workdir)
        }
        "list_directory" => {
            let path = args["path"].as_str().unwrap_or(".");
            execute_list_directory(path, workdir)
        }
        _ => format!("Unknown tool: {}", name),
    }
}

// ============================================================================
// 会话
// ============================================================================

/// SimpleAI 会话
struct SimpleAISession {
    /// 消息历史（OpenAI 格式）
    messages: Vec<Value>,
    /// 工作目录
    #[allow(dead_code)]
    work_dir: String,
    /// 中断信号发送端
    abort_tx: watch::Sender<bool>,
    /// 中断信号接收端
    abort_rx: watch::Receiver<bool>,
    /// 是否正在运行
    is_running: bool,
}

impl SimpleAISession {
    fn new(work_dir: String) -> Self {
        let (abort_tx, abort_rx) = watch::channel(false);
        Self {
            messages: Vec::new(),
            work_dir,
            abort_tx,
            abort_rx,
            is_running: false,
        }
    }
}

// ============================================================================
// 系统提示词
// ============================================================================

fn build_system_prompt(work_dir: &str) -> String {
    let os_info = if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };

    format!(
        "You are a lightweight AI assistant built into Polaris. \
You can execute bash commands and read/write files to help users complete tasks.\n\n\
Current working directory: {}\n\
Operating system: {}\n\n\
Available tools:\n\
- bash: Execute shell commands\n\
- read_file: Read file contents\n\
- write_file: Write content to files\n\
- list_directory: List directory contents\n\n\
Be concise and efficient. When a task requires multiple steps, proceed step by step. \
If the user asks to install software, use bash to do it. Always verify results.",
        work_dir, os_info
    )
}

// ============================================================================
// 对话循环核心
// ============================================================================

/// 发起 OpenAI Chat Completions 流式请求，执行工具调用循环
async fn run_chat_loop(
    session_id: &str,
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    work_dir: &str,
    tools: &[Value],
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    abort_rx: &mut watch::Receiver<bool>,
) -> Result<()> {
    tracing::info!("[SimpleAI] run_chat_loop 开始, session={}", session_id);
    let max_tool_rounds = 20;
    let mut round = 0;

    loop {
        if round >= max_tool_rounds {
            let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                session_id,
                "Reached maximum tool call rounds (20), stopping.",
            )));
            break;
        }
        round += 1;

        if *abort_rx.borrow() {
            let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
            return Ok(());
        }

        // 构建请求体
        let mut body = json!({
            "model": profile.model,
            "messages": messages,
            "stream": true,
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
            tracing::info!(
                "[SimpleAI] 发送 {} 个工具定义, tool_names=[{}]",
                tools.len(),
                tools.iter()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        } else {
            tracing::warn!("[SimpleAI] 工具列表为空!");
        }

        // HTTP 请求
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;

        let url = format!(
            "{}/chat/completions",
            profile.base_url.trim_end_matches('/')
        );
        tracing::info!("[SimpleAI] 发送 API 请求: {} (model={})", url, profile.model);

        let mut req = client.post(&url).header("Content-Type", "application/json");

        if !profile.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", profile.api_key));
        }
        if let Some(headers) = &profile.custom_headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }

        let response = req
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| {
                tracing::error!("[SimpleAI] API 请求失败: {}", e);
                AppError::ProcessError(format!("API request failed: {}", e))
            })?;

        let status = response.status();
        tracing::info!("[SimpleAI] API 响应状态: {}", status);

        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            tracing::error!("[SimpleAI] API 错误 ({}): {}", status, error_body);
            return Err(AppError::ProcessError(format!(
                "API error ({}): {}",
                status, error_body
            )));
        }

        // 流式解析 SSE
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut assistant_content = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();

        loop {
            if *abort_rx.borrow() {
                let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                return Ok(());
            }

            let chunk = tokio::select! {
                chunk = stream.next() => chunk,
                _ = abort_rx.changed() => {
                    let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                    return Ok(());
                }
            };

            let Some(chunk_result) = chunk else { break };

            let bytes = chunk_result
                .map_err(|e| AppError::ProcessError(format!("Stream error: {}", e)))?;

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }

                let Ok(chunk_json) = serde_json::from_str::<Value>(data) else {
                    continue;
                };

                let delta = &chunk_json["choices"][0]["delta"];

                // 文本增量
                if let Some(content) = delta["content"].as_str() {
                    if !content.is_empty() {
                        assistant_content.push_str(content);
                        let _ = event_callback(AIEvent::Token(TokenEvent::new(
                            session_id,
                            content.to_string(),
                        )));
                    }
                }

                // 思考过程
                if let Some(thinking) = delta["reasoning_content"].as_str() {
                    if !thinking.is_empty() {
                        let _ = event_callback(AIEvent::Thinking(ThinkingEvent::new(
                            session_id,
                            thinking.to_string(),
                        )));
                    }
                }

                // 工具调用增量
                if let Some(tc_deltas) = delta["tool_calls"].as_array() {
                    for tc_delta in tc_deltas {
                        let index = tc_delta["index"].as_u64().unwrap_or(0) as usize;

                        while tool_calls.len() <= index {
                            tool_calls.push(json!({
                                "id": "",
                                "type": "function",
                                "function": { "name": "", "arguments": "" }
                            }));
                        }

                        if let Some(call) = tool_calls.get_mut(index) {
                            if let Some(id) = tc_delta["id"].as_str() {
                                if !id.is_empty() {
                                    call["id"] = json!(id);
                                }
                            }
                            if let Some(name) = tc_delta["function"]["name"].as_str() {
                                let existing = call["function"]["name"].as_str().unwrap_or("");
                                call["function"]["name"] =
                                    json!(format!("{}{}", existing, name));
                            }
                            if let Some(args) = tc_delta["function"]["arguments"].as_str() {
                                let existing =
                                    call["function"]["arguments"].as_str().unwrap_or("");
                                call["function"]["arguments"] =
                                    json!(format!("{}{}", existing, args));
                            }
                        }
                    }
                }
            }
        }

        // 流处理完毕
        tracing::info!(
            "[SimpleAI] 流处理完毕, session={}, content_len={}, tool_calls={}, first_100_chars={:?}",
            session_id,
            assistant_content.len(),
            tool_calls.len(),
            assistant_content.chars().take(100).collect::<String>()
        );

        if tool_calls.is_empty() {
            // 纯文本回复
            messages.push(json!({
                "role": "assistant",
                "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) }
            }));
            break;
        }

        // === 有工具调用 ===

        // 1. 发送 tool_call_start 事件
        for tc in &tool_calls {
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let mut start_event = ToolCallStartEvent::new(
                session_id,
                tool_name.to_string(),
                args.as_object()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            );
            start_event.call_id = Some(tc["id"].as_str().unwrap_or("").to_string());
            let _ = event_callback(AIEvent::ToolCallStart(start_event));
        }

        // 2. 保存 assistant 消息
        messages.push(json!({
            "role": "assistant",
            "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) },
            "tool_calls": tool_calls
        }));
        assistant_content.clear();

        // 3. 执行工具并收集结果
        for tc in &tool_calls {
            let call_id = tc["id"].as_str().unwrap_or("").to_string();
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let result = execute_tool(tool_name, &args, work_dir);

            let mut end_event =
                ToolCallEndEvent::new(session_id, tool_name.to_string(), true);
            end_event.call_id = Some(call_id.clone());
            end_event.result = Some(Value::String(result.clone()));
            let _ = event_callback(AIEvent::ToolCallEnd(end_event));

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result
            }));
        }

        tool_calls.clear();
    }

    Ok(())
}

// ============================================================================
// 引擎
// ============================================================================

/// SimpleAI 引擎
pub struct SimpleAIEngine {
    config: Config,
    sessions: Arc<Mutex<HashMap<String, SimpleAISession>>>,
    session_counter: std::sync::atomic::AtomicU64,
}

impl SimpleAIEngine {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_counter: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn next_session_id(&self) -> String {
        let count = self
            .session_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!(
            "simple-ai-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            count
        )
    }

    fn find_active_profile(
        &self,
        profile_id: Option<&str>,
    ) -> Option<&crate::models::config::ModelProfile> {
        let profiles = &self.config.model_profiles;

        if let Some(pid) = profile_id {
            if let Some(p) = profiles.iter().find(|p| p.id == pid) {
                return Some(p);
            }
        }

        if let Some(pid) = &self.config.active_model_profile_id {
            if let Some(p) = profiles.iter().find(|p| &p.id == pid) {
                return Some(p);
            }
        }

        profiles.iter().find(|p| p.active)
    }
}

// ============================================================================
// AIEngine trait
// ============================================================================

impl AIEngine for SimpleAIEngine {
    fn id(&self) -> EngineId {
        EngineId::SimpleAI
    }

    fn name(&self) -> &'static str {
        "Simple AI"
    }

    fn description(&self) -> &'static str {
        "Lightweight AI assistant using model provider configuration with built-in tools"
    }

    fn is_available(&self) -> bool {
        self.config.model_profiles.iter().any(|p| {
            !p.base_url.is_empty() && !p.api_key.is_empty() && !p.model.is_empty()
        })
    }

    fn unavailable_reason(&self) -> Option<String> {
        if self.config.model_profiles.is_empty() {
            Some(
                "No model profiles configured. Please add one in Settings > Model Provider."
                    .to_string(),
            )
        } else {
            let has_valid = self.config.model_profiles.iter().any(|p| {
                !p.base_url.is_empty() && !p.api_key.is_empty() && !p.model.is_empty()
            });
            if !has_valid {
                Some(
                    "Model profiles exist but none have complete baseUrl/apiKey/model. \
                     Please check Settings > Model Provider."
                        .to_string(),
                )
            } else {
                None
            }
        }
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        // 优先从 env_overrides 获取精确的 profile ID（由 apply_model_profile_options 设置）
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").map(|s| s.as_str());
        let profile = self
            .find_active_profile(profile_id)
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError(
                    "No suitable model profile found. Please configure one in Settings > Model Provider."
                        .to_string(),
                )
            })?;

        let session_id = self.next_session_id();
        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        // 系统提示词
        let system_prompt = if let Some(custom) = &options.system_prompt {
            custom.clone()
        } else {
            let mut prompt = build_system_prompt(&work_dir);
            if let Some(append) = &options.append_system_prompt {
                prompt.push('\n');
                prompt.push_str(append);
            }
            prompt
        };

        // 构建初始消息
        let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system_prompt })];
        for entry in &options.message_history {
            messages.push(json!({ "role": entry.role, "content": entry.content }));
        }
        messages.push(json!({ "role": "user", "content": message }));

        let tools = builtin_tools();

        // 发送事件
        let _ = (options.event_callback)(AIEvent::SessionStart(SessionStartEvent::new(
            &session_id,
        )));
        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            &session_id,
            message.to_string(),
        )));

        // 创建会话
        let session = SimpleAISession::new(work_dir.clone());
        let mut abort_rx = session.abort_rx.clone();

        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        tokio::spawn(async move {
            sessions.lock().await.insert(sid, session);
        });

        // 启动后台任务
        let sid = session_id.clone();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();
        tokio::spawn(async move {
            tracing::info!("[SimpleAI] 后台任务启动, session={}", sid);
            let result = run_chat_loop(
                &sid,
                &mut messages,
                &profile,
                &work_dir,
                &tools,
                &cb,
                &mut abort_rx,
            )
            .await;

            match result {
                Ok(()) => {
                    tracing::info!("[SimpleAI] 对话循环完成, session={}", sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
                Err(e) => {
                    tracing::error!("[SimpleAI] 对话循环失败, session={}, error={}", sid, e);
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, e.to_string())));
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
            }
        });

        Ok(session_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        // 优先从 env_overrides 获取精确的 profile ID
        let profile_id = options.env_overrides.get("__simple_ai_profile_id").map(|s| s.as_str());
        let profile = self
            .find_active_profile(profile_id)
            .cloned()
            .ok_or_else(|| {
                AppError::ProcessError("No suitable model profile found.".to_string())
            })?;

        let work_dir = options.work_dir.clone().unwrap_or_else(|| ".".to_string());

        let _ = (options.event_callback)(AIEvent::UserMessage(UserMessageEvent::new(
            session_id,
            message.to_string(),
        )));

        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();
        let msg = message.to_string();
        let tools = builtin_tools();
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = options.event_callback.clone();

        tokio::spawn(async move {
            tracing::info!("[SimpleAI] continue_session 后台任务启动, session={}", sid);

            // 获取会话历史
            let mut existing_messages = {
                let guard = sessions.lock().await;
                if let Some(session) = guard.get(&sid) {
                    session.messages.clone()
                } else {
                    let system_prompt = build_system_prompt(&work_dir);
                    vec![json!({ "role": "system", "content": system_prompt })]
                }
            };

            let mut abort_rx = {
                let guard = sessions.lock().await;
                if let Some(session) = guard.get(&sid) {
                    session.abort_rx.clone()
                } else {
                    let (_, rx) = watch::channel(false);
                    rx
                }
            };

            existing_messages.push(json!({ "role": "user", "content": msg }));

            let result = run_chat_loop(
                &sid,
                &mut existing_messages,
                &profile,
                &work_dir,
                &tools,
                &cb,
                &mut abort_rx,
            )
            .await;

            // 更新会话历史
            {
                let mut guard = sessions.lock().await;
                if let Some(session) = guard.get_mut(&sid) {
                    session.messages = existing_messages;
                    session.is_running = false;
                }
            }

            match result {
                Ok(()) => {
                    tracing::info!("[SimpleAI] continue 完成, session={}", sid);
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
                Err(e) => {
                    tracing::error!("[SimpleAI] continue 失败, session={}, error={}", sid, e);
                    let _ = cb(AIEvent::Error(ErrorEvent::new(&sid, e.to_string())));
                    let _ = cb(AIEvent::SessionEnd(SessionEndEvent::new(&sid)));
                }
            }
        });

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        let sessions = Arc::clone(&self.sessions);
        let sid = session_id.to_string();

        tokio::spawn(async move {
            let guard = sessions.lock().await;
            if let Some(session) = guard.get(&sid) {
                let _ = session.abort_tx.send(true);
                tracing::info!("[SimpleAI] Interrupt signal sent for session {}", sid);
            } else {
                tracing::warn!("[SimpleAI] Session {} not found for interrupt", sid);
            }
        });

        Ok(())
    }

    fn active_session_count(&self) -> usize {
        self.sessions
            .try_lock()
            .map(|s| s.values().filter(|sess| sess.is_running).count())
            .unwrap_or(0)
    }

    fn update_config(&mut self, new_config: Config) {
        self.config = new_config;
    }
}
