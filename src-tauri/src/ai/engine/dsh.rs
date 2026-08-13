/*! DeepSeek Harness (dsh) 引擎
 *
 * 实现 AIEngine trait，作为 DeepSeek Harness Web API 的客户端适配器。
 *
 * 通信模型（基于 dsh Web API 协议，源码验证 + 端到端实测）：
 *
 * - 服务端：dsh 作为常驻 Web 服务器进程运行（`dsh --profile web --port 0`）。
 *   每个 DshEngine 实例管理一个 dsh 子进程，多个 Polaris 会话共享同一 dsh 实例。
 *
 * - 控制通道：HTTP POST JSON RPC
 *   - 请求格式：`POST /api/<method>`，body 为 `{type:"client-request", rpcId, method, payload}`
 *   - 响应格式：`{type:"server-response", rpcId, result:{ok,value|error}}`
 *   - 核心方法：host.describe / session.create / session.prompt / session.cancel /
 *     session.history / session.models / session.selectModel
 *
 * - 事件通道：WebSocket（HTTP 426 Upgrade 后）
 *   - 路径：`GET /api/events.mux`（服务端→客户端单向流）
 *   - 帧格式：`{type:"server-request", rpcId, method, payload}`
 *   - payload.type 决定事件类型（session/event, session/projection, approval/requested 等）
 *   - session/event 的 event.type 携带具体事件（assistant/chunk, user/message 等）
 *
 * 事件翻译（dsh → Polaris AIEvent）：
 *   assistant/chunk (text)      → AIEvent::Token
 *   assistant/chunk (reasoning) → AIEvent::Thinking
 *   assistant/message           → AIEvent::AssistantMessage
 *   user/message                → AIEvent::UserMessage
 *   tool/call                   → AIEvent::ToolCallStart
 *   tool/result                 → AIEvent::ToolCallEnd
 *   sessionStats projection     → AIEvent::Usage
 *   approval/requested          → AIEvent::PermissionRequest
 *   turn/end                    → 触发 session_end（无 pending tool calls 时）
 *
 * Session 管理：
 * - Polaris session_id（前端 UUID）↔ dsh session_id（dsh 生成）映射存于 session_map
 * - dsh session 持久化到 ~/.dsh/sessions/，重启后仍可通过 session.list 恢复
 *
 * 能力：
 *   - 流式输出（✅ WebSocket 逐帧）
 *   - 工具调用（✅ dsh 内部 shell/fs/subagent/approval）
 *   - 中断（✅ session.cancel）
 *   - 续聊（✅ dsh session 持久化，复用已有 dsh session_id）
 *   - 模型切换（✅ session.selectModel）
 *   - Token 用量（✅ sessionStats projection）
 *   - 图片输入（⚠️ 通过 PromptContentPart 支持，首版仅 text）
 *   - MCP 工具（❌ dsh 内部 Cordis 插件生态，不直接桥接 Polaris MCP）
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineCapabilities, EngineDistribution, EngineId, EngineMetadata, EnvKeyMapping,
    SessionOptions,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::AIEvent;

use tokio::runtime::Handle;
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// DSH 引擎
pub struct DshEngine {
    /// 应用配置
    _config: Config,
    /// 会话管理器（管理 stdin 输入和 PID）
    sessions: SessionManager,
    /// dsh CLI 路径
    cli_path: Option<String>,
    /// dsh Web 服务器子进程
    dsh_child: Option<Child>,
    /// dsh Web 服务器 base URL（如 http://127.0.0.1:XXXXX）
    dsh_base_url: Mutex<Option<String>>,
    /// 是否正在运行 dsh 服务器
    dsh_running: AtomicBool,
    /// 捕获的 tokio runtime handle（延迟到首次调用时捕获）
    ///
    /// `DshEngine::new()` 在 Tauri 同步初始化阶段调用，此时 `Handle::try_current()` 返回 None。
    /// 实际的 WebSocket 事件读取发生在 `start_session` 内（被 async `start_chat_inner` 调用），
    /// 此时已经在 tokio worker 线程上。因此将 handle 捕获推迟到首次实际需要时。
    tokio_handle: Mutex<Option<Handle>>,
    /// Polaris session_id → dsh session_id 映射
    session_map: Mutex<HashMap<String, String>>,
    /// 每个 session 的 callId → toolName 映射（per-session 隔离）
    call_id_maps: Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    /// 泄漏到 &'static str 的引擎标识
    leaked_name: &'static str,
    leaked_description: &'static str,
}

impl DshEngine {
    pub fn new(_config: Config) -> Self {
        Self {
            _config,
            sessions: SessionManager::new(),
            cli_path: None,
            dsh_child: None,
            dsh_base_url: Mutex::new(None),
            dsh_running: AtomicBool::new(false),
            tokio_handle: Mutex::new(None),
            session_map: Mutex::new(HashMap::new()),
            call_id_maps: Arc::new(Mutex::new(HashMap::new())),
            leaked_name: Box::leak("DeepSeek Harness".to_string().into_boxed_str()),
            leaked_description: Box::leak(
                "DeepSeek Harness — 开源 Agent 编排框架（HTTP RPC + WebSocket 事件流）"
                    .to_string()
                    .into_boxed_str(),
            ),
        }
    }

    // ========================================================================
    // dsh 子进程管理
    // ========================================================================

    /// 获取 dsh CLI 路径
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        let cmd = "dsh";

        // 直接路径存在
        if Path::new(cmd).exists() {
            self.cli_path = Some(cmd.to_string());
            return Ok(cmd.to_string());
        }

        // Windows: 探测 npm/pnpm/bun 全局安装路径
        #[cfg(windows)]
        {
            let candidates = [
                std::env::var("APPDATA")
                    .ok()
                    .map(|d| {
                        std::path::PathBuf::from(&d).join("npm").join("dsh.cmd")
                    }),
                std::env::var("LOCALAPPDATA")
                    .ok()
                    .map(|d| {
                        std::path::PathBuf::from(&d).join("pnpm").join("dsh.cmd")
                    }),
                std::env::var("USERPROFILE")
                    .ok()
                    .map(|d| {
                        std::path::PathBuf::from(&d)
                            .join(".bun")
                            .join("bin")
                            .join("dsh.exe")
                    }),
            ];
            for candidate in candidates.into_iter().flatten() {
                if candidate.exists() {
                    let s = candidate.to_string_lossy().to_string();
                    self.cli_path = Some(s.clone());
                    return Ok(s);
                }
            }
        }

        // PATH 查找
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut check = Command::new(which_cmd);
        check.arg(cmd);
        #[cfg(windows)]
        check.creation_flags(CREATE_NO_WINDOW);
        if check.output().map(|o| o.status.success()).unwrap_or(false) {
            self.cli_path = Some(cmd.to_string());
            return Ok(cmd.to_string());
        }

        tracing::warn!("[DshEngine] dsh CLI 未找到");
        Ok(cmd.to_string())
    }

    /// 启动 dsh Web 服务器
    fn ensure_dsh_server(&mut self) -> Result<String> {
        // 读取一次锁，避免两次获取
        let url_opt = self.dsh_base_url.lock().unwrap().clone();
        if let Some(ref url) = url_opt {
            if self.dsh_running.load(Ordering::SeqCst) {
                return Ok(url.clone());
            }
        }
        drop(url_opt);

        // 检查子进程是否还活着
        if let Some(ref mut child) = self.dsh_child {
            if let Ok(None) = child.try_wait() {
                // 还在运行，重新读取 URL
                let url = self.dsh_base_url.lock().unwrap().clone();
                if let Some(url) = url {
                    self.dsh_running.store(true, Ordering::SeqCst);
                    return Ok(url);
                }
            }
            // 已退出，需要重启
            self.dsh_child = None;
            self.dsh_running.store(false, Ordering::SeqCst);
        }

        let cli_path = self.get_cli_path()?;
        tracing::info!("[DshEngine] 启动 dsh Web 服务器: {}", cli_path);

        let mut cmd: Command = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(&cli_path).arg("--profile").arg("web").arg("--port").arg("0");
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            c
        } else {
            let mut c = Command::new(&cli_path);
            c.arg("--profile").arg("web").arg("--port").arg("0");
            c
        };

        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            AppError::ProcessError(format!("启动 dsh 进程失败: {}", e))
        })?;

        // 读取 stdout 找到 URL（用 take() 取出，避免 partial move）
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => return Err(AppError::ProcessError("无法获取 dsh stdout".to_string())),
        };
        let reader = BufReader::new(stdout);

        let mut base_url = None;
        let start = Instant::now();
        let timeout = Duration::from_secs(30);

        for line in reader.lines().map_while(|r| r.ok()) {
            if start.elapsed() > timeout {
                break;
            }
            if let Some(url) = line
                .strip_prefix("dsh web: http://")
                .or_else(|| line.strip_prefix("dsh web: https://"))
            {
                // 移除末尾可能的空格和端口后面的字符
                let url = url.trim();
                base_url = Some(format!("http://{}", url));
                tracing::info!("[DshEngine] dsh 服务器已启动: {}", base_url.as_ref().unwrap());
                break;
            }
            tracing::debug!("[DshEngine] dsh stdout: {}", line);
        }

        if base_url.is_none() {
            let _stderr = child.stderr.take();
            return Err(AppError::ProcessError(
                "dsh 服务器启动超时或未输出 URL".to_string(),
            ));
        }

        let url = base_url.unwrap();

        // 消费 stderr（避免管道缓冲区满阻塞 dsh 进程）
        // 用独立线程持续读取 stderr 并记录为 warn 级别日志
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                return Err(AppError::ProcessError(
                    "无法获取 dsh stderr".to_string(),
                ))
            }
        };
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(|r| r.ok()) {
                tracing::warn!("[DshEngine] dsh stderr: {}", line);
            }
        });

        self.dsh_child = Some(child);
        *self.dsh_base_url.lock().unwrap() = Some(url.clone());
        self.dsh_running.store(true, Ordering::SeqCst);

        // 等待服务器就绪（轮询 /api/host.describe 的轻量检查）
        self.wait_for_server_ready(&url)?;

        Ok(url)
    }

    /// 等待 dsh 服务器就绪
    ///
    /// 卸载到独立线程执行 blocking reqwest，避免在 async 上下文中 drop
    /// reqwest blocking client（reqwest 0.12 的 blocking client 内部持有独立
    /// Tokio runtime，在 tokio worker 线程上 drop 会 panic）。
    fn wait_for_server_ready(&self, base_url: &str) -> Result<()> {
        let base_url_str = base_url.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let start = Instant::now();
            let timeout = Duration::from_secs(15);
            let result: Result<()> = loop {
                if start.elapsed() > timeout {
                    break Err(AppError::ProcessError(
                        "dsh 服务器就绪检查超时".to_string(),
                    ));
                }
                match reqwest::blocking::Client::new()
                    .post(format!("{}/api/host.describe", base_url_str))
                    .header("Content-Type", "application/json")
                    .body(
                        json!({
                            "type": "client-request",
                            "rpcId": "ready-check",
                            "method": "host.describe",
                            "payload": {}
                        })
                        .to_string(),
                    )
                    .timeout(Duration::from_secs(5))
                    .send()
                {
                    Ok(resp) => {
                        if resp.status().is_success() {
                            tracing::info!(
                                "[DshEngine] dsh 服务器已就绪: {}",
                                base_url_str
                            );
                            break Ok(());
                        }
                    }
                    Err(_) => {}
                }
                std::thread::sleep(Duration::from_millis(500));
            };
            let _ = tx.send(result);
        });
        let result = rx.recv()
            .map_err(|e| AppError::ProcessError(format!("ready 线程通信失败: {}", e)))?;

        // 确保 settings.yaml 的 agent-default-model 有效
        // 之前的 session.selectModel 可能污染了该配置
        self.ensure_valid_default_model();

        result
    }

    /// 确保 settings.yaml 的 agent-default-model 使用有效的 provider/model
    ///
    /// dsh 的 settings.yaml 中 agent-default-model 可能被之前失败的
    /// session.selectModel 调用污染（如 provider=deepseek-official + model=sensenova-6.8-flash-lite
    /// 这种不存在组合），导致模型调用静默失败。
    ///
    /// 如果当前配置无效，回退到有效的默认值（deepseek-official + deepseek-v4-flash）。
    fn ensure_valid_default_model(&self) {
        let settings_path = dirs::home_dir()
            .map(|h| h.join(".dsh").join("settings.yaml"))
            .unwrap_or_else(|| PathBuf::from(".dsh/settings.yaml"));

        if !settings_path.exists() {
            return;
        }

        let content = match fs::read_to_string(&settings_path) {
            Ok(c) => c,
            Err(_) => return,
        };

        // 检查 agent-default-model 的 provider 和 model
        // 简单 YAML 解析：找到 provider: 和 model: 行
        let mut has_default = false;
        let mut in_default_block = false;
        let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
        let mut modified = false;

        for (i, line) in lines.clone().iter().enumerate() {
            let trimmed = line.trim();
            if trimmed == "agent-default-model:" {
                in_default_block = true;
                has_default = true;
                continue;
            }
            if in_default_block {
                if trimmed.starts_with('-') || !trimmed.starts_with("  ") {
                    // 离开 agent-default-model 块
                    break;
                }
                if trimmed.starts_with("provider:") {
                    let val = trimmed.trim_start_matches("provider:").trim();
                    // 只接受 deepseek-official 或 st（这两个 provider 已注册）
                    if val != "deepseek-official" && val != "st" {
                        // 修复 provider
                        let indent = line.len() - line.trim_start().len();
                        lines[i] = format!("{}provider: deepseek-official", " ".repeat(indent));
                        modified = true;
                    }
                }
                if trimmed.starts_with("model:") {
                    let val = trimmed.trim_start_matches("model:").trim().trim_matches('"');
                    // 只接受 deepseek-official 下存在的模型名
                    if val != "deepseek-v4-flash" && val != "deepseek-v4-pro" {
                        let indent = line.len() - line.trim_start().len();
                        lines[i] = format!("{}model: deepseek-v4-flash", " ".repeat(indent));
                        modified = true;
                    }
                }
            }
        }

        if !has_default {
            // 没有 agent-default-model 块，追加一个
            lines.push(String::new());
            lines.push("agent-default-model:".to_string());
            lines.push("  provider: deepseek-official".to_string());
            lines.push("  model: deepseek-v4-flash".to_string());
            modified = true;
        }

        if modified {
            let new_content = lines.join("\n");
            if let Err(e) = fs::write(&settings_path, &new_content) {
                tracing::warn!(
                    "[DshEngine] 修复 settings.yaml 失败: {}",
                    e
                );
            } else {
                tracing::info!(
                    "[DshEngine] 已修复 settings.yaml 的 agent-default-model（回退到 deepseek-official + deepseek-v4-flash）"
                );
            }
        }
    }

    // ========================================================================
    // HTTP RPC 客户端
    // ========================================================================

    /// 调用 dsh HTTP RPC 方法
    ///
    /// 卸载到独立线程执行 blocking reqwest，避免在 async 上下文中 drop
    /// reqwest blocking client 导致 Tokio runtime panic。
    fn rpc_call(&self, method: &str, payload: Value) -> Result<Value> {
        let guard = self.dsh_base_url.lock().unwrap();
        let base_url = guard.as_ref().ok_or_else(|| {
            AppError::ProcessError("dsh 服务器未启动".to_string())
        })?;
        let base_url_str = base_url.clone();
        drop(guard);

        // method: &str 不能逃出方法体进子线程，预先 clone 为 String
        let method_str = method.to_string();
        let url = format!("{}/api/{}", base_url_str, method_str);
        let body = json!({
            "type": "client-request",
            "rpcId": format!("polaris-{}", uuid::Uuid::new_v4().simple()),
            "method": method_str,
            "payload": payload,
        }).to_string();
        let method_str_closure = method_str.clone();

        // 在独立线程中执行 blocking HTTP 调用
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = (|| -> Result<Value> {
                let resp = reqwest::blocking::Client::new()
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .body(body)
                    .timeout(Duration::from_secs(60))
                    .send()
                    .map_err(|e| AppError::ProcessError(format!("RPC {} 请求失败: {}", method_str_closure, e)))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let resp_body = resp.text().unwrap_or_default();
                    return Err(AppError::ProcessError(format!(
                        "RPC {} 返回 HTTP {}: {}",
                        method_str_closure, status, resp_body
                    )));
                }

                let envelope: Value = resp
                    .json()
                    .map_err(|e| AppError::ProcessError(format!("RPC {} 响应解析失败: {}", method_str_closure, e)))?;

                let result = envelope
                    .get("result")
                    .ok_or_else(|| AppError::ProcessError(format!("RPC {} 响应缺少 result", method_str_closure)))?;

                if let Some(error) = result.get("error") {
                    let code = error
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let message = error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    return Err(AppError::ProcessError(format!(
                        "RPC {} 业务错误: {}: {}",
                        method_str_closure, code, message
                    )));
                }

                Ok(result
                    .get("value")
                    .cloned()
                    .unwrap_or_else(|| json!(null)))
            })();
            let _ = tx.send(result);
        });

        rx.recv()
            .map_err(|e| AppError::ProcessError(format!("RPC {} 线程通信失败: {}", method_str, e)))?
    }

    // ========================================================================
    // WebSocket 事件读取
    // ========================================================================

    /// 启动 WebSocket 事件读取线程
    ///
    /// 从 dsh 的 events.mux 流接收所有事件帧，翻译为 Polaris AIEvent。
    ///
    /// Tokio handle 延迟到此处捕获（`DshEngine::new()` 在 Tauri 同步初始化阶段调用，
    /// 此时不在 tokio runtime 上下文中；本方法被 `start_session` 调用，此时已在 tokio worker 上）。
    fn spawn_event_reader(
        &self,
        base_url: String,
        session_id: String,
        dsh_session_id: String,
        event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) -> Result<()> {
        let ws_url = base_url
            .replace("http://", "ws://")
            .replace("https://", "wss://")
            .trim_end_matches('/')
            .to_string();
        let ws_url = format!("{}/api/events.mux", ws_url);

        // 延迟捕获 Tokio handle（lazy init）
        let mut handle_guard = self.tokio_handle.lock().unwrap();
        if handle_guard.is_none() {
            tracing::debug!(
                "[DshEngine] 首次捕获 Tokio runtime handle (lazy init)"
            );
            let handle = Handle::try_current().map_err(|e| {
                AppError::ProcessError(
                    format!("Tokio runtime 不可用: {}", e)
                )
            })?;
            *handle_guard = Some(handle.clone());
        }
        let handle = handle_guard.as_ref().unwrap().clone();

        // 复制需要的数据到闭包
        let session_id_clone = session_id.clone();
        let dsh_session_id_clone = dsh_session_id.clone();
        let call_id_maps = self.call_id_maps.clone();

        handle.spawn(async move {
            tracing::info!("[DshEngine] 启动 WebSocket 事件读取器: {}", ws_url);

            let mut connected = true;
            while connected {
                let (ws_stream, _resp) = match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok(ws) => ws,
                    Err(e) => {
                        tracing::warn!("[DshEngine] WebSocket 连接失败: {}，5s 后重试", e);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };

                tracing::info!("[DshEngine] WebSocket 已连接: {}", ws_url);

                let mut turn_ended = false;

                // 使用 write half 保持连接（Ping/pong 由 tokio-tungstenite 自动处理）
                let (_write, read) = ws_stream.split();

                use futures_util::StreamExt;

                let mut stream = read;
                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(WsMessage::Text(text)) => {
                            let frame: Value = match serde_json::from_str(&text) {
                                Ok(v) => v,
                                Err(e) => {
                                    tracing::debug!(
                                        "[DshEngine] WebSocket 帧解析失败: {}",
                                        e
                                    );
                                    continue;
                                }
                            };

                            // 调试：日志所有帧（首版开发期间保留，后续可降级为 trace）
                            tracing::debug!(
                                "[DshEngine] WebSocket 帧: {}",
                                text.chars().take(300).collect::<String>()
                            );

                            let payload = frame.get("payload");
                            if payload.is_none() {
                                continue;
                            }
                            let payload = payload.unwrap();

                            // 多会话隔离：mux 流包含所有会话的事件，只处理本会话的事件
                            let frame_session_id = payload
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !frame_session_id.is_empty()
                                && frame_session_id != dsh_session_id_clone
                            {
                                // 不是本会话的事件，跳过
                                continue;
                            }

                            let event_type = payload
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");

                            match event_type {
                                "session/event" => {
                                    Self::handle_session_event(
                                        &session_id_clone,
                                        payload,
                                        &event_callback,
                                        &call_id_maps,
                                    );
                                }
                                "approval/requested" => {
                                    Self::handle_approval(
                                        &session_id_clone,
                                        payload,
                                        &event_callback,
                                    );
                                }
                                "question/requested" => {
                                    Self::handle_question(
                                        &session_id_clone,
                                        payload,
                                        &event_callback,
                                    );
                                }
                                "session/projection" => {
                                    Self::handle_projection(
                                        &session_id_clone,
                                        payload,
                                        &event_callback,
                                    );
                                }
                                "session/queue" => {
                                    // 排队状态变更，无需前端事件
                                }
                                "stream/error" => {
                                    let error = payload
                                        .get("error")
                                        .and_then(|e| e.get("message"))
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("unknown stream error");
                                    event_callback(AIEvent::error(
                                        &session_id_clone,
                                        format!("dsh stream error: {}", error),
                                    ));
                                    connected = false;
                                    break;
                                }
                                _ => {
                                    tracing::debug!(
                                        "[DshEngine] 未知事件类型: {}",
                                        event_type
                                    );
                                }
                            }

                            // turn/end 后如果没有 pending 的 tool calls，发送 session_end
                            if event_type == "session/event" {
                                let inner_type = payload
                                    .get("event")
                                    .and_then(|e| e.get("type"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("");
                                if inner_type == "turn/end" && !turn_ended {
                                    turn_ended = true;
                                    event_callback(AIEvent::session_end(&session_id_clone));
                                }
                            }
                        }
                        Ok(WsMessage::Close(_)) => {
                            tracing::info!("[DshEngine] WebSocket 连接关闭");
                            connected = false;
                            break;
                        }
                        Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) => {}
                        Err(e) => {
                            tracing::warn!(
                                "[DshEngine] WebSocket 读取错误: {}，尝试重连",
                                e
                            );
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            break;
                        }
                        _ => {}
                    }
                }

            }

            tracing::info!(
                "[DshEngine] WebSocket 事件读取器退出: session={}",
                session_id
            );
        });

        Ok(())
    }

    /// 处理 session/event 帧
    fn handle_session_event(
        session_id: &str,
        payload: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
        call_id_maps: &Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    ) {
        let event = match payload.get("event") {
            Some(e) => e,
            None => return,
        };

        let event_type = event
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match event_type {
            "assistant/chunk" => {
                Self::handle_assistant_chunk(session_id, event, event_callback);
            }
            "assistant/message" => {
                Self::handle_assistant_message(session_id, event, event_callback);
            }
            "user/message" => {
                Self::handle_user_message(session_id, event, event_callback);
            }
            "tool/call" => {
                Self::handle_tool_call(session_id, event, event_callback, call_id_maps);
            }
            "tool/result" => {
                Self::handle_tool_result(session_id, event, event_callback, call_id_maps);
            }
            "turn/start" => {
                event_callback(AIEvent::progress(
                    session_id,
                    "turn started",
                ));
            }
            "turn/end" => {
                // session_end 在 spawn_event_reader 中统一发出
            }
            "step/start" | "step/end" => {
                // 内部步骤边界，无需前端事件
            }
            "compaction/start" => {
                event_callback(AIEvent::progress(
                    session_id,
                    "context compaction started",
                ));
            }
            "compaction/end" | "compaction/summary" => {
                event_callback(AIEvent::progress(
                    session_id,
                    "context compaction completed",
                ));
            }
            "agent/inbox/spliced" => {
                // 收件箱变更，内部事件
            }
            _ => {
                tracing::debug!(
                    "[DshEngine] 未处理的 session/event 类型: {}",
                    event_type
                );
            }
        }
    }

    /// 处理 assistant/chunk 事件（流式输出）
    ///
    /// dsh 实际 chunk 类型（2026-08-13 实测）：
    ///   "reasoning-delta" → 思考过程增量，text 字段携带增量文本
    ///   "text-delta"      → 可见文本增量，text 字段携带增量文本
    ///   "block-start"     → 块边界开始（无文本，blockType=reasoning|text）
    ///   "block-end"       → 块边界结束（block.text 含完整内容，非增量）
    ///   "usage"           → 流末 token 用量（chunk.usage.inputTokens/outputTokens）
    ///   "finish"          → 流完成（reason.kind=stop|length|error）
    fn handle_assistant_chunk(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = match event.get("data") {
            Some(d) => d,
            None => return,
        };
        let chunk = match data.get("chunk") {
            Some(c) => c,
            None => return,
        };

        let chunk_type = chunk
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match chunk_type {
            "text-delta" => {
                if let Some(text) = chunk.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        event_callback(AIEvent::token(session_id, text));
                    }
                }
            }
            "reasoning-delta" => {
                if let Some(text) = chunk.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        event_callback(AIEvent::thinking(session_id, text));
                    }
                }
            }
            "usage" => {
                // 流末 token 用量（也可从 assistant/message.data.usage 获取）
                if let Some(usage) = chunk.get("usage") {
                    let input = usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let output = usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    if input > 0 || output > 0 {
                        event_callback(AIEvent::usage(session_id, input, None, None, output, None, None));
                    }
                }
            }
            "finish" => {
                // 流完成标记，无文本
                let reason = chunk
                    .get("reason")
                    .and_then(|r| r.get("kind"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                tracing::trace!(
                    "[DshEngine] assistant/chunk finish: reason={}",
                    reason
                );
            }
            "block-start" | "block-end" => {
                // 块边界标记，无增量文本
                tracing::trace!(
                    "[DshEngine] assistant/chunk {}",
                    chunk_type
                );
            }
            _ => {
                tracing::debug!(
                    "[DshEngine] 未处理的 assistant/chunk 类型: {}",
                    chunk_type
                );
            }
        }
    }

    /// 处理 assistant/message 事件（完整消息）
    ///
    /// 注意：文本内容已通过 assistant/chunk 的 text-delta 事件逐 Token 发送，
    /// 此处不再重复发送 AssistantMessage，否则前端会重复渲染。
    /// 只提取 Token 用量信息。
    fn handle_assistant_message(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = match event.get("data") {
            Some(d) => d,
            None => return,
        };

        // 仅提取 Token 用量（文本已通过 chunk 流式发送）
        if let Some(usage) = data.get("usage") {
            let input_tokens = usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output_tokens = usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            if input_tokens > 0 || output_tokens > 0 {
                event_callback(AIEvent::usage(
                    session_id,
                    input_tokens,
                    None,
                    None,
                    output_tokens,
                    None,
                    None,
                ));
            }
        }
    }

    /// 处理 user/message 事件（dsh 回显用户消息，前端已知道内容，跳过避免重复）
    fn handle_user_message(
        _session_id: &str,
        _event: &Value,
        _event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        // dsh 的 mux 流会回显 user/message 事件，但消息已由 Polaris 前端发送，
        // 重复发送 AIEvent::UserMessage 会导致前端重复渲染，故跳过。
    }

    /// 处理 tool/call 事件
    ///
    /// 实测 dsh 格式（2026-08-13）：
    /// ```json
    /// { "data": { "callId": "call_00_xxx", "name": "pwsh",
    ///             "arguments": "{\"command\":\"echo\"}" } }
    /// ```
    /// - `name` 是工具名（非 `toolName`）
    /// - `callId` 是调用 ID
    /// - `arguments` 是 JSON 字符串，需要 serde_json::from_str 解析
    fn handle_tool_call(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
        call_id_maps: &Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    ) {
        let data = match event.get("data") {
            Some(d) => d,
            None => return,
        };

        let tool_name = data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let call_id = data
            .get("callId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 写入 callId → toolName 映射（per-session 隔离，供 tool/result 使用）
        if !call_id.is_empty() && !tool_name.is_empty() && !tool_name.eq("unknown") {
            if let Ok(mut maps) = call_id_maps.lock() {
                let session_map = maps.entry(session_id.to_string()).or_default();
                session_map.insert(call_id.clone(), tool_name.clone());
            }
        }

        // arguments 是 JSON 字符串，需解析为 HashMap
        let mut args = HashMap::new();
        if let Some(raw_args) = data.get("arguments").and_then(|v| v.as_str()) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_args) {
                if let Some(obj) = parsed.as_object() {
                    for (k, v) in obj {
                        args.insert(k.clone(), v.clone());
                    }
                }
            }
        }

        tracing::debug!(
            "[DshEngine] tool/call: tool={} callId={} args={}",
            tool_name, call_id, serde_json::to_string(&args).unwrap_or_default()
        );
        event_callback(AIEvent::tool_call_start(session_id, tool_name, args));
    }

    /// 处理 tool/result 事件
    ///
    /// 实测 dsh 格式（2026-08-13）：
    /// ```json
    /// { "data": { "message": { "content": [{
    ///     "type": "tool-result", "toolCallId": "call_00_xxx",
    ///     "content": [{"type": "text", "text": "output"}],
    ///     "isError": false
    /// }] } } }
    /// ```
    /// - isError 在 `message.content[0].isError`
    /// - toolCallId 在 `message.content[0].toolCallId`
    /// - tool name 从 `call_id_map` 查询（tool/call 时已写入）
    fn handle_tool_result(
        session_id: &str,
        _event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
        call_id_maps: &Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    ) {
        // 从 data.message.content[0] 提取工具结果
        let data = match _event.get("data") {
            Some(d) => d,
            None => return,
        };
        let message = match data.get("message") {
            Some(m) => m,
            None => return,
        };
        let content = match message.get("content").and_then(|c| c.as_array()) {
            Some(arr) => arr,
            None => return,
        };

        // 取第一个 tool-result block
        let tool_result_block = content.iter().find(|b| {
            b.get("type").and_then(|v| v.as_str()) == Some("tool-result")
        });
        let (tool_call_id, is_error) = match tool_result_block {
            Some(block) => {
                let tid = block
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let err = block
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                (tid, err)
            }
            None => {
                // 回退到外层 source.callId
                let tid = message
                    .get("source")
                    .and_then(|s| s.get("callId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                (tid, false)
            }
        };

        // 从 per-session call_id_maps 查询工具名
        let tool_name = call_id_maps.lock()
            .ok()
            .and_then(|maps| {
                maps.get(session_id)
                    .and_then(|session_map| session_map.get(&tool_call_id).cloned())
            })
            .unwrap_or_else(|| {
                if tool_call_id.len() > 8 {
                    tool_call_id[..8].to_string()
                } else {
                    "tool".to_string()
                }
            });

        tracing::debug!(
            "[DshEngine] tool/result: tool={} callId={} isError={}",
            tool_name, tool_call_id, is_error
        );
        event_callback(AIEvent::tool_call_end(session_id, tool_name, !is_error));
    }

    /// 处理 approval/requested 事件
    fn handle_approval(
        session_id: &str,
        _payload: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let tool_name = _payload
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let reason = _payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        event_callback(AIEvent::progress(
            session_id,
            format!("approval requested for {}: {}", tool_name, reason),
        ));
    }

    /// 处理 question/requested 事件
    fn handle_question(
        session_id: &str,
        _payload: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        event_callback(AIEvent::progress(
            session_id,
            "agent is asking a question",
        ));
    }

    /// 处理 session/projection 事件
    fn handle_projection(
        session_id: &str,
        payload: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let key = payload
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if key == "sessionStats" {
            let value = payload.get("value");
            if let Some(stats) = value {
                let turns = stats
                    .get("turns")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let steps = stats
                    .get("steps")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if turns > 0 || steps > 0 {
                    event_callback(AIEvent::progress(
                        session_id,
                        format!("stats: {} turns, {} steps", turns, steps),
                    ));
                }
            }
        }
        // contextPressure / contextBreakdown 等投影暂不翻译
    }
}

// ========================================================================
// AIEngine Trait 实现
// ========================================================================

impl AIEngine for DshEngine {
    fn id(&self) -> EngineId {
        EngineId::Custom("dsh".to_string())
    }

    fn name(&self) -> &'static str {
        self.leaked_name
    }

    fn description(&self) -> &'static str {
        self.leaked_description
    }

    fn metadata(&self) -> EngineMetadata {
        let caps = EngineCapabilities {
            tools: true,
            image_input: true,
            streaming: true,
            interrupt: true,
            resume: true,
            stdin_input: false,
            fork_session: true,
        };
        EngineMetadata {
            id: self.id(),
            name: "DeepSeek Harness".to_string(),
            description: Some(
                "DeepSeek Harness — 开源 Agent 编排框架。通过 HTTP RPC + WebSocket 事件流与 Polaris 通信，支持流式输出、工具调用、多轮对话、中断、子 agent 委派。"
                    .to_string(),
            ),
            distribution: EngineDistribution::CustomPath {
                path: "dsh".to_string(),
                available: self.is_available(),
            },
            capabilities: caps,
            env_keys: EnvKeyMapping {
                base_url: "DSH_BASE_URL",
                api_key: "DEEPSEEK_API_KEY",
                model: "DSH_MODEL",
            },
            supports_model_provider: true,
            install_guide: Some(
                "通过 npm 全局安装: npm install -g @deepseek-ai/dsh"
                    .to_string(),
            ),
            npm_package: Some("@deepseek-ai/dsh".to_string()),
            install_url: None,
        }
    }

    fn is_available(&self) -> bool {
        // 直接用静态命令名检查 PATH（避免 &mut self 借用冲突）
        let cmd = "dsh";
        if Path::new(cmd).exists() {
            return true;
        }
        #[cfg(windows)]
        {
            let candidates = [
                std::env::var("APPDATA").ok().map(|d| {
                    std::path::PathBuf::from(&d).join("npm").join("dsh.cmd")
                }),
                std::env::var("LOCALAPPDATA").ok().map(|d| {
                    std::path::PathBuf::from(&d).join("pnpm").join("dsh.cmd")
                }),
                std::env::var("USERPROFILE").ok().map(|d| {
                    std::path::PathBuf::from(&d)
                        .join(".bun")
                        .join("bin")
                        .join("dsh.exe")
                }),
            ];
            for candidate in candidates.into_iter().flatten() {
                if candidate.exists() {
                    return true;
                }
            }
        }
        let which_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut check = Command::new(which_cmd);
        check.arg(cmd);
        #[cfg(windows)]
        check.creation_flags(CREATE_NO_WINDOW);
        check.output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn unavailable_reason(&self) -> Option<String> {
        if !self.is_available() {
            Some(
                "DeepSeek Harness 未安装。安装方式: npm install -g @deepseek-ai/dsh"
                    .to_string(),
            )
        } else {
            None
        }
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        let engine_id = self.id().to_string();
        tracing::info!(
            "[DshEngine] 启动会话, message_len={}",
            message.len()
        );

        if !self.is_available() {
            return Err(AppError::ProcessError("DeepSeek Harness CLI 不可用".to_string()));
        }

        // 确保 dsh 服务器已启动
        let base_url = self.ensure_dsh_server()?;

        // 创建 dsh 会话
        let cwd = options
            .work_dir
            .clone()
            .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default());

        let create_result = self.rpc_call("session.create", json!({
            "cwd": cwd,
        }))?;

        let dsh_session_id = create_result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AppError::ProcessError(format!(
                    "session.create 响应缺少 sessionId: {}",
                    create_result
                ))
            })?
            .to_string();

        tracing::info!(
            "[DshEngine] 已创建 dsh 会话: dsh_session={}",
            dsh_session_id
        );

        // 不切换模型：dsh 的 settings.yaml 已通过 Polaris 环境正确配置了
        // 默认 provider 和模型（agent-default-model: provider=st, model=deepseek-v4-flash）。
        // Polaris 的 pi_provider_config.name 是内部 Profile 标识符（如
        // "polaris-profile_xxx"），不是 dsh 的 provider 名，传递无效。
        // 让 dsh 使用其默认模型即可，无需 session.selectModel。
        tracing::debug!(
            "[DshEngine] 使用 dsh 默认模型（settings.yaml 已配置），跳过 session.selectModel"
        );

        // 生成 Polaris session_id
        let polaris_session_id = uuid::Uuid::new_v4().to_string();

        // 建立映射
        {
            let mut map = self.session_map.lock().unwrap();
            map.insert(polaris_session_id.clone(), dsh_session_id.clone());
        }

        // 启动 WebSocket 事件读取器（必须成功，否则会话无法接收回复）
        let event_callback = options.event_callback.clone();
        self.spawn_event_reader(base_url.clone(), polaris_session_id.clone(), dsh_session_id.clone(), event_callback)?;

        // 等待 WebSocket 连接就绪
        std::thread::sleep(Duration::from_millis(1000));

        // 发送初始消息
        self.send_prompt(&dsh_session_id, message, &polaris_session_id)?;

        // 注册到 SessionManager
        self.sessions.register(
            polaris_session_id.clone(),
            0, // PID 不适用（dsh 是 HTTP 服务）
            engine_id,
        )?;

        // 发送 session_start 事件
        (options.event_callback)(AIEvent::session_start_with_engine(
            &polaris_session_id,
            "dsh",
        ));

        Ok(polaris_session_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!(
            "[DshEngine] 继续会话: polaris_session={}",
            session_id
        );

        // 查找对应的 dsh session_id
        let dsh_session_id = {
            let map = self.session_map.lock().unwrap();
            map.get(session_id)
                .cloned()
                .ok_or_else(|| AppError::ProcessError(format!(
                    "未找到会话 {} 对应的 dsh session",
                    session_id
                )))?
        };

        // 确保 dsh 服务器已启动
        let _base_url = self.ensure_dsh_server()?;

        // 重新连接 WebSocket 事件读取器（必须成功）
        let base_url = self.dsh_base_url.lock().unwrap().clone()
            .ok_or_else(|| AppError::ProcessError("dsh 服务器未启动（续聊时）".to_string()))?;
        let event_callback = options.event_callback.clone();
        self.spawn_event_reader(base_url, session_id.to_string(), dsh_session_id.clone(), event_callback)?;
        std::thread::sleep(Duration::from_millis(1000));

        // 发送续聊消息
        self.send_prompt(&dsh_session_id, message, session_id)?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!(
            "[DshEngine] 中断会话: polaris_session={}",
            session_id
        );

        let dsh_session_id = {
            let map = self.session_map.lock().unwrap();
            map.get(session_id).cloned()
        };

        match dsh_session_id {
            Some(sid) => {
                let _ = self.rpc_call("session.cancel", json!({
                    "sessionId": sid,
                }));
                Ok(())
            }
            None => Err(AppError::ProcessError(format!(
                "未找到会话 {} 对应的 dsh session",
                session_id
            ))),
        }
    }

    fn send_input(&mut self, _session_id: &str, _input: &str) -> Result<bool> {
        // dsh 不支持通过 stdin 发送输入，使用 session.prompt
        Ok(false)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }
}

// ========================================================================
// 消息发送辅助
// ========================================================================

impl DshEngine {
    /// 向 dsh 会话发送消息
    fn send_prompt(
        &self,
        dsh_session_id: &str,
        message: &str,
        _polaris_session_id: &str,
    ) -> Result<()> {
        tracing::info!(
            "[DshEngine] 发送消息到 dsh 会话: dsh_session={}, message_len={}",
            dsh_session_id,
            message.len()
        );

        // 构建 PromptContentPart[]
        let content: Vec<Value> = vec![json!({
            "type": "text",
            "text": message,
        })];

        let prompt_payload = json!({
            "sessionId": dsh_session_id,
            "mode": "queue",
            "content": content,
        });

        let result = self.rpc_call("session.prompt", prompt_payload)?;
        tracing::debug!("[DshEngine] session.prompt 响应: {}", result);

        if result
            .get("accepted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(AppError::ProcessError(format!(
                "session.prompt 未被接受: {}",
                result
            )))
        }
    }
}