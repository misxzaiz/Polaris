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
use crate::services::form_core::{merge_template_defaults, FormTemplate};
use crate::services::form_flow;
use crate::services::form_template as form_tpl;
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
    let state_for_sweeper = state.clone();
    tokio::spawn(async move {
        accept_loop(listener, state, token_for_loop).await;
    });

    // 表单超时清扫：后台周期扫描超时 hold，广播 form-skipped(timeout) 事件并
    // 唤醒挂起的 form 工具调用。这是表单"超时自动跳过"的驱动源——不依赖 AI
    // 再次调用 form 工具才触发清理，超时后前端面板也能同步关闭。
    spawn_form_timeout_sweeper(state_for_sweeper);

    Ok(AskListenerHandle { port, token })
}

/// 周期清扫超时表单。超时 hold 被移除时：
/// 1. 广播 `form-skipped`（reason=timeout）chat-event → 前端 FormCard 置 skipped
/// 2. 唤醒挂起的 form 工具调用（handle_form_frame 等一个 oneshot），回写超时回执
///
/// 间隔取超时窗口的 1/10，既保证及时性又不至于高频空扫。
fn spawn_form_timeout_sweeper(state: Arc<AppState>) {
    const SWEEP_INTERVAL_SECS: u64 = 10;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
        loop {
            ticker.tick().await;
            let expired: Vec<(String, form_flow::FormHold)> = {
                let Ok(mut holds) = state.form_holds.lock() else {
                    continue;
                };
                let now = std::time::Instant::now();
                let mut gone: Vec<(String, form_flow::FormHold)> = Vec::new();
                holds.retain(|id, h| {
                    if now.duration_since(h.created_at)
                        >= std::time::Duration::from_secs(form_flow::FORM_WAIT_TIMEOUT_SECS)
                    {
                        gone.push((id.clone(), h.clone()));
                        false
                    } else {
                        true
                    }
                });
                gone
            };
            for (form_id, hold) in expired {
                tracing::info!(
                    "[Form] 后台清扫超时表单 formId={} target={} action={} sessionId={}",
                    form_id,
                    hold.target,
                    hold.action,
                    hold.session_id
                );
                // 广播 form-skipped(timeout) → 前端关闭面板
                let inner = serde_json::json!({
                    "type": "form-skipped",
                    "formId": form_id,
                    "sessionId": hold.session_id.clone(),
                    "reason": "timeout",
                });
                let event = wrap_question_route_event(&hold.session_id, inner);
                emit_chat_event(&state, &event);
                // 唤醒挂起的 form 工具调用（等 600s 的循环立即拿超时回执）
                if let Some(entry) = state.take_form_answer_sender(&form_id) {
                    let receipt = form_flow::build_skip_receipt(&hold, "timeout");
                    let _ = entry.sender.send(receipt);
                }
            }
        }
    });
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
        "form" => handle_form_frame(&mut stream, frame, state, &expected_token).await,
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
        "cap" => handle_cap_frame(&mut stream, frame, state, &expected_token).await,
        "cap_list" => handle_cap_list_frame(&mut stream, frame, state, &expected_token).await,
        "dispatch_status" => {
            handle_dispatch_status_frame(&mut stream, frame, state, &expected_token).await
        }
        "find_expert" => {
            handle_find_expert_frame(&mut stream, frame, &expected_token).await
        }
        "dispatch_roster" => {
            handle_dispatch_roster_frame(&mut stream, frame, state, &expected_token).await
        }
        "dispatch_continue" => {
            handle_dispatch_continue_frame(&mut stream, frame, state, &expected_token).await
        }
        "dispatch_targets" => {
            handle_dispatch_targets_frame(&mut stream, frame, state, &expected_token).await
        }
        "agent_save" => handle_agent_save_frame(&mut stream, frame, &expected_token).await,
        "agent_delete" => handle_agent_delete_frame(&mut stream, frame, &expected_token).await,
        "agent_list" => handle_agent_list_frame(&mut stream, frame, &expected_token).await,
        "roster_save" => handle_roster_save_frame(&mut stream, frame, &expected_token).await,
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

/// 处理 `form` 帧：AI 经 polaris-ask MCP 拉起结构化表单（阻塞等待提交）。
///
/// 与 `ask` 采用同一挂起骨架，差异只在回执来源：
///   1. token 校验 → 2. 解析 formId/title/read/target/action/fields/sessionId
///   3. `build_hold` 校验 fields schema（非法 → 回写 `form_error` 帧）
///   4. 注册 `AppState.form_holds` 与 `AppState.form_answer_senders`
///   5. 广播 `form` chat-event（前端 FormCard 拉起渲染）
///   6. **挂起等待**用户提交 —— `form_submit` 动作转发目标能力后 send receipt 唤醒
///   7. 回写 `form_result` 帧 → AI 的 tool_result = receipt（含目标能力执行结果）
///
/// 超时（`FORM_WAIT_TIMEOUT_SECS`）或连接断开按超时收尾，AI 拿到一条状态文案。
/// 原始 fields 只在服务端流转；前端与 AI 都只见 build_receipt 的产物。
async fn handle_form_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    // Auth — 与 ask 帧同一令牌。
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError(
            "ask_listener token 不匹配".into(),
        ));
    }

    // 顺手清一次超时 hold（表单有 600s 存活窗口）。超时 hold 被移除时，
    // 其挂起的 form_answer_sender 一并移除：让那条等 600s 的循环立即醒来
    // 拿超时文案，而不是空等。
    if let Ok(mut holds) = state.form_holds.lock() {
        // 先收集超时的 formId，再连 sender 一起清。
        let now = std::time::Instant::now();
        let expired: Vec<String> = holds
            .iter()
            .filter(|(_, h)| {
                now.duration_since(h.created_at)
                    >= std::time::Duration::from_secs(form_flow::FORM_WAIT_TIMEOUT_SECS)
            })
            .map(|(id, _)| id.clone())
            .collect();
        form_flow::cleanup_expired(&mut holds);
        for id in expired {
            if let Some(entry) = state.take_form_answer_sender(&id) {
                let _ = entry.sender.send(format!(
                    "表单等待超时（{}s），请让 AI 重新拉起",
                    form_flow::FORM_WAIT_TIMEOUT_SECS
                ));
            }
        }
    }

    // 解析字段 —— 全部由 MCP 侧生成/透传。
    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let form_id = frame
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = frame
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let read = frame
        .get("read")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let target = frame
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let action = frame
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let fields = frame.get("fields").cloned().unwrap_or_else(|| json!([]));
    // 表单模式：collect（仅收集参数，不转发）/ dispatch（默认，转发目标能力）。
    // collect 模式不受白名单限制——字段值只回喂 AI 自行处理。
    let mode = frame
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("dispatch")
        .to_string();
    // AI 声明的样式（可选，前端 FormCard 按白名单键应用）。
    let style = frame.get("style").cloned().unwrap_or_else(|| json!({}));
    // 模板引用（可选，前端据此预填 + 显示「来自模板 X」）。
    let template = frame.get("template").cloned().unwrap_or_else(|| json!(null));

    // 方向 4：模板展开。若 AI/前端传了 `template: {name}`，从工作区 DataRoot
    // 加载对应模板，用模板的 title/mode/style/fields 作为 baseline，再与本次
    // 声明的字段按 name 合并（AI 显式字段优先）。模板加载失败是硬错误——AI
    // 引用了不存在的模板应立即知道，而不是渲染空表单。
    let template_name = template
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut declared_title = title.clone();
    let mut declared_mode = mode.clone();
    let mut declared_style = style.clone();
    let mut declared_fields = fields.clone();
    if !template_name.is_empty() {
        let root = crate::services::data_root::data_root().root().to_path_buf();
        match form_tpl::load_template(&root, &template_name) {
            Ok(t) => {
                let merged = merge_template_defaults(
                    Some(&t),
                    if declared_title.is_empty() { None } else { Some(&declared_title) },
                    if declared_mode.is_empty() { None } else { Some(&declared_mode) },
                    &declared_style,
                    &declared_fields,
                );
                // 合并结果回填到声明变量（build_hold 仍用这些变量）
                declared_title = merged
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                declared_mode = merged
                    .get("mode")
                    .and_then(Value::as_str)
                    .unwrap_or("dispatch")
                    .to_string();
                declared_style = merged.get("style").cloned().unwrap_or(json!({}));
                declared_fields = merged.get("fields").cloned().unwrap_or(json!([]));
                tracing::info!(
                    "[Form] 模板「{}」展开 merged_fields={}",
                    template_name,
                    declared_fields.as_array().map(|a| a.len()).unwrap_or(0)
                );
            }
            Err(e) => {
                write_frame(
                    stream,
                    &json!({
                        "type": "form_error",
                        "formId": form_id,
                        "message": e,
                    }),
                )
                .await?;
                let _ = stream.shutdown().await;
                return Ok(());
            }
        }
    }

    // formId 复用 callId 字段（引擎侧 UUID）。缺 target 直接失败。
    if form_id.is_empty() {
        return Err(AppError::ValidationError("form 帧缺少 callId(formId)".into()));
    }
    // 白名单拉起时拦截（阶段 E）：dispatch 模式下 target 不在白名单 → AI 立即拿到失败原因，
    // 不落 hold、不给用户渲染表单。collect 模式不转发目标能力，无需白名单。
    // 用 declared_mode（模板可提供 collect），不用原始 mode。
    let mode_is_collect = declared_mode == "collect";
    if !mode_is_collect && !form_flow::target_allowed(&target) {
        write_frame(
            stream,
            &json!({
                "type": "form_error",
                "formId": form_id,
                "message": format!(
                    "目标能力 {} 不在表单白名单（{}）",
                    target,
                    form_flow::FORM_TARGET_WHITELIST.join(" / ")
                ),
            }),
        )
        .await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let hold = match form_flow::build_hold(
        &form_id,
        &session_id,
        &target,
        &action,
        &read,
        &declared_fields,
        &declared_title,
        &declared_mode,
        &declared_style,
        &template,
    ) {
        Ok(hold) => hold,
        Err(msg) => {
            // schema 非法 → 回写错误帧，AI 的 tool_result 会带上失败原因。
            write_frame(
                stream,
                &json!({
                    "type": "form_error",
                    "formId": form_id,
                    "message": msg,
                }),
            )
            .await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };

    // 注册 hold —— 用户提交时由 form_submit 动作取走。
    if let Ok(mut holds) = state.form_holds.lock() {
        holds.insert(form_id.clone(), hold.clone());
        tracing::info!(
            "[Form] hold 已注册 formId={} target={} action={} sessionId={} holds 总数={}",
            form_id,
            hold.target,
            hold.action,
            hold.session_id,
            holds.len()
        );
    } else {
        tracing::error!("[Form] form_holds 锁获取失败（中毒），formId={} 未注册", form_id);
    }

    // 广播 form chat-event（前端 FormCard 依据该事件拉起面板）。
    emit_form_event(&state, &hold);

    // 阻塞等待用户提交（对标 ask/card 骨架）：注册 oneshot sender 后挂起，
    // 不立即回 ack。提交 —— `form_submit` 动作 send receipt 唤醒本循环，
    // 回写 result 帧作为引擎的 tool_result —— AI 拿到回执后在同一套接字
    // 继续下一轮；超时（FORM_WAIT_TIMEOUT_SECS）或连接断开则按超时收尾。
    //
    // 与 ask 的差异：ask 的 oneshot 由 answer_question 取出后 send；这里
    // 由 form_submit 的 dispatch 分支 send。双方都经 AppState.form_answer_senders。
    let (tx, rx) = oneshot::channel::<String>();
    state.register_form_answer_sender(&form_id, tx);
    let receipt = match tokio::time::timeout(
        std::time::Duration::from_secs(form_flow::FORM_WAIT_TIMEOUT_SECS),
        rx,
    )
    .await
    {
        Ok(Ok(response)) => {
            tracing::info!(
                "[Form] 收到提交回执 formId={} 唤醒，回写引擎 tool_result",
                form_id
            );
            response
        }
        Ok(Err(_recv_err)) => {
            // oneshot 被丢弃（如 form_submit 已把 sender 拿走但未 send）。按超时处理。
            tracing::info!(
                "[Form] formId={} oneshot 被丢弃，按超时收尾",
                form_id
            );
            String::from("用户表单提交失败：应答通道已断开")
        }
        Err(_elapsed) => {
            tracing::info!(
                "[Form] formId={} 等待提交超时（{}s）",
                form_id,
                form_flow::FORM_WAIT_TIMEOUT_SECS
            );
            String::from(format!(
                "表单等待超时（{}s），请让 AI 重新拉起",
                form_flow::FORM_WAIT_TIMEOUT_SECS
            ))
        }
    };

    // 回写 result 帧（引擎的 tool_result 语义）：含回执文本。对于已经提交的
    // 表单，这是回喂给 AI 的正式结果；超时/断连则是一段让 AI 感知状态的文案。
    write_frame(
        stream,
        &serde_json::json!({
            "type": "form_result",
            "formId": form_id,
            "receipt": receipt,
        }),
    )
    .await?;

    // 无论哪种路径，此刻 sender 已被消费或超时 —— 依 form_id 清理。
    state.take_form_answer_sender(&form_id);
    let _ = stream.shutdown().await;

    Ok(())
}

/// 广播 `form` chat-event（前端 FormCard 拉起）。字段 schema 携带给前端渲染，
/// 但**不包含任何用户值**——值只在用户提交时才出现。
fn emit_form_event(state: &AppState, hold: &form_flow::FormHold) {
    let event = wrap_question_route_event(
        &hold.session_id,
        json!({
            "type": "form",
            "sessionId": hold.session_id,
            "formId": hold.form_id,
            "title": hold.title,
            "read": hold.read,
            "target": hold.target,
            "action": hold.action,
            "mode": hold.mode,
            "style": hold.style,
            "template": hold.template,
            "fields": hold.fields,
        }),
    );
    tracing::info!(
        "[Form] 广播 form 事件 formId={} sessionId={} mode={} fields={}",
        hold.form_id,
        hold.session_id,
        hold.mode,
        hold.fields.len()
    );
    emit_chat_event(state, &event);
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

/// 派发注册参数（MCP dispatch 帧与 dispatch_create_task 命令共用）
#[derive(Debug, Clone, Default)]
pub struct DispatchTaskParams {
    pub source_session_id: String,
    pub prompt: String,
    pub title: Option<String>,
    pub work_dir: Option<String>,
    pub engine_id: Option<String>,
    /// 队员角色名（优先级最高，命中预设后覆盖 engine/model/profile）
    pub role: Option<String>,
    /// 模型供应商：Profile 名称或 id；"official" = 显式官方端点
    pub provider: Option<String>,
    pub model: Option<String>,
    /// 指定 dispatch_id（MCP 帧携带；命令路径留空自动生成）
    pub dispatch_id: Option<String>,
    /// 结构化结果 schema id（P2-2，可选）
    pub result_schema: Option<String>,
    /// NEXUS roster 流水线 id（P2-5，仅内部派发路径设置）
    pub roster_id: Option<String>,
    /// 调用方显式注入的 system prompt（专家人格 body 等）。
    /// 优先级最高:覆盖 preset.append_system_prompt,result_schema 注入在其后追加。
    pub append_system_prompt: Option<String>,
}

impl DispatchTaskParams {
    fn from_frame(frame: &Value) -> Self {
        let opt_str = |key: &str| {
            frame
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Self {
            source_session_id: frame
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            prompt: frame
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
            title: opt_str("title"),
            work_dir: opt_str("workDir"),
            engine_id: opt_str("engineId"),
            role: opt_str("role"),
            provider: opt_str("provider"),
            model: opt_str("model"),
            dispatch_id: opt_str("dispatchId"),
            result_schema: opt_str("resultSchema"),
            roster_id: None,
            append_system_prompt: opt_str("appendSystemPrompt"),
        }
    }
}

/// 按角色名解析队员预设；未命中返回含候选列表的错误
fn resolve_dispatch_preset(
    config: &crate::models::config::Config,
    role: &str,
) -> std::result::Result<crate::models::config::DispatchPreset, String> {
    let presets = &config.dispatch.presets;
    if let Some(preset) = presets.iter().find(|p| p.name == role) {
        return Ok(preset.clone());
    }
    let lower = role.to_lowercase();
    let ci_matches: Vec<_> = presets
        .iter()
        .filter(|p| p.name.to_lowercase() == lower)
        .collect();
    match ci_matches.len() {
        1 => Ok(ci_matches[0].clone()),
        _ => {
            let available = presets
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(if available.is_empty() {
                format!("未找到队员预设「{}」，当前未配置任何预设；可改用 provider/model 参数或省略以继承来源会话", role)
            } else {
                format!("未找到队员预设「{}」，可用角色：{}", role, available)
            })
        }
    }
}

/// 按名称/id 解析模型 Profile；歧义或未命中返回含候选的错误。
/// 返回 Some("official") 哨兵表示显式官方端点。
fn resolve_dispatch_provider(
    config: &crate::models::config::Config,
    provider: &str,
) -> std::result::Result<Option<String>, String> {
    if provider.eq_ignore_ascii_case("official") {
        return Ok(Some("official".to_string()));
    }
    let profiles = &config.model_profiles;
    if let Some(p) = profiles.iter().find(|p| p.id == provider) {
        return Ok(Some(p.id.clone()));
    }
    if let Some(p) = profiles.iter().find(|p| p.name == provider) {
        return Ok(Some(p.id.clone()));
    }
    let lower = provider.to_lowercase();
    let ci_matches: Vec<_> = profiles
        .iter()
        .filter(|p| p.name.to_lowercase().contains(&lower))
        .collect();
    match ci_matches.len() {
        1 => Ok(Some(ci_matches[0].id.clone())),
        0 => {
            let available = profiles
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(format!(
                "未找到模型供应商「{}」，可用：{}（或 \"official\" 使用官方端点）",
                provider,
                if available.is_empty() { "无" } else { &available }
            ))
        }
        _ => {
            let candidates = ci_matches
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(format!(
                "供应商「{}」匹配到多个 Profile：{}，请使用完整名称",
                provider, candidates
            ))
        }
    }
}

/// 校验并登记派发任务（MCP dispatch 帧与 dispatch_create_task 命令共用）。
///
/// 完成深度/并发校验与 role/provider 解析，插入注册表并返回任务记录；
/// 调用方负责把任务下发给前端执行（emit 事件或命令返回值）。
pub fn register_dispatch_task(
    state: &AppState,
    params: DispatchTaskParams,
) -> std::result::Result<DispatchedTask, String> {
    if params.prompt.is_empty() {
        return Err("dispatch 请求缺少 prompt".to_string());
    }

    // 深度限制：防止派发会话无限递归派发
    let depth = parse_dispatch_depth(&params.source_session_id) + 1;
    if depth > MAX_DISPATCH_DEPTH {
        return Err(format!(
            "派发深度已达上限（{}），当前会话不能再派发子任务",
            MAX_DISPATCH_DEPTH
        ));
    }

    // 并发限制：防止资源被并行引擎进程打满
    let active = state.active_dispatched_task_count();
    if active >= MAX_ACTIVE_DISPATCHES {
        return Err(format!(
            "已有 {} 个派发任务在执行（上限 {}），请等待现有任务完成后再派发，可用 check_dispatched_task 查询进度",
            active, MAX_ACTIVE_DISPATCHES
        ));
    }

    // role/provider 解析（需要配置）
    let config = state.clone_config().unwrap_or_default();
    let mut engine_id = params.engine_id.clone();
    let mut model = params.model.clone();
    let mut model_profile_id: Option<String> = None;
    let mut permission_mode: Option<String> = None;
    let mut role: Option<String> = None;

    // system prompt 三来源合并(优先级: params 显式人格 > preset > result_schema 追加)
    let mut append_system_prompt: Option<String> = params.append_system_prompt.clone();

    if let Some(role_name) = params.role.as_deref() {
        // role 可能是 DispatchPreset 名(队员预设)或 corpus 专家 slug(/dispatch <slug>)。
        // 命中 preset → 应用其引擎/模型/profile/权限;未命中 → 当 corpus slug 读人格注入,
        // 引擎/模型继承来源会话(不报错,兼容单人专家派发)。
        match resolve_dispatch_preset(&config, role_name) {
            Ok(preset) => {
                role = Some(preset.name.clone());
                engine_id = Some(preset.engine_id.clone());
                model_profile_id = preset.model_profile_id.clone();
                model = params.model.clone().or(preset.model.clone());
                permission_mode = preset.permission_mode.clone();
                if append_system_prompt.is_none() {
                    append_system_prompt = preset.append_system_prompt.clone();
                }
            }
            Err(_) => {
                // 未命中 preset:尝试当全局专家 slug 读人格注入。
                // 路径与 nexus_pipeline::load_agent_persona 同构,复用 simple_ai::load_agent_def。
                if let Some((_s, _desc, body)) =
                    crate::ai::engine::simple_ai::load_agent_def(role_name)
                {
                    if !body.trim().is_empty() && append_system_prompt.is_none() {
                        append_system_prompt = Some(body);
                        role = Some(role_name.to_string());
                        tracing::info!("[Dispatch] role「{role_name}」按全局专家注入人格");
                    }
                }
                // 全局也无该 slug:role 仍记名(供展示),引擎/模型继承来源会话
                if role.is_none() {
                    role = Some(role_name.to_string());
                }
            }
        }
    } else if let Some(provider) = params.provider.as_deref() {
        model_profile_id = resolve_dispatch_provider(&config, provider)?;
    }

    // resultSchema 校验与结构化输出指令注入（P2-2，追加在人格之后）
    if let Some(schema_id) = params.result_schema.as_deref() {
        if !super::nexus_verdict::schema_exists(schema_id) {
            return Err(format!(
                "未知 resultSchema: {schema_id}；可用: qa-pass/qa-fail/phase-gate/escalation/qa-verdict"
            ));
        }
        if let Some(injection) = super::nexus_verdict::build_injection(schema_id) {
            append_system_prompt = Some(match append_system_prompt.take() {
                Some(existing) => format!("{existing}{injection}"),
                None => injection,
            });
        }
    }

    let dispatch_id = params
        .dispatch_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let short_id: String = Uuid::new_v4().simple().to_string()[..8].to_string();
    let session_id = format!("dispatch-{}-{}", depth, short_id);

    let title = params.title.clone().unwrap_or_else(|| {
        let mut t: String = params.prompt.chars().take(24).collect();
        if params.prompt.chars().count() > 24 {
            t.push('…');
        }
        t
    });

    let now = chrono::Utc::now().timestamp();
    let task = DispatchedTask {
        dispatch_id: dispatch_id.clone(),
        session_id,
        source_session_id: params.source_session_id,
        title,
        prompt: params.prompt,
        work_dir: params.work_dir,
        engine_id,
        depth,
        role,
        model_profile_id,
        model,
        append_system_prompt,
        permission_mode,
        status: "pending".to_string(),
        summary: None,
        latest_activity: None,
        conversation_id: None,
        result_schema: params.result_schema,
        roster_id: params.roster_id,
        verdict: None,
        verdict_status: None,
        verdict_retry_done: false,
        created_at: now,
        updated_at: now,
    };

    tracing::info!(
        "[Dispatch] 派发任务登记: dispatch_id={}, session_id={}, depth={}, role={:?}, title={}",
        task.dispatch_id,
        task.session_id,
        task.depth,
        task.role,
        task.title
    );
    state.insert_dispatched_task(task.clone());
    Ok(task)
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

    let params = DispatchTaskParams::from_frame(&frame);
    let reply = match register_dispatch_task(&state, params) {
        Ok(task) => {
            // 通知前端执行（前端监听 dispatch-task-request，创建静默会话并 start_chat）
            emit_dispatch_event(&state, "dispatch-task-request", &dispatch_request_payload(&task));
            json!({
                "type": "dispatch_result",
                "ok": true,
                "dispatchId": task.dispatch_id,
                "sessionId": task.session_id,
                "role": task.role,
                "note": "任务已派发到后台会话执行，当前会话不会被阻塞；可用 check_dispatched_task 查询进度",
            })
        }
        Err(message) => dispatch_error_reply("dispatch_result", &message),
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 cap 帧：通用总线能力转发 —— 经主进程 RouterBus.dispatch 调任意已注册
/// 能力（cap.ai.chat / cap.history / cap.todo / cap.kv / cap.config 等），返回能力
/// 执行结果。帧协议：{ type:"cap", token, target:"cap.*", payload:{action,...} }。
///
/// 权限：以 Source::Plugin 注入（bus 桥的既定身份），走主进程 PolicyPermission gate。
/// 管理面能力（cap.config/cap.data_root/cap.plugin*）内置 remote-deny 不拦 Plugin，
/// 但工具描述已标注「需谨慎」。
async fn handle_cap_frame(
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

    let target = frame
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let payload = frame.get("payload").cloned().unwrap_or_else(|| json!({}));

    let reply = if target.is_empty() {
        dispatch_error_reply("cap_result", "cap 帧缺少 target")
    } else if !target.starts_with("cap.") {
        dispatch_error_reply(
            "cap_result",
            &format!("target 必须是 cap.* 能力 id（收到 {target}）"),
        )
    } else {
        use crate::contracts::Router as _;
        let env = crate::contracts::Envelope {
            id: crate::contracts::MsgId(format!("cap-mcp-{}", uuid::Uuid::new_v4())),
            source: crate::contracts::Source::Plugin {
                caller: crate::contracts::PluginId("polaris-dispatch".into()),
            },
            target: crate::contracts::CapabilityId(target.clone()),
            payload,
            trace: crate::contracts::TraceId(format!("cap-mcp-{}", uuid::Uuid::new_v4())),
        };
        match state.router.dispatch(env) {
            Ok(reply) => match reply.result {
                Ok(value) => json!({
                    "type": "cap_result",
                    "ok": true,
                    "target": target,
                    "result": value,
                }),
                Err(error) => dispatch_error_reply("cap_result", &error),
            },
            Err(error) => dispatch_error_reply("cap_result", &error),
        }
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 cap_list 帧：返回主进程总线上已注册的全部能力 id。
async fn handle_cap_list_frame(
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

    use crate::contracts::Router as _;
    let ids: Vec<String> = state
        .router
        .list_capabilities()
        .iter()
        .map(|c| c.0.clone())
        .collect();
    let reply = json!({
        "type": "cap_list_result",
        "ok": true,
        "capabilities": ids,
        "note": "用 cap_dispatch(target, payload) 调用其中任意能力；cap.ai.chat 为流式能力，start/continue 需经 Web/WS 订阅事件。",
    });

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 对已终态的派发任务追加指令(同会话续跑):置 running 并通知前端。
/// nexus Dev↔QA loop 与 verdict 校验重试复用此入口。
pub fn trigger_dispatch_continue(
    state: &AppState,
    dispatch_id: &str,
    prompt: &str,
) -> std::result::Result<(), String> {
    let task = state
        .get_dispatched_task(dispatch_id)
        .ok_or_else(|| format!("未找到派发任务: {dispatch_id}"))?;
    if matches!(task.status.as_str(), "pending" | "running") {
        return Err("任务仍在执行中".into());
    }
    state.update_dispatched_task(dispatch_id, |t| {
        t.status = "running".to_string();
        t.latest_activity = None;
    });
    emit_dispatch_event(
        state,
        "dispatch-task-continue",
        &json!({
            "dispatchId": task.dispatch_id,
            "sessionId": task.session_id,
            "prompt": prompt,
            "conversationId": task.conversation_id,
        }),
    );
    Ok(())
}

/// 通用事件发射(nexus 进度等;tauri emit / web ws 双通道)
pub fn emit_event(state: &AppState, event_name: &str, payload: &Value) {
    emit_dispatch_event(state, event_name, payload);
}

/// 供 nexus_pipeline 派发成员时通知前端（复用 dispatch-task-request 事件链路）
pub fn emit_dispatch_request(state: &AppState, task: &DispatchedTask) {
    emit_dispatch_event(state, "dispatch-task-request", &dispatch_request_payload(task));
}

/// 处理 find_expert 帧(U2-4):L1 coordination.json 任务类型查表(零 token 确定性),
/// miss 时 L2 catalog+自定义专家关键词候选(调用方 LLM 做最终语义挑选)。
async fn handle_find_expert_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }
    let query = frame
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    let reply = if query.is_empty() {
        dispatch_error_reply("find_expert_result", "缺少 query")
    } else {
        json!({
            "type": "find_expert_result",
            "ok": true,
            "candidates": find_expert_candidates(&query),
            "note": "从候选中按任务语义选一位;用其 slug 派发时在 prompt 前注明「以该专家身份、先读取其定义文件」",
        })
    };
    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn find_expert_candidates(query: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return out;
    }

    // 全局专家关键词匹配
    for a in crate::ai::engine::simple_ai::list_agents() {
        if out.len() >= 8 {
            break;
        }
        let hay = format!("{} {} {}", a.slug, a.name, a.description).to_lowercase();
        let hit = hay.contains(&q)
            || q.split_whitespace()
                .filter(|w| w.chars().count() >= 2)
                .any(|w| hay.contains(w));
        if hit {
            out.push(json!({
                "slug": a.slug,
                "name": a.name,
                "description": a.description,
                "source": "custom"
            }));
        }
    }
    out
}

/// 处理 dispatch_roster 帧：按场景组队 → 拓扑波次派发（P2-5）。
async fn handle_dispatch_roster_frame(
    stream: &mut TcpStream,
    frame: Value,
    state: Arc<AppState>,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }
    let scenario = frame.get("scenario").and_then(Value::as_str).unwrap_or_default();
    let goal = frame.get("goal").and_then(Value::as_str).unwrap_or_default();
    let source_session_id = frame.get("sessionId").and_then(Value::as_str).unwrap_or_default();
    let work_dir = frame
        .get("workDir")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);

    let reply = if scenario.is_empty() || goal.trim().is_empty() {
        dispatch_error_reply("dispatch_roster_result", "缺少 scenario 或 goal 参数")
    } else {
        let mode = frame.get("mode").and_then(Value::as_str);
        match super::nexus_pipeline::start_roster(&state, scenario, goal, source_session_id, work_dir, mode) {
            Ok((pipeline, dispatched)) => json!({
                "type": "dispatch_roster_result",
                "ok": true,
                "rosterId": pipeline.id,
                "scenario": pipeline.scenario,
                "waves": pipeline.waves,
                "dispatchedNow": dispatched,
                "note": "已按拓扑波次开始组队派发：每波 ≤3 并行，前波全部结束后自动派发下一波；用 check_dispatched_task 查询各成员进度",
            }),
            Err(message) => dispatch_error_reply("dispatch_roster_result", &message),
        }
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn dispatch_error_reply(kind: &str, message: &str) -> Value {
    json!({
        "type": kind,
        "ok": false,
        "error": message,
    })
}

/// 构建 dispatch-task-request 事件负载（与前端 DispatchTaskRequestEvent 对齐）
fn dispatch_request_payload(task: &DispatchedTask) -> Value {
    json!({
        "dispatchId": task.dispatch_id,
        "sessionId": task.session_id,
        "sourceSessionId": task.source_session_id,
        "prompt": task.prompt,
        "title": task.title,
        "workDir": task.work_dir,
        "engineId": task.engine_id,
        "role": task.role,
        "modelProfileId": task.model_profile_id,
        "model": task.model,
        "appendSystemPrompt": task.append_system_prompt,
        "permissionMode": task.permission_mode,
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
        None => dispatch_error_reply(
            "dispatch_status_result",
            &format!("未找到派发任务: {}", dispatch_id),
        ),
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 dispatch_continue 帧：对已结束的派发任务追加指令（同会话续跑）。
/// running 状态拒绝（避免并发写同一会话）；深度不变、不占新并发额度。
async fn handle_dispatch_continue_frame(
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
        .unwrap_or_default()
        .to_string();
    let prompt = frame
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    let reply = if prompt.is_empty() {
        dispatch_error_reply("dispatch_continue_result", "缺少 prompt")
    } else {
        match state.get_dispatched_task(&dispatch_id) {
            None => dispatch_error_reply(
                "dispatch_continue_result",
                &format!("未找到派发任务: {}", dispatch_id),
            ),
            Some(task) if matches!(task.status.as_str(), "pending" | "running") => {
                dispatch_error_reply(
                    "dispatch_continue_result",
                    "任务仍在执行中，请先用 check_dispatched_task 等待其完成",
                )
            }
            Some(task) => match trigger_dispatch_continue(&state, &task.dispatch_id, &prompt) {
                Ok(()) => json!({
                    "type": "dispatch_continue_result",
                    "ok": true,
                    "dispatchId": task.dispatch_id,
                    "sessionId": task.session_id,
                    "note": "追加指令已下发到原后台会话（上下文保留），可用 check_dispatched_task 查询进度",
                }),
                Err(message) => dispatch_error_reply("dispatch_continue_result", &message),
            },
        }
    };

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 dispatch_targets 帧：枚举可用队员预设/引擎/模型供应商（不含密钥字段）。
async fn handle_dispatch_targets_frame(
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

    let config = state.clone_config().unwrap_or_default();
    let roles: Vec<Value> = config
        .dispatch
        .presets
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "engineId": p.engine_id,
                "model": p.model,
                "hasSystemPrompt": p.append_system_prompt.as_deref().is_some_and(|s| !s.trim().is_empty()),
            })
        })
        .collect();
    let providers: Vec<Value> = config
        .model_profiles
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "models": p.model_options.clone().unwrap_or_else(|| vec![p.model.clone()]),
            })
        })
        .collect();

    let reply = json!({
        "type": "dispatch_targets_result",
        "ok": true,
        "roles": roles,
        "engines": ["claude-code", "codex", "simple-ai"],
        "providers": providers,
        "note": "role 优先于 provider/model；均省略时继承来源会话配置",
    });

    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 agent_save 帧:新建/覆盖项目级专家。
async fn handle_agent_save_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }
    let g = |k: &str| frame.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let slug = g("slug");
    let name = g("name");
    let description = g("description");
    let emoji = g("emoji");
    let system_prompt = g("systemPrompt");
    let tools: Vec<String> = frame
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let reply = match crate::commands::agent_corpus::custom_agent_save_inner(
        &slug, &name, &description, &emoji, &system_prompt, &tools,
    ) {
        Ok(path) => json!({
            "type": "agent_save_result",
            "ok": true,
            "slug": slug,
            "filePath": path.to_string_lossy(),
        }),
        Err(e) => json!({
            "type": "agent_save_result",
            "ok": false,
            "error": e.to_message(),
        }),
    };
    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 agent_delete 帧:删除全局专家。
async fn handle_agent_delete_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }
    let slug = frame.get("slug").and_then(Value::as_str).unwrap_or_default();

    let reply = match crate::commands::agent_corpus::custom_agent_delete_inner(&slug) {
        Ok(()) => json!({ "type": "agent_delete_result", "ok": true, "slug": slug }),
        Err(e) => json!({
            "type": "agent_delete_result",
            "ok": false,
            "error": e.to_message(),
        }),
    };
    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 agent_list 帧:返回全局专家 + 用户专家团(供 AI 查重)。
async fn handle_agent_list_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }

    let agents: Vec<Value> = crate::ai::engine::simple_ai::list_agents()
        .into_iter()
        .map(|a| {
            json!({
                "slug": a.slug,
                "name": a.name,
                "description": a.description,
                "source": "custom",
            })
        })
        .collect();
    let rosters: Vec<Value> = crate::commands::agent_corpus::corpus_rosters_inner()
        .ok()
        .and_then(|v| v.get("rosters").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            json!({
                "slug": r.get("slug").cloned().unwrap_or(Value::Null),
                "title": r.get("title").cloned().unwrap_or(Value::Null),
                "members": r.pointer("/groups/0/members").cloned().unwrap_or(Value::Array(vec![])),
                "source": "roster",
            })
        })
        .collect();

    let reply = json!({
        "type": "agent_list_result",
        "ok": true,
        "agents": agents,
        "rosters": rosters,
    });
    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 处理 roster_save 帧:新建/覆盖用户专家团。
async fn handle_roster_save_frame(
    stream: &mut TcpStream,
    frame: Value,
    expected_token: &str,
) -> Result<()> {
    let token = frame.get("token").and_then(Value::as_str).unwrap_or_default();
    if token != expected_token {
        return Err(AppError::ValidationError("ask_listener token 不匹配".into()));
    }
    let g = |k: &str| frame.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let slug = g("slug");
    let title = g("title");
    let summary = g("summary");
    let members: Vec<String> = frame
        .get("members")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let reply = match crate::commands::agent_corpus::user_roster_save_inner(
        &slug, &title, &summary, members,
    ) {
        Ok(()) => json!({ "type": "roster_save_result", "ok": true, "slug": slug }),
        Err(e) => json!({
            "type": "roster_save_result",
            "ok": false,
            "error": e.to_message(),
        }),
    };
    write_frame(stream, &reply).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// 向前端发出派发相关事件。
///
/// 单消费者语义（与 SchedulerDaemon 一致）：桌面模式只 emit Tauri 事件由桌面
/// 前端执行；无 AppHandle（web-only 模式）时才走 WebSocket 广播，避免桌面与
/// 远程 Web 客户端同时执行同一任务。
fn emit_dispatch_event(state: &AppState, event_name: &str, payload: &Value) {
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit(event_name, payload) {
            tracing::warn!("[AskListener] emit {} 失败: {}", event_name, error);
        }
        return;
    }

    let ws_msg = serde_json::json!({
        "event": event_name,
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
    // Phase 3: 收敛到 BrowserActionDispatcher (ADR 0004 P0 #2)
    use crate::commands::browser::{BrowserActionDispatcher, BrowserActionSource};
    let dispatcher = BrowserActionDispatcher::from_app_handle()?;
    dispatcher
        .dispatch(&frame, BrowserActionSource::Mcp)
        .await
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

/// Internal entry stored in `AppState.form_answer_senders`.
///
/// See [`handle_form_frame`] for the blocking loop: the sender is `await`ed
/// until the user submits the form (via `form_submit`), the hold expires, or
/// the connection drops.
pub struct FormAnswerEntry {
    /// oneshot results in the receipt text the engine sees as tool_result.
    pub sender: oneshot::Sender<String>,
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

    /// Register a form answer sender keyed by form_id.
    pub(crate) fn register_form_answer_sender(
        &self,
        form_id: &str,
        sender: oneshot::Sender<String>,
    ) {
        if let Ok(mut map) = self.form_answer_senders.lock() {
            map.insert(form_id.to_string(), FormAnswerEntry { sender });
        }
    }

    /// Remove and return the form answer entry for a form_id, if present.
    pub fn take_form_answer_sender(&self, form_id: &str) -> Option<FormAnswerEntry> {
        self.form_answer_senders.lock().ok()?.remove(form_id)
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

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use crate::models::config::{Config, DispatchPreset, ModelProfile};

    #[test]
    fn form_answer_sender_roundtrip() {
        // FormAnswerEntry 的 oneshot 传输语义：form_submit 侧注册时取出 sender，
        // send receipt 后，handle_form_frame 挂起的 rx 应能收到同一份回执文本。
        // 这是阻塞回喂闭环的最小可用性验证。
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let entry = FormAnswerEntry { sender: tx };
        let receipt = "用户已提交表单\n执行结果: {\"ok\":true}".to_string();
        let _ = entry.sender.send(receipt.clone());
        let got = rx
            .blocking_recv()
            .expect("oneshot 应收到回执");
        assert_eq!(got, receipt);
    }

    #[test]
    fn dispatch_depth_parsing() {
        assert_eq!(parse_dispatch_depth(""), 0);
        assert_eq!(parse_dispatch_depth("some-session-id"), 0);
        assert_eq!(parse_dispatch_depth("dispatch-1-abc12345"), 1);
        assert_eq!(parse_dispatch_depth("dispatch-2-abc12345"), 2);
        // 格式异常但带 dispatch- 前缀：按 1 层保守处理
        assert_eq!(parse_dispatch_depth("dispatch-x"), 1);
    }

    fn preset(name: &str) -> DispatchPreset {
        DispatchPreset {
            id: format!("id-{}", name),
            name: name.to_string(),
            engine_id: "claude-code".to_string(),
            model_profile_id: None,
            model: Some("haiku".to_string()),
            append_system_prompt: None,
            permission_mode: None,
        }
    }

    fn profile(id: &str, name: &str) -> ModelProfile {
        ModelProfile {
            id: id.to_string(),
            name: name.to_string(),
            model: "m1".to_string(),
            model_options: None,
            ..serde_json::from_value(serde_json::json!({
                "id": "", "name": "", "baseUrl": "https://example.com",
                "apiKey": "sk-test", "model": ""
            }))
            .expect("ModelProfile 反序列化默认值")
        }
    }

    #[test]
    fn preset_resolution_exact_and_case_insensitive() {
        let mut config = Config::default();
        config.dispatch.presets = vec![preset("测试员"), preset("Docs")];

        assert_eq!(resolve_dispatch_preset(&config, "测试员").unwrap().name, "测试员");
        assert_eq!(resolve_dispatch_preset(&config, "docs").unwrap().name, "Docs");

        let err = resolve_dispatch_preset(&config, "不存在").unwrap_err();
        assert!(err.contains("测试员"), "错误信息应列出候选角色: {}", err);
    }

    #[test]
    fn provider_resolution_official_exact_and_ambiguous() {
        let mut config = Config::default();
        config.model_profiles = vec![
            profile("p1", "DeepSeek Pro"),
            profile("p2", "DeepSeek Lite"),
            profile("p3", "Kimi"),
        ];

        assert_eq!(
            resolve_dispatch_provider(&config, "official").unwrap(),
            Some("official".to_string())
        );
        assert_eq!(
            resolve_dispatch_provider(&config, "p1").unwrap(),
            Some("p1".to_string())
        );
        assert_eq!(
            resolve_dispatch_provider(&config, "Kimi").unwrap(),
            Some("p3".to_string())
        );
        // 模糊唯一命中
        assert_eq!(
            resolve_dispatch_provider(&config, "lite").unwrap(),
            Some("p2".to_string())
        );
        // 歧义：列出候选
        let err = resolve_dispatch_provider(&config, "deepseek").unwrap_err();
        assert!(err.contains("DeepSeek Pro") && err.contains("DeepSeek Lite"));
        // 未命中：列出全部可用
        let err = resolve_dispatch_provider(&config, "nope").unwrap_err();
        assert!(err.contains("Kimi"));
    }
}
