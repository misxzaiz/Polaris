//! cap.todo —— 统一待办的唯一实现（第四步闭环替换完成态）
//!
//! 对应 `dev/docs/sky/step3-dispatch.md` 第四步：Todo 域已彻底搬上 dispatch，
//! 命令层 `commands/todo.rs` / `unified_todo_repository.rs` / `todo_mcp_server`
//! 全部移除，本 capability 成为 todo 存储的**唯一入口**（前端 + AI 全走
//! `router_dispatch("cap.todo", ...)`）。
//!
//! # 存储
//!
//! 经 `ctx.storage()` 读写 SqliteStorage（domain=`todo`，落
//! `<DataRoot>/stores/todo.db`）。每条 `TodoItem` 是 `Item { id: todo.id,
//! data: TodoItem 的 camelCase JSON }`。数据格式自本版起即是唯一格式，
//! 不再与命令层双写。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `list`       `{ "action": "list", "scope"?, "status"?, "priority"?, "limit"? }`
//!                          → `{ "items": [TodoItem...] }`
//! - `get`        `{ "action": "get", "id" }` → `{ "item": TodoItem } | null`
//! - `create`     `{ "action": "create", "content", "workSpacePath"? ... }` → `{ "item": TodoItem }`
//! - `update`     `{ "action": "update", "id", ...fields }` → `{ "item": TodoItem }`
//! - `delete`     `{ "action": "delete", "id" }` → `{ "item": TodoItem }`
//! - `start`      `{ "action": "start", "id", "lastProgress"? }` → `{ "item": TodoItem }`
//! - `complete`   `{ "action": "complete", "id", "lastProgress"? }` → `{ "item": TodoItem }`
//! - `breakdown`  `{ "action": "breakdown", "scope"? }` → `{ "stats": {workspaceName:count} }`

use crate::contracts::{
    AuditEntry, Capability, CapabilityId, Context, Id, Item, Query, Value,
};
use crate::models::todo::{TodoCreateParams, TodoItem, TodoPriority, TodoStatus, TodoSubtask, TodoUpdateParams};
use chrono::Utc;

/// cap.todo —— 统一待办能力（唯一实现）
pub struct TodoCapability;

const DOMAIN: &str = "todo";
const CAP_ID: &str = "cap.todo";

// ---------------------------------------------------------------------------
// 存储 helpers
// ---------------------------------------------------------------------------

fn load_all(ctx: &dyn Context) -> Result<Vec<TodoItem>, String> {
    let storage = ctx.storage()?;
    let items = storage
        .query(
            DOMAIN,
            &Query {
                filter: Value::Null,
                limit: None,
            },
        )
        .map_err(|e| format!("cap.todo 读取失败: {}", e))?;
    let mut todos = Vec::with_capacity(items.len());
    for item in items {
        if let Ok(todo) = serde_json::from_value::<TodoItem>(item.data) {
            todos.push(todo);
        }
    }
    Ok(todos)
}

fn load_one(ctx: &dyn Context, id: &str) -> Result<Option<TodoItem>, String> {
    let storage = ctx.storage()?;
    match storage.load(DOMAIN, &Id(id.to_string())) {
        Ok(item) => Ok(Some(
            serde_json::from_value(item.data)
                .map_err(|e| format!("cap.todo 反序列化待办失败: {}", e))?,
        )),
        Err(e) if e.contains("不存在") => Ok(None),
        Err(e) => Err(e),
    }
}

/// 构造域审计条目（第五步阶段 D：业务写与审计同库同事务）
fn audit_entry(ctx: &dyn Context, action: &str) -> AuditEntry {
    AuditEntry {
        timestamp_ms: Utc::now().timestamp_millis().max(0) as u64,
        capability: CapabilityId(CAP_ID.to_string()),
        source: ctx.source().clone(),
        action: action.to_string(),
        // 哈希链由 FileAuditSink（Bootstrap 直管）维护；domain_audit 是域内轨迹
        prev_hash: String::new(),
    }
}

/// 事务写：业务写 + 域审计同库同事务（commit 落库 / 失败全回滚）
fn write_with_audit(ctx: &dyn Context, todo: &TodoItem, action: &str) -> Result<(), String> {
    let storage = ctx.storage()?;
    let data =
        serde_json::to_value(todo).map_err(|e| format!("cap.todo 序列化待办失败: {}", e))?;
    let mut txn = storage
        .begin()
        .map_err(|e| format!("cap.todo 开启事务失败: {}", e))?;
    txn.store(DOMAIN, &Item { id: Id(todo.id.clone()), data })
        .map_err(|e| format!("cap.todo 写入失败: {}", e))?;
    txn.append_audit(DOMAIN, &audit_entry(ctx, action))
        .map_err(|e| format!("cap.todo 审计写入失败: {}", e))?;
    txn.commit().map_err(|e| format!("cap.todo 事务提交失败: {}", e))
}

/// 事务删：业务删 + 域审计同库同事务
fn delete_with_audit(ctx: &dyn Context, id: &str, action: &str) -> Result<(), String> {
    let storage = ctx.storage()?;
    let mut txn = storage
        .begin()
        .map_err(|e| format!("cap.todo 开启事务失败: {}", e))?;
    txn.delete(DOMAIN, &Id(id.to_string()))
        .map_err(|e| format!("cap.todo 删除失败: {}", e))?;
    txn.append_audit(DOMAIN, &audit_entry(ctx, action))
        .map_err(|e| format!("cap.todo 审计写入失败: {}", e))?;
    txn.commit().map_err(|e| format!("cap.todo 事务提交失败: {}", e))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 当前工作区过滤语义：给定 workspace_path，只保留匹配；否则保留全局（workspace_path 为 None）
/// 与旧命令层 `QueryScope::Workspace` 同语义（Todo 不再有 QueryScope 概念，scope 并入传参）。
fn filter_workspace(todos: Vec<TodoItem>, workspace_path: Option<&str>) -> Vec<TodoItem> {
    match workspace_path {
        Some(wp) => {
            let wp = wp.to_string();
            todos.into_iter().filter(|t| t.workspace_path.as_deref() == Some(wp.as_str())).collect()
        }
        None => todos.into_iter().filter(|t| t.workspace_path.is_none()).collect(),
    }
}

/// sanitize：空串 → None、trim；空数组 → None
fn sanitize_opt_str(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
fn sanitize_opt_vec(v: Option<Vec<String>>) -> Option<Vec<String>> {
    v.map(|mut vec| {
        vec.retain(|s| !s.trim().is_empty());
        vec
    })
    .filter(|vec| !vec.is_empty())
}

// ---------------------------------------------------------------------------
// 动作分发
// ---------------------------------------------------------------------------

impl TodoCapability {
    fn action_list(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let mut todos = load_all(ctx)?;

        // scope：default workspace；"all" 跳过过滤
        let scope = params.get("scope").and_then(|s| s.as_str()).unwrap_or("workspace");
        if scope != "all" {
            let wp = params.get("workspacePath").and_then(|w| w.as_str());
            todos = filter_workspace(todos, wp);
        }

        // status / priority 过滤
        if let Some(status) = params.get("status").and_then(|s| s.as_str()) {
            if let Ok(s) = serde_json::from_str::<TodoStatus>(&format!("\"{}\"", status)) {
                todos.retain(|t| t.status == s);
            }
        }
        if let Some(priority) = params.get("priority").and_then(|p| p.as_str()) {
            if let Ok(p) = serde_json::from_str::<TodoPriority>(&format!("\"{}\"", priority)) {
                todos.retain(|t| t.priority == p);
            }
        }

        // limit
        if let Some(limit) = params.get("limit").and_then(|l| l.as_u64()) {
            todos.truncate(limit as usize);
        }

        Ok(serde_json::json!({ "items": todos }))
    }

    fn action_get(ctx: &dyn Context, id: &str) -> Result<Value, String> {
        let item = load_one(ctx, id)?;
        Ok(serde_json::json!({ "item": item }))
    }

    fn action_create(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let content = params
            .get("content")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "cap.todo create 需要 content 参数".to_string())?;
        let content = content.trim();
        if content.is_empty() {
            return Err("待办内容不能为空".to_string());
        }

        // workspace 关联：旧命令层由 current_workspace 注入，现由调用方显式传 workspacePath/workspaceName
        let workspace_path = params.get("workspacePath").and_then(|v| v.as_str()).map(String::from);
        let workspace_name = params.get("workspaceName").and_then(|v| v.as_str()).map(String::from);

        let create_params = TodoCreateParams {
            content: content.to_string(),
            description: sanitize_opt_str(params.get("description").and_then(|v| v.as_str()).map(String::from)),
            priority: params.get("priority").and_then(|v| v.as_str()).and_then(|s| {
                serde_json::from_str::<TodoPriority>(&format!("\"{}\"", s)).ok()
            }),
            tags: sanitize_opt_vec(params.get("tags").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|t| t.as_str().map(String::from)).collect()
            })),
            related_files: sanitize_opt_vec(params.get("relatedFiles").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|f| f.as_str().map(String::from)).collect()
            })),
            session_id: sanitize_opt_str(params.get("sessionId").and_then(|v| v.as_str()).map(String::from)),
            workspace_id: sanitize_opt_str(params.get("workspaceId").and_then(|v| v.as_str()).map(String::from)),
            subtasks: params.get("subTasks").and_then(|v| v.as_array()).map(|a| {
                a.iter()
                    .filter_map(|t| {
                        t.get("title").and_then(|x| x.as_str()).map(|title| {
                            crate::models::todo::TodoCreateSubtask {
                                title: title.to_string(),
                            }
                        })
                    })
                    .collect()
            }),
            due_date: sanitize_opt_str(params.get("dueDate").and_then(|v| v.as_str()).map(String::from)),
            estimated_hours: params.get("estimatedHours").and_then(|v| v.as_f64()),
        };

        let uuid = uuid::Uuid::new_v4().to_string();
        let now = now_iso();

        let subtasks = create_params.subtasks.map(|items| {
            items
                .into_iter()
                .filter_map(|s| {
                    let title = s.title.trim();
                    if title.is_empty() {
                        return None;
                    }
                    Some(TodoSubtask {
                        id: uuid::Uuid::new_v4().to_string(),
                        title: title.to_string(),
                        completed: false,
                        created_at: Some(now.clone()),
                    })
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());

        let todo = TodoItem {
            id: uuid.clone(),
            content: create_params.content.clone(),
            description: create_params.description.clone(),
            status: TodoStatus::Pending,
            priority: create_params.priority.unwrap_or_default(),
            tags: create_params.tags.clone(),
            related_files: create_params.related_files.clone(),
            session_id: create_params.session_id.clone(),
            workspace_id: create_params.workspace_id.clone(),
            subtasks,
            due_date: create_params.due_date.clone(),
            reminder_time: None,
            estimated_hours: create_params.estimated_hours,
            spent_hours: None,
            depends_on: None,
            blockers: None,
            completed_at: None,
            last_progress: None,
            last_error: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            workspace_path,
            workspace_name,
        };

        write_with_audit(ctx, &todo, "todo.create")?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_update(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "cap.todo update 需要 id 参数".to_string())?;
        let mut todo = load_one(ctx, id)?.ok_or_else(|| format!("待办不存在: {}", id))?;

        let mut updates = TodoUpdateParams::default();
        if let Some(v) = params.get("content").and_then(|c| c.as_str()) {
            updates.content = Some(v.to_string());
        }
        if let Some(v) = params.get("description").and_then(|v| v.as_str()) {
            updates.description = Some(v.to_string());
        }
        if let Some(v) = params.get("status").and_then(|v| v.as_str()) {
            updates.status = serde_json::from_str::<TodoStatus>(&format!("\"{}\"", v)).ok();
        }
        if let Some(v) = params.get("priority").and_then(|v| v.as_str()) {
            updates.priority = serde_json::from_str::<TodoPriority>(&format!("\"{}\"", v)).ok();
        }
        if let Some(v) = params.get("tags").and_then(|v| v.as_array()) {
            updates.tags = Some(sanitize_vec(v.iter().filter_map(|t| t.as_str().map(String::from)).collect()));
        }
        if let Some(v) = params.get("relatedFiles").and_then(|v| v.as_array()) {
            updates.related_files = Some(sanitize_vec(v.iter().filter_map(|f| f.as_str().map(String::from)).collect()));
        }
        if let Some(v) = params.get("dueDate").and_then(|v| v.as_str()) {
            updates.due_date = Some(v.to_string());
        }
        if let Some(v) = params.get("estimatedHours").and_then(|v| v.as_f64()) {
            updates.estimated_hours = Some(v);
        }
        if let Some(v) = params.get("spentHours").and_then(|v| v.as_f64()) {
            updates.spent_hours = Some(v);
        }
        if let Some(v) = params.get("reminderTime").and_then(|v| v.as_str()) {
            updates.reminder_time = Some(v.to_string());
        }
        if let Some(v) = params.get("dependsOn").and_then(|v| v.as_array()) {
            updates.depends_on = Some(sanitize_vec(v.iter().filter_map(|t| t.as_str().map(String::from)).collect()));
        }
        if let Some(v) = params.get("sessionId").and_then(|v| v.as_str()) {
            updates.session_id = Some(v.to_string());
        }
        if let Some(v) = params.get("subTasks").and_then(|v| v.as_array()) {
            updates.subtasks = Some(v.iter().filter_map(|st| {
                st.get("id").and_then(|i| i.as_str()).map(|i| TodoSubtask {
                    id: i.to_string(),
                    title: st.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    completed: st.get("completed").and_then(|c| c.as_bool()).unwrap_or(false),
                    created_at: st.get("createdAt").and_then(|c| c.as_str()).map(String::from),
                })
            }).collect());
        }
        if let Some(v) = params.get("lastProgress").and_then(|v| v.as_str()) {
            updates.last_progress = Some(v.to_string());
        }
        if let Some(v) = params.get("lastError").and_then(|v| v.as_str()) {
            updates.last_error = Some(v.to_string());
        }

        // 捕获更新前状态（completed_at 流转语义需要）
        let was_completed_before = todo.status == TodoStatus::Completed;
        apply_updates(&mut todo, updates)?;
        update_timestamps(&mut todo, was_completed_before);
        write_with_audit(ctx, &todo, "todo.update")?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_delete(ctx: &dyn Context, id: &str) -> Result<Value, String> {
        let todo = load_one(ctx, id)?.ok_or_else(|| format!("待办不存在: {}", id))?;
        delete_with_audit(ctx, id, "todo.delete")?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_start(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "cap.todo start 需要 id 参数".to_string())?;
        let mut todo = load_one(ctx, id)?.ok_or_else(|| format!("待办不存在: {}", id))?;
        todo.status = TodoStatus::InProgress;
        if let Some(v) = params.get("lastProgress").and_then(|v| v.as_str()) {
            todo.last_progress = Some(v.to_string());
        }
        todo.updated_at = now_iso();
        write_with_audit(ctx, &todo, "todo.start")?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_complete(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "cap.todo complete 需要 id 参数".to_string())?;
        let mut todo = load_one(ctx, id)?.ok_or_else(|| format!("待办不存在: {}", id))?;
        let was_completed = todo.status == TodoStatus::Completed;
        todo.status = TodoStatus::Completed;
        if let Some(v) = params.get("lastProgress").and_then(|v| v.as_str()) {
            todo.last_progress = Some(v.to_string());
        }
        if !was_completed {
            todo.completed_at = Some(now_iso());
        }
        todo.updated_at = now_iso();
        write_with_audit(ctx, &todo, "todo.complete")?;
        Ok(serde_json::json!({ "item": todo }))
    }

    /// breakdown：按 workspace_name 分组（旧命令层 `get_workspace_breakdown` 同语义）
    fn action_breakdown(ctx: &dyn Context) -> Result<Value, String> {
        let todos = load_all(ctx)?;
        let mut stats = std::collections::BTreeMap::new();
        for t in &todos {
            let key = t.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *stats.entry(key).or_insert(0usize) += 1;
        }
        Ok(serde_json::json!({ "stats": stats }))
    }
}

/// 应用 TodoUpdateParams 到 todo（对齐旧命令层全部字段）
fn apply_updates(todo: &mut TodoItem, updates: TodoUpdateParams) -> Result<(), String> {
    if let Some(content) = updates.content {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            todo.content = trimmed.to_string();
        }
    }
    if let Some(description) = updates.description {
        todo.description = sanitize_opt_str(Some(description));
    }
    if let Some(priority) = updates.priority {
        todo.priority = priority;
    }
    if let Some(tags) = updates.tags {
        todo.tags = sanitize_opt_vec(Some(tags));
    }
    if let Some(related_files) = updates.related_files {
        todo.related_files = sanitize_opt_vec(Some(related_files));
    }
    if let Some(due_date) = updates.due_date {
        todo.due_date = sanitize_opt_str(Some(due_date));
    }
    if let Some(estimated_hours) = updates.estimated_hours {
        todo.estimated_hours = Some(estimated_hours);
    }
    if let Some(spent_hours) = updates.spent_hours {
        todo.spent_hours = Some(spent_hours);
    }
    if let Some(reminder_time) = updates.reminder_time {
        todo.reminder_time = sanitize_opt_str(Some(reminder_time));
    }
    if let Some(depends_on) = updates.depends_on {
        todo.depends_on = sanitize_opt_vec(Some(depends_on));
    }
    if let Some(session_id) = updates.session_id {
        todo.session_id = sanitize_opt_str(Some(session_id));
    }
    if let Some(subtasks) = updates.subtasks {
        todo.subtasks = if subtasks.is_empty() { None } else { Some(subtasks) };
    }
    if let Some(last_progress) = updates.last_progress {
        todo.last_progress = sanitize_opt_str(Some(last_progress));
    }
    if let Some(last_error) = updates.last_error {
        todo.last_error = sanitize_opt_str(Some(last_error));
    }
    // 状态流转（status 字段此前从未被应用——修复：update 改状态生效）
    if let Some(status) = updates.status {
        todo.status = status;
    }
    Ok(())
}

/// 状态变更 timestamp 语义（对齐旧命令层 update_todo）：
/// - 变更到 Completed：若之前非 Completed，置 completed_at
/// - 变更出 Completed：清空 completed_at
/// - 状态未变：completed_at 保持不动，仅刷新 updated_at
fn update_timestamps(todo: &mut TodoItem, was_completed_before: bool) {
    let is_completed = todo.status == TodoStatus::Completed;
    if is_completed && !was_completed_before {
        todo.completed_at = Some(now_iso());
    } else if !is_completed && was_completed_before {
        todo.completed_at = None;
    }
    todo.updated_at = now_iso();
}

fn sanitize_vec(values: Vec<String>) -> Vec<String> {
    values.into_iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect()
}

impl Capability for TodoCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.todo".into())
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.todo 需要 action 参数（list/get/create/update/delete/start/complete/breakdown）".to_string())?;

        match action {
            "list" => Self::action_list(ctx, &params),
            "get" => {
                let id = params.get("id").and_then(|i| i.as_str())
                    .ok_or_else(|| "get 需要 id 参数".to_string())?;
                Self::action_get(ctx, id)
            }
            "create" => Self::action_create(ctx, &params),
            "update" => Self::action_update(ctx, &params),
            "delete" => {
                let id = params.get("id").and_then(|i| i.as_str())
                    .ok_or_else(|| "delete 需要 id 参数".to_string())?;
                Self::action_delete(ctx, id)
            }
            "start" => Self::action_start(ctx, &params),
            "complete" => Self::action_complete(ctx, &params),
            "breakdown" => Self::action_breakdown(ctx),
            other => Err(format!("cap.todo 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Storage;
    use crate::services::storage::SqliteStorage;
    use std::sync::Arc;

    /// 用临时目录建 SqliteStorage，构造一个提供 storage 的测试 Context
    struct TestCtx {
        storage: Arc<SqliteStorage>,
        caller: crate::contracts::PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn Storage, String> {
            Ok(self.storage.as_ref())
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
            &self.caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_ctx() -> TestCtx {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!("polaris-todo-cap-test-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let storage = Arc::new(SqliteStorage::new(&tmp).unwrap());
        TestCtx {
            storage,
            caller: crate::contracts::PluginId("cap.todo".into()),
        }
    }

    #[test]
    fn create_get_roundtrip() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(
                serde_json::json!({"action": "create", "content": "写周报", "priority": "high"}),
                &ctx,
            )
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["item"]["status"], "pending");

        let got = cap
            .invoke(serde_json::json!({"action": "get", "id": id}), &ctx)
            .unwrap();
        assert_eq!(got["item"]["content"], "写周报");
        assert_eq!(got["item"]["priority"], "high");
    }

    #[test]
    fn list_scopes_and_filters() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "content": "a"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "content": "b", "priority": "urgent"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "content": "c-ws", "workspacePath": "/ws"}), &ctx).unwrap();

        // 默认 scope=workspace：无 workspacePath → 只返回全局（workspace_path None）
        let ws = cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        assert_eq!(ws["items"].as_array().unwrap().len(), 2);

        // scope=all → 全量
        let all = cap.invoke(serde_json::json!({"action": "list", "scope": "all"}), &ctx).unwrap();
        assert_eq!(all["items"].as_array().unwrap().len(), 3);

        // status/priority 过滤
        let urgent = cap.invoke(serde_json::json!({"action": "list", "priority": "urgent", "scope": "all"}), &ctx).unwrap();
        assert_eq!(urgent["items"].as_array().unwrap().len(), 1);
        assert_eq!(urgent["items"][0]["content"], "b");
    }

    #[test]
    fn limit_truncates() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        for i in 0..5 {
            cap.invoke(serde_json::json!({"action": "create", "content": format!("t{}", i)}), &ctx).unwrap();
        }
        let limited = cap.invoke(serde_json::json!({"action": "list", "limit": 3}), &ctx).unwrap();
        assert_eq!(limited["items"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn create_sanitize_and_subtask_created_at() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({
                "action": "create",
                "content": "  任务  ",
                "description": "  描述  ",
                "tags": ["  a ", "   ", "b"],
                "subTasks": [{ "title": "子1" }, { "title": "  " }]
            }), &ctx)
            .unwrap();
        // content/description trim，空 tag 剔除
        assert_eq!(created["item"]["content"], "任务");
        assert_eq!(created["item"]["description"], "描述");
        assert_eq!(created["item"]["tags"].as_array().unwrap().len(), 2);
        // 空标题子任务剔除 + created_at 已填
        let subs = created["item"]["subtasks"].as_array().unwrap();
        assert_eq!(subs.len(), 1);
        assert!(subs[0]["createdAt"].is_string());
    }

    #[test]
    fn update_completed_at_semantics() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "任务"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["item"]["completedAt"], Value::Null);

        // 切到 completed → completed_at 置位
        let done = cap
            .invoke(serde_json::json!({"action": "update", "id": id, "status": "completed"}), &ctx)
            .unwrap();
        assert!(done["item"]["completedAt"].is_string());

        // 切回 pending → completed_at 清空
        let back = cap
            .invoke(serde_json::json!({"action": "update", "id": id, "status": "pending"}), &ctx)
            .unwrap();
        assert_eq!(back["item"]["completedAt"], Value::Null);
    }

    #[test]
    fn update_all_fields_apply() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "初稿"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let updated = cap
            .invoke(serde_json::json!({
                "action": "update", "id": id,
                "content": "终稿", "spentHours": 2.5, "reminderTime": "2026-09-12T00:00:00Z",
                "lastError": "e1", "dependsOn": ["dep1"], "sessionId": "s1"
            }), &ctx)
            .unwrap();
        assert_eq!(updated["item"]["content"], "终稿");
        assert_eq!(updated["item"]["spentHours"], 2.5);
        assert_eq!(updated["item"]["reminderTime"], "2026-09-12T00:00:00Z");
        assert_eq!(updated["item"]["lastError"], "e1");
        assert_eq!(updated["item"]["dependsOn"][0], "dep1");
        assert_eq!(updated["item"]["sessionId"], "s1");
    }

    #[test]
    fn delete_returns_deleted_item() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "待删"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let del = cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(del["item"]["id"], id);

        let got = cap.invoke(serde_json::json!({"action": "get", "id": id}), &ctx).unwrap();
        assert_eq!(got["item"], Value::Null);
    }

    #[test]
    fn breakdown_groups_by_workspace_name() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "content": "全局1"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "content": "全局2"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "content": "w1任务", "workspacePath": "/a", "workspaceName": "w1"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "content": "w2任务", "workspacePath": "/b", "workspaceName": "w2"}), &ctx).unwrap();

        let stats = cap.invoke(serde_json::json!({"action": "breakdown"}), &ctx).unwrap();
        assert_eq!(stats["stats"]["全局"], 2);
        assert_eq!(stats["stats"]["w1"], 1);
        assert_eq!(stats["stats"]["w2"], 1);
    }

    #[test]
    fn start_and_complete_transitions() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "任务"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let started = cap
            .invoke(serde_json::json!({"action": "start", "id": id}), &ctx)
            .unwrap();
        assert_eq!(started["item"]["status"], "in_progress");

        let completed = cap
            .invoke(serde_json::json!({"action": "complete", "id": id, "lastProgress": "搞定"}), &ctx)
            .unwrap();
        assert_eq!(completed["item"]["status"], "completed");
        assert_eq!(completed["item"]["lastProgress"], "搞定");
        assert!(completed["item"]["completedAt"].is_string());
    }

    #[test]
    fn start_then_update_preserves_updated_at() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "任务"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        let t0 = created["item"]["updatedAt"].as_str().unwrap().to_string();

        std::thread::sleep(std::time::Duration::from_millis(5));
        let started = cap.invoke(serde_json::json!({"action": "start", "id": id}), &ctx).unwrap();
        let t1 = started["item"]["updatedAt"].as_str().unwrap().to_string();
        assert_ne!(t0, t1, "update 应刷新 updatedAt");
    }

    #[test]
    fn writes_leave_domain_audit() {
        // 第五步阶段 D：create/start/complete/delete 各落一条域审计（同事务）
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "审计"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        cap.invoke(serde_json::json!({"action": "start", "id": id}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "complete", "id": id}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("todo").unwrap(), 4);
        // 读路径（list）不落审计
        cap.invoke(serde_json::json!({"action": "list", "scope": "all"}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("todo").unwrap(), 4);
    }

    #[test]
    fn missing_action_returns_err() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("action"));
    }

    #[test]
    fn unknown_action_returns_err() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({"action": "explode"}), &ctx);
        assert!(r.is_err());
    }
}