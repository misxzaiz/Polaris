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
use std::io::{BufRead, BufReader};
use std::path::Path;
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
        // 如果已经在运行，直接返回
        if let Some(url) = self.dsh_base_url.lock().unwrap().as_ref() {
            if self.dsh_running.load(Ordering::SeqCst) {
                return Ok(url.clone());
            }
        }

        // 检查子进程是否还活着
        if let Some(ref mut child) = self.dsh_child {
            if let Ok(None) = child.try_wait() {
                // 还在运行
                if let Some(url) = self.dsh_base_url.lock().unwrap().as_ref() {
                    self.dsh_running.store(true, Ordering::SeqCst);
                    return Ok(url.clone());
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
        rx.recv()
            .map_err(|e| AppError::ProcessError(format!("ready 线程通信失败: {}", e)))?
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

                            let payload = frame.get("payload");
                            if payload.is_none() {
                                continue;
                            }
                            let payload = payload.unwrap();

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
    ) {
        let event = payload.get("event");
        if event.is_none() {
            return;
        }
        let event = event.unwrap();

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
                Self::handle_tool_call(session_id, event, event_callback);
            }
            "tool/result" => {
                Self::handle_tool_result(session_id, event, event_callback);
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
    fn handle_assistant_chunk(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = event.get("data");
        if data.is_none() {
            return;
        }
        let data = data.unwrap();
        let chunk = data.get("chunk");
        if chunk.is_none() {
            return;
        }
        let chunk = chunk.unwrap();

        let chunk_type = chunk
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let block_type = chunk
            .get("blockType")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match chunk_type {
            "delta" => {
                match block_type {
                    "text" => {
                        let text = chunk
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !text.is_empty() {
                            event_callback(AIEvent::token(session_id, text));
                        }
                    }
                    "reasoning" => {
                        let text = chunk
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !text.is_empty() {
                            event_callback(AIEvent::thinking(session_id, text));
                        }
                    }
                    _ => {}
                }
            }
            "block-start" | "block-end" => {
                // 块边界标记，无需前端事件
                tracing::trace!(
                    "[DshEngine] assistant/chunk {}: blockType={}",
                    chunk_type,
                    block_type
                );
            }
            _ => {}
        }
    }

    /// 处理 assistant/message 事件（完整消息）
    fn handle_assistant_message(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = event.get("data");
        if data.is_none() {
            return;
        }
        let data = data.unwrap();

        // 提取文本内容
        let message = data.get("message");
        if let Some(msg) = message {
            let content = msg.get("content");
            if let Some(content) = content {
                let mut text_parts = Vec::new();
                if let Some(arr) = content.as_array() {
                    for block in arr {
                        let block_type = block
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if block_type == "text" {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    text_parts.push(text.to_string());
                                }
                            }
                        }
                    }
                }
                let full_text = text_parts.join("");
                if !full_text.is_empty() {
                    // 流式已经在 chunk 中发送了，这里发送完整的 AssistantMessage（is_delta=false）
                    event_callback(AIEvent::assistant_message(
                        session_id,
                        full_text,
                        false,
                    ));
                }
            }
        }

        // Token 用量
        let usage = data.get("usage");
        if let Some(usage) = usage {
            let input_tokens = usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output_tokens = usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
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

    /// 处理 user/message 事件
    fn handle_user_message(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = event.get("data");
        if data.is_none() {
            return;
        }
        let data = data.unwrap();
        let content = data.get("content");
        if let Some(content) = content {
            let mut text_parts = Vec::new();
            if let Some(arr) = content.as_array() {
                for block in arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            text_parts.push(text.to_string());
                        }
                    }
                }
            }
            let full_text = text_parts.join("");
            if !full_text.is_empty() {
                event_callback(AIEvent::user_message(session_id, full_text));
            }
        }
    }

    /// 处理 tool/call 事件
    fn handle_tool_call(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = event.get("data");
        if data.is_none() {
            return;
        }
        let data = data.unwrap();

        let tool_name = data
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let call_id = data
            .get("callId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let mut args = HashMap::new();
        if let Some(raw_args) = data.get("args") {
            if let Some(obj) = raw_args.as_object() {
                for (k, v) in obj {
                    args.insert(k.clone(), v.clone());
                }
            }
        }

        tracing::debug!(
            "[DshEngine] tool/call: tool={} callId={}",
            tool_name, call_id
        );
        event_callback(AIEvent::tool_call_start(session_id, tool_name, args));
    }

    /// 处理 tool/result 事件
    fn handle_tool_result(
        session_id: &str,
        event: &Value,
        event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        let data = event.get("data");
        if data.is_none() {
            return;
        }
        let data = data.unwrap();

        let tool_name = data
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let is_error = data
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

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

        // 如果有模型选择，切换模型
        if let Some(model) = &options.model {
            // 需要从 llm.models 获取 provider，这里用默认的 deepseek-official
            // 首版用 deepseek-official provider
            let _ = self.rpc_call("session.selectModel", json!({
                "sessionId": dsh_session_id,
                "provider": "deepseek-official",
                "model": model,
            }));
            tracing::debug!(
                "[DshEngine] 尝试切换模型: provider=deepseek-official model={}",
                model
            );
        }

        // 生成 Polaris session_id
        let polaris_session_id = uuid::Uuid::new_v4().to_string();

        // 建立映射
        {
            let mut map = self.session_map.lock().unwrap();
            map.insert(polaris_session_id.clone(), dsh_session_id.clone());
        }

        // 启动 WebSocket 事件读取器（必须成功，否则会话无法接收回复）
        let event_callback = options.event_callback.clone();
        self.spawn_event_reader(base_url.clone(), polaris_session_id.clone(), event_callback)?;

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
        let base_url = self.dsh_base_url.lock().unwrap().as_ref().unwrap().clone();
        let event_callback = options.event_callback.clone();
        self.spawn_event_reader(base_url, session_id.to_string(), event_callback)?;
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