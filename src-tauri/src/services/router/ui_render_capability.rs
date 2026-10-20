//! cap.ui.render —— 可交互渲染入口（P2）
//!
//! 对应 `plans/plugin-cap-inject-render-v1.md` §2.1 / `plans/plugin-manage-hook-inject-v1.md`
//! §5 P2：把「可交互渲染」从 MCP 伴生进程专属提升为 **cap 契约的一等公民**。
//!
//! # 协议（payload `{ "action": "request", ... }`）
//!
//! 任意 cap（含动态注册的 ui-render handler）调用即弹可交互 UI 帧，用户操作后
//! answer 经 oneshot 回传调用方（AI 同回合继续）。**与 plugin_card 问询同构，
//! 复用既有 PendingPluginCard + oneshot + 前端渲染/回填全链路。**
//!
//! ```jsonc
//! { "action": "request",
//!   "sessionId": "session-uuid",      // 必填（前端 respond_plugin_card 回填依赖）
//!   "pluginId": "polaris.ui",        // 归属（卡片 header 显示）
//!   "cardId": "confirm",             // 前端 chatCardRegistry 匹配 key（custom 帧）
//!   "toolName": "ui.render",         // 兜底渲染的卡片名
//!   "title": "确认操作",
//!   "frame": { "type": "confirm", "content": "确定删除？", "danger": true,
//!              /* question: {questions:[...]} / form: {fields:[...]} / custom: {任何} */ } }
//! ```
//!
//! 返回（oneshot 回传，阻塞等待用户应答，超时 180s 按 declined）：
//! ```jsonc
//! { "status": "answered" | "declined" | "timeout",
//!   "answer": { /* question 答案 / form 值 / custom 原始值 */ },
//!   "interactionId": "uuid" }
//! ```
//!
//! # 复用链路
//!
//! - 登记 `PendingPluginCard`（state.pending_plugin_cards）+ oneshot
//!   （`register_plugin_card_answer_sender`）—— 与 ask_listener 同款通道。
//! - 广播 `plugin_card` 事件（`emit_plugin_card_event`，已 pub(crate)）——
//!   前端 eventHandler 已有处理，零前端改动即渲染。
//! - 回填：前端 `respondPluginCard` → `cap.ai.chat respond_plugin_card` →
//!   `ai_chat_core::respond_plugin_card` → oneshot send → 本能力 await 返回。
//!
//! # 安全
//!
//! - frame.type 白名单 {question, form, confirm, custom} + 字段校验；
//! - interactionId 防重放（uuid 由后端生成，登记前检查 pending 表已存在则拒绝）；
//! - 经 RouterBus dispatch 复用权限 gate + 审计（Source::Remote 默认 deny 规则由
//!   policy_permission 控制）。

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::contracts::{Capability, CapabilityId, Context};
use crate::state::{AppState, PendingPluginCard, PluginCardStatus};
use crate::services::ask_listener::{PluginCardOutcome, emit_plugin_card_event};

const CAP_ID: &str = "cap.ui.render";

/// 支持的动作协议
pub const UI_RENDER_ACTIONS: &[&str] = &["request"];

/// frame.type 白名单（v1 渐进内容安全，不做任意 HTML）
const ALLOWED_FRAME_TYPES: &[&str] = &["question", "form", "confirm", "custom"];

/// 等待用户应答超时（与 ask_listener PLUGIN_CARD_TIMEOUT 同值）
const UI_RENDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// cap.ui.render —— 通用可交互渲染入口。
///
/// 依赖注入 `Arc<AppState>`（state.rs 装配提供）：复用 pending_plugin_cards /
/// plugin_card_answer_senders / event_broadcast。
pub struct UiRenderCapability {
    state: Arc<AppState>,
}

impl UiRenderCapability {
    pub fn with_state(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn require_str<'a>(args: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("cap.ui.render 缺少参数: {}", key))
    }

    /// 校验 frame 白名单与必填字段
    fn validate_frame(frame: &Value) -> std::result::Result<(), String> {
        let ftype = frame
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "cap.ui.render frame 缺少 type".to_string())?;
        if !ALLOWED_FRAME_TYPES.contains(&ftype) {
            return Err(format!(
                "cap.ui.render frame.type 不在白名单（{:?}）: {}",
                ALLOWED_FRAME_TYPES, ftype
            ));
        }
        match ftype {
            "question" => {
                if frame.get("questions").is_none() {
                    return Err("cap.ui.render question 帧缺少 questions".to_string());
                }
            }
            "form" => {
                if frame.get("fields").is_none() {
                    return Err("cap.ui.render form 帧缺少 fields".to_string());
                }
            }
            "confirm" => {
                if frame.get("content").is_none() {
                    return Err("cap.ui.render confirm 帧缺少 content".to_string());
                }
            }
            _ => {} // custom：透传，由前端 chatCardRegistry 匹配组件
        }
        Ok(())
    }
}

impl Capability for UiRenderCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "通用可交互渲染：cap 调用即弹可交互 UI 帧，answer oneshot 回传同回合",
            "note": "复用 plugin_card 渲染/回填全链路；frame.type 白名单 question/form/confirm/custom",
            "actions": {
                "request": { "params": { "sessionId": "string（必填）", "pluginId": "string（必填）", "cardId": "string（必填）", "toolName": "string?", "title": "string?", "frame": "object（type 白名单）" }, "returns": "{ status, answer, interactionId }" }
            }
        })
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        if action != "request" {
            return Err(format!("cap.ui.render 仅支持动作 {:?}", UI_RENDER_ACTIONS));
        }

        let session_id = Self::require_str(&params, "sessionId")?.to_string();
        let plugin_id = Self::require_str(&params, "pluginId")?.to_string();
        let card_id = Self::require_str(&params, "cardId")?.to_string();
        let tool_name = params
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("ui.render")
            .to_string();
        let frame = params
            .get("frame")
            .ok_or_else(|| "cap.ui.render 缺少 frame".to_string())?;
        Self::validate_frame(frame)?;

        // 组装前端渲染 payload：title + frame（frame 内嵌 questions/fields/content/自定义）
        let mut payload = json!({
            "title": params.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            "frame": frame,
        });

        let state = self.state.clone();
        // 同步 invoke 驱动 async oneshot 等待（与 ai_chat_capability 同款：
        // block_in_place + Handle::block_on，调用方在 tokio 多线程运行时内）
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.ui.render 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let interaction_id = uuid::Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel::<PluginCardOutcome>();

                // 1. 登记 pending + oneshot sender（复用 ask_listener 通道）
                {
                    let mut pending = state.pending_plugin_cards.lock().map_err(|e| {
                        format!("cap.ui.render pending_plugin_cards 锁: {}", e)
                    })?;
                    if pending.contains_key(&interaction_id) {
                        return Err(format!(
                            "cap.ui.render interactionId 冲突（防重放）: {}",
                            interaction_id
                        ));
                    }
                    pending.insert(
                        interaction_id.clone(),
                        PendingPluginCard {
                            interaction_id: interaction_id.clone(),
                            session_id: session_id.clone(),
                            call_id: None,
                            plugin_id: plugin_id.clone(),
                            card_id: card_id.clone(),
                            tool_name: tool_name.clone(),
                            payload: payload.clone(),
                            status: PluginCardStatus::Pending,
                        },
                    );
                }
                state.register_plugin_card_answer_sender(&interaction_id, tx);

                // 2. 广播 plugin_card 事件 → 前端渲染（零改动复用 eventHandler）
                emit_plugin_card_event(
                    &state,
                    &session_id,
                    &interaction_id,
                    &plugin_id,
                    &card_id,
                    &tool_name,
                    payload,
                );

                // 3. 等待用户应答（前端 respondPluginCard → respond_plugin_card → oneshot）
                match tokio::time::timeout(UI_RENDER_TIMEOUT, rx).await {
                    Ok(Ok(outcome)) => {
                        // 清理 pending（应答已回）
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        if outcome.declined {
                            Ok(json!({
                                "status": "declined",
                                "answer": Value::Null,
                                "interactionId": interaction_id,
                            }))
                        } else {
                            Ok(json!({
                                "status": "answered",
                                "answer": outcome.result,
                                "interactionId": interaction_id,
                            }))
                        }
                    }
                    Ok(Err(_recv_err)) => {
                        // oneshot 被丢弃，按 declined 处理
                        tracing::info!(
                            "[cap.ui.render] interaction_id={} oneshot 被丢弃，按 declined 处理",
                            interaction_id
                        );
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        Ok(json!({
                            "status": "declined",
                            "answer": Value::Null,
                            "interactionId": interaction_id,
                        }))
                    }
                    Err(_elapsed) => {
                        tracing::info!(
                            "[cap.ui.render] interaction_id={} 超时，按 declined 处理",
                            interaction_id
                        );
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        Ok(json!({
                            "status": "timeout",
                            "answer": Value::Null,
                            "interactionId": interaction_id,
                        }))
                    }
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}