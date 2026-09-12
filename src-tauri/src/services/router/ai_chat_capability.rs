//! cap.ai.chat —— AI 聊天流式能力（第七步阶段 A2：唯一实现，接 ai_chat_core 业务核）
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 A：`commands/chat.rs` 已摘除，
//! 本能力是 AI 会话的**唯一入口**：
//! - 流式动作（dispatch_stream）：`start` / `continue` —— 经业务核
//!   `start_chat_inner` / `continue_chat_inner`，事件走 ChatCallbacks → 本能力
//!   泵通道 → RouterBus 泵任务 → EventAdapter（chat-event 线格式与历史一致）
//! - 同步动作（dispatch）：`interrupt` / `send_input` / `approve_plan` /
//!   `reject_plan` / `answer_question` / `respond_plugin_card` /
//!   `register_pending_question` / `register_pending_plan` / `get_pending_plans` /
//!   `get_pending_questions` / `clear_processed_plans` / `clear_answered_questions`
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
use crate::contracts::{Capability, CapabilityId, Context, Event, StreamingCapability, TraceId, Value};
use std::sync::Arc;
use tokio::sync::mpsc;

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

/// 业务核回调 → 流通道（emit_event 收到的已是 {contextId, payload} 信封）
fn pump_callbacks(tx: &mpsc::Sender<Event>) -> core::ChatCallbacks {
    let tx = tx.clone();
    core::ChatCallbacks {
        emit_event: Arc::new(move |json| {
            let _ = tx.try_send(make_event("chat-event", json));
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
                            let ev = make_event("chat-event", json);
                            match &pump_tx {
                                Some(tx) => {
                                    let _ = tx.try_send(ev);
                                }
                                None => adapter.broadcast(ev),
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
                            let sid = core::start_chat_inner(message, options, s, callbacks, &app_paths)
                                .await
                                .map_err(|e| e.to_message())?;
                            Ok(serde_json::json!(sid))
                        } else {
                            let sid = sid();
                            core::continue_chat_inner(sid, message, options, s, callbacks, &app_paths)
                                .await
                                .map_err(|e| e.to_message())?;
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
                            .ok_or_else(|| "answer 参数缺失或非法".to_string())?;
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
                    other => Err(format!("cap.ai.chat 不支持同步动作: {}", other)),
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

        // 业务核 async 调用 → 工作线程 block_on 驱动；事件经回调 → 泵通道
        std::thread::spawn(move || {
            let result: Result<(), String> = match action.as_str() {
                "start" => handle
                    .block_on(async {
                        core::start_chat_inner(message, options, state.as_ref(), callbacks, &app_paths)
                            .await
                    })
                    .map(|_sid| ())
                    .map_err(|e| e.to_message()),
                "continue" => {
                    let sid = session_id.unwrap_or_default();
                    handle
                        .block_on(async {
                            core::continue_chat_inner(sid, message, options, state.as_ref(), callbacks, &app_paths)
                                .await
                        })
                        .map(|_| ())
                        .map_err(|e| e.to_message())
                }
                other => Err(format!("cap.ai.chat 不支持流式动作: {}", other)),
            };
            if let Err(error) = result {
                let _ = tx.try_send(make_event(
                    "stream.error",
                    serde_json::json!({ "action": action, "error": error }),
                ));
            }
            // tx 在此 drop → RouterBus 泵任务广播 dispatch.end(stream)
        });

        Ok(rx)
    }
}
