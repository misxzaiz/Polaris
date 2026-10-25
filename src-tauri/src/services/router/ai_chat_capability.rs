//! cap.ai.chat —— AI 聊天流式能力（第七步阶段 A2：唯一实现，接 ai_chat_core 业务核）
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 A：`commands/chat.rs` 已摘除，
//! 本能力是 AI 会话的**唯一入口**：
//! - 流式动作（dispatch_stream）：`start` / `continue` —— 经业务核
//!   `start_chat_inner` / `continue_chat_inner`，事件走 ChatCallbacks → 本能力
//!   泵通道 → RouterBus 泵任务 → EventAdapter（chat-event 线格式与历史一致）
//! - 同步动作（dispatch）：`interrupt` / `send_input` / `approve_plan` /
//!   `reject_plan` / `answer_question` / `respond_plugin_card` /
//!   `form_submit` / `form_skip` / `form_template_save` / `form_template_list` /
//!   `register_pending_question` / `register_pending_plan` / `get_pending_plans` /
//!   `get_pending_questions` / `clear_processed_plans` / `clear_answered_questions`
//!   （start/continue 也可经 dispatch 同步调用：RouterBus 对流式表目标自动回退
//!   invoke，同步返回结果；token 流仍走 chat-event 事件订阅）
//!
//! # 状态持有
//!
//! 业务核函数需要 `&AppState`（引擎注册表 / pending_plans / 应答通道 / 供应商
//! 路由 / 用量统计等）。能力在装配点（web 服务器状态构建后）持有 `Arc<AppState>`
//! ——`clone_for_web` 的全部业务字段与本源共享（Arc 克隆），见 step7 §A2。
//!
//! # 线程模型
//!
//! `Capability::invoke` / `invoke_stream` 是同步 fn，而业务核是 async：在
//! `block_in_place + Handle::block_on` 中驱动（调用方均为 tokio 多线程运行时）；
//! 流式的引擎读线程经 `std::thread` + 持有的 Handle block_on 驱动核心 async 调用。

use crate::services::ai_chat_core as core;
use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Event,
    StreamingCapability, TraceId, Value,
};
use std::sync::Arc;
use tokio::sync::mpsc;

/// 同步动作清单（describe 与未知动作错误文案共用，单一事实来源；
/// describe_contract 测试断言两者一致）
const SYNC_ACTIONS: &[&str] = &[
    "start",
    "continue",
    "interrupt",
    "send_input",
    "approve_plan",
    "reject_plan",
    "answer_question",
    "respond_plugin_card",
    "form_submit",
    "form_skip",
    "form_template_save",
    "form_template_list",
    "register_pending_question",
    "register_pending_plan",
    "get_pending_plans",
    "get_pending_questions",
    "clear_processed_plans",
    "clear_answered_questions",
];

/// 流式动作清单（invoke_stream 仅支持 start/continue）
const STREAM_ACTIONS: &[&str] = &["start", "continue"];

/// describe 内容（模块级函数：单测无需构造 AppState 即可校验契约形状）。
///
/// 形状经 `standard_describe` 构造（id/name/summary/note/actions 五键白名单）；
/// params/returns 以 invoke/invoke_stream 实现为准逐项核对（2026-10-25 审计）。
fn describe_value() -> Value {
    standard_describe(
        "cap.ai.chat",
        "AI会话",
        "AI 会话（流式）：启动/继续/打断/输入/计划审批/问题回答/表单/待答注册",
        Some(
            "start/continue 可经 cap_dispatch 同步调用（RouterBus 对流式表目标自动回退 invoke 并返回结果），token 流经 WS chat-event 事件订阅",
        ),
        serde_json::json!({
            "start": {
                "params": { "message": "string（必填，非空）", "options": "ChatRequestOptions 对象?；缺省时兼容顶层平铺 camelCase 字段", "sessionId": "string?" },
                "returns": "sessionId 字符串（JSON string，非 { sessionId } 包装）；token/事件走 chat-event 流",
                // example：bus_help usage_examples 派生源（payload 已对 start 参数校验核对）
                "example": { "action": "start", "message": "<用户消息>" }
            },
            "continue": {
                "params": { "message": "string（必填，非空）", "sessionId": "string（必填）", "options": "ChatRequestOptions 对象?；缺省时兼容顶层平铺 camelCase 字段" },
                "returns": "{ ok: true }（事件走 chat-event 流）"
            },
            "interrupt": { "params": { "sessionId": "string（必填）", "engineId": "string?" }, "returns": "{ interrupted: true }" },
            "send_input": { "params": { "sessionId": "string（必填）", "input": "string（必填）" }, "returns": "{ delivered: bool }" },
            "approve_plan": { "params": { "sessionId": "string（必填）", "planId": "string（必填）" }, "returns": "{ ok: true }" },
            "reject_plan": { "params": { "sessionId": "string（必填）", "planId": "string（必填）", "feedback": "string?" }, "returns": "{ ok: true }" },
            "answer_question": { "params": { "sessionId": "string（必填）", "callId": "string（必填）", "answer": "QuestionAnswer 对象（必填）：{ answers: [{ selected: string[], customInput?: string, declined?: bool }], declined?: bool }" }, "returns": "{ ok: true }" },
            "respond_plugin_card": { "params": { "sessionId": "string（必填）", "interactionId": "string（必填）", "response": "PluginCardResponse 对象（必填）" }, "returns": "{ ok: true }" },
            "form_submit": {
                "params": { "formId": "string（必填，表单 hold id）", "values": "any?（字段值，按表单字段名）", "private": "bool?（用户私密提交，服务端强制脱敏回执）", "read": "string?（AI 声明的读取模式；未传 private 时 read=none 视为私密）" },
                "returns": "目标能力执行结果（dispatch 模式转发目标能力 reply；collect 模式为 { collected: true }）"
            },
            "form_skip": { "params": { "formId": "string（必填）" }, "returns": "{ ok: true }" },
            "form_template_save": {
                "params": { "formId": "string（必填）", "templateName": "string?（缺省用表单标题，再缺省取 formId 前缀）", "version": "string?（缺省 v1）" },
                "returns": "{ ok, name, version, title, slugified }（name 为最终落盘名，可能已 slug 化）"
            },
            "form_template_list": { "params": {}, "returns": "{ templates: [模板元信息] }（不含字段值）" },
            "register_pending_question": {
                "params": { "options": "QuestionOption 数组（必填，每项 { value: string 必填, label?, description? }）", "sessionId": "string?", "callId": "string?", "header": "string?", "multiSelect": "bool?（默认 false）", "allowCustomInput": "bool?（默认 false）" },
                "returns": "{ ok: true }"
            },
            "register_pending_plan": {
                "params": { "planId": "string（缺失时按空串注册、不报错，务必显式传入）", "sessionId": "string?", "title": "string?", "description": "string?" },
                "returns": "{ ok: true }"
            },
            "get_pending_plans": { "params": { "sessionId": "string?（过滤）" }, "returns": "PendingPlan[] 裸数组（JSON 数组，无包装键）" },
            "get_pending_questions": { "params": { "sessionId": "string?（过滤）" }, "returns": "PendingQuestion[] 裸数组（JSON 数组，无包装键）" },
            "clear_processed_plans": { "params": {}, "returns": "{ removed: 移除条数 }" },
            "clear_answered_questions": { "params": {}, "returns": "{ removed: 移除条数 }" }
        }),
    )
}

/// cap.ai.chat —— AI 聊天能力（唯一实现）
pub struct AiChatCapability {
    state: Arc<crate::AppState>,
    /// 自有事件适配层（包住 AppState.event_broadcast 同一广播器）：
    /// 同步动作（start/continue）的事件直发 WS（与旧 broadcast_chat_event 同线），
    /// 桌面 tauri emit 由 lib.rs 中继订阅广播通道承接。
    event_adapter: Arc<crate::services::router::EventAdapter>,
}

impl AiChatCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self {
            event_adapter: Arc::new(crate::services::router::EventAdapter::from_broadcaster(
                state.event_broadcast.clone(),
            )),
            state,
        }
    }

    fn app_paths(&self) -> core::AppPaths {
        core::AppPaths {
            config_dir: crate::services::data_root::data_root().config_dir(),
            resource_dir: self.state.resource_dir.get().cloned().flatten(),
        }
    }
}

fn make_event(kind: &str, payload: Value) -> Event {
    Event {
        seq: 0,
        kind: kind.into(),
        payload,
        trace: TraceId("cap.ai.chat".into()),
    }
}

/// 判断信封 payload 是否 session_end（终态事件，丢了前端会卡流式态）
fn is_session_end_payload(json: &Value) -> bool {
    json.get("payload")
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        == Some("session_end")
}

/// 业务核回调 → 流通道（emit_event 收到的已是 {contextId, payload} 信封）。
///
/// B2.h（审计 3.9）：此前 `let _ = tx.try_send(...)` 在通道满（512）时静默丢弃
/// ——慢消费端连 session_end 都可能丢，前端永远转圈。策略：
/// - 普通事件：满时 warn 后丢弃（保序优先——异步重试会导致 token 乱序）；
/// - session_end：终态事件且其后无事件，有界阻塞重试（≤2s）尽量送达。
fn forward_chat_event(tx: &mpsc::Sender<Event>, json: Value) {
    match tx.try_send(make_event("chat-event", json.clone())) {
        Ok(()) => {}
        Err(e) if matches!(e, tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            if is_session_end_payload(&json) {
                for _ in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if tx.try_send(make_event("chat-event", json.clone())).is_ok() {
                        return;
                    }
                }
                tracing::error!("[cap.ai.chat] session_end 事件在通道满重试后仍丢弃（消费端阻塞）");
            } else {
                tracing::warn!("[cap.ai.chat] chat-event 通道满，丢弃事件（慢消费端）");
            }
        }
        Err(_) => {
            // 接收端已关闭（流提前结束）：丢弃即可
        }
    }
}

/// 业务核回调 → 流通道（emit_event 收到的已是 {contextId, payload} 信封）
fn pump_callbacks(tx: &mpsc::Sender<Event>) -> core::ChatCallbacks {
    let tx = tx.clone();
    core::ChatCallbacks {
        emit_event: Arc::new(move |json| {
            forward_chat_event(&tx, json);
        }),
        notify_complete: Arc::new(|| {
            // 桌面完成通知由 lib.rs 中继任务按 session_end 事件触发
        }),
    }
}

impl Capability for AiChatCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ai.chat".into())
    }

    fn describe(&self) -> Value {
        describe_value()
    }

    /// 同步动作（dispatch；RouterBus 对流式表目标自动回退到 invoke）
    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let state = self.state.clone();
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.ai.chat 同步动作需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let s = state.as_ref();
                let get = |k: &str| params.get(k);
                let sid = || {
                    get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                // 同步 start/continue：返回值承载引擎 sessionId（前端 conversationId），
                // 事件经能力自有 adapter 直播（chat-event 线格式不变）
                let chat_callbacks = |tx_opt: Option<mpsc::Sender<Event>>| {
                    let adapter = self.event_adapter.clone();
                    let pump_tx = tx_opt;
                    core::ChatCallbacks {
                        emit_event: Arc::new(move |json| {
                            match &pump_tx {
                                Some(tx) => forward_chat_event(tx, json),
                                None => {
                                    let ev = make_event("chat-event", json);
                                    adapter.broadcast(ev);
                                }
                            }
                        }),
                        notify_complete: Arc::new(|| {}),
                    }
                };
                match action.as_str() {
                    "start" | "continue" => {
                        // 前端 options 嵌套在 "options" 字段下（{action, message, options}）；
                        // 兼容顶层平铺。修复：此前直接反序列化整个 payload 导致
                        // contextId/workDir 等全部丢失 → 事件落 "main" 触发新建会话窗口。
                        let options: core::ChatRequestOptions = if get("options").is_some() {
                            serde_json::from_value(get("options").cloned().unwrap_or(Value::Null))
                                .map_err(|e| format!("options 参数非法: {}", e))?
                        } else {
                            let mut flat = params.clone();
                            if let Some(obj) = flat.as_object_mut() {
                                obj.remove("action");
                                obj.remove("sessionId");
                            }
                            serde_json::from_value(flat)
                                .map_err(|e| format!("请求参数非法: {}", e))?
                        };
                        let message = get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        if message.trim().is_empty() {
                            return Err("cap.ai.chat 需要 message 参数".to_string());
                        }
                        let callbacks = chat_callbacks(None);
                        let app_paths = core::AppPaths {
                            config_dir: crate::services::data_root::data_root().config_dir(),
                            resource_dir: s.resource_dir.get().cloned().flatten(),
                        };
                        if action == "start" {
                            // B2.f（审计 3.8）：start 排他——此前仅 continue 有 try_start 闸，
                            // 双击/外部重试会产生两个引擎进程、两个 conversationId，
                            // 事件交织渲染。以 context_id 为键做并发互斥：占位仅在
                            // start 执行期间持有（真实运行态由引擎事件流的
                            // session_start/session_end 记录），结束即释放。
                            // 前缀必须带 start-gate-：try_start 占位会写 lifecycle
                            // session_start，无前缀的 contextId 会被跨端跟随当成
                            // 真实会话（幻影卡片，2026-10-24 浏览器实测）。加前缀后
                            // Follower 的 isIgnorableConversation 过滤生效，排他
                            // 语义不变（仍按 contextId 分组互斥）。
                            let gate_key = options
                                .context_id
                                .clone()
                                .filter(|c| !c.is_empty())
                                .map(|c| format!("start-gate-{}", c))
                                .unwrap_or_else(|| format!("start-gate-{}", uuid::Uuid::new_v4()));
                            if let Some(reason) =
                                crate::commands::session_state_commands::session_try_start_inner(
                                    &gate_key,
                                    "start",
                                )
                                .map_err(|e| e.to_message())?
                            {
                                return Err(reason);
                            }
                            let start_result = core::start_chat_inner(
                                message,
                                options,
                                s,
                                callbacks,
                                &app_paths,
                            )
                            .await;
                            // 无论成败都释放 start 互斥占位（真实会话运行态由事件流记录）
                            core::append_session_event(
                                &gate_key,
                                crate::services::session_state::SessionEventType::SessionEnd,
                                Some("start-gate-released".to_string()),
                                None,
                            );
                            let sid = start_result.map_err(|e| e.to_message())?;
                            Ok(serde_json::json!(sid))
                        } else {
                            let sid = sid();
                            if sid.trim().is_empty() {
                                return Err("cap.ai.chat continue 需要 sessionId 参数".to_string());
                            }
                            // 阶段 2 排他锁：同一会话仅允许一个 active 操作。
                            // 事务化「仲裁 + 占位」——并发时先到者胜出，后到者直接拒绝。
                            if let Some(reason) =
                                crate::commands::session_state_commands::session_try_start_inner(
                                    &sid,
                                    "ipc",
                                )
                                .map_err(|e| e.to_message())?
                            {
                                return Err(reason);
                            }
                            let continue_result = core::continue_chat_inner(
                                sid.clone(),
                                message,
                                options,
                                s,
                                callbacks,
                                &app_paths,
                            )
                            .await;
                            if let Err(e) = continue_result {
                                // 失败补偿：引擎未启动/续接失败时释放占位（配对 session_end），
                                // 避免占位 start 卡 running 导致后续 continue 永久被拒。
                                core::append_session_event(
                                    &sid,
                                    crate::services::session_state::SessionEventType::SessionEnd,
                                    Some("error".to_string()),
                                    Some(e.to_message()),
                                );
                                return Err(e.to_message());
                            }
                            Ok(serde_json::json!({ "ok": true }))
                        }
                    }
                    "interrupt" => {
                        let engine_id = get("engineId").and_then(|v| v.as_str()).map(String::from);
                        core::interrupt_chat_inner(sid(), engine_id, s)
                            .await
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "interrupted": true }))
                    }
                    "send_input" => {
                        let input = get("input").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let delivered = core::send_input(sid(), input, s)
                            .await
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "delivered": delivered }))
                    }
                    "approve_plan" => {
                        let plan_id = get("planId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        core::approve_plan(sid(), plan_id, s).await.map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "reject_plan" => {
                        let plan_id = get("planId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let feedback = get("feedback").and_then(|v| v.as_str()).map(String::from);
                        core::reject_plan(sid(), plan_id, feedback, s)
                            .await
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "answer_question" => {
                        let call_id = get("callId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let answer: crate::state::QuestionAnswer = get("answer")
                            .cloned()
                            .and_then(|v| serde_json::from_value(v).ok())
                            .ok_or_else(|| {
                                "answer 参数缺失或非法（需为 QuestionAnswer 对象：{ answers: [{ selected: string[], customInput?, declined? }], declined? }）"
                                    .to_string()
                            })?;
                        core::answer_question(sid(), call_id, answer, s)
                            .await
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "respond_plugin_card" => {
                        let interaction_id =
                            get("interactionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let response: core::PluginCardResponse = get("response")
                            .cloned()
                            .and_then(|v| serde_json::from_value(v).ok())
                            .ok_or_else(|| "response 参数缺失或非法".to_string())?;
                        core::respond_plugin_card(sid(), interaction_id, response, s)
                            .await
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "form_submit" => {
                        // 表单工具回填：按 formId 取 hold，原文转发目标能力，回执喂回前端/引擎。
                        // 信任边界：AI 与前端都只见 build_receipt 的产物，原始 values 只在服务端流转。
                        let form_id = get("formId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if form_id.is_empty() {
                            return Err("cap.ai.chat form_submit 需要 formId 参数".to_string());
                        }
                        let values = get("values").cloned().unwrap_or(Value::Null);
                        // 用户私密提交：由前端 FormCard 的"私密提交"开关决定；未显式传时
                        // 跟随 AI 声明的 read===none。服务端强制脱敏，不信任 AI 的 read。
                        let private = get("private")
                            .and_then(|v| v.as_bool())
                            .unwrap_or_else(|| {
                                get("read").and_then(|v| v.as_str()) == Some("none")
                            });
                        let hold = {
                            let mut holds = s.form_holds.lock().ok().ok_or_else(|| {
                                "表单存储已损坏（form_holds 锁中毒）".to_string()
                            })?;
                            tracing::info!(
                                "[Form] form_submit 请求 formId={} 当前 holds 数={} holds keys={:?}",
                                form_id,
                                holds.len(),
                                holds.keys().collect::<Vec<_>>()
                            );
                            holds.remove(&form_id)
                        };
                        let Some(hold) = hold else {
                            // 迟到/重复提交：hold 已被取走或超时清理 → 表单失效
                            return Err("表单已失效（不存在或已提交），请让 AI 重新发起".to_string());
                        };
                        let (receipt, ok, reply) =
                            crate::services::form_flow::submit_form(&hold, &values, &*s.router, private);
                        tracing::info!(
                            "[Form] submit_form 返回 formId={} ok={} receipt={}",
                            hold.form_id,
                            ok,
                            receipt.replace('\n', " ")
                        );
                        // 前端 FormCard 依据 form-answered 事件切提交态（receipt 是安全回执）。
                        // 走 chat-event 通道（与 ask_listener::emit_form_event 同结构）：
                        //   {"event":"chat-event","payload":{"contextId":"session-<id>","payload":{type:form-answered,...}}}
                        // 前端 EventRouter 只订阅 chat-event，独立 kind（form-answered）会被
                        // WS should_send 过滤掉 → FormCard 永远收不到回执卡在加载态。
                        let form_answered_inner = serde_json::json!({
                            "type": "form-answered",
                            "formId": hold.form_id,
                            "sessionId": hold.session_id.clone(),
                            "ok": ok,
                            "receipt": receipt.clone(),
                        });
                        let form_answered_event = if hold.session_id.trim().is_empty() {
                            form_answered_inner
                        } else {
                            serde_json::json!({
                                "contextId": format!("session-{}", hold.session_id),
                                "payload": form_answered_inner,
                            })
                        };
                        tracing::info!(
                            "[Form] 广播 form-answered 事件 formId={} ok={} sessionId={}",
                            hold.form_id,
                            ok,
                            hold.session_id
                        );
                        self.event_adapter.broadcast(make_event(
                            "chat-event",
                            form_answered_event,
                        ));

                        // 把回执喂给挂起的 form 工具调用（handle_form_frame 等一个 oneshot）：
                        // 用户提交完成 → 引擎的 tool_result 拿到 receipt，AI 在同一回合继续跑。
                        if let Some(entry) = s.take_form_answer_sender(&hold.form_id) {
                            if entry.sender.send(receipt.clone()).is_err() {
                                tracing::info!(
                                    "[Form] formId={} answer sender 已关闭，回执未送达（用户可能已取消）",
                                    hold.form_id
                                );
                            }
                        }
                        match reply {
                            Ok(reply) => Ok(reply),
                            Err(e) => Err(format!(
                                "表单目标能力执行失败（formId={}）: {}",
                                hold.form_id, e
                            )),
                        }
                    }
                    "form_skip" => {
                        // 表单跳过：用户主动放弃填写（FormCard「跳过」按钮触发）。
                        // 语义与 form_submit 对齐：按 formId 取 hold，构造跳过回执
                        // 唤醒挂起的 form 工具调用（AI 感知后自行决定是否重拉），
                        // 并广播 form-skipped 事件让前端 FormCard 切 skipped 态。
                        let form_id = get("formId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if form_id.is_empty() {
                            return Err("cap.ai.chat form_skip 需要 formId 参数".to_string());
                        }
                        let hold = {
                            let mut holds = s.form_holds.lock().ok().ok_or_else(|| {
                                "表单存储已损坏（form_holds 锁中毒）".to_string()
                            })?;
                            holds.remove(&form_id)
                        };
                        let Some(hold) = hold else {
                            // 迟到/重复跳过：hold 已被取走或超时清理 → 表单已失效。
                            return Err("表单已失效（不存在或已提交），请让 AI 重新发起".to_string());
                        };
                        // 跳过回执的信任边界与提交一致：不携带任何字段值。
                        let receipt =
                            crate::services::form_flow::build_skip_receipt(&hold, "user");
                        tracing::info!(
                            "[Form] form_skip formId={} target={} action={} sessionId={}",
                            hold.form_id,
                            hold.target,
                            hold.action,
                            hold.session_id
                        );
                        // 广播 form-skipped 事件 → 前端 FormCard 置 skipped
                        let form_skipped_inner = serde_json::json!({
                            "type": "form-skipped",
                            "formId": hold.form_id,
                            "sessionId": hold.session_id.clone(),
                            "reason": "user",
                        });
                        let form_skipped_event = if hold.session_id.trim().is_empty() {
                            form_skipped_inner
                        } else {
                            serde_json::json!({
                                "contextId": format!("session-{}", hold.session_id),
                                "payload": form_skipped_inner,
                            })
                        };
                        self.event_adapter.broadcast(make_event(
                            "chat-event",
                            form_skipped_event,
                        ));
                        // 唤醒挂起的 form 工具调用（与 form_submit 同通道）
                        if let Some(entry) = s.take_form_answer_sender(&hold.form_id) {
                            if entry.sender.send(receipt.clone()).is_err() {
                                tracing::info!(
                                    "[Form] form_skip formId={} answer sender 已关闭，回执未送达",
                                    hold.form_id
                                );
                            }
                        }
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "form_template_save" => {
                        // 方向 4：把当前表单保存为模板（用户侧入口，FormCard「保存为模板」）。
                        // 从 form_holds 读副本（不删 hold，表单仍可继续填写/提交），
                        // 用其 fields/style/mode/title 构造模板结构存到 DataRoot。
                        // 模板只存结构不存值——字段值任何情况都不落盘。
                        let form_id = get("formId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if form_id.is_empty() {
                            return Err("cap.ai.chat form_template_save 需要 formId 参数".to_string());
                        }
                        let hold_opt = {
                            let holds = s.form_holds.lock().ok().ok_or_else(|| {
                                "表单存储已损坏（form_holds 锁中毒）".to_string()
                            })?;
                            holds.get(&form_id).cloned()
                        };
                        let hold = hold_opt.ok_or_else(|| {
                            "表单不存在或已提交，无法保存为模板".to_string()
                        })?;
                        // 模板名：显式 templateName > 表单标题 > formId 前缀
                        let name = get("templateName")
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .or_else(|| {
                                let t = hold.title.trim();
                                if t.is_empty() {
                                    None
                                } else {
                                    Some(t.to_string())
                                }
                            })
                            .unwrap_or_else(|| {
                                let id = &hold.form_id;
                                id[..id.len().min(12)].to_string()
                            });
                        let version = get("version")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .or_else(|| Some("v1".to_string()));
                        // 只取结构字段（fields/style/mode/title），不含 fields 原始值。
                        let source = serde_json::json!({
                            "name": name,
                            "version": version,
                            "title": hold.title,
                            "mode": hold.mode,
                            "style": hold.style,
                            "fields": hold.fields,
                        });
                        let root = crate::services::data_root::data_root().root().to_path_buf();
                        let saved =
                            crate::services::form_template::save_template(&root, &source)
                                .map_err(|e| format!("保存模板失败: {}", e))?;
                        // saved.name 是最终落盘名（可能已 slug 化/唯一化）
                        let saved_name = saved
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&name)
                            .to_string();
                        tracing::info!(
                            "[Form] 保存模板 name={} formId={} fields={}",
                            saved_name,
                            hold.form_id,
                            hold.fields.len()
                        );
                        Ok(serde_json::json!({
                            "ok": true,
                            "name": saved_name,
                            "version": version,
                            // 落盘名与展示标题分离：模板文件用 slug 名，UI 仍显示中文标题
                            "title": hold.title,
                            "slugified": saved_name != name,
                        }))
                    }
                    "form_template_list" => {
                        // 方向 4：列出已保存模板（元信息，不含字段值）。
                        let root = crate::services::data_root::data_root().root().to_path_buf();
                        let templates = crate::services::form_template::list_templates(&root)
                            .map_err(|e| format!("读取模板列表失败: {}", e))?;
                        Ok(serde_json::json!({ "templates": templates }))
                    }
                    "register_pending_question" => {
                        let options: Vec<crate::state::QuestionOption> = get("options")
                            .cloned()
                            .and_then(|v| serde_json::from_value(v).ok())
                            .ok_or_else(|| "options 参数缺失或非法".to_string())?;
                        core::register_pending_question(
                            sid(),
                            get("callId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            get("header").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            get("multiSelect").and_then(|v| v.as_bool()).unwrap_or(false),
                            options,
                            get("allowCustomInput").and_then(|v| v.as_bool()).unwrap_or(false),
                            s,
                        )
                        .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "register_pending_plan" => {
                        core::register_pending_plan(
                            sid(),
                            get("planId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            get("title").and_then(|v| v.as_str()).map(String::from),
                            get("description").and_then(|v| v.as_str()).map(String::from),
                            s,
                        )
                        .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "get_pending_plans" => {
                        let plans = core::get_pending_plans(
                            get("sessionId").and_then(|v| v.as_str()).map(String::from),
                            s,
                        )
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(plans).map_err(|e| e.to_string())
                    }
                    "get_pending_questions" => {
                        let qs = core::get_pending_questions(
                            get("sessionId").and_then(|v| v.as_str()).map(String::from),
                            s,
                        )
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(qs).map_err(|e| e.to_string())
                    }
                    "clear_processed_plans" => {
                        let removed = core::clear_processed_plans(s).map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "removed": removed }))
                    }
                    "clear_answered_questions" => {
                        let removed =
                            core::clear_answered_questions(s).map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "removed": removed }))
                    }
                    other => Err(unsupported_action("cap.ai.chat", other, SYNC_ACTIONS)),
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

impl StreamingCapability for AiChatCapability {
    fn invoke_stream(
        &self,
        params: Value,
        _ctx: &dyn Context,
    ) -> Result<tokio::sync::mpsc::Receiver<Event>, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("start")
            .to_string();
        let message = params
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let session_id = params.get("sessionId").and_then(|v| v.as_str()).map(String::from);
        let app_paths = self.app_paths();

        if action == "continue" && session_id.is_none() {
            return Err("cap.ai.chat continue 需要 sessionId 参数".into());
        }
        if message.trim().is_empty() {
            return Err("cap.ai.chat 需要 message 参数".into());
        }

        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.ai.chat 流式动作需在 tokio 运行时内调用".to_string())?;
        let (tx, rx) = mpsc::channel(512);
        let callbacks = pump_callbacks(&tx);
        let state = self.state.clone();
        let options: core::ChatRequestOptions = if params.get("options").is_some() {
            serde_json::from_value(params.get("options").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("options 参数非法: {}", e))?
        } else {
            // 顶层字段即选项（action/message/sessionId 之外的 camelCase 字段）
            let mut v = params.clone();
            if let Some(obj) = v.as_object_mut() {
                obj.remove("action");
                obj.remove("sessionId");
            }
            serde_json::from_value(v).map_err(|e| format!("请求参数非法: {}", e))?
        };

        // 失败终态事件的信封要素（options/session_id 随下方 move 进线程，先取出）：
        // contextId 决定前端路由目标（session-<前端UUID>），sessionId 供事件内容。
        let err_ctx = options
            .context_id
            .clone()
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "main".to_string());
        let err_sid = session_id.clone().unwrap_or_default();

        // 业务核 async 调用 → 工作线程 block_on 驱动；事件经回调 → 泵通道
        std::thread::spawn(move || -> Result<(), String> {
            let result: Result<(), String> = match action.as_str() {
                "start" => {
                    // B2.f（审计 3.8）：start 排他（同 invoke 路径，占位仅执行期持有）
                    // 同上：start-gate- 前缀防 lifecycle 幻影会话
                    let gate_key = options
                        .context_id
                        .clone()
                        .filter(|c| !c.is_empty())
                        .map(|c| format!("start-gate-{}", c))
                        .unwrap_or_else(|| format!("start-gate-{}", uuid::Uuid::new_v4()));
                    if let Some(reason) =
                        crate::commands::session_state_commands::session_try_start_inner(
                            &gate_key,
                            "start",
                        )
                        .map_err(|e| e.to_string())?
                    {
                        Err(reason)
                    } else {
                        let start_result = handle
                            .block_on(async {
                                core::start_chat_inner(message, options, state.as_ref(), callbacks, &app_paths)
                                    .await
                            })
                            .map(|_sid| ())
                            .map_err(|e| e.to_message());
                        core::append_session_event(
                            &gate_key,
                            crate::services::session_state::SessionEventType::SessionEnd,
                            Some("start-gate-released".to_string()),
                            None,
                        );
                        start_result
                    }
                }
                "continue" => {
                    let sid = session_id.unwrap_or_default();
                    // 阶段 2 排他锁（流式路径同 invoke）：同一会话仅允许一个 active 操作。
                    // 拒绝时以 match 值（而非闭包 return）携带错误——闭包尾部的
                    // 失败终态分发（error/session_end/stream.error）依赖 result 值，
                    // return 会绕过它导致前端收不到任何收尾事件。
                    if let Some(reason) =
                        crate::commands::session_state_commands::session_try_start_inner(
                            &sid,
                            "stream",
                        )
                        .map_err(|e| e.to_message())?
                    {
                        Err(reason)
                    } else {
                        let continue_result = handle
                            .block_on(async {
                                core::continue_chat_inner(sid.clone(), message, options, state.as_ref(), callbacks, &app_paths)
                                    .await
                            })
                            .map(|_| ());
                        match continue_result {
                            Ok(()) => Ok(()),
                            // 失败补偿：释放占位，避免卡 running
                            Err(e) => {
                                core::append_session_event(
                                    &sid,
                                    crate::services::session_state::SessionEventType::SessionEnd,
                                    Some("error".to_string()),
                                    Some(e.to_message()),
                                );
                                Err(e.to_message())
                            }
                        }
                    }
                }
                other => Err(unsupported_action("cap.ai.chat", other, STREAM_ACTIONS)),
            };
            if let Err(error) = result {
                // 失败终态双通道（spec B3）：
                // 1) 可路由事件对——error + session_end(reason=error)，与引擎错误
                //    路径同构、走 {contextId, payload} 信封，前端 eventRouter 能
                //    路由、eventHandler 能收尾 isStreaming。旧实现只发 stream.error
                //    （无 sessionId、前端零消费者），continue 被排他门拒绝等场景
                //    下前端 isStreaming 永久 true（永远转圈无报错）。
                // 2) stream.error 原始观测通道保留，补 sessionId 字段。
                //    action=start 尚无会话时 sessionId 为空，前端按 contextId 路由
                //    仍可收尾本端流式态。
                let _ = tx.try_send(make_event(
                    "chat-event",
                    serde_json::json!({
                        "contextId": err_ctx,
                        "payload": { "type": "error", "sessionId": err_sid, "error": error }
                    }),
                ));
                let _ = tx.try_send(make_event(
                    "chat-event",
                    serde_json::json!({
                        "contextId": err_ctx,
                        "payload": { "type": "session_end", "sessionId": err_sid, "reason": "error" }
                    }),
                ));
                let _ = tx.try_send(make_event(
                    "stream.error",
                    serde_json::json!({ "action": action, "sessionId": err_sid, "error": error }),
                ));
            }
            // tx 在此 drop → RouterBus 泵任务广播 dispatch.end(stream)
            Ok(())
        });

        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        let d = describe_value();
        let problems = validate_describe("cap.ai.chat", &d);
        assert!(
            problems.is_empty(),
            "describe 应过契约校验: {problems:?}"
        );
        // actions 键与 SYNC_ACTIONS 清单一致（未知动作错误文案与 describe 同源）
        let mut keys: Vec<&str> = d["actions"]
            .as_object()
            .expect("actions 应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected: Vec<&str> = SYNC_ACTIONS.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected, "describe 动作清单应与 SYNC_ACTIONS 一致");
    }
}
