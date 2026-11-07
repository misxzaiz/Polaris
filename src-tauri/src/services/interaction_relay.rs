//! 交互中继（Interaction Relay）—— 插件交互工具（form/ask/组件 wait）的宿主基础支持
//!
//! 定位（plugin-ui-contribution-spec §3 修订 + 交互组件 v2 规划）：
//! - **工具与阻塞执行在插件**（Node MCP server 本地挂起，等回包唤醒——ask_mcp_server 已验证模式）
//! - **信任边界在宿主**（form_core 脱敏/超时/审计不动）
//! - **本模块提供中继**：插件拉起交互 → 宿主广播事件到正确的前端会话 → 用户提交 →
//!   宿主把回执 POST 回插件的 callbackUrl → 插件 tools/call 返回，AI 同回合继续。
//!
//! 修复的核心缺陷：`emit_form_event`/ask 广播的 contextId 用了后端 conversationId，
//! 前端 eventRouter 路由不上（`session-<前端uuid>` 才是路由 key）。本中继在服务端
//! 用 SessionRecord.conversation_id 反查前端会话 id，构造正确信封——路由缺陷即消除。
//!
//! 端点协议（插件 server ↔ 宿主）：
//! - `POST /api/interaction/begin`  body {conversationId, kind: "form"|"ask", decl, callbackUrl, callbackToken}
//!   → {ok, interactionId}   宿主广播 form/question 事件（带正确 contextId）
//! - `POST /api/interaction/cancel` body {interactionId} —— 用户跳过/超时，宿主通知插件收尾
//! - 超时：FORM_WAIT_TIMEOUT_SECS 到期宿主主动 POST callbackUrl {status:"timeout"}
//!
//! 安全：callbackToken 由 begin 时插件自报、回执时回传校验（防本地伪造回包）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::session_state::SessionStateDb;

/// 一次进行中的交互
#[derive(Debug, Clone)]
pub struct RelayEntry {
    pub interaction_id: String,
    pub conversation_id: String,
    pub kind: String, // "form" | "ask"
    pub callback_url: String,
    pub callback_token: String,
    pub created_at: Instant,
}

/// 全局中继表（begin 登记 / 提交认领 / 超时清理）
static RELAY: Mutex<Option<relay::Relay>> = Mutex::new(None);

pub(crate) mod relay {
    use super::{RelayEntry, FORM_WAIT_TIMEOUT_SECS};
    use std::collections::HashMap;
    use std::time::Instant;

    pub struct Relay {
        pub entries: HashMap<String, RelayEntry>,
        pub timeouts: Vec<(String, Instant)>, // (interaction_id, deadline)
    }

    impl Relay {
        pub fn new() -> Self {
            Self { entries: HashMap::new(), timeouts: Vec::new() }
        }
        pub fn insert(&mut self, id: String, e: RelayEntry) {
            self.timeouts.retain(|(iid, _)| iid != &id);
            self.timeouts.push((id.clone(), e.created_at + FORM_WAIT_TIMEOUT_SECS));
            self.entries.insert(id, e);
        }
        pub fn take(&mut self, id: &str) -> Option<RelayEntry> {
            self.timeouts.retain(|(iid, _)| iid != id);
            self.entries.remove(id)
        }
        pub fn expire(&mut self) -> Vec<(String, String, String)> {
            // 返回 (interaction_id, callback_url, callback_token) 已到期列表
            let now = Instant::now();
            let expired: Vec<String> = self.timeouts.iter().filter(|(_, d)| *d <= now).map(|(id, _)| id.clone()).collect();
            let mut out = Vec::new();
            for id in expired {
                self.timeouts.retain(|(iid, _)| iid != &id);
                if let Some(e) = self.entries.remove(&id) { out.push((id, e.callback_url, e.callback_token)); }
            }
            out
        }
    }
}

/// 表单等待时长（与 form_flow::FORM_WAIT_TIMEOUT_SECS 对齐；中继自带超时兜底）
pub const FORM_WAIT_TIMEOUT_SECS: Duration = Duration::from_secs(600);

// ─── conversationId → 前端会话 uuid 反查 ────────────────────────────────────

/// 反查：后端 conversationId（simple-ai-… / claude-…）→ 前端会话 uuid。
/// 依据 SessionRecord.conversation_id（前端 session_register 时写入）。
/// 返回 None 表示查不到（会话未注册——前端没走 session_register 路径，如直连引擎）。
fn frontend_session_id(conversation_id: &str) -> Result<Option<String>> {
    let records = list_records_cached()?;
    Ok(records
        .into_iter()
        .find(|r| r.conversation_id.as_deref() == Some(conversation_id))
        .map(|r| r.id))
}

/// session list 走 db()（SessionStateDb 全局单例）
fn list_records_cached() -> Result<Vec<crate::services::session_state::SessionRecord>> {
    // 直接读 registry（SessionStateDb::list_records）
    let db = session_db()?;
    let recs = db.list_records().map_err(|e| AppError::StateError(format!("中继读会话表失败: {}", e)))?;
    Ok(recs)
}

fn session_db() -> Result<std::sync::Arc<SessionStateDb>> {
    crate::commands::session_state_commands::db()
        .map_err(|e| AppError::StateError(format!("中继开会话库失败: {}", e)))
}

// ─── 广播（复用 ask_listener 的 emit_chat_event 通道，但信封用前端会话 id） ──

static BROADCASTER: Mutex<Option<std::sync::Arc<crate::web::EventBroadcaster>>> = Mutex::new(None);

/// 启动时注入（state.rs AppState 构建）
pub fn set_broadcaster(tx: std::sync::Arc<crate::web::EventBroadcaster>) {
    if let Ok(mut g) = BROADCASTER.lock() {
        *g = Some(tx);
    }
}

fn broadcast_to_frontend(frontend_id: &str, payload: Value) {
    let guard = match BROADCASTER.lock() {
        Ok(g) => g,
        Err(_) => { tracing::warn!("[Relay] 广播通道锁中毒"); return; }
    };
    let Some(tx) = guard.as_ref() else {
        tracing::warn!("[Relay] 广播通道未注入");
        return;
    };
    let ws_msg = json!({
        "event": "chat-event",
        "payload": { "contextId": format!("session-{}", frontend_id), "payload": payload },
    });
    let _ = tx.send(serde_json::to_string(&ws_msg).unwrap_or_default());
}

// ─── begin / submit-notify 端点实现（HTTP 桥 + Tauri command 双入口） ───────

/// 插件拉起交互：广播事件 + 登记 callback
pub fn interaction_begin(args: &Value) -> Result<Value> {
    let conversation_id = str_field(args, "conversationId")?;
    let kind = str_field(args, "kind")?; // "form" | "ask"
    let decl = args.get("decl").cloned().unwrap_or(Value::Null);
    let callback_url = str_field(args, "callbackUrl")?;
    let callback_token = str_field(args, "callbackToken")?;

    let frontend_id = frontend_session_id(&conversation_id)?
        .ok_or_else(|| AppError::StateError(format!(
            "交互中继：conversationId={} 未在前端注册（无 session_register 记录）", conversation_id
        )))?;

    let interaction_id = format!("ic-{}", uuid::Uuid::new_v4());
    let payload_type = if kind == "form" { "form" } else { "question" };

    // 广播事件：contextId 用前端会话 id（路由缺陷修复核心）
    let mut payload = decl.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("type".into(), Value::String(payload_type.into()));
        obj.insert("sessionId".into(), Value::String(frontend_id.clone()));
    } else {
        return Err(AppError::ValidationError("decl 必须是对象".into()));
    }
    broadcast_to_frontend(&frontend_id, payload);

    // 登记回调
    let entry = RelayEntry {
        interaction_id: interaction_id.clone(),
        conversation_id: conversation_id,
        kind: kind,
        callback_url,
        callback_token,
        created_at: Instant::now(),
    };
    with_relay(|r| r.insert(interaction_id.clone(), entry))?;

    Ok(json!({ "ok": true, "interactionId": interaction_id }))
}

/// 用户提交后把回执转发回插件（form_submit 分发处调用）
pub fn interaction_notify(form_id: &str, receipt: &str, skipped: bool) -> Result<()> {
    let entry = match with_relay(|r| r.take(form_id))? { Some(e) => e, None => return Ok(()) };
    // POST 回插件；失败仅记日志（插件超时自兜底）
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post(&entry.callback_url)
        .json(&json!({
            "status": if skipped { "skipped" } else { "submitted" },
            "receipt": receipt,
            "token": entry.callback_token,
        }))
        .timeout(Duration::from_secs(5))
        .send();
    Ok(())
}

/// 超时扫描（由 form_submit 的既有清理路径或定期任务调用）
pub fn interaction_sweep() {
    let expired = match with_relay(|r| { r.expire() }) {
        Ok(v) => v,
        Err(_) => return,
    };
    for (_id, url, token) in expired {
        let client = reqwest::blocking::Client::new();
        let _ = client.post(&url).json(&json!({"status": "timeout", "token": token}))
            .timeout(Duration::from_secs(5)).send();
    }
}

fn with_relay<T>(f: impl FnOnce(&mut relay::Relay) -> T) -> Result<T> {
    let mut guard = RELAY.lock().map_err(|_| AppError::StateError("中继表锁中毒".into()))?;
    let slot = guard.get_or_insert_with(|| relay::Relay::new());
    Ok(f(slot))
}

fn str_field(args: &Value, key: &str) -> Result<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
        .ok_or_else(|| AppError::ValidationError(format!("interaction begin 缺少 {}", key)))
}
