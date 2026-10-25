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

use crate::commands::dialog_storage::{
    dedupe_assistant_by_content, message_ts, parse_existing_dialog, parse_iso, sort_messages_by_time,
    upsert_by_id,
};
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
    /// 本轮错误文本（Error 事件携带；轮末随内容落库，审计 2.9）
    error_message: Option<String>,
}

fn turns() -> &'static Mutex<HashMap<String, Turn>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Turn>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 待落库的用户请求（按 context_id 配对）。
///
/// 为什么需要它：`start` 的**返回值并不是事件流使用的会话 id**（实测 claude-code：
/// 返回 temp id，事件带引擎真实会话 id，前端最终以事件 id 作为 conversationId）。
/// 因此用户消息不能在请求入口直接落到真实会话——必须等本轮第一个事件到达、拿到
/// 「事件会话 id」后再写。
///
/// 根因修复（2026-10-24，审计 2.9，B1.e）：曾是**全局 FIFO**「首个内容事件弹队首」，
/// 多会话并发时按到达顺序而非请求归属配对——A 会话可能认领 B 的提问。
/// 现按 `context_id`（前端 session-<UUID>，随请求传入、随事件回调闭包捕获）配对，
/// 只有同 context 的首个事件才能认领；无 context 的调用方（测试/旧路径）回退
/// 共享队列，行为等同旧 FIFO。
fn pending_user_requests() -> &'static Mutex<HashMap<String, VecDeque<PendingUser>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, VecDeque<PendingUser>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 无 context_id 调用方的共享回退 key
const PENDING_NO_CONTEXT_KEY: &str = "__no_context__";

/// 每个context 队列上限（并发同 context 极少超过）
const PENDING_MAX: usize = 4;

struct PendingUser {
    content: String,
    client_message_id: Option<String>,
    /// 前端预生成的 assistant 消息 id（供 new_turn adopt，消除 id 漂移）
    assistant_message_id: Option<String>,
    /// 发起请求的真实设备 id（前端每安装 UUID；None = 旧前端/插件来源，落 "core"）
    device_id: Option<String>,
    at: std::time::Instant,
}

/// 待落库用户请求的存活上限：超时未等到轮次首事件（引擎启动失败等）即丢弃内存条目，
/// 避免被后续轮次误认领、写进错误会话。
/// 注意：B1.h 即时落库后，超时只影响「认领」；已写盘的 pending- 伪会话行由
/// 启动恢复清扫（`delete_pending_user_rows`），用户消息不再丢失。
const PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// 会话级「待 adopt 的 assistant message id」（continue 路径用，会话 id 已知）。
/// start 路径走 PendingUser 队列；continue 路径直接登记到这里。
/// new_turn 创建 Turn 时优先从这里取 id，取不到才回退到自造 id。
fn pending_assistant_ids() -> &'static Mutex<HashMap<String, String>> {
    static IDS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记一次用户请求（start 路径调用），待该轮首个事件到达时落到真实会话。
///
/// B1.h（审计 2.6）即时落库：同时把用户消息立即写入 `pending-<context_id>` 伪会话
/// ——引擎启动失败或首事件前进程崩溃时，内存配对丢失但磁盘消息仍在，重启后由
/// `recover_pending_turns` 清扫合并前可保底找回（当前策略：伪会话行在认领时
/// reattribute 到真实会话；重启后无人认领的由启动清扫删除——与会话恢复主链路
/// （JSONL 归档）不冲突，归档侧由前端轮末覆写为真相）。
pub fn record_user_request(
    content: &str,
    client_message_id: Option<&str>,
    assistant_message_id: Option<&str>,
    context_id: Option<&str>,
    device_id: Option<&str>,
) {
    if content.is_empty() {
        return;
    }
    let ctx_key = context_id
        .filter(|c| !c.is_empty())
        .unwrap_or(PENDING_NO_CONTEXT_KEY)
        .to_string();
    if let Ok(mut map) = pending_user_requests().lock() {
        let q = map.entry(ctx_key.clone()).or_default();
        q.push_back(PendingUser {
            content: content.to_string(),
            client_message_id: client_message_id.map(str::to_string),
            assistant_message_id: assistant_message_id.map(str::to_string),
            device_id: device_id.map(str::to_string),
            at: std::time::Instant::now(),
        });
        while q.len() > PENDING_MAX {
            q.pop_front();
        }
    }
    // B1.h：立即落盘到伪会话（不设墓碑闸门——伪会话不可能被删除入口指向）
    if ctx_key != PENDING_NO_CONTEXT_KEY {
        append_user_message_row(
            &pending_conversation_id(&ctx_key),
            content,
            client_message_id,
            device_id,
        );
    }
}

/// 伪会话 id：请求时刻真实会话 id 尚不存在（见 pending_user_requests 注释）
fn pending_conversation_id(context_key: &str) -> String {
    format!("pending-{}", context_key)
}

/// 轮次开始（该会话首个 assistant 侧事件）：按 context_id 认领本会话的待落库请求。
/// 无 context（旧路径/测试）回退共享队列，行为等同旧 FIFO。
fn flush_pending_user_request(conversation_id: &str, context_id: Option<&str>) {
    let existed = turns()
        .lock()
        .map(|m| m.contains_key(conversation_id))
        .unwrap_or(true);
    if existed {
        return; // 本轮已开始，不是轮次首事件
    }
    // 墓碑闸门：已删除会话不认领用户消息（审计 2.2）
    if is_tombstoned(conversation_id) {
        return;
    }
    let ctx_key = context_id
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| PENDING_NO_CONTEXT_KEY.to_string());
    let pending = pending_user_requests().lock().ok().and_then(|mut map| {
        let q = map.get_mut(&ctx_key)?;
        while let Some(front) = q.front() {
            if front.at.elapsed() <= PENDING_TTL {
                break;
            }
            q.pop_front(); // 过期条目：丢弃，避免误认领
        }
        q.pop_front()
    });
    if let Some(p) = pending {
        // 把前端预生成的 assistant id 登记到会话级 map，供 new_turn adopt
        if let Some(aid) = &p.assistant_message_id {
            if let Ok(mut m) = pending_assistant_ids().lock() {
                m.insert(conversation_id.to_string(), aid.clone());
            }
        }
        if ctx_key != PENDING_NO_CONTEXT_KEY {
            // B1.h：请求时已即时落盘到伪会话——迁移到真实会话（幂等：迁移后伪会话
            // 无行，重复调用 no-op）。墓碑已在上方闸门排除；无人认领的伪会话行由
            // 启动清扫（recover_pending_turns）删除。
            let pseudo = pending_conversation_id(&ctx_key);
            reattribute_pending_rows(&pseudo, conversation_id);
        } else {
            append_user_message(
                conversation_id,
                &p.content,
                p.client_message_id.as_deref(),
                p.device_id.as_deref(),
            );
        }
    }
}

/// 把伪会话行迁移到真实会话（幂等）
fn reattribute_pending_rows(from: &str, to: &str) {
    let Ok(db) = crate::commands::session_messages::db() else {
        return;
    };
    if let Err(e) = db.reattribute_conversation(from, to) {
        tracing::warn!("[TurnPersist] 迁移 pending 用户消息失败 {} -> {}: {}", from, to, e);
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

// ============================================================================
// 事件入口
// ============================================================================

/// 观察一个 AI 事件：累加当前轮 / 轮末落定并归档（前端不受影响，纯旁路）。
/// 无 context 版本（测试/旧路径）：用户请求认领走共享回退队列。
pub fn observe(event: &AIEvent, engine: &str) {
    observe_ctx(event, engine, None)
}

/// 带 context_id 的观察入口（生产路径）：context 用于把「轮次首事件」与
/// 「登记中的用户请求」按请求归属配对（B1.e，替代全局 FIFO 弹队首）。
pub fn observe_ctx(event: &AIEvent, engine: &str, context_id: Option<&str>) {
    // 轮次首事件 → 先落库本轮的用户请求（详见 `pending_user_requests` 注释）。
    // 卡片类事件（question/plan/permission/agent_run）可能是本轮首个事件，一并触发认领。
    if matches!(
        event,
        AIEvent::Token(_)
            | AIEvent::AssistantMessage(_)
            | AIEvent::Thinking(_)
            | AIEvent::ToolCallStart(_)
            | AIEvent::ToolCallUpdate(_)
            | AIEvent::ToolCallEnd(_)
            | AIEvent::Question(_)
            | AIEvent::PermissionRequest(_)
            | AIEvent::PlanContent(_)
            | AIEvent::PlanApprovalRequest(_)
            | AIEvent::AgentRunStart(_)
    ) {
        flush_pending_user_request(event.session_id(), context_id);
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

        // 错误事件：轮次可能不会再有 assistant 内容，先落定已累积的部分。
        // 根因修复（审计 2.9）：错误文本本身也随轮落库——此前只 finalize 不存
        // 文本，客户端中途关闭后恢复只见「已中断」不知为何。
        AIEvent::Error(e) => {
            set_turn_error(&e.session_id, &e.error);
            finalize_turn(&e.session_id, true);
        }

        // ===== 卡片类块落库（审计 2.9 覆盖面，B1.g）=====
        // 客户端中途关闭后恢复的轮次此前只剩文本+工具块；plan/权限/提问/
        // AgentRun 卡片与错误原因现在一并持久化（块形状对齐前端 types/chat.ts）。

        AIEvent::PlanContent(e) => {
            let sid = e.session_id.clone();
            let block = json!({
                "type": "plan_mode",
                "id": e.plan_id,
                "sessionId": e.session_id,
                "title": e.title,
                "description": e.description,
                "stages": e.stages,
                "status": e.status,
                "isActive": true,
            });
            let should_flush = mutate_turn(&sid, engine, |t| upsert_card_block(t, block));
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::PlanStageUpdate(e) => {
            // 阶段状态推进：按 (plan_id, stage_id) 定位 stage 更新 status/tasks
            let sid = e.session_id.clone();
            let plan_id = e.plan_id.clone();
            let stage_id = e.stage_id.clone();
            let status = serde_json::to_value(&e.status).unwrap_or(serde_json::Value::Null);
            let tasks = e.tasks.as_ref().map(|tasks| serde_json::to_value(tasks).unwrap_or(serde_json::Value::Null));
            let should_flush = mutate_turn(&sid, engine, |t| {
                update_plan_stage(t, &plan_id, &stage_id, &status, tasks);
            });
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::PlanApprovalRequest(e) => {
            // 计划审批复用 permission_request 卡（对齐前端 eventHandler:732）
            let sid = e.session_id.clone();
            let block = json!({
                "type": "permission_request",
                "id": e.plan_id,
                "sessionId": e.session_id,
                "denials": [],
                "status": "pending",
            });
            let should_flush = mutate_turn(&sid, engine, |t| upsert_card_block(t, block));
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::PlanApprovalResult(e) => {
            let sid = e.session_id.clone();
            let status = if e.approved { "approved" } else { "denied" };
            let should_flush = mutate_turn(&sid, engine, |t| {
                update_card_status(t, "permission_request", &e.plan_id, status);
            });
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::PlanEnd(e) => {
            let sid = e.session_id.clone();
            let status = e.status.clone();
            let should_flush = mutate_turn(&sid, engine, |t| {
                // 计划结束：plan_mode 块收尾（isActive=false，终态 status）
                update_card_fields(t, "plan_mode", &e.plan_id, json!({
                    "isActive": false,
                    "status": status,
                }));
            });
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::PermissionRequest(e) => {
            let sid = e.session_id.clone();
            // 前端对 permission_request 事件即时生成 id（perm-{ts}），后端同规则
            let id = format!("perm-{}", now_ms());
            let block = json!({
                "type": "permission_request",
                "id": id,
                "sessionId": e.session_id,
                "denials": e.denials,
                "status": "pending",
            });
            let should_flush = mutate_turn(&sid, engine, |t| upsert_card_block(t, block));
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::Question(e) => {
            let sid = e.session_id.clone();
            let block = json!({
                "type": "question",
                "id": e.question_id,
                "sessionId": e.session_id,
                "header": e.header,
                "options": e.options,
                "multiSelect": e.multi_select,
                "allowCustomInput": e.allow_custom_input,
                "categoryLabel": e.category_label,
                "questions": e.questions,
                "status": "pending",
            });
            let should_flush = mutate_turn(&sid, engine, |t| upsert_card_block(t, block));
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::QuestionAnswered(e) => {
            let sid = e.session_id.clone();
            let answers = json!(e.answers);
            let declined = e.declined;
            let should_flush = mutate_turn(&sid, engine, |t| {
                update_card_fields(t, "question", &e.question_id, json!({
                    "status": "answered",
                    "answers": answers,
                    "declined": declined,
                }));
            });
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::AgentRunStart(e) => {
            let sid = e.session_id.clone();
            let block = json!({
                "type": "agent_run",
                "id": e.task_id,
                "agentType": e.agent_type,
                "capabilities": e.capabilities,
                "status": "running",
                "toolCalls": [],
            });
            let should_flush = mutate_turn(&sid, engine, |t| upsert_card_block(t, block));
            if should_flush {
                flush_turn(&sid);
            }
        }

        AIEvent::AgentRunEnd(e) => {
            let sid = e.session_id.clone();
            let status = if e.success { "success" } else { "error" };
            let result = e.result.clone();
            let completed_at = iso(now_ms());
            let should_flush = mutate_turn(&sid, engine, |t| {
                update_card_fields(t, "agent_run", &e.task_id, json!({
                    "status": status,
                    "output": result,
                    "completedAt": completed_at,
                }));
            });
            if should_flush {
                flush_turn(&sid);
            }
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
    // B1.h 配套：清扫无人认领的 pending- 伪会话行（重启后内存配对必然丢失）
    if let Ok(db) = crate::commands::session_messages::db() {
        match db.delete_pending_conversations() {
            Ok(n) if n > 0 => {
                tracing::info!("[TurnPersist] 启动清扫 {} 行孤儿 pending 用户消息", n)
            }
            Err(e) => tracing::warn!("[TurnPersist] 清扫 pending 伪会话失败: {}", e),
            _ => {}
        }
    }
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
    // adopt 前端预生成的 assistant message id（消除 id 漂移）；
    // 取不到时回退到后端自造 id（兼容旧前端 / 未传 id 的场景）。
    let message_id = pending_assistant_ids()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(conversation_id))
        .unwrap_or_else(|| format!("{}#a{}{}", conversation_id, ts, next_seq()));
    Turn {
        conversation_id: conversation_id.to_string(),
        message_id,
        engine_id: engine.to_string(),
        started_at_ms: ts,
        last_write_ms: 0,
        blocks: Vec::new(),
        last_written: None,
        dirty: false,
        error_message: None,
    }
}

/// 每进程单调递增后缀，避免同毫秒分配出相同 id
fn next_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::SeqCst)
}

/// 在锁内修改当前轮，返回是否需要落库（节流）。
/// 墓碑闸门：已删除的会话不重建轮次（审计 2.2 复活链——删除流式中的会话后，
/// 晚到的 Token 事件经 or_insert_with 重建 Turn 继续写库，会话带半截回复复活）。
/// 仅在「轮次尚不存在」时查询（轮首低频点），token 热路径零额外开销。
fn mutate_turn<F: FnOnce(&mut Turn)>(conversation_id: &str, engine: &str, f: F) -> bool {
    let Ok(mut map) = turns().lock() else {
        return false;
    };
    if !map.contains_key(conversation_id) && is_tombstoned(conversation_id) {
        return false;
    }
    let t = map
        .entry(conversation_id.to_string())
        .or_insert_with(|| new_turn(conversation_id, engine));
    f(t);
    t.dirty && now_ms() - t.last_write_ms >= FLUSH_INTERVAL_MS
}

/// 会话是否已被删除（会话级墓碑，见 session_db::tombstone_conversations）。
fn is_tombstoned(conversation_id: &str) -> bool {
    crate::commands::session_messages::db()
        .ok()
        .and_then(|db| db.is_conversation_tombstoned(conversation_id).ok())
        .unwrap_or(false)
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
fn find_tool_index(t: &Turn, call_id: Option<&str>, tool: &str) -> Option<usize> {    match call_id {
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

// ============================================================================
// 卡片块操作（审计 2.9 覆盖面，B1.g）
// ============================================================================

/// 按 (type, id) 定位卡片块下标
fn find_card_index(t: &Turn, block_type: &str, id: &str) -> Option<usize> {
    t.blocks.iter().position(|b| {
        b.get("type").and_then(Value::as_str) == Some(block_type)
            && b.get("id").and_then(Value::as_str) == Some(id)
    })
}

/// 按 (type, id) upsert 卡片块：存在则合并（新字段覆盖、null 跳过保留旧值——
/// 审批结果等更新事件只携带部分字段），不存在则追加。
fn upsert_card_block(t: &mut Turn, block: Value) {
    let id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let btype = block.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if !id.is_empty() {
        if let Some(idx) = find_card_index(t, &btype, &id) {
            if let Some(slot) = t.blocks.get_mut(idx) {
                if let (Some(new_obj), Some(old_obj)) = (block.as_object(), slot.as_object_mut()) {
                    for (k, v) in new_obj {
                        if !v.is_null() {
                            old_obj.insert(k.clone(), v.clone());
                        }
                    }
                }
                t.dirty = true;
                return;
            }
        }
    }
    t.dirty = true;
    t.blocks.push(block);
}

/// 更新卡片块的部分字段（按 type+id 定位；块不存在时忽略——卡片首事件必先到）
fn update_card_fields(t: &mut Turn, block_type: &str, id: &str, patch: Value) {
    if let Some(idx) = find_card_index(t, block_type, id) {
        if let Some(slot) = t.blocks.get_mut(idx) {
            if let (Some(patch_obj), Some(old_obj)) = (patch.as_object(), slot.as_object_mut()) {
                for (k, v) in patch_obj {
                    if !v.is_null() {
                        old_obj.insert(k.clone(), v.clone());
                    }
                }
                t.dirty = true;
            }
        }
    }
}

/// 更新卡片状态（update_card_fields 的常用快捷方式）
fn update_card_status(t: &mut Turn, block_type: &str, id: &str, status: &str) {
    update_card_fields(t, block_type, id, json!({ "status": status }));
}

/// 更新 plan_mode 块内某阶段的状态/任务列表（plan_stage_update 事件）
fn update_plan_stage(
    t: &mut Turn,
    plan_id: &str,
    stage_id: &str,
    status: &serde_json::Value,
    tasks: Option<serde_json::Value>,
) {
    let Some(idx) = find_card_index(t, "plan_mode", plan_id) else { return };
    let Some(slot) = t.blocks.get_mut(idx) else { return };
    let Some(stages) = slot.get_mut("stages").and_then(Value::as_array_mut) else { return };
    for stage in stages.iter_mut() {
        if stage.get("stageId").and_then(Value::as_str) != Some(stage_id) {
            continue;
        }
        if let Some(obj) = stage.as_object_mut() {
            obj.insert("status".into(), status.clone());
            if let Some(tasks) = &tasks {
                obj.insert("tasks".into(), tasks.clone());
            }
            t.dirty = true;
        }
        return;
    }
}

/// 记录本轮错误文本（Error 事件 → 轮末随内容落库）
fn set_turn_error(conversation_id: &str, error: &str) {
    if error.is_empty() {
        return;
    }
    if let Ok(mut map) = turns().lock() {
        if let Some(t) = map.get_mut(conversation_id) {
            t.error_message = Some(error.to_string());
        }
    }
}

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
    // 错误原因随轮落库（审计 2.9：恢复后知道为何中断，而非只见「已中断」）
    if let Some(err) = &t.error_message {
        content["errorMessage"] = Value::String(err.clone());
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
        // 错误文本转为可见 text 块（引用样式），恢复侧无需理解 errorMessage
        // 字段即可渲染错误原因（审计 2.9）；同时保留机器可读字段。
        if let Some(err) = t.error_message.take() {
            push_text(t, &format!("\n\n> ⚠️ {}", err));
            t.dirty = true;
        }
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
///
/// `assistant_message_id`：前端预生成的 assistant 消息 id，登记到会话级 map
/// 供 `new_turn` adopt，实现全链路 id 统一（消除 id 漂移导致的重复）。
pub fn record_user_message(
    conversation_id: &str,
    content: &str,
    client_message_id: Option<&str>,
    assistant_message_id: Option<&str>,
    device_id: Option<&str>,
) {
    if let Some(aid) = assistant_message_id {
        if let Ok(mut m) = pending_assistant_ids().lock() {
            m.insert(conversation_id.to_string(), aid.to_string());
        }
    }
    append_user_message(conversation_id, content, client_message_id, device_id);
}

fn append_user_message(
    conversation_id: &str,
    content: &str,
    client_message_id: Option<&str>,
    device_id: Option<&str>,
) {
    if conversation_id.trim().is_empty() || content.is_empty() {
        return;
    }
    // 墓碑闸门：已删除会话不写入（审计 2.2）
    if is_tombstoned(conversation_id) {
        return;
    }
    // 新用户消息 = 新一轮开始：丢弃上一轮残留缓冲（防御：SessionEnd 丢失时）
    if let Ok(mut map) = turns().lock() {
        map.remove(conversation_id);
    }
    append_user_message_row(conversation_id, content, client_message_id, device_id);
}

/// 用户消息落库裸写（无闸门无副作用）——供 append_user_message 与 B1.h 即时落盘共用
///
/// device_id：发起请求的真实设备（前端每安装 UUID 透传）；None/空回退 "core"
/// （旧前端/插件/内部来源）——助手消息恒 "core"（由主机后端产生，语义正确）。
fn append_user_message_row(
    conversation_id: &str,
    content: &str,
    client_message_id: Option<&str>,
    device_id: Option<&str>,
) {
    if conversation_id.trim().is_empty() || content.is_empty() {
        return;
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
        device_id: device_id
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .unwrap_or("core")
            .to_string(),
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
    // 墓碑闸门：已删除会话不重建 JSONL 归档（审计 2.2 复活链的最后一环——
    // SessionEnd 到达时 archive_conversation 会无条件重建归档文件）。
    if is_tombstoned(conversation_id) {
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
        // 跳过流式中间快照（isStreaming:true）：只归档完成版。
        // 中间快照是节流落库产生的派生版本，内容不完整；若一并归档会与
        // 完成版同内容不同（后端 id）并存，读取侧按 id 去重无法收敛 → 重复。
        if e
            .content
            .get("isStreaming")
            .and_then(Value::as_bool)
            == Some(true)
        {
            continue;
        }
        upsert_by_id(&mut messages, e.content.clone());
        added += 1;
    }
    if added == 0 {
        return;
    }

    sort_messages_by_time(&mut messages);
    // 内容指纹去重（与前端 dedupeAssistantMessages 对齐）：
    // 后端兜底归档可能把同内容不同 id 的消息追加进既有归档，
    // 写盘前按 assistant 文本指纹收敛，消除「同内容不同 id」的重复。
    dedupe_assistant_by_content(&mut messages);
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

// 行级编解码 helper（parse_existing_dialog / upsert_by_id / sort_messages_by_time /
// dedupe_assistant_by_content / message_ts / parse_iso）已迁至
// `commands/dialog_storage.rs` 单一真源（阶段 1A⑥），本文件经 use 引用。

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
        // observe 是 void 函数（纯旁路落库），断言不抛错、能正常调用
        observe(&token("conv-observe", "a"), "simple-ai");
        observe(&token("conv-observe", "b"), "simple-ai");
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
