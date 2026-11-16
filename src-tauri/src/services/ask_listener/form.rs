//! 表单帧处理与事件（K-R3 拆分）

use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use serde_json::{json, Value};
use crate::error::{AppError, Result};
use crate::state::{AppState, DispatchedTask, PendingPluginCard, QuestionItem, QuestionOption, QuestionStatus, SubAnswer};
use crate::services::form_flow;
use crate::services::form_template as form_tpl;
use crate::services::form_core::merge_template_defaults;
use super::frames::{read_frame, write_frame};
use super::emit::{wrap_question_route_event, emit_chat_event};

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
pub async fn handle_form_frame(
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
    // unwrap_or 的参数须写成 json!(null)：clippy --fix 曾把宏展开体 $crate::Value::Null
    // 落成源码导致语法错误；宏调用形式才是不求值语义的正确写法
    let template = frame.get("template").cloned().unwrap_or(json!(null));

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
            format!(
                "表单等待超时（{}s），请让 AI 重新拉起",
                form_flow::FORM_WAIT_TIMEOUT_SECS
            )
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
