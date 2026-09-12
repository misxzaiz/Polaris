//! cap.ai.chat —— 第一个真实流式能力（第六步阶段 C1 薄包装）
//!
//! 对应 `dev/docs/sky/step6-ai-streaming.md` §2.C：把 AI 引擎执行接入 dispatch
//! 总线的流式通道。定位是**新消费方专用通道**（scheduler 任务 / agent / 第三方），
//! 现有聊天 UI 继续走 `start_chat` 命令——两条通道并行，chat.rs 簿记全量上总线
//! （C2）另行评估。
//!
//! # 设计要点
//!
//! - **能力自持引擎句柄**：契约 Context 是借用且不可跨 spawn（StreamingCapability
//!   返回的 Receiver 活得比 ctx 久），`engine_registry` Arc 在注册点捕获
//!   （`state.rs` create_app_state），tokio Mutex 在工作线程上用 `blocking_lock`。
//! - **chat-event 线格式兼容**：事件统一发
//!   `Event{kind:"chat-event", payload:{contextId, payload:<AIEvent>}}`，
//!   经 EventAdapter 编码后与 `broadcast_chat_event` 的 WS 输出逐字节同形
//!   （chat.rs:1989-1996），前端 EventRouter / conversationStore 零改动可消费。
//!   默认 `contextId = "capai-<uuid>"`（不落任何前端会话桶）；调用方传
//!   `"session-<id>|main"` 可直接渲染进现有聊天 UI。
//! - **SessionEnd 关流**：engine 会话结束时关闭事件门（gate），RouterBus 泵任务
//!   感知 sender 全关后广播 `dispatch.end(stream)` 收尾。
//! - **C1 不含**（对齐 step6 §2.C 清单）：pending_plans / dispatched_tasks 簿记、
//!   Profile failover 统计、usage_db 挂钩（用量仍由引擎解析器层记录）。
//!
//! # 动作协议（payload `{ "action": ... }`，均走 dispatch_stream）
//!
//! - `start`     `{ "message", "engineId"?, "workDir"?, "systemPrompt"?,
//!                 "allowedTools"?, "contextId"?, "clientMessageId"? }`
//! - `continue`  `{ "sessionId", "engineId", "message", ...同上 }`
//! - `interrupt` `{ "sessionId" }`
//!
//! 引擎级失败经 `Event{kind:"stream.error", payload:{action, error}}` 报告；
//! 参数缺失在 invoke_stream 内同步返回 Err（流未建立）。

use crate::ai::registry::EngineRegistry;
use crate::ai::traits::{EngineId, SessionOptions};
use crate::contracts::{Capability, CapabilityId, Context, Event, StreamingCapability, TraceId, Value};
use crate::models::ai_event::AIEvent;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// cap.ai.chat —— AI 聊天流式能力
pub struct AiChatCapability {
    engine_registry: Arc<tokio::sync::Mutex<EngineRegistry>>,
}

impl AiChatCapability {
    pub fn new(engine_registry: Arc<tokio::sync::Mutex<EngineRegistry>>) -> Self {
        Self { engine_registry }
    }
}

/// 事件门：回调经此发事件；会话结束（on_complete/on_error）时 take() 关流
type EventGate = Arc<Mutex<Option<mpsc::Sender<Event>>>>;

fn make_event(kind: &str, payload: Value) -> Event {
    Event {
        seq: 0,
        kind: kind.into(),
        payload,
        trace: TraceId("cap.ai.chat".into()),
    }
}

impl Capability for AiChatCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.ai.chat".into())
    }

    fn invoke(&self, _params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        Err("cap.ai.chat 是流式能力，请走 dispatch_stream".into())
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
        let session_id = params.get("sessionId").and_then(|s| s.as_str()).map(String::from);
        let engine_id_param = params.get("engineId").and_then(|s| s.as_str()).map(String::from);
        let work_dir = params.get("workDir").and_then(|s| s.as_str()).map(String::from);
        let system_prompt = params.get("systemPrompt").and_then(|s| s.as_str()).map(String::from);
        let client_message_id =
            params.get("clientMessageId").and_then(|s| s.as_str()).map(String::from);
        let allowed_tools: Vec<String> = params
            .get("allowedTools")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // 凭证/配置透传（薄管道，无逻辑）：正常聊天由 chat.rs 经模型 Profile 注入，
        // 本通道由调用方显式传入（step6 §2.C1 边界：不做 Profile 解析）
        let env_overrides: std::collections::HashMap<String, String> = params
            .get("envOverrides")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let settings_overlay_path =
            params.get("settingsOverlayPath").and_then(|s| s.as_str()).map(String::from);
        let mcp_config_path =
            params.get("mcpConfigPath").and_then(|s| s.as_str()).map(String::from);

        // 参数校验（流建立前同步失败）
        match action.as_str() {
            "start" if message.trim().is_empty() => {
                return Err("cap.ai.chat start 需要 message 参数".into());
            }
            "continue" => {
                if session_id.is_none() || engine_id_param.is_none() || message.trim().is_empty() {
                    return Err(
                        "cap.ai.chat continue 需要 sessionId / engineId / message 参数".into(),
                    );
                }
            }
            "interrupt" if session_id.is_none() => {
                return Err("cap.ai.chat interrupt 需要 sessionId 参数".into());
            }
            "start" | "continue" | "interrupt" => {}
            other => return Err(format!("cap.ai.chat 不支持动作: {}", other)),
        }

        let (tx, rx) = mpsc::channel::<Event>(256);
        let tx_gate: EventGate = Arc::new(Mutex::new(Some(tx)));
        let registry = self.engine_registry.clone();
        let action_for_thread = action.clone();

        std::thread::spawn(move || {
            let context_id = params
                .get("contextId")
                .and_then(|s| s.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("capai-{}", uuid::Uuid::new_v4()));

            let run = || -> Result<Value, String> {
                // 工作线程（无异步上下文）上锁 tokio Mutex
                let mut registry = registry.blocking_lock();
                let engine_str = engine_id_param
                    .clone()
                    .unwrap_or_else(|| "claude-code".into());
                let engine_id = EngineId::parse_any(&engine_str);

                let engine_str_for_cb = engine_str.clone();
                let context_id_for_cb = context_id.clone();
                let tx_gate_cb = tx_gate.clone();
                let event_callback = move |event: AIEvent| {
                    // 对齐 chat.rs:1168-1178：SessionStart 注入 engineId（前端绑引擎）
                    let payload = match &event {
                        AIEvent::SessionStart(_) => {
                            serde_json::to_value(&event).ok().map(|mut v| {
                                if let Some(obj) = v.as_object_mut() {
                                    obj.insert(
                                        "engineId".into(),
                                        serde_json::Value::String(engine_str_for_cb.clone()),
                                    );
                                }
                                v
                            })
                        }
                        _ => serde_json::to_value(&event).ok(),
                    };
                    let Some(payload) = payload else { return };
                    let ev = Event {
                        seq: 0,
                        kind: "chat-event".into(),
                        payload: serde_json::json!({
                            "contextId": context_id_for_cb,
                            "payload": payload
                        }),
                        trace: TraceId("cap.ai.chat".into()),
                    };
                    if let Some(tx) = tx_gate_cb.lock().unwrap().as_ref() {
                        let _ = tx.try_send(ev);
                    }
                };
                let mut opts = SessionOptions::new(event_callback);
                opts.work_dir = work_dir;
                opts.system_prompt = system_prompt;
                opts.allowed_tools = allowed_tools;
                opts.client_message_id = client_message_id;
                opts.env_overrides = env_overrides;
                opts.settings_overlay_path = settings_overlay_path;
                opts.mcp_config_path = mcp_config_path;

                // 会话结束 / 引擎级错误 → 关流（gate.take() 丢弃 Sender，
                // 泵任务感知通道关闭后广播 dispatch.end 收尾）
                let gate_complete = tx_gate.clone();
                opts.on_complete = Some(Arc::new(move |_exit_code| {
                    if let Some(tx) = gate_complete.lock().unwrap().take() {
                        drop(tx);
                    }
                }));
                let gate_err = tx_gate.clone();
                let action_for_err = action_for_thread.clone();
                opts.on_error = Some(Arc::new(move |error: String| {
                    if let Some(tx) = gate_err.lock().unwrap().take() {
                        let _ = tx.try_send(make_event(
                            "stream.error",
                            serde_json::json!({ "action": action_for_err, "error": error }),
                        ));
                        drop(tx);
                    }
                }));

                match action_for_thread.as_str() {
                    "start" => {
                        let engine_opt = Some(engine_id);
                        let session_id = registry
                            .start_session(engine_opt, &message, opts)
                            .map_err(|e| e.to_message())?;
                        // 对齐 chat.rs:1205-1212 的 session_id_update 合成事件
                        if let Some(tx) = tx_gate.lock().unwrap().as_ref() {
                            let _ = tx.try_send(make_event(
                                "chat-event",
                                serde_json::json!({
                                    "contextId": context_id,
                                    "payload": {
                                        "type": "session_start",
                                        "sessionId": session_id,
                                        "engineId": engine_str,
                                    }
                                }),
                            ));
                        }
                        Ok(serde_json::json!({ "sessionId": session_id }))
                    }
                    "continue" => {
                        let sid = session_id.clone().unwrap_or_default();
                        registry
                            .continue_session(engine_id, &sid, &message, opts)
                            .map_err(|e| e.to_message())?;
                        Ok(Value::Null)
                    }
                    "interrupt" => {
                        let sid = session_id.clone().unwrap_or_default();
                        let interrupted = registry.try_interrupt_all(&sid);
                        Ok(serde_json::json!({ "interrupted": interrupted }))
                    }
                    other => Err(format!("cap.ai.chat 不支持动作: {}", other)),
                }
            };

            let result = run();
            if let Err(error) = &result {
                if let Some(tx) = tx_gate.lock().unwrap().take() {
                    let _ = tx.try_send(make_event(
                        "stream.error",
                        serde_json::json!({ "action": action_for_thread, "error": error }),
                    ));
                    drop(tx);
                }
            }
            // interrupt 成功也主动关流（引擎停止发事件）
            if action_for_thread == "interrupt" {
                if let Some(tx) = tx_gate.lock().unwrap().take() {
                    drop(tx);
                }
            }
        });

        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestCtx;
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &crate::contracts::Source {
            static S: crate::contracts::Source = crate::contracts::Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            static C: crate::contracts::PluginId = crate::contracts::PluginId(String::new());
            &C
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_cap() -> (AiChatCapability, Arc<tokio::sync::Mutex<EngineRegistry>>) {
        use std::sync::atomic::AtomicU64 as A;
        static C: A = A::new(0);
        C.fetch_add(1, Ordering::SeqCst);
        let registry = Arc::new(tokio::sync::Mutex::new(EngineRegistry::new()));
        (AiChatCapability::new(registry.clone()), registry)
    }

    #[test]
    fn invoke_sync_returns_hint() {
        let (cap, _reg) = make_cap();
        let ctx = TestCtx;
        let r = cap.invoke(serde_json::json!({}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("dispatch_stream"));
    }

    #[test]
    fn start_without_message_fails_sync() {
        let (cap, _reg) = make_cap();
        let ctx = TestCtx;
        let r = cap.invoke_stream(serde_json::json!({"action": "start"}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("message"));
    }

    #[test]
    fn continue_requires_session_and_engine() {
        let (cap, _reg) = make_cap();
        let ctx = TestCtx;
        let r = cap.invoke_stream(
            serde_json::json!({"action": "continue", "message": "hi"}),
            &ctx,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("sessionId"));
    }

    #[test]
    fn unknown_action_fails_sync() {
        let (cap, _reg) = make_cap();
        let ctx = TestCtx;
        let r = cap.invoke_stream(serde_json::json!({"action": "explode"}), &ctx);
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn start_with_unknown_engine_emits_stream_error_then_closes() {
        let (cap, _reg) = make_cap();
        let ctx = TestCtx;
        let mut rx = cap
            .invoke_stream(
                serde_json::json!({"action": "start", "message": "hi", "engineId": "no-such-engine"}),
                &ctx,
            )
            .unwrap();
        let mut saw_error = false;
        while let Some(ev) = rx.recv().await {
            if ev.kind == "stream.error" {
                saw_error = true;
                assert!(ev.payload["error"].as_str().unwrap().contains("no-such-engine"));
            }
        }
        assert!(saw_error, "未知引擎应在流上报告 stream.error 后关流");
    }
}
