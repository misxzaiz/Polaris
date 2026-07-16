//! Ask User Question — TCP Listener
//!
//! Bound on 127.0.0.1:0 at startup. The `polaris-ask-mcp` companion process
//! connects here when Claude CLI invokes `ask_user_question`; this listener:
//!
//!   1. Reads the `ask` frame (length-prefixed JSON)
//!   2. Registers a `PendingQuestionEntry { answer_tx, … }` in AppState
//!   3. Emits a `question` chat-event so the UI renders the card
//!   4. Awaits the oneshot from `answer_question` Tauri command / HTTP handler
//!   5. Writes the `answer` frame back to the companion → CLI tool_result
//!
//! See `services::ask_mcp_server` for the client side and the frame protocol.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::state::{
    AppState, DispatchedTask, PendingPluginCard, PendingQuestion, PluginCardStatus, QuestionItem,
    QuestionOption, QuestionStatus, SubAnswer,
};

/// Maximum frame size we accept on the wire. Browser diagnostics may include
/// a clipped PNG screenshot, so this is larger than the original ask-only cap.
const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
const PLUGIN_CARD_TIMEOUT: Duration = Duration::from_secs(180);
/// 派发深度上限：普通会话派发为 1，派发会话再派发为 2，2 层封顶（防循环派发）。
const MAX_DISPATCH_DEPTH: u32 = 2;
/// 同时处于 pending/running 的派发任务上限（防 AI 一次派发把机器打满）。
const MAX_ACTIVE_DISPATCHES: usize = 3;

/// Final answer payload that goes back to the companion → CLI tool_result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOutcome {
    /// Frame type discriminator on the wire.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// True when the user dismissed without answering.
    pub declined: bool,
    /// Per-question answer, ordered the same as the input questions.
    pub answers: Vec<QuestionAnswerPayload>,
}

impl QuestionOutcome {
    pub fn answer(answers: Vec<QuestionAnswerPayload>) -> Self {
        Self {
            kind: "answer",
            declined: false,
            answers,
        }
    }

    pub fn declined() -> Self {
        Self {
            kind: "answer",
            declined: true,
            answers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerPayload {
    pub question: String,
    pub header: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

/// Final answer payload that goes back to a plugin MCP server waiting for an
/// interaction card response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCardOutcome {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub declined: bool,
    pub result: Value,
}

impl PluginCardOutcome {
    pub fn answer(result: Value) -> Self {
        Self {
            kind: "card_answer",
            declined: false,
            result,
        }
    }

    pub fn declined() -> Self {
        Self {
            kind: "card_answer",
            declined: true,
            result: Value::Null,
        }
    }
}

/// Handle returned by [`spawn_ask_listener`]; carries the bound port + auth
/// token that must be injected as args to the `polaris-ask-mcp` companion.
#[derive(Debug, Clone)]
pub struct AskListenerHandle {
    pub port: u16,
    pub token: String,
}

/// Bind a TCP socket on 127.0.0.1:0 and spawn the accept loop.
///
/// The loop runs for the app's lifetime — no graceful-shutdown signal is
/// wired here because connections are short-lived (one request/response per
/// connection) and Tokio drops the task at process exit.
pub async fn spawn_ask_listener(state: Arc<AppState>) -> Result<AskListenerHandle> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::ProcessError(format!("ask_listener bind 失败: {}", e)))?;
    let local = listener
        .local_addr()
        .map_err(|e| AppError::ProcessError(format!("ask_listener local_addr: {}", e)))?;
    let port = local.port();
    let token = Uuid::new_v4().to_string();

    tracing::info!("[AskListener] 绑定 127.0.0.1:{}", port);

    let token_for_loop = token.clone();
    tokio::spawn(async move {
        accept_loop(listener, state, token_for_loop).await;
    });

    Ok(AskListenerHandle { port, token })
}

async fn accept_loop(listener: TcpListener, state: Arc<AppState>, expected_token: String) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!("[AskListener] accept 失败: {}", error);
                continue;
            }
        };
        tracing::debug!("[AskListener] 接受连接 {}", peer);

        let state = state.clone();
        let expected_token = expected_token.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, state, expected_token).await {
                tracing::warn!("[AskListener] 连接处理失败: {}", error);
            }
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    state: Arc<AppState>,
    expected_token: String,
) -> Result<()> {
    let frame = read_frame(&mut stream).await?;
    let kind = frame
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "ask" => handle_ask_frame(&mut stream, frame, state, &expected_token).await,
        "card" => handle_card_frame(&mut stream, frame, state, &expected_token).await,
        #[cfg(feature = "tauri-app")]
        "browser" => handle_browser_frame(&mut stream, frame, &expected_token).await,
        #[cfg(not(feature = "tauri-app"))]
        "browser" => Err(AppError::ValidationError(
            "browser 帧需要 tauri-app 功能".into(),
        )),
        "cancel" => {
            // Cancel frames arrive when the CLI sends notifications/cancelled
            // to the companion. We simply remove any matching pending entry
            // so the awaiting oneshot is dropped (sending will error and the
            // companion returns a declined outcome).
            handle_cancel_frame(frame, state, &expected_token);
            Ok(())
        }
        "card_cancel" => {
            handle_card_cancel_frame(frame, state, &expected_token);
            Ok(())
        }
        "dispatch" => handle_dispatch_frame(&mut stream, frame, state, &expected_token).await,
        "dispatch_status" => {
            handle_dispatch_status_frame(&mut stream, frame, state, &expected_token).await
        }
        other => Err(AppError::ValidationError(format!("未知帧类型: {}", other))),
    }
}

async fn handle_ask_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    // Auth.
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return Err(AppError::ValidationError("ask 帧缺少 callId".into()));
    }

    let questions_value = frame.get("questions").cloned().unwrap_or_else(|| json!([]));
    let questions = parse_questions(&questions_value)?;
    if questions.is_empty() {
        return Err(AppError::ValidationError("ask 帧 questions 为空".into()));
    }

    // Register pending entry + oneshot.
    let (tx, rx) = oneshot::channel::<QuestionOutcome>();
    {
        let mut pending = state
            .pending_questions
            .lock()
            .map_err(|e| AppError::ProcessError(format!("pending_questions 锁: {}", e)))?;
        pending.insert(
            call_id.clone(),
            PendingQuestion {
                call_id: call_id.clone(),
                session_id: session_id.clone(),
                questions: questions.iter().map(parsed_to_item).collect(),
                status: QuestionStatus::Pending,
            },
        );
    }
    state.register_ask_answer_sender(&call_id, questions.clone(), tx);

    // Emit chat-event to render the UI card.
    emit_question_event(&state, &session_id, &call_id, &questions);

    // Block until the user answers (or oneshot is dropped → declined).
    let outcome = match rx.await {
        Ok(outcome) => outcome,
        Err(_recv_err) => {
            tracing::info!(
                "[AskListener] call_id={} oneshot 被丢弃，按 declined 处理",
                call_id
            );
            QuestionOutcome::declined()
        }
    };

    // Write answer frame back to companion.
    write_frame(stream, &serde_json::to_value(&outcome)?).await?;
    let _ = stream.shutdown().await;

    // Cleanup — answer_question handler may already have removed it.
    {
        if let Ok(mut pending) = state.pending_questions.lock() {
            pending.remove(&call_id);
        }
    }
    state.take_ask_answer_sender(&call_id);

    Ok(())
}

async fn handle_card_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let interaction_id = frame
        .get("interactionId")
        .or_else(|| frame.get("callId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let plugin_id = frame
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let card_id = frame
        .get("cardId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_name = frame
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);

    if plugin_id.trim().is_empty() {
        return Err(AppError::ValidationError("card 帧缺少 pluginId".into()));
    }
    if card_id.trim().is_empty() {
        return Err(AppError::ValidationError("card 帧缺少 cardId".into()));
    }

    let (tx, rx) = oneshot::channel::<PluginCardOutcome>();
    {
        let mut pending = state
            .pending_plugin_cards
            .lock()
            .map_err(|e| AppError::ProcessError(format!("pending_plugin_cards 锁: {}", e)))?;
        pending.insert(
            interaction_id.clone(),
            PendingPluginCard {
                interaction_id: interaction_id.clone(),
                session_id: session_id.clone(),
                call_id,
                plugin_id: plugin_id.clone(),
                card_id: card_id.clone(),
                tool_name: tool_name.clone(),
                payload: payload.clone(),
                status: PluginCardStatus::Pending,
            },
        );
    }
    state.register_plugin_card_answer_sender(&interaction_id, tx);

    emit_plugin_card_event(
        &state,
        &session_id,
        &interaction_id,
        &plugin_id,
        &card_id,
        &tool_name,
        payload,
    );

    let outcome = match tokio::time::timeout(PLUGIN_CARD_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_recv_err)) => {
            tracing::info!(
                "[AskListener] interaction_id={} oneshot 被丢弃，按 declined 处理",
                interaction_id
            );
            PluginCardOutcome::declined()
        }
        Err(_elapsed) => {
            tracing::info!(
                "[AskListener] interaction_id={} 超时，按 declined 处理",
                interaction_id
            );
            emit_plugin_card_answered_event(
                &state,
                &session_id,
                &interaction_id,
                true,
                Value::Null,
            );
            PluginCardOutcome::declined()
        }
    };

    write_frame(stream, &serde_json::to_value(&outcome)?).await?;
    let _ = stream.shutdown().await;

    if let Ok(mut pending) = state.pending_plugin_cards.lock() {
        pending.remove(&interaction_id);
    }
    state.take_plugin_card_answer_sender(&interaction_id);

    Ok(())
}

/// 解析来源会话的派发深度：`dispatch-{depth}-{id}` → depth，普通会话 → 0。
fn parse_dispatch_depth(source_session_id: &str) -> u32 {
    source_session_id
        .strip_prefix("dispatch-")
        .and_then(|rest| rest.split('-').next())
        .and_then(|seg| seg.parse::<u32>().ok())
        .unwrap_or(if source_session_id.starts_with("dispatch-") {
            1
        } else {
            0
        })
}

/// 处理 dispatch 帧：登记派发任务 → 通知前端创建后台会话执行 → 立即回 ack。
/// 派发是 fire-and-forget 的：本函数不等待任务执行，来源会话同回合继续。
async fn handle_dispatch_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let reply = build_dispatch_reply(&frame, &state);
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        // 通知前端执行（前端监听 dispatch-task-request，创建静默会话并 start_chat）
        emit_dispatch_request_event(&state, &reply, &frame);
    }

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 校验派发请求并登记任务记录，返回 ack/错误帧。不产生副作用以外的 IO。
fn build_dispatch_reply(frame: &Value, state: &AppState) -> Value {
    let prompt = frame
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if prompt.is_empty() {
        return dispatch_error_reply("dispatch 帧缺少 prompt");
    }

    let source_session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 深度限制：防止派发会话无限递归派发
    let depth = parse_dispatch_depth(&source_session_id) + 1;
    if depth > MAX_DISPATCH_DEPTH {
        return dispatch_error_reply(&format!(
            "派发深度已达上限（{}），当前会话不能再派发子任务",
            MAX_DISPATCH_DEPTH
        ));
    }

    // 并发限制：防止资源被并行引擎进程打满
    let active = state.active_dispatched_task_count();
    if active >= MAX_ACTIVE_DISPATCHES {
        return dispatch_error_reply(&format!(
            "已有 {} 个派发任务在执行（上限 {}），请等待现有任务完成后再派发，可用 check_dispatched_task 查询进度",
            active, MAX_ACTIVE_DISPATCHES
        ));
    }

    let dispatch_id = frame
        .get("dispatchId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let short_id: String = Uuid::new_v4().simple().to_string()[..8].to_string();
    let session_id = format!("dispatch-{}-{}", depth, short_id);

    let title = frame
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let mut t: String = prompt.chars().take(24).collect();
            if prompt.chars().count() > 24 {
                t.push('…');
            }
            t
        });

    let now = chrono::Utc::now().timestamp();
    let task = DispatchedTask {
        dispatch_id: dispatch_id.clone(),
        session_id: session_id.clone(),
        source_session_id,
        title,
        prompt: prompt.to_string(),
        work_dir: frame
            .get("workDir")
            .and_then(Value::as_str)
            .filter(|d| !d.trim().is_empty())
            .map(str::to_string),
        engine_id: frame
            .get("engineId")
            .and_then(Value::as_str)
            .filter(|e| !e.trim().is_empty())
            .map(str::to_string),
        depth,
        status: "pending".to_string(),
        summary: None,
        created_at: now,
        updated_at: now,
    };

    tracing::info!(
        "[AskListener] 派发任务登记: dispatch_id={}, session_id={}, depth={}, title={}",
        task.dispatch_id,
        task.session_id,
        task.depth,
        task.title
    );
    state.insert_dispatched_task(task);

    json!({
        "type": "dispatch_result",
        "ok": true,
        "dispatchId": dispatch_id,
        "sessionId": session_id,
        "note": "任务已派发到后台会话执行，当前会话不会被阻塞；可用 check_dispatched_task 查询进度",
    })
}

fn dispatch_error_reply(message: &str) -> Value {
    json!({
        "type": "dispatch_result",
        "ok": false,
        "error": message,
    })
}

/// 处理 dispatch_status 帧：查询派发任务状态并立即回帧。
async fn handle_dispatch_status_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let dispatch_id = frame
        .get("dispatchId")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let reply = match state.get_dispatched_task(dispatch_id) {
        Some(task) => json!({
            "type": "dispatch_status_result",
            "ok": true,
            "task": task,
        }),
        None => json!({
            "type": "dispatch_status_result",
            "ok": false,
            "error": format!("未找到派发任务: {}", dispatch_id),
        }),
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 向前端发出派发执行请求事件。
///
/// 单消费者语义（与 SchedulerDaemon 一致）：桌面模式只 emit Tauri 事件由桌面
/// 前端执行；无 AppHandle（web-only 模式）时才走 WebSocket 广播，避免桌面与
/// 远程 Web 客户端同时执行同一任务。
fn emit_dispatch_request_event(state: &AppState, reply: &Value, frame: &Value) {
    let payload = json!({
        "dispatchId": reply.get("dispatchId").cloned().unwrap_or(Value::Null),
        "sessionId": reply.get("sessionId").cloned().unwrap_or(Value::Null),
        "sourceSessionId": frame.get("sessionId").cloned().unwrap_or(Value::Null),
        "prompt": frame.get("prompt").cloned().unwrap_or(Value::Null),
        "title": frame.get("title").cloned().unwrap_or(Value::Null),
        "workDir": frame.get("workDir").cloned().unwrap_or(Value::Null),
        "engineId": frame.get("engineId").cloned().unwrap_or(Value::Null),
    });

    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("dispatch-task-request", &payload) {
            tracing::warn!("[AskListener] emit dispatch-task-request 失败: {}", error);
        }
        return;
    }

    let ws_msg = serde_json::json!({
        "event": "dispatch-task-request",
        "payload": payload,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }
}

#[cfg(feature = "tauri-app")]
async fn handle_browser_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    let outcome = match dispatch_browser_frame(frame).await {
        Ok(result) => json!({
            "type": "browser_result",
            "ok": true,
            "result": result,
        }),
        Err(error) => json!({
            "type": "browser_result",
            "ok": false,
            "error": error.to_message(),
        }),
    };

    write_frame(stream, &outcome).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

#[cfg(feature = "tauri-app")]
async fn dispatch_browser_frame(frame: Value) -> Result<Value> {
    use crate::commands::browser::{
        browser_acquire_with_app, browser_app_handle, browser_click_with_app,
        browser_fill_with_app, browser_get_diagnostics_with_app,
        browser_get_interactive_elements_with_app, browser_get_page_context_with_app,
        browser_history_with_app, browser_list_registered_sessions_with_app,
        browser_navigate_ai_with_app, browser_reload_with_app, emit_browser_operation_with_app,
        resolve_browser_label_for_agent_with_app,
    };

    let action = frame
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("browser 帧缺少 action".to_string()))?;

    let agent_key = frame
        .get("agentKey")
        .or_else(|| frame.get("agent_key"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            frame
                .get("sessionId")
                .or_else(|| frame.get("session_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        });
    let app = browser_app_handle()?;

    if action == "list" {
        return serde_json::to_value(browser_list_registered_sessions_with_app(&app)?)
            .map_err(Into::into);
    }

    if action == "acquire" {
        let result = browser_acquire_with_app(
            &app,
            agent_key,
            frame.get("label").and_then(Value::as_str),
            frame.get("url").and_then(Value::as_str),
            frame.get("title").and_then(Value::as_str),
            frame.get("mode").and_then(Value::as_str),
            frame
                .get("activate")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        )
        .await?;
        return serde_json::to_value(result).map_err(Into::into);
    }

    let label = resolve_browser_label_for_agent_with_app(
        &app,
        frame.get("label").and_then(Value::as_str),
        agent_key,
    )?;

    match action {
        "navigate" => {
            let url = frame
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::ValidationError("browser navigate 缺少 url".into()))?;
            let normalized = browser_navigate_ai_with_app(&app, &label, url)?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "navigate",
                "success",
                format!("Claude/MCP 导航到 {normalized}"),
                None,
                Some(normalized.clone()),
            );
            Ok(json!({ "label": label, "url": normalized }))
        }
        "context" => {
            let context = browser_get_page_context_with_app(&app, &label).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "context",
                "success",
                if context.title.trim().is_empty() {
                    "Claude/MCP 读取页面上下文".to_string()
                } else {
                    format!(
                        "Claude/MCP 读取页面上下文：{}",
                        truncate_for_log(&context.title, 80)
                    )
                },
                None,
                Some(context.url.clone()),
            );
            serde_json::to_value(context).map_err(Into::into)
        }
        "diagnostics" => {
            let include_screenshot = frame
                .get("includeScreenshot")
                .or_else(|| frame.get("include_screenshot"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let diagnostics =
                browser_get_diagnostics_with_app(&app, &label, include_screenshot).await?;
            serde_json::to_value(diagnostics).map_err(Into::into)
        }
        "inspect" => {
            let elements = browser_get_interactive_elements_with_app(&app, &label).await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "inspect",
                "success",
                format!("Claude/MCP 检查到 {} 个可操作元素", elements.len()),
                None,
                None,
            );
            serde_json::to_value(elements).map_err(Into::into)
        }
        "click" => {
            let result = browser_click_with_app(
                &app,
                &label,
                frame_index(&frame)?,
                frame.get("text").and_then(Value::as_str),
            )
            .await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "click",
                if result.ok { "success" } else { "warning" },
                result.message.clone(),
                non_empty_target(&result.text),
                Some(result.url.clone()),
            );
            serde_json::to_value(result).map_err(Into::into)
        }
        "fill" => {
            let value = frame
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::ValidationError("browser fill 缺少 value".into()))?;
            let result = browser_fill_with_app(
                &app,
                &label,
                frame_index(&frame)?,
                frame.get("text").and_then(Value::as_str),
                value,
            )
            .await?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "fill",
                if result.ok { "success" } else { "warning" },
                result.message.clone(),
                non_empty_target(&result.text),
                Some(result.url.clone()),
            );
            serde_json::to_value(result).map_err(Into::into)
        }
        "reload" => {
            browser_reload_with_app(&app, &label)?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "reload",
                "success",
                "Claude/MCP 刷新了当前页面".to_string(),
                None,
                None,
            );
            Ok(json!({ "label": label, "reloaded": true }))
        }
        "back" => {
            browser_history_with_app(&app, &label, "back")?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "back",
                "success",
                "Claude/MCP 后退到上一页".to_string(),
                None,
                None,
            );
            Ok(json!({ "label": label, "direction": "back" }))
        }
        "forward" => {
            browser_history_with_app(&app, &label, "forward")?;
            emit_browser_operation_with_app(
                &app,
                &label,
                "forward",
                "success",
                "Claude/MCP 前进到下一页".to_string(),
                None,
                None,
            );
            Ok(json!({ "label": label, "direction": "forward" }))
        }
        other => Err(AppError::ValidationError(format!(
            "未知 browser action: {other}"
        ))),
    }
}

#[cfg(feature = "tauri-app")]
fn frame_index(frame: &Value) -> Result<Option<usize>> {
    match frame.get("index").and_then(Value::as_i64) {
        Some(index) if index >= 0 => Ok(Some(index as usize)),
        Some(_) => Err(AppError::ValidationError("index 不能为负数".to_string())),
        None => Ok(None),
    }
}

#[cfg(feature = "tauri-app")]
fn non_empty_target(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_for_log(trimmed, 120))
    }
}

#[cfg(feature = "tauri-app")]
fn truncate_for_log(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in value.chars().take(max_chars) {
        out.push(ch);
    }
    if value.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn handle_cancel_frame(frame: Value, state: Arc<AppState>, expected_token: &str) {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        tracing::warn!("[AskListener] cancel token 不匹配");
        return;
    }
    let call_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return;
    }
    if let Some(entry) = state.take_ask_answer_sender(&call_id) {
        let _ = entry.sender.send(QuestionOutcome::declined());
    }
    if let Ok(mut pending) = state.pending_questions.lock() {
        pending.remove(&call_id);
    }
}

fn handle_card_cancel_frame(frame: Value, state: Arc<AppState>, expected_token: &str) {
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        tracing::warn!("[AskListener] card_cancel token 不匹配");
        return;
    }
    let interaction_id = frame
        .get("interactionId")
        .or_else(|| frame.get("callId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if interaction_id.is_empty() {
        return;
    }
    let session_id = state
        .pending_plugin_cards
        .lock()
        .ok()
        .and_then(|pending| {
            pending
                .get(&interaction_id)
                .map(|card| card.session_id.clone())
        })
        .unwrap_or_default();
    if let Some(entry) = state.take_plugin_card_answer_sender(&interaction_id) {
        let _ = entry.sender.send(PluginCardOutcome::declined());
    }
    if let Ok(mut pending) = state.pending_plugin_cards.lock() {
        pending.remove(&interaction_id);
    }
    emit_plugin_card_answered_event(&state, &session_id, &interaction_id, true, Value::Null);
}

/// Parsed `questions[i]` for internal use.
#[derive(Debug, Clone)]
pub struct ParsedQuestion {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<ParsedOption>,
}

#[derive(Debug, Clone)]
pub struct ParsedOption {
    pub label: String,
    pub description: Option<String>,
}

fn parsed_to_item(q: &ParsedQuestion) -> QuestionItem {
    QuestionItem {
        question: q.question.clone(),
        header: q.header.clone(),
        multi_select: q.multi_select,
        options: q
            .options
            .iter()
            .map(|o| QuestionOption {
                value: o.label.clone(),
                label: Some(o.label.clone()),
                description: o.description.clone(),
            })
            .collect(),
        allow_custom_input: true,
    }
}

fn parse_questions(value: &Value) -> Result<Vec<ParsedQuestion>> {
    let arr = value
        .as_array()
        .ok_or_else(|| AppError::ValidationError("questions 必须是数组".into()))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let question = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let header = item
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let multi_select = item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .map(|o| ParsedOption {
                        label: o
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(ParsedQuestion {
            question,
            header,
            multi_select,
            options,
        });
    }
    Ok(out)
}

fn emit_question_event(
    state: &AppState,
    session_id: &str,
    call_id: &str,
    questions: &[ParsedQuestion],
) {
    // 单事件携带全部 questions（即使只有 1 题，也走数组形态以统一前端处理）。
    // 顶层仍带摘要字段（第一题的 header / options 等）便于旧消费方兼容。
    let questions_payload: Vec<Value> = questions
        .iter()
        .map(|q| {
            let options: Vec<Value> = q
                .options
                .iter()
                .map(|o| {
                    // 前端 QuestionOption 要求 `value`；用 label 同时作为
                    // 标识符与显示文本。
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect();
            // MCP question 是正文，前端 header 字段承载正文；
            // MCP header 是短标签，映射到 categoryLabel。
            let body = if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            };
            let mut item = json!({
                "question": body,
                "header": q.header,        // 短标签
                "multiSelect": q.multi_select,
                "options": options,
                "allowCustomInput": true,
            });
            if !q.question.is_empty() && !q.header.is_empty() {
                item["categoryLabel"] = Value::String(q.header.clone());
            }
            item
        })
        .collect();

    // 顶层摘要：第一题的字段，便于旧消费方
    let first_body = questions
        .first()
        .map(|q| {
            if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            }
        })
        .unwrap_or_default();
    let first_options = questions
        .first()
        .map(|q| {
            q.options
                .iter()
                .map(|o| {
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let first_multi = questions.first().map(|q| q.multi_select).unwrap_or(false);
    let first_category = questions.first().and_then(|q| {
        if !q.question.is_empty() && !q.header.is_empty() {
            Some(q.header.clone())
        } else {
            None
        }
    });

    let mut payload = json!({
        "type": "question",
        "sessionId": session_id,
        "questionId": call_id,
        "questions": questions_payload,
        // 兼容字段：填充第一题
        "header": first_body,
        "options": first_options,
        "multiSelect": first_multi,
        "allowCustomInput": true,
    });
    if let Some(category) = first_category {
        payload["categoryLabel"] = Value::String(category);
    }

    let event = wrap_question_route_event(session_id, payload.clone());

    // Web/WebSocket broadcast — wrap in envelope for event routing.
    // Frontend httpTransport filters messages without "event" field.
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }

    // Tauri webview emission — only when tauri-app feature is on.
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("chat-event", &event) {
            tracing::warn!("[AskListener] emit chat-event 失败: {}", error);
        }
    }
}

fn wrap_question_route_event(session_id: &str, payload: Value) -> Value {
    if session_id.trim().is_empty() {
        payload
    } else {
        json!({
            "contextId": format!("session-{}", session_id),
            "payload": payload,
        })
    }
}

fn emit_plugin_card_event(
    state: &AppState,
    session_id: &str,
    interaction_id: &str,
    plugin_id: &str,
    card_id: &str,
    tool_name: &str,
    payload: Value,
) {
    let event = wrap_question_route_event(
        session_id,
        json!({
            "type": "plugin_card",
            "sessionId": session_id,
            "interactionId": interaction_id,
            "pluginId": plugin_id,
            "cardId": card_id,
            "toolName": tool_name,
            "payload": payload,
        }),
    );
    emit_chat_event(state, &event);
}

pub(crate) fn emit_plugin_card_answered_event(
    state: &AppState,
    session_id: &str,
    interaction_id: &str,
    declined: bool,
    result: Value,
) {
    let event = wrap_question_route_event(
        session_id,
        json!({
            "type": "plugin_card_answered",
            "sessionId": session_id,
            "interactionId": interaction_id,
            "declined": declined,
            "result": result,
        }),
    );
    emit_chat_event(state, &event);
}

fn emit_chat_event(state: &AppState, event: &Value) {
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }

    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("chat-event", event) {
            tracing::warn!("[AskListener] emit chat-event 失败: {}", error);
        }
    }
}

// ============================================================================
// Frame I/O (u32 LE length prefix + UTF-8 JSON body)
// ============================================================================

async fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧长度: {}", e)))?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_SIZE {
        return Err(AppError::ProcessError(format!("非法帧长度: {}", len)));
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧体: {}", e)))?;
    let value: Value = serde_json::from_slice(&body)?;
    Ok(value)
}

async fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len()).map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream
        .write_all(&len.to_le_bytes())
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧长度: {}", e)))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧体: {}", e)))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::ProcessError(format!("flush 帧: {}", e)))?;
    Ok(())
}

// ============================================================================
// AppState integration — answer sender bookkeeping
// ============================================================================

/// Internal entry stored in `AppState.ask_answer_senders`.
pub struct AskAnswerEntry {
    pub questions: Vec<ParsedQuestion>,
    pub sender: oneshot::Sender<QuestionOutcome>,
}

/// Internal entry stored in `AppState.plugin_card_answer_senders`.
pub struct PluginCardAnswerEntry {
    pub sender: oneshot::Sender<PluginCardOutcome>,
}

impl AppState {
    /// Register a oneshot answer sender keyed by call_id.
    pub(crate) fn register_ask_answer_sender(
        &self,
        call_id: &str,
        questions: Vec<ParsedQuestion>,
        sender: oneshot::Sender<QuestionOutcome>,
    ) {
        if let Ok(mut map) = self.ask_answer_senders.lock() {
            map.insert(call_id.to_string(), AskAnswerEntry { questions, sender });
        }
    }

    /// Remove and return the answer entry for a call_id, if present.
    pub fn take_ask_answer_sender(&self, call_id: &str) -> Option<AskAnswerEntry> {
        self.ask_answer_senders.lock().ok()?.remove(call_id)
    }

    pub(crate) fn register_plugin_card_answer_sender(
        &self,
        interaction_id: &str,
        sender: oneshot::Sender<PluginCardOutcome>,
    ) {
        if let Ok(mut map) = self.plugin_card_answer_senders.lock() {
            map.insert(interaction_id.to_string(), PluginCardAnswerEntry { sender });
        }
    }

    pub fn take_plugin_card_answer_sender(
        &self,
        interaction_id: &str,
    ) -> Option<PluginCardAnswerEntry> {
        self.plugin_card_answer_senders
            .lock()
            .ok()?
            .remove(interaction_id)
    }
}

/// Build a `QuestionOutcome` from the user-submitted multi-answer payload.
/// Length-aligns `answers` to `entry.questions` (missing slots get empty
/// SubAnswer; extra slots are dropped). If `declined == true` the outcome
/// is reported as a full decline regardless of `answers` content.
pub fn build_outcome_for_multiple_answers(
    entry: &AskAnswerEntry,
    answers: Vec<SubAnswer>,
    declined: bool,
) -> QuestionOutcome {
    if declined {
        return QuestionOutcome::declined();
    }
    let mut out = Vec::with_capacity(entry.questions.len());
    for (idx, q) in entry.questions.iter().enumerate() {
        let sub = answers.get(idx).cloned().unwrap_or_default();
        out.push(QuestionAnswerPayload {
            question: q.question.clone(),
            header: q.header.clone(),
            selected: sub.selected,
            custom_input: sub.custom_input,
        });
    }
    QuestionOutcome::answer(out)
}
