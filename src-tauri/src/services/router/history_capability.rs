//! cap.history —— AI 会话历史能力（第七步阶段 B2：壳命令摘除后的唯一实现）
//!
//! 接 `services/ai_history_core.rs` 业务核（会话统一分页接口 + Claude Code
//! 会话树/fork 推断 + 历史消息读取），全部为同步 dispatch 动作（文件系统读取，
//! 无流式语义）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `list_sessions`          `{ "engineId", "page"?, "pageSize"?, "workDir"? }` → PagedResult<SessionMeta>
//! - `get_session_history`    `{ "sessionId", "engineId", "page"?, "pageSize"? }` → PagedResult<HistoryMessage>
//! - `delete_session`         `{ "sessionId", "engineId"? }`（引擎原生删除）
//! - `list_claude_sessions`   `{}`（无参数——实现不接收 workDir，勿传）→ ClaudeSessionMeta[]
//! - `get_claude_history`     `{ "sessionId", "projectPath"? }` → ClaudeHistoryMessage[]
//!
//! # v2 扩展（plans/session-history-plugin-prd.md P0：查询面上总线）
//!
//! - `query`           `{ "params"?: HistoryQueryParams }` → HistoryQueryResult（统一时间线，index.db）
//! - `search`          `{ "query", "workspacePath"?, "limit"?, "strictWorkspace"? }` → HistorySessionRow[]（FTS5）
//! - `mark`            `{ "id", "marks": { starred?, pinned?, archived?, color?, userTags?, note? } }`
//! - `archive_page`    `{ "sessionId", "beforeSeq"?, "limit"? }` → 归档分页（宿主侧解析 + 去重，
//!   消费方无需重复实现行级解析/指纹去重契约）
//! - `list_running`    `{}` → 当前在任一引擎中运行的会话列表（engine registry 活跃会话 ∪
//!   session_state 事件日志 running 投影；插件面板「其他设备进行中」与
//!   AI 观测共用）
//! - `delete_session`（扩展）`{ "sessionId", "source"?, "engineId"? }`：source ∈
//!   `self` | `claude-code-native` | `plugin-native`，缺省自动推断
//!   （self JSONL 存在 → self；plugin-sessions 目录存在 → plugin-native；
//!   否则 claude-code-native）。self 走完整删除编排：
//!   运行中 best-effort 中断 → 删 JSONL → 删后端消息库（会话级墓碑，
//!   阻断晚到事件复活链）→ 索引随 on_self_delete 清理。

use crate::services::ai_history_core as hist;
use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use std::sync::Arc;

const CAP_ID: &str = "cap.history";

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const HISTORY_ACTIONS: &[&str] = &[
    "list_sessions",
    "get_session_history",
    "delete_session",
    "list_claude_sessions",
    "get_claude_history",
    // v2（plans/session-history-plugin-prd.md P0）
    "query",
    "search",
    "mark",
    "archive_page",
    "list_running",
];

/// cap.history —— 会话历史能力（唯一实现）
pub struct HistoryCapability {
    state: Arc<crate::AppState>,
}

impl HistoryCapability {
    pub fn with_state(state: Arc<crate::AppState>) -> Self {
        Self { state }
    }

    /// describe 文档体（状态无关；独立成关联函数便于 describe_contract 测试
    /// 直接调用，无需构造 AppState）。
    ///
    /// 2026-10-25 审计修正：删去 list_claude_sessions 的 workDir——实现完全不
    /// 接收该参数（底层 `list_claude_code_sessions()` 无参），传入被静默忽略，
    /// AI 以过滤意图传参后会拿到全量结果。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "会话历史",
            "AI 会话历史：会话列表/历史消息/删除 + Claude Code 会话树 + 统一时间线查询/全文搜索/标注/归档分页（v2）",
            None,
            serde_json::json!({
                "list_sessions": { "params": { "engineId": "string?（默认 claude-code）", "page": "int?", "pageSize": "int?", "workDir": "string?" }, "returns": "PagedResult<SessionMeta>", "example": { "action": "list_sessions" } },
                "get_session_history": { "params": { "sessionId": "string（必填）", "engineId": "string?（默认 claude-code）", "page": "int?", "pageSize": "int?" }, "returns": "PagedResult<HistoryMessage>" },
                "delete_session": { "params": { "sessionId": "string（必填）", "engineId": "string?（引擎原生删除时使用）", "source": "string?（self | claude-code-native | plugin-native，缺省自动推断；self 走完整删除编排含墓碑）" }, "returns": "{ ok: true, source }" },
                "list_claude_sessions": { "params": {}, "returns": "ClaudeSessionMeta[]" },
                "get_claude_history": { "params": { "sessionId": "string（必填）", "projectPath": "string?" }, "returns": "ClaudeHistoryMessage[]" },
                "query": { "params": { "params": "object?（HistoryQueryParams：workspacePath/engines/starred/pinned/archived/source/forceScan/strictWorkspace/page/pageSize，camelCase）" }, "returns": "HistoryQueryResult { items: HistorySessionRow[], total, page, pageSize }" },
                "search": { "params": { "query": "string（必填）", "workspacePath": "string?", "limit": "int?", "strictWorkspace": "bool?" }, "returns": "HistorySessionRow[]（含 snippet 命中片段）" },
                "mark": { "params": { "id": "string（必填）", "marks": "object（必填：starred?/pinned?/archived?/color?/userTags?/note?）" }, "returns": "{ ok: true }（会话不在索引 → 显式报错）" },
                "archive_page": { "params": { "sessionId": "string（必填）", "beforeSeq": "int?", "limit": "int?（默认 20，上限 1000）" }, "returns": "{ meta: object, messages: ChatMessage[], earliestSeq: int|null, total, hasMore }（宿主侧已按 id + 内容指纹去重）" },
                "list_running": { "params": {}, "returns": "{ running: [{ conversationId, running, startedAt?, startedByDevice? }] }" }
            }),
        )
    }
}

impl Capability for HistoryCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        // 缺 action 显式报错并列出全部动作（原 unwrap_or("") 把空串落 unknown
        // 分支，报"不支持动作: "且无候选清单，AI 无法自纠）
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.history 需要 action 参数（{:?}）", HISTORY_ACTIONS))?
            .to_string();
        let state = self.state.clone();
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.history 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let s = state.as_ref();
                let get = |k: &str| params.get(k);
                let opt_str = |k: &str| get(k).and_then(|v| v.as_str()).map(String::from);
                let opt_usize = |k: &str| get(k).and_then(|v| v.as_u64()).map(|v| v as usize);
                // 必填字符串参数：缺失显式报错（原 unwrap_or("") 传空串，下游报
                // "会话不存在: "（尾随空串），不指向漏传参数，AI 易误判为 id 值错误）
                let req_str = |k: &str, act: &str| -> Result<String, String> {
                    get(k)
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .ok_or_else(|| format!("cap.history {act} 需要字符串参数 {k}"))
                };
                match action.as_str() {
                    "list_sessions" => {
                        let result = hist::list_sessions(
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            opt_usize("page"),
                            opt_usize("pageSize"),
                            opt_str("workDir"),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "get_session_history" => {
                        let session_id = req_str("sessionId", "get_session_history")?;
                        let result = hist::get_session_history(
                            session_id,
                            get("engineId").and_then(|v| v.as_str()).unwrap_or("claude-code").to_string(),
                            opt_usize("page"),
                            opt_usize("pageSize"),
                            s,
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "delete_session" => {
                        let session_id = req_str("sessionId", "delete_session")?;
                        // v2：source 显式声明（self | claude-code-native | plugin-native），
                        // 缺省自动推断（见 infer_delete_source）。引擎原生路径保持
                        // 既有 hist::delete_session 语义；self 走完整删除编排
                        // （中断运行中会话 → 删 JSONL → 删消息库写墓碑 → 索引清理）。
                        let explicit_source = opt_str("source");
                        let engine_id = opt_str("engineId");
                        let source = match explicit_source.as_deref() {
                            Some("self") => DeleteSource::SelfArchive,
                            Some("claude-code-native") => DeleteSource::ClaudeNative,
                            Some("plugin-native") => DeleteSource::PluginNative,
                            Some(other) => {
                                return Err(format!(
                                    "cap.history delete_session 未知 source: {other}（合法值 self / claude-code-native / plugin-native）"
                                ));
                            }
                            None => infer_delete_source(&session_id),
                        };
                        match source {
                            DeleteSource::SelfArchive => {
                                delete_self_session(s, &session_id).await?;
                                Ok(serde_json::json!({ "ok": true, "source": "self" }))
                            }
                            DeleteSource::ClaudeNative => {
                                hist::delete_session(
                                    session_id,
                                    engine_id.unwrap_or_else(|| "claude-code".to_string()),
                                    s,
                                )
                                .await
                                .map_err(|e| e.to_message())?;
                                Ok(serde_json::json!({ "ok": true, "source": "claude-code-native" }))
                            }
                            DeleteSource::PluginNative => {
                                // 插件引擎原生删除：engineId 仅在显式给出时使用；
                                // 自动推断路径下由 plugin-sessions 目录扫描兜底（见
                                // delete_plugin_native_session）。
                                match engine_id {
                                    Some(engine) => {
                                        hist::delete_session(session_id, engine, s)
                                            .await
                                            .map_err(|e| e.to_message())?;
                                    }
                                    None => delete_plugin_native_session(&session_id)?,
                                }
                                Ok(serde_json::json!({ "ok": true, "source": "plugin-native" }))
                            }
                        }
                    }
                    "list_claude_sessions" => {
                        // 无参数动作（实现不接收 workDir，见 describe_doc 注释）
                        let result = hist::list_claude_code_sessions()
                            .await
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "get_claude_history" => {
                        let session_id = req_str("sessionId", "get_claude_history")?;
                        let result = hist::get_claude_code_session_history(
                            session_id,
                            opt_str("projectPath"),
                        )
                        .await
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    // ── v2 动作（plans/session-history-plugin-prd.md P0）────────
                    "query" => {
                        // 统一时间线（index.db）。参数两种形态兼容：顶层 camelCase
                        // 或包一层 { params: {...} }（与旧 history_query 命令的
                        // params 包装一致）。
                        let inner = get("params")
                            .and_then(|v| v.as_object())
                            .cloned()
                            .unwrap_or_else(|| params.as_object().cloned().unwrap_or_default());
                        let query_params: crate::services::dialog_index::HistoryQueryParams =
                            serde_json::from_value(serde_json::Value::Object(inner))
                                .map_err(|e| {
                                    format!("cap.history query 参数解析失败（HistoryQueryParams camelCase）: {e}")
                                })?;
                        let result = crate::services::dialog_index::history_query_inner(query_params)
                            .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "search" => {
                        let query = req_str("query", "search")?;
                        let limit = opt_usize("limit").unwrap_or(50).clamp(1, 100) as u32;
                        let result = crate::services::dialog_index::history_search_inner(
                            &query,
                            opt_str("workspacePath").as_deref(),
                            limit,
                            get("strictWorkspace").and_then(|v| v.as_bool()).unwrap_or(false),
                        )
                        .map_err(|e| e.to_message())?;
                        serde_json::to_value(result).map_err(|e| e.to_string())
                    }
                    "mark" => {
                        let id = req_str("id", "mark")?;
                        let marks_value = get("marks").cloned().ok_or_else(|| {
                            "cap.history mark 需要对象参数 marks（starred/pinned/archived/color/userTags/note）".to_string()
                        })?;
                        let marks: crate::services::dialog_index::HistoryMarks =
                            serde_json::from_value(marks_value).map_err(|e| {
                                format!("cap.history mark marks 解析失败: {e}")
                            })?;
                        crate::services::dialog_index::history_mark_inner(&id, marks)
                            .map_err(|e| e.to_message())?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "archive_page" => {
                        let session_id = req_str("sessionId", "archive_page")?;
                        let before_seq = get("beforeSeq").and_then(|v| v.as_i64());
                        let limit = opt_usize("limit").unwrap_or(20).clamp(1, 1000);
                        archive_page_action(&session_id, before_seq, limit)
                    }
                    "list_running" => {
                        // 运行中会话：引擎 registry 活跃会话数聚合 + session_state
                        // 事件日志 running 投影（覆盖「进程内已无活跃句柄但事件日志
                        // 尚未闭合」的窗口，如强杀后恢复）。registry 只给计数，
                        // 事件日志给精确 id——两者并集去重。
                        let registry_active: usize = {
                            let registry = s.engine_registry.lock().await;
                            registry.get_all_status().iter().map(|st| st.active_sessions).sum()
                        };
                        let event_running =
                            crate::commands::session_state_commands::running_projection_ids();
                        let _ = registry_active; // 计数仅用于诊断（下方日志）
                        let mut running: Vec<serde_json::Value> = Vec::new();
                        for id in event_running {
                            let mut entry = serde_json::json!({
                                "conversationId": id,
                                "running": true,
                            });
                            if let Ok(status) =
                                crate::commands::session_state_commands::session_get_status_inner(id.clone())
                            {
                                if let Some(started) = status.started_at {
                                    entry["startedAt"] = serde_json::json!(started);
                                }
                                if let Some(device) = status.started_by_device {
                                    entry["startedByDevice"] = serde_json::json!(device);
                                }
                            }
                            running.push(entry);
                        }
                        tracing::debug!(
                            registry_active,
                            event_running = running.len(),
                            "cap.history list_running"
                        );
                        Ok(serde_json::json!({ "running": running }))
                    }
                    // 未知动作文案统一走 contracts::unsupported_action（列出合法
                    // 动作与 cap.help 指路，AI 可自纠）
                    other => Err(unsupported_action(CAP_ID, other, HISTORY_ACTIONS)),
                }
            })
        })
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

/// 删除来源（v2 delete_session 扩展）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeleteSource {
    /// self JSONL 归档（含后端消息库墓碑编排）
    SelfArchive,
    /// Claude Code 引擎原生文件
    ClaudeNative,
    /// 插件引擎原生文件（plugin-sessions/）
    PluginNative,
}

/// 删除来源自动推断（source 缺省时）：
/// 1. self JSONL 归档存在 → self（最常见路径，优先）；
/// 2. 任一 plugin-sessions/<engine>/ 目录存在该会话 → plugin-native；
/// 3. 否则按 claude-code-native（hist::delete_session 内部报"会话不存在"）。
fn infer_delete_source(session_id: &str) -> DeleteSource {
    use crate::services::data_root::data_root;
    let self_path = data_root()
        .dialogs_dir()
        .join(format!("{session_id}.jsonl"));
    if self_path.exists() {
        return DeleteSource::SelfArchive;
    }
    let plugin_base = data_root().root().join("plugin-sessions");
    if let Ok(entries) = std::fs::read_dir(&plugin_base) {
        for engine_dir in entries.flatten() {
            if engine_dir.path().join(format!("{session_id}.jsonl")).exists() {
                return DeleteSource::PluginNative;
            }
        }
    }
    DeleteSource::ClaudeNative
}

/// self 归档删除编排（对齐前端 historyService.deleteHistorySession self 分支语义）：
/// 1. 运行中会话 best-effort 中断（中断失败不阻断删除——墓碑兜底一切晚到事件）；
/// 2. 删 JSONL 归档（dialog_delete_inner → on_self_delete 清理索引/FTS）；
/// 3. 删后端消息库该会话全部消息并写会话级墓碑（阻断 turn_persist /
///    archive_conversation 的「删除后复活」链，审计 2.2）。
async fn delete_self_session(state: &crate::AppState, session_id: &str) -> Result<(), String> {
    // 1. best-effort 中断（等待有上限，不阻塞删除本身）
    {
        let registry = state.engine_registry.lock().await;
        if registry.is_session_active(session_id) {
            drop(registry);
            let _ = crate::services::ai_chat_core::interrupt_chat_inner(
                session_id.to_string(),
                None,
                state,
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        }
    }
    // 2. 删 JSONL（不存在时静默跳过，保持幂等——消息库墓碑仍要写）
    let name = format!("{session_id}.jsonl");
    if let Err(e) = crate::commands::dialog_storage::dialog_delete_inner(&name) {
        // 文件不存在不算失败（可能仅消息库有残影）；其余错误上抛
        let not_found = e.to_message().contains("不存在")
            || std::fs::metadata(
                crate::services::data_root::data_root()
                    .dialogs_dir()
                    .join(&name),
            )
            .is_err();
        if !not_found {
            return Err(e.to_message());
        }
    }
    // 3. 删后端消息库 + 写会话级墓碑（阻断晚到事件复活链）
    crate::commands::session_messages::message_delete_by_conversation_inner(session_id.to_string())
        .map_err(|e| e.to_message())?;
    Ok(())
}

/// 插件引擎原生删除（无 engineId 提示时按 plugin-sessions 目录扫描定位）。
fn delete_plugin_native_session(session_id: &str) -> Result<(), String> {
    use crate::services::data_root::data_root;
    let base = data_root().root().join("plugin-sessions");
    let target = format!("{session_id}.jsonl");
    if let Ok(entries) = std::fs::read_dir(&base) {
        for engine_dir in entries.flatten() {
            let candidate = engine_dir.path().join(&target);
            if candidate.exists() {
                std::fs::remove_file(&candidate)
                    .map_err(|e| format!("删除插件引擎会话文件失败: {e}"))?;
                return Ok(());
            }
        }
    }
    Err(format!("会话 {session_id} 在 plugin-sessions 下不存在"))
}

/// archive_page 动作：归档分页（宿主侧解析 + 去重）。
///
/// 与裸 dialog_read_page 的区别：本动作在宿主完成行解析（meta + 消息行）与
/// 「按消息 id 收敛（同 id 取末行 = 最新快照）+ assistant 内容指纹去重」，
/// 消费方（插件面板 / AI / 远程端）拿到的是可直接渲染的 ChatMessage[]，
/// 无需各自复制 jsonlCodec 的行级解析与去重契约。
fn archive_page_action(
    session_id: &str,
    before_seq: Option<i64>,
    limit: usize,
) -> Result<Value, String> {
    let name = format!("{session_id}.jsonl");
    let page = crate::commands::dialog_storage::dialog_read_page_inner(
        &name,
        before_seq,
        limit,
    )
    .map_err(|e| e.to_message())?;
    let Some(page) = page else {
        return Err(format!("会话归档不存在: {session_id}"));
    };
    // meta 行解析（宽容：坏 meta 视为无效会话）
    let meta: Value = serde_json::from_str(&page.meta_line)
        .map_err(|e| format!("归档 meta 解析失败: {e}"))?;
    // 消息行解析 + seq 升序（dialog_read_page_inner 已排序，此处防御性再排）
    let mut lines: Vec<(i64, Value)> = Vec::with_capacity(page.lines.len());
    let mut fallback_seq = before_seq.unwrap_or(0).saturating_sub(limit as i64);
    for raw in &page.lines {
        let Ok(v) = serde_json::from_str::<Value>(raw) else { continue };
        let seq = v.get("seq").and_then(Value::as_i64).unwrap_or(fallback_seq);
        fallback_seq = seq + 1;
        if let Some(msg) = v.get("message") {
            lines.push((seq, msg.clone()));
        }
    }
    lines.sort_by_key(|(seq, _)| *seq);
    // 去重契约（与前端 parseDialogLines 同规则）：同 id 取末内容（checkpoint
    // 快照收敛），assistant 同内容指纹再收敛一轮（id 漂移防御）。
    let messages = dedupe_archive_messages(lines);
    let earliest_seq = messages.first().map(|m| m.0);
    Ok(serde_json::json!({
        "meta": meta,
        "messages": messages.into_iter().map(|(_, m)| m).collect::<Vec<_>>(),
        "earliestSeq": earliest_seq,
        "total": page.total,
        "hasMore": page.has_more,
    }))
}

/// 归档消息去重（读侧契约，对齐前端 jsonlCodec.parseDialogLines 两道收敛）。
fn dedupe_archive_messages(lines: Vec<(i64, Value)>) -> Vec<(i64, Value)> {
    // 第一道：按 message.id 收敛（保留首次位置 + 末内容）
    let mut by_id: std::collections::HashMap<String, (i64, Value)> =
        std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (seq, msg) in lines {
        let id = msg
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            // 无 id 消息（异常数据）原样保留
            order.push(format!("__anon__{}", order.len()));
            by_id.insert(format!("__anon__{}", order.len() - 1), (seq, msg));
            continue;
        }
        if by_id.insert(id.clone(), (seq, msg)).is_none() {
            order.push(id);
        }
    }
    let collected: Vec<(i64, Value)> =
        order.iter().filter_map(|id| by_id.remove(id)).collect();
    // 第二道：assistant 内容指纹收敛（同内容不同 id 只留最后一条，放首次位置）
    let mut first_idx: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut last_by_fp: std::collections::HashMap<String, (usize, Value)> =
        std::collections::HashMap::new();
    for (i, (_, msg)) in collected.iter().enumerate() {
        if msg.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let fp = assistant_text_fp(msg);
        if fp.is_empty() {
            continue;
        }
        first_idx.entry(fp.clone()).or_insert(i);
        last_by_fp.insert(fp, (i, msg.clone()));
    }
    if first_idx.is_empty() {
        return collected;
    }
    let mut used: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut out: Vec<(i64, Value)> = Vec::with_capacity(collected.len());
    for (i, (seq, msg)) in collected.into_iter().enumerate() {
        let fp = if msg.get("type").and_then(Value::as_str) == Some("assistant") {
            assistant_text_fp(&msg)
        } else {
            String::new()
        };
        if !fp.is_empty() {
            if used.contains(&i) {
                continue;
            }
            if let Some((last_i, last_msg)) = last_by_fp.get(&fp) {
                used.insert(*last_i);
                // 用末内容替换当前位置（seq 保持首次出现位置）
                out.push((seq, last_msg.clone()));
                continue;
            }
        }
        out.push((seq, msg));
    }
    out
}

/// assistant 消息文本指纹（对齐前端 jsonlCodec.assistantTextFp：text 块 content 拼接 trim）。
fn assistant_text_fp(msg: &Value) -> String {
    let mut s = String::new();
    if let Some(blocks) = msg.get("blocks").and_then(Value::as_array) {
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(content) = b.get("content").and_then(Value::as_str) {
                    s.push_str(content);
                }
            }
        }
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = HistoryCapability::describe_doc();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（HISTORY_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), HISTORY_ACTIONS.len());
        for name in HISTORY_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn list_claude_sessions_declares_no_workdir() {
        // 审计漂移回归锚：list_claude_sessions 无 workDir 参数（实现不接收，
        // 传入被静默忽略），describe 不得再声明
        let d = HistoryCapability::describe_doc();
        let params = d["actions"]["list_claude_sessions"]["params"]
            .as_object()
            .unwrap();
        assert!(!params.contains_key("workDir"), "workDir 已删，不得回潮");
    }

    #[test]
    fn v2_actions_declared() {
        // v2 动作（query/search/mark/archive_page/list_running）必须在 describe
        // 中可发现（AI 自纠依赖 cap.help 聚合的 describe）
        let d = HistoryCapability::describe_doc();
        for name in ["query", "search", "mark", "archive_page", "list_running"] {
            assert!(
                d["actions"][name].is_object(),
                "describe 缺 v2 动作 {name}"
            );
        }
        // delete_session 的 source 语义入 describe（自动推断规则可发现）
        let del = d["actions"]["delete_session"]["params"]["source"]
            .as_str()
            .unwrap_or_default();
        assert!(del.contains("self"), "delete_session.source 应说明 self 语义");
    }

    #[test]
    fn dedupe_archive_by_id_keeps_last_content() {
        // 同 id 多行（流式快照 + 完成版）→ 保留首次位置 + 末内容
        let lines = vec![
            (0i64, serde_json::json!({"id":"m1","type":"user","content":"hi"})),
            (1, serde_json::json!({"id":"a1","type":"assistant","blocks":[{"type":"text","content":"part"}]})),
            (2, serde_json::json!({"id":"a1","type":"assistant","blocks":[{"type":"text","content":"part done"}]})),
        ];
        let out = dedupe_archive_messages(lines);
        assert_eq!(out.len(), 2, "同 id 收敛为一条");
        assert_eq!(out[1].0, 1, "保留首次出现位置");
        assert_eq!(
            out[1].1["blocks"][0]["content"], "part done",
            "取末内容（canonical 完成版）"
        );
    }

    #[test]
    fn dedupe_archive_by_assistant_fingerprint() {
        // 同内容不同 id（id 漂移）→ 指纹收敛，只留最后一条
        let lines = vec![
            (0i64, serde_json::json!({"id":"a1","type":"assistant","blocks":[{"type":"text","content":"same"}]})),
            (1, serde_json::json!({"id":"a2","type":"assistant","blocks":[{"type":"text","content":"same"}]})),
            (2, serde_json::json!({"id":"u1","type":"user","content":"next"})),
        ];
        let out = dedupe_archive_messages(lines);
        assert_eq!(out.len(), 2, "同内容不同 id 收敛");
        assert_eq!(out[0].0, 0, "放首次出现位置");
        assert_eq!(out[0].1["id"], "a2", "取最后一条（canonical）");
    }

    #[test]
    fn archive_page_action_missing_session_errors() {
        // 归档不存在 → 显式报错（AI/插件可自纠）
        let err = archive_page_action("__definitely_missing__", None, 20).unwrap_err();
        assert!(err.contains("不存在"), "应报会话归档不存在: {err}");
    }

    #[test]
    fn infer_delete_source_prefers_self() {
        // 推断规则：self JSONL 存在 → SelfArchive（最常见路径优先）。
        // 该测试跑在真实数据根上：不创建文件，只验证「不存在时回落 claude-native」
        // 的安全默认（避免误删）。
        let src = infer_delete_source("__no_such_session__");
        assert_eq!(src, DeleteSource::ClaudeNative);
    }
}
