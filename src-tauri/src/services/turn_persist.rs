//! 后端权威消息持久化（S6：消息真相下沉后端）
//!
//! 目标：客户端（web / 移动端）在 AI 回复途中关闭时回复不丢失；任意端重新打开都能
//! 看到完整（含被中断的）会话；多端共享同一份真相。
//!
//! 设计（详见 `plans/session-rearchitecture/S6-消息持久化后端权威.md`）：
//! - AI 事件流是唯一输入；按 `conversation_id`（= 引擎 session_id）维护「当前轮」缓冲。
//! - 缓冲中的 assistant 消息带 `isStreaming: true`，节流写入 `session_messages`（SQLite）。
//! - 轮末（`SessionEnd`）落定 `isStreaming: false`，并把该会话**全量导出**为 JSONL 归档
//!   （复用既有 `dialog_write_inner` → 历史索引 / FTS 增量维护，历史面板零改动）。
//! - 后端启动时把残留的 `isStreaming: true` 落定为中断态并补一次导出
//!   （覆盖后端进程被强杀的场景）。
//!
//! 消息 id 由后端分配并经事件 `messageId` 字段下发，前端 adopt 同一 id；轮末前端用
//! canonical ChatMessage 覆盖（`message_revise`），保证归档保真（富块不降级）。
//!
//! 失败一律只告警不阻断主流程（影子语义）。

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::models::{AIEvent, SessionEndReason};

/// 节流写库间隔（ms）：流式 token 高频，按时间窗合并写入。
const FLUSH_INTERVAL_MS: i64 = 600;


/// 单会话「当前轮」累加缓冲。
#[derive(Debug, Clone)]
struct Turn {
    conversation_id: String,
    /// 后端分配的消息 id（同一下发到事件 `messageId`，前端 adopt）
    message_id: String,
    engine_id: String,
    started_at_ms: i64,
    last_write_ms: i64,
    /// 与前端 ChatMessage.blocks 同构的内容块
    blocks: Vec<Value>,
    /// 最近一次写入库的内容；用于轮末判定「库中最新版是否仍是本累加器所写」
    last_written: Option<Value>,
    /// 是否有过实际内容（防空消息入档）
    dirty: bool,
}

fn turns() -> &'static Mutex<HashMap<String, Turn>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Turn>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 待落库的用户请求（FIFO）。
///
/// 为什么需要它：`start` 的**返回值并不是事件流使用的会话 id**（实测 claude-code：
/// 返回 temp id，事件带引擎真实会话 id，前端最终以事件 id 作为 conversationId）。
/// 因此用户消息不能在请求入口直接落库——必须等本轮第一个事件到达、拿到「事件会话 id」
/// 后再写，才能与会话下的 assistant 消息同属一个 conversation_id。
fn pending_user_requests() -> &'static Mutex<VecDeque<PendingUser>> {
    static PENDING: OnceLock<Mutex<VecDeque<PendingUser>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(VecDeque::new()))
}

struct PendingUser {
    content: String,
    client_message_id: Option<String>,
    at: std::time::Instant,
}

/// 待落库用户请求的存活上限：超时未等到轮次首事件（引擎启动失败等）即丢弃，
/// 避免被后续轮次误认领、写进错误会话。
const PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(30);
/// 待落库队列上限（并发 start 亦极少超过）
const PENDING_MAX: usize = 4;

/// 登记一次用户请求（start 路径调用），待该轮首个事件到达时落库。
pub fn record_user_request(content: &str, client_message_id: Option<&str>) {
    if content.is_empty() {
        return;
    }
    if let Ok(mut q) = pending_user_requests().lock() {
        q.push_back(PendingUser {
            content: content.to_string(),
            client_message_id: client_message_id.map(str::to_string),
            at: std::time::Instant::now(),
        });
        while q.len() > PENDING_MAX {
            q.pop_front();
        }
    }
}

/// 轮次开始（该会话首个 assistant 侧事件）：把最早登记的待落库请求写到该会话下。
fn flush_pending_user_request(conversation_id: &str) {
    let existed = turns()
        .lock()
        .map(|m| m.contains_key(conversation_id))
        .unwrap_or(true);
    if existed {
        return; // 本轮已开始，不是轮次首事件
    }
    let pending = pending_user_requests().lock().ok().and_then(|mut q| {
        while let Some(front) = q.front() {
            if front.at.elapsed() <= PENDING_TTL {
                break;
            }
            q.pop_front(); // 过期条目：丢弃，避免误认领
        }
        q.pop_front()
    });
    if let Some(p) = pending {
        append_user_message(conversation_id, &p.content, p.client_message_id.as_deref());
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// epoch ms → ISO 8601（与前端 `Date#toISOString` 同形，如 `2026-10-15T08:07:39.192Z`）
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// ISO 8601 → epoch ms（解析失败返回 None）
fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

// ============================================================================
// 事件入口
// ============================================================================

/// 观察一个 AI 事件：累加当前轮 / 轮末落定并归档（前端不受影响，纯旁路）。
pub fn observe(event: &AIEvent, engine: &str) {
    // 轮次首事件 → 先落库本轮的用户请求（详见 `pending_user_requests` 注释）
    if matches!(
        event,
        AIEvent::Token(_)
            | AIEvent::AssistantMessage(_)
            | AIEvent::Thinking(_)
            | AIEvent::ToolCallStart(_)
            | AIEvent::ToolCallUpdate(_)
            | AIEvent::ToolCallEnd(_)
    ) {
        flush_pending_user_request(event.session_id());
    }
    match event {
        AIEvent::UserMessage(m) => {
            // 用户消息的后端落库不在事件路径上（部分引擎不回显 user 事件，如 claude-code
            // --print），统一由请求入口 `record_user_message` 写入；此处只做轮次边界处理：
            // 新用户消息 = 新一轮开始，丢弃上一轮残留缓冲（防御 SessionEnd 丢失）。
            forget(&m.session_id);
        }

        AIEvent::Token(e) => {
            let should_flush = mutate_turn(&e.session_id, engine, |t| push_text(t, &e.value));
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::AssistantMessage(e) => {
            let should_flush = mutate_turn(&e.session_id, engine, |t| push_text(t, &e.content));
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::Thinking(e) => {
            let should_flush = mutate_turn(&e.session_id, engine, |t| push_thinking(t, &e.content));
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::ToolCallStart(e) => {
            let call_id = e
                .call_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4()));
            let name = e.tool.clone();
            let input = Value::Object(e.args.clone().into_iter().collect());
            let should_flush = mutate_turn(&e.session_id, engine, move |t| {
                push_tool_start(t, &call_id, &name, input)
            });
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::ToolCallUpdate(e) => {
            let call_id = e.call_id.clone();
            let output = e.output.clone();
            let tool = e.tool.clone();
            let should_flush = mutate_turn(&e.session_id, engine, |t| {
                update_tool_output(t, call_id.as_deref(), &tool, &output, false)
            });
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::ToolCallEnd(e) => {
            let call_id = e.call_id.clone();
            let tool = e.tool.clone();
            let output = e.result.as_ref().map(value_to_text);
            let success = e.success;
            let should_flush = mutate_turn(&e.session_id, engine, |t| {
                match output.as_deref() {
                    Some(out) => update_tool_output(t, call_id.as_deref(), &tool, out, false),
                    None => {}
                }
                finalize_tool(t, call_id.as_deref(), &tool, success);
            });
            if should_flush {
                flush_turn(&e.session_id);
            }
        }

        AIEvent::SessionEnd(e) => {
            let interrupted = !matches!(e.reason, Some(SessionEndReason::Completed));
            finalize_turn(&e.session_id, interrupted);
        }

        // 错误事件：轮次可能不会再有 assistant 内容，先落定已累积的部分
        AIEvent::Error(e) => {
            finalize_turn(&e.session_id, true);
        }

        _ => {}
    }
}

/// 会话被删除 / 外部清理时丢弃缓冲
pub fn forget(conversation_id: &str) {
    if let Ok(mut map) = turns().lock() {
        map.remove(conversation_id);
    }
}

/// 进程启动恢复：把 store 中残留 `isStreaming: true` 的消息落定为中断态并补导出。
pub fn recover_pending_turns() {
    let pending = match crate::services::session_db::pending_streaming_conversations() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[TurnPersist] 查询残留流式会话失败: {}", e);
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    tracing::info!("[TurnPersist] 启动恢复 {} 个残留流式会话", pending.len());
    for (conversation_id, _id) in pending {
        if let Err(e) = normalize_interrupted(&conversation_id) {
            tracing::warn!("[TurnPersist] 残留轮次归一失败 {}: {}", conversation_id, e);
        }
        archive_conversation(&conversation_id);
    }
}

// ============================================================================
// 缓冲操作
// ============================================================================

fn new_turn(conversation_id: &str, engine: &str) -> Turn {
    let ts = now_ms();
    Turn {
        conversation_id: conversation_id.to_string(),
        message_id: format!("{}#a{}{}", conversation_id, ts, next_seq()),
        engine_id: engine.to_string(),
        started_at_ms: ts,
        last_write_ms: 0,
        blocks: Vec::new(),
        last_written: None,
        dirty: false,
    }
}

/// 每进程单调递增后缀，避免同毫秒分配出相同 id
fn next_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::SeqCst)
}

/// 在锁内修改当前轮，返回是否需要落库（节流）
fn mutate_turn<F: FnOnce(&mut Turn)>(conversation_id: &str, engine: &str, f: F) -> bool {
    let Ok(mut map) = turns().lock() else {
        return false;
    };
    let t = map
        .entry(conversation_id.to_string())
        .or_insert_with(|| new_turn(conversation_id, engine));
    f(t);
    t.dirty && now_ms() - t.last_write_ms >= FLUSH_INTERVAL_MS
}

/// 文本块累加（连续文本并入末个 text 块，与前端 `appendTextBlock` 同规则）
fn push_text(t: &mut Turn, text: &str) {
    if text.is_empty() {
        return;
    }
    t.dirty = true;
    if let Some(last) = t.blocks.last_mut() {
        if last.get("type").and_then(Value::as_str) == Some("text") {
            let cur = last.get("content").and_then(Value::as_str).unwrap_or("").to_string();
            last["content"] = Value::String(cur + text);
            return;
        }
    }
    t.blocks.push(json!({ "type": "text", "content": text }));
}

/// 思考块累加
fn push_thinking(t: &mut Turn, content: &str) {
    if content.is_empty() {
        return;
    }
    t.dirty = true;
    if let Some(last) = t.blocks.last_mut() {
        if last.get("type").and_then(Value::as_str) == Some("thinking") {
            let cur = last.get("content").and_then(Value::as_str).unwrap_or("").to_string();
            last["content"] = Value::String(cur + content);
            return;
        }
    }
    t.blocks.push(json!({ "type": "thinking", "content": content, "collapsed": true }));
}

fn push_tool_start(t: &mut Turn, call_id: &str, name: &str, input: Value) {
    t.dirty = true;
    t.blocks.push(json!({
        "type": "tool_call",
        "id": call_id,
        "name": name,
        "input": input,
        "status": "running",
        "startedAt": iso(now_ms()),
    }));
}

/// 定位工具块下标：显式 call_id 优先；无 call_id 时回退到最后一个 running 的同名工具块
/// （对齐前端 `eventHandler` 的 no-callId 兜底）。
fn find_tool_index(t: &Turn, call_id: Option<&str>, tool: &str) -> Option<usize> {
    match call_id {
        Some(id) if !id.is_empty() => t.blocks.iter().position(|b| {
            b.get("type").and_then(Value::as_str) == Some("tool_call")
                && b.get("id").and_then(Value::as_str) == Some(id)
        }),
        _ => t.blocks.iter().rposition(|b| {
            b.get("type").and_then(Value::as_str) == Some("tool_call")
                && b.get("name").and_then(Value::as_str) == Some(tool)
                && b.get("status").and_then(Value::as_str) == Some("running")
        }),
    }
}

fn update_tool_output(t: &mut Turn, call_id: Option<&str>, tool: &str, output: &str, partial: bool) {
    let Some(idx) = find_tool_index(t, call_id, tool) else {
        return;
    };
    t.dirty = true;
    if let Some(block) = t.blocks.get_mut(idx) {
        block["output"] = Value::String(output.to_string());
        block["status"] = Value::String(if partial { "running" } else { "completed" }.to_string());
    }
}

fn finalize_tool(t: &mut Turn, call_id: Option<&str>, tool: &str, success: bool) {
    let Some(idx) = find_tool_index(t, call_id, tool) else {
        return;
    };
    t.dirty = true;
    if let Some(block) = t.blocks.get_mut(idx) {
        if block.get("completedAt").is_none() {
            block["completedAt"] = Value::String(iso(now_ms()));
        }
        block["status"] = Value::String(if success { "completed" } else { "failed" }.to_string());
    }
}

/// 工具结果值 → 展示文本（字符串原样；其余 JSON 序列化）
fn value_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

// ============================================================================
// 落库
// ============================================================================

fn turn_content(t: &Turn, streaming: bool, interrupted: bool) -> Value {
    let mut content = json!({
        "id": t.message_id,
        "type": "assistant",
        "engineId": t.engine_id,
        "blocks": Value::Array(t.blocks.clone()),
        "timestamp": iso(t.started_at_ms),
        "isStreaming": streaming,
    });
    if interrupted {
        content["interrupted"] = Value::Bool(true);
    }
    content
}

/// 把当前轮写入库（节流路径）。已在库中则追加新版本，否则首版 append。
fn flush_turn(conversation_id: &str) {
    let payload = {
        let Ok(mut map) = turns().lock() else {
            return;
        };
        let Some(t) = map.get_mut(conversation_id) else {
            return;
        };
        if !t.dirty {
            return;
        }
        let content = turn_content(t, true, false);
        t.last_written = Some(content.clone());
        t.last_write_ms = now_ms();
        t.dirty = false;
        content
    };
    write_content(conversation_id, &payload, "assistant");
}

/// 轮末落定：把当前轮标为完成（或中断），追加版本，然后导出归档。
fn finalize_turn(conversation_id: &str, interrupted: bool) {
    let existing = {
        let Ok(mut map) = turns().lock() else {
            return;
        };
        let Some(t) = map.get_mut(conversation_id) else {
            return;
        };
        if !t.dirty && t.last_written.is_none() {
            // 无内容（本轮只有用户消息 / 空回复）
            map.remove(conversation_id);
            return;
        }
        // 库中最新版若不是本累加器所写（前端已回写 canonical 内容），不覆盖它
        let clobber_safe = match crate::commands::session_messages::message_get_latest_inner(
            t.message_id.clone(),
        ) {
            Ok(Some(entry)) => t.last_written.as_ref() == Some(&entry.content),
            Ok(None) => true,
            Err(_) => false,
        };
        let content = turn_content(t, false, interrupted);
        t.last_written = Some(content.clone());
        t.dirty = false;
        map.remove(conversation_id);
        if clobber_safe {
            Some(content)
        } else {
            tracing::debug!(
                "[TurnPersist] 跳过轮末落定（库中已是更新版本）conversation={}",
                conversation_id
            );
            None
        }
    };
    if let Some(content) = existing {
        write_content(conversation_id, &content, "assistant");
    }
    // 兜底归档：客户端不在线时由这里把本轮补进归档（在线时前端轮末自行写，
    // 本函数只追加「比归档更新」的消息 → 天然 no-op）。
    archive_conversation(conversation_id);
}

fn write_content(conversation_id: &str, content: &Value, role: &str) {
    let id = content.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        return;
    }
    let ts = content
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso)
        .unwrap_or_else(now_ms);
    let entry = crate::services::session_db::MessageEntry {
        id: id.clone(),
        conversation_id: conversation_id.to_string(),
        role: role.to_string(),
        timestamp: ts,
        device_id: "core".to_string(),
        content: content.clone(),
        version: 1,
        parent_version: None,
    };
    match crate::commands::session_messages::message_get_latest_inner(id.clone()) {
        Ok(Some(_)) => {
            if let Err(e) = crate::commands::session_messages::message_revise_inner(id.clone(), content.clone()) {
                tracing::warn!("[TurnPersist] 修订消息失败 {}: {}", id, e);
            }
        }
        Ok(None) => {
            if let Err(e) = crate::commands::session_messages::message_append_inner(entry) {
                tracing::warn!("[TurnPersist] 写入消息失败 {}: {}", id, e);
            }
        }
        Err(e) => tracing::warn!("[TurnPersist] 查询消息失败 {}: {}", id, e),
    }
}

/// 记录一次用户请求（后端权威入口：请求发起时调用，不依赖引擎事件回显）。
///
/// 消息 id 优先取前端透传的 `clientMessageId`（与前端消息 id 一致，轮末 canonical
/// 回写为同 id 修订）；缺省时按 `user-{conversationId}-{ts}` 生成。
pub fn record_user_message(conversation_id: &str, content: &str, client_message_id: Option<&str>) {
    append_user_message(conversation_id, content, client_message_id);
}

fn append_user_message(conversation_id: &str, content: &str, client_message_id: Option<&str>) {
    if conversation_id.trim().is_empty() || content.is_empty() {
        return;
    }
    // 新用户消息 = 新一轮开始：丢弃上一轮残留缓冲（防御：SessionEnd 丢失时）
    if let Ok(mut map) = turns().lock() {
        map.remove(conversation_id);
    }
    let ts = now_ms();
    let id = client_message_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("user-{}-{}", conversation_id, ts));
    let payload = json!({
        "id": id,
        "type": "user",
        "content": content,
        "timestamp": iso(ts),
    });
    let entry = crate::services::session_db::MessageEntry {
        id: id.clone(),
        conversation_id: conversation_id.to_string(),
        role: "user".to_string(),
        timestamp: ts,
        device_id: "core".to_string(),
        content: payload,
        version: 1,
        parent_version: None,
    };
    if let Err(e) = crate::commands::session_messages::message_append_inner(entry) {
        tracing::warn!("[TurnPersist] 写入用户消息失败: {}", e);
    }
}

/// 把某会话中所有残留的 `isStreaming: true` 消息落定为中断态（启动恢复用）
fn normalize_interrupted(conversation_id: &str) -> crate::error::Result<()> {
    let entries = crate::commands::session_messages::message_read_inner(
        conversation_id.to_string(),
        None,
        None,
    )?;
    for e in entries {
        let streaming = e.content.get("isStreaming").and_then(Value::as_bool) == Some(true);
        if !streaming {
            continue;
        }
        let mut content = e.content.clone();
        if let Some(obj) = content.as_object_mut() {
            obj.insert("isStreaming".into(), Value::Bool(false));
            obj.insert("interrupted".into(), Value::Bool(true));
        }
        crate::commands::session_messages::message_revise_inner(e.id.clone(), content)?;
    }
    Ok(())
}

// ============================================================================
// JSONL 归档导出
// ============================================================================

/// 把「消息库中比归档更新的消息」补写进 JSONL 归档（兜底写入方）。
///
/// 设计（S6，见 `plans/session-rearchitecture/S6-消息持久化后端权威.md`）：
/// - 归档的**常规**写入方仍是前端（轮末整体覆写，内容最完整：富块/附件/表单卡片）；
/// - 本函数是**兜底**：客户端中途关闭时没人写归档，由后端把本轮（含被中断的部分）补进去。
///
/// 因此规则刻意保守：**只追加比归档最后一条更新的消息**——不覆盖、不删除、不重排既有内容。
/// 客户端已经写过本轮时调用它天然是 no-op（归档里已有更晚的消息）。
pub fn archive_conversation(conversation_id: &str) {
    if conversation_id.trim().is_empty() {
        return;
    }
    let name = format!("{}.jsonl", conversation_id);

    let existing = crate::commands::dialog_storage::dialog_read_inner(&name)
        .ok()
        .flatten();
    let (existing_meta, mut messages) = parse_existing_dialog(existing.as_deref());
    let newest = messages.iter().filter_map(message_ts).max().unwrap_or(0);

    let entries = match crate::commands::session_messages::message_read_inner(
        conversation_id.to_string(),
        None,
        None,
    ) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[TurnPersist] 读取消息失败 {}: {}", conversation_id, e);
            return;
        }
    };

    let mut added = 0usize;
    for e in entries {
        // 只补归档里还没有的新轮次（归档已更晚 → 客户端已写过，跳过）
        if e.timestamp <= newest {
            continue;
        }
        upsert_by_id(&mut messages, e.content.clone());
        added += 1;
    }
    if added == 0 {
        return;
    }

    sort_messages_by_time(&mut messages);
    let meta = build_meta_line(conversation_id, &messages, existing_meta.as_ref());

    let mut content = String::new();
    content.push_str(&meta.to_string());
    content.push('\n');
    for (i, m) in messages.iter().enumerate() {
        content.push_str(&json!({ "type": "msg", "seq": i, "message": m }).to_string());
        content.push('\n');
    }

    if let Err(e) = crate::commands::dialog_storage::dialog_write_inner(&name, &content) {
        tracing::warn!("[TurnPersist] 归档写入失败 {}: {}", name, e);
    }
}

/// 取消息 JSON 的时间戳（epoch ms）；无 timestamp 返回 None
fn message_ts(msg: &Value) -> Option<i64> {
    msg.get("timestamp").and_then(Value::as_str).and_then(parse_iso)
}

/// 解析既有 JSONL：返回 (meta 行, 消息列表)。消息按 id 收敛（首位置 + 末内容）。
fn parse_existing_dialog(raw: Option<&str>) -> (Option<Value>, Vec<Value>) {
    let mut meta = None;
    let mut messages: Vec<Value> = Vec::new();
    let Some(text) = raw else {
        return (meta, messages);
    };
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if i == 0 || v.get("type").and_then(Value::as_str) == Some("meta") {
            meta = Some(v);
            continue;
        }
        if v.get("type").and_then(Value::as_str) == Some("msg") {
            if let Some(msg) = v.get("message") {
                upsert_by_id(&mut messages, msg.clone());
            }
        }
    }
    (meta, messages)
}

/// 按 id 插入/覆盖：保留首次出现的位置，内容取最新（与 `parseDialogLines`+前端去重同规则）
fn upsert_by_id(messages: &mut Vec<Value>, msg: Value) {
    let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        messages.push(msg);
        return;
    }
    if let Some(slot) = messages
        .iter_mut()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        *slot = msg;
    } else {
        messages.push(msg);
    }
}

/// 按消息时间升序稳定排序；缺失/不可解析的时间沿用前一条（保持相对顺序）
fn sort_messages_by_time(messages: &mut [Value]) {
    let mut prev = 0i64;
    let mut keyed: Vec<(i64, usize)> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        let ts = m
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso)
            .unwrap_or(prev);
        prev = ts;
        keyed.push((ts, i));
    }
    keyed.sort_by_key(|(ts, i)| (*ts, *i));
    let order: Vec<usize> = keyed.into_iter().map(|(_, i)| i).collect();
    let snapshot: Vec<Value> = messages.to_vec();
    for (dst, src) in order.into_iter().enumerate() {
        messages[dst] = snapshot[src].clone();
    }
}

/// 构建 meta 行（字段与前端 `DialogMeta` 对齐）
fn build_meta_line(conversation_id: &str, messages: &[Value], existing: Option<&Value>) -> Value {
    let pick = |key: &str| -> Option<Value> {
        existing
            .and_then(|m| m.get(key))
            .filter(|v| !v.is_null())
            .cloned()
    };
    let str_of = |v: Option<Value>| v.and_then(|x| x.as_str().map(str::to_string));

    let first_user = messages
        .iter()
        .find(|m| m.get("type").and_then(Value::as_str) == Some("user"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let first_user_text: String = first_user.chars().take(200).collect();

    // 末条可见文本作为预览（优先 assistant，其次 user）
    let preview: String = messages
        .iter()
        .rev()
        .find_map(|m| {
            let ty = m.get("type").and_then(Value::as_str)?;
            if ty == "assistant" {
                m.get("blocks")?.as_array()?.iter().rev().find_map(|b| {
                    (b.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| b.get("content").and_then(Value::as_str).unwrap_or(""))
                        .filter(|s| !s.trim().is_empty())
                })
            } else if ty == "user" {
                m.get("content").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
            } else {
                None
            }
        })
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect();

    // 标签：全部 assistant 消息中 tool_call 名称去重
    let mut tags: Vec<String> = Vec::new();
    for m in messages {
        let Some(blocks) = m.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for b in blocks {
            if b.get("type").and_then(Value::as_str) != Some("tool_call") {
                continue;
            }
            if let Some(name) = b.get("name").and_then(Value::as_str) {
                if !name.is_empty() && !tags.iter().any(|t| t == name) {
                    tags.push(name.to_string());
                }
            }
        }
    }

    let engine_id = str_of(pick("engineId"))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            messages.iter().rev().find_map(|m| {
                (m.get("type").and_then(Value::as_str) == Some("assistant"))
                    .then(|| m.get("engineId").and_then(Value::as_str).unwrap_or("").to_string())
                    .filter(|s| !s.is_empty())
            })
        })
        .unwrap_or_default();

    let title = str_of(pick("title"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| first_user.chars().take(50).collect());

    let created_at = str_of(pick("createdAt")).unwrap_or_else(|| {
        messages
            .first()
            .and_then(|m| m.get("timestamp"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });

    let mut meta = json!({
        "v": 3,
        "type": "meta",
        "externalId": conversation_id,
        "engineId": engine_id,
        "title": title,
        "workspaceId": pick("workspaceId").unwrap_or(Value::Null),
        "workspacePath": pick("workspacePath").unwrap_or(Value::Null),
        "createdAt": created_at,
        "updatedAt": iso(now_ms()),
        "messageCount": messages.len(),
        "firstUserText": first_user_text,
        "preview": preview,
        "tags": tags,
    });
    // 会话级 token 用量（v3）：沿用既有 meta 的统计，避免归档把用量抹掉
    if let Some(tu) = pick("tokenUsage") {
        if let Some(obj) = meta.as_object_mut() {
            obj.insert("tokenUsage".into(), tu);
        }
    }
    meta
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn token(session: &str, text: &str) -> AIEvent {
        AIEvent::Token(crate::models::ai_event::TokenEvent::new(session, text.to_string()))
    }

    #[test]
    fn push_text_merges_into_trailing_text_block() {
        let mut t = new_turn("conv", "simple-ai");
        push_text(&mut t, "你好");
        push_text(&mut t, "，世界");
        assert_eq!(t.blocks.len(), 1);
        assert_eq!(t.blocks[0]["content"], "你好，世界");
    }

    #[test]
    fn text_after_tool_starts_new_block() {
        let mut t = new_turn("conv", "simple-ai");
        push_text(&mut t, "先看文件");
        push_tool_start(&mut t, "call_1", "read_file", json!({"path": "a.ts"}));
        push_text(&mut t, "看完");
        assert_eq!(t.blocks.len(), 3);
        assert_eq!(t.blocks[2]["type"], "text");
    }

    #[test]
    fn thinking_merges_separately_from_text() {
        let mut t = new_turn("conv", "simple-ai");
        push_thinking(&mut t, "想想");
        push_thinking(&mut t, "再看");
        push_text(&mut t, "答案");
        assert_eq!(t.blocks.len(), 2);
        assert_eq!(t.blocks[0]["content"], "想想再看");
        assert_eq!(t.blocks[1]["type"], "text");
    }

    #[test]
    fn tool_block_lifecycle_updates_status_and_output() {
        let mut t = new_turn("conv", "simple-ai");
        push_tool_start(&mut t, "call_1", "bash", json!({"command": "ls"}));
        update_tool_output(&mut t, Some("call_1"), "bash", "partial...", true);
        assert_eq!(t.blocks[0]["status"], "running");
        finalize_tool(&mut t, Some("call_1"), "bash", true);
        assert_eq!(t.blocks[0]["status"], "completed");
        assert_eq!(t.blocks[0]["output"], "partial...");
        assert!(t.blocks[0].get("completedAt").is_some());
    }

    #[test]
    fn tool_end_without_call_id_falls_back_to_last_running() {
        let mut t = new_turn("conv", "simple-ai");
        push_tool_start(&mut t, "call_1", "bash", json!({}));
        finalize_tool(&mut t, None, "bash", false);
        assert_eq!(t.blocks[0]["status"], "failed");
    }

    #[test]
    fn turn_content_shape_matches_frontend_chat_message() {
        let mut t = new_turn("conv", "simple-ai");
        push_text(&mut t, "hi");
        let c = turn_content(&t, true, false);
        assert_eq!(c["type"], "assistant");
        assert_eq!(c["engineId"], "simple-ai");
        assert_eq!(c["isStreaming"], true);
        assert_eq!(c["id"], t.message_id);
        assert!(c["timestamp"].as_str().unwrap().ends_with('Z'));

        let done = turn_content(&t, false, true);
        assert_eq!(done["isStreaming"], false);
        assert_eq!(done["interrupted"], true);
    }

    #[test]
    fn observe_token_returns_backend_message_id() {
        // 断言：Token 事件会返回（并复用）同一条消息 id 供事件下发
        let id1 = observe(&token("conv-observe", "a"), "simple-ai");
        let id2 = observe(&token("conv-observe", "b"), "simple-ai");
        assert!(id1.is_some());
        assert_eq!(id1, id2);
        forget("conv-observe");
    }

    #[test]
    fn upsert_by_id_keeps_first_position_last_content() {
        let mut msgs = vec![json!({"id": "a", "v": 1}), json!({"id": "b"}), json!({"id": "a", "v": 2})];
        upsert_by_id(&mut msgs, json!({"id": "a", "v": 3}));
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"], "a");
        assert_eq!(msgs[0]["v"], 3);
        assert_eq!(msgs[1]["id"], "b");
    }

    #[test]
    fn sort_messages_by_time_orders_and_keeps_missing_after_previous() {
        let mut msgs = vec![
            json!({"id": "c", "timestamp": "2026-10-15T00:00:03.000Z"}),
            json!({"id": "a", "timestamp": "2026-10-15T00:00:01.000Z"}),
            json!({"id": "b", "timestamp": "2026-10-15T00:00:02.000Z"}),
        ];
        sort_messages_by_time(&mut msgs);
        let ids: Vec<&str> = msgs.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);

        // 无 timestamp 的消息沿用前一条时间 → 保持相对顺序
        let mut msgs2 = vec![
            json!({"id": "x", "timestamp": "2026-10-15T00:00:01.000Z"}),
            json!({"id": "y"}),
            json!({"id": "z", "timestamp": "2026-10-15T00:00:02.000Z"}),
        ];
        sort_messages_by_time(&mut msgs2);
        let ids2: Vec<&str> = msgs2.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids2, vec!["x", "y", "z"]);
    }

    #[test]
    fn build_meta_line_derives_title_preview_and_tags() {
        let messages = vec![
            json!({"id": "u1", "type": "user", "content": "帮我分析项目结构", "timestamp": "2026-10-15T00:00:01.000Z"}),
            json!({
                "id": "a1", "type": "assistant", "engineId": "simple-ai",
                "blocks": [
                    {"type": "text", "content": "我来分析"},
                    {"type": "tool_call", "id": "c1", "name": "list_directory"}
                ],
                "timestamp": "2026-10-15T00:00:02.000Z"
            }),
        ];
        let meta = build_meta_line("conv-1", &messages, None);
        assert_eq!(meta["externalId"], "conv-1");
        assert_eq!(meta["engineId"], "simple-ai");
        assert_eq!(meta["title"], "帮我分析项目结构");
        assert_eq!(meta["firstUserText"], "帮我分析项目结构");
        assert_eq!(meta["preview"], "我来分析");
        assert_eq!(meta["tags"][0], "list_directory");
        assert_eq!(meta["messageCount"], 2);
        assert_eq!(meta["v"], 3);
    }

    #[test]
    fn build_meta_line_carries_workspace_and_token_usage_from_existing() {
        let existing = json!({
            "workspaceId": "ws-1",
            "workspacePath": "D:\\space\\base",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "tokenUsage": {"input": 10, "output": 20}
        });
        let messages = vec![json!({"id": "u1", "type": "user", "content": "hi", "timestamp": "2026-10-15T00:00:01.000Z"})];
        let meta = build_meta_line("conv-1", &messages, Some(&existing));
        assert_eq!(meta["workspaceId"], "ws-1");
        assert_eq!(meta["workspacePath"], "D:\\space\\base");
        assert_eq!(meta["createdAt"], "2026-10-01T00:00:00.000Z");
        assert_eq!(meta["tokenUsage"]["input"], 10);
    }

    #[test]
    fn parse_existing_dialog_reads_meta_and_messages() {
        let raw = "{ \"v\": 3, \"type\": \"meta\", \"externalId\": \"c\", \"workspacePath\": \"D:\\\\x\" }\n\
                   {\"type\":\"msg\",\"seq\":0,\"message\":{\"id\":\"u1\",\"type\":\"user\",\"content\":\"hi\"}}\n\
                   {\"type\":\"msg\",\"seq\":1,\"message\":{\"id\":\"a1\",\"type\":\"assistant\",\"blocks\":[]}}\n";
        let (meta, msgs) = parse_existing_dialog(Some(raw));
        assert_eq!(meta.unwrap()["workspacePath"], "D:\\x");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"], "u1");
    }
}
