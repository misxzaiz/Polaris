//! cap.todo —— 真实业务能力：统一待办（第一条"命令层→dispatch→capability→SqliteStorage"闭环链路）
//!
//! 对应 `dev/docs/sky/step3-dispatch.md` 第四步闭环替换第一块：把真实业务域（todo）
//! 搬上 dispatch 总线。复用 `UnifiedTodoRepository` 的存储格式（TodoItem JSON in
//! SqliteStorage domain=`todo`），命令层照常双轨并存，capability 先经 dispatch 验证
//! 真实业务完整可用。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `list`       `{ "action": "list", "status"?, "priority"?, "scope"?, "workspacePath"? }`
//!                          → `{ "items": [TodoItem...] }`
//! - `get`        `{ "action": "get", "id" }` → `{ "item": TodoItem } | null`
//! - `create`     `{ "action": "create", "content", ... }` → `{ "item": TodoItem }`
//! - `update`     `{ "action": "update", "id", ...fields }` → `{ "item": TodoItem }`
//! - `delete`     `{ "action": "delete", "id" }` → `{ "deleted": true }`
//! - `start`      `{ "action": "start", "id", "lastProgress"? }` → `{ "item": TodoItem }`（置 InProgress）
//! - `complete`   `{ "action": "complete", "id", "lastProgress"? }` → `{ "item": TodoItem }`（置 Completed）
//! - `breakdown`  `{ "action": "breakdown", "workspacePath"? }` → `{ "stats": {status:count} }`
//!
//! 存取格式与 `UnifiedTodoRepository` **字节一致**：`store("todo", Item{ id, data: TodoItem to_value })` /
//! `query("todo", 空 filter)` / `delete("todo", Id(id))`。命令层能读出 cap.todo 写的数据（反之亦然）。

use crate::contracts::{Capability, CapabilityId, Context, Id, Item, Query, Value};
use crate::models::todo::{TodoCreateParams, TodoItem, TodoStatus, TodoUpdateParams};

/// cap.todo —— 统一待办能力（复用 UnifiedTodoRepository 存储格式）
pub struct TodoCapability;

const DOMAIN: &str = "todo";

// ---------------------------------------------------------------------------
// 存储格式 helpers（与 UnifiedTodoRepository 字节一致）
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

fn insert_item(ctx: &dyn Context, todo: &TodoItem) -> Result<(), String> {
    let storage = ctx.storage()?;
    let data = serde_json::to_value(todo)
        .map_err(|e| format!("cap.todo 序列化待办失败: {}", e))?;
    storage
        .store(DOMAIN, &Item { id: Id(todo.id.clone()), data })
        .map(|_| ())
        .map_err(|e| format!("cap.todo 写入失败: {}", e))
}

fn now_iso() -> String {
    // 与 UnifiedTodoRepository::now_iso 完全一致（UTC RFC3339 毫秒），保证字节级兼容
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// 动作分发
// ---------------------------------------------------------------------------

impl TodoCapability {
    fn action_list(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let mut todos = load_all(ctx)?;

        // 内存过滤（与 UnifiedTodoRepository 同语义）
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
        if let Some(wp) = params.get("workspacePath").and_then(|w| w.as_str()) {
            todos.retain(|t| t.workspace_path.as_deref() == Some(wp));
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

        let create_params = TodoCreateParams {
            content: content.to_string(),
            description: params.get("description").and_then(|v| v.as_str()).map(String::from),
            priority: params.get("priority").and_then(|v| v.as_str()).and_then(|s| {
                serde_json::from_str::<TodoPriority>(&format!("\"{}\"", s)).ok()
            }),
            tags: params.get("tags").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|t| t.as_str().map(String::from)).collect()
            }),
            related_files: params.get("relatedFiles").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|f| f.as_str().map(String::from)).collect()
            }),
            session_id: params.get("sessionId").and_then(|v| v.as_str()).map(String::from),
            workspace_id: params.get("workspaceId").and_then(|v| v.as_str()).map(String::from),
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
            due_date: params.get("dueDate").and_then(|v| v.as_str()).map(String::from),
            estimated_hours: params.get("estimatedHours").and_then(|v| v.as_f64()),
        };

        let uuid = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let workspace_path = params.get("workspacePath").and_then(|v| v.as_str()).map(String::from);
        let workspace_name = params.get("workspaceName").and_then(|v| v.as_str()).map(String::from);

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
            subtasks: create_params.subtasks.map(|items| {
                items
                    .into_iter()
                    .map(|s| crate::models::todo::TodoSubtask {
                        id: uuid::Uuid::new_v4().to_string(),
                        title: s.title,
                        completed: false,
                        created_at: Some(now.clone()),
                    })
                    .collect()
            }),
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

        insert_item(ctx, &todo)?;
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
            updates.tags = Some(v.iter().filter_map(|t| t.as_str().map(String::from)).collect());
        }
        if let Some(v) = params.get("dueDate").and_then(|v| v.as_str()) {
            updates.due_date = Some(v.to_string());
        }
        if let Some(v) = params.get("lastProgress").and_then(|v| v.as_str()) {
            updates.last_progress = Some(v.to_string());
        }
        if let Some(v) = params.get("estimatedHours").and_then(|v| v.as_f64()) {
            updates.estimated_hours = Some(v);
        }

        apply_updates(&mut todo, updates);
        insert_item(ctx, &todo)?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_delete(ctx: &dyn Context, id: &str) -> Result<Value, String> {
        let storage = ctx.storage()?;
        storage
            .delete(DOMAIN, &Id(id.to_string()))
            .map_err(|e| format!("cap.todo 删除失败: {}", e))?;
        Ok(serde_json::json!({ "deleted": true }))
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
        insert_item(ctx, &todo)?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_complete(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "cap.todo complete 需要 id 参数".to_string())?;
        let mut todo = load_one(ctx, id)?.ok_or_else(|| format!("待办不存在: {}", id))?;
        todo.status = TodoStatus::Completed;
        if let Some(v) = params.get("lastProgress").and_then(|v| v.as_str()) {
            todo.last_progress = Some(v.to_string());
        }
        todo.completed_at = Some(now_iso());
        todo.updated_at = now_iso();
        insert_item(ctx, &todo)?;
        Ok(serde_json::json!({ "item": todo }))
    }

    fn action_breakdown(ctx: &dyn Context) -> Result<Value, String> {
        let todos = load_all(ctx)?;
        let mut stats = std::collections::BTreeMap::new();
        for t in &todos {
            let key = format!("{:?}", t.status).to_lowercase();
            *stats.entry(key).or_insert(0usize) += 1;
        }
        Ok(serde_json::json!({ "stats": stats }))
    }
}

fn apply_updates(todo: &mut TodoItem, updates: TodoUpdateParams) {
    if let Some(v) = updates.content {
        if !v.trim().is_empty() {
            todo.content = v;
        }
    }
    if let Some(v) = updates.description {
        todo.description = Some(v);
    }
    if let Some(v) = updates.status {
        todo.status = v;
    }
    if let Some(v) = updates.priority {
        todo.priority = v;
    }
    if let Some(v) = updates.tags {
        todo.tags = Some(v);
    }
    if let Some(v) = updates.due_date {
        todo.due_date = Some(v);
    }
    if let Some(v) = updates.last_progress {
        todo.last_progress = Some(v);
    }
    if let Some(v) = updates.estimated_hours {
        todo.estimated_hours = Some(v);
    }
    todo.updated_at = now_iso();
}

// 类型别名：cap.todo 用 TodoPriority（list/update 过滤用）
type TodoPriority = crate::models::todo::TodoPriority;

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
                let id = params
                    .get("id")
                    .and_then(|i| i.as_str())
                    .ok_or_else(|| "get 需要 id 参数".to_string())?;
                Self::action_get(ctx, id)
            }
            "create" => Self::action_create(ctx, &params),
            "update" => Self::action_update(ctx, &params),
            "delete" => {
                let id = params
                    .get("id")
                    .and_then(|i| i.as_str())
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
        storage: Arc<dyn Storage>,
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
        let storage: Arc<dyn Storage> = Arc::new(SqliteStorage::new(&tmp).unwrap());
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

        let all = cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        assert_eq!(all["items"].as_array().unwrap().len(), 2);

        let urgent = cap
            .invoke(serde_json::json!({"action": "list", "priority": "urgent"}), &ctx)
            .unwrap();
        assert_eq!(urgent["items"].as_array().unwrap().len(), 1);
        assert_eq!(urgent["items"][0]["content"], "b");
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
            .invoke(serde_json::json!({"action": "complete", "id": id}), &ctx)
            .unwrap();
        assert_eq!(completed["item"]["status"], "completed");
        assert!(completed["item"]["completedAt"].is_string());
    }

    #[test]
    fn update_edits_fields() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "初稿"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let updated = cap
            .invoke(
                serde_json::json!({"action": "update", "id": id, "content": "终稿", "description": "改好"}),
                &ctx,
            )
            .unwrap();
        assert_eq!(updated["item"]["content"], "终稿");
        assert_eq!(updated["item"]["description"], "改好");
    }

    #[test]
    fn delete_removes() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "待删"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let del = cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(del["deleted"], true);

        let got = cap.invoke(serde_json::json!({"action": "get", "id": id}), &ctx).unwrap();
        assert_eq!(got["item"], Value::Null);
    }

    #[test]
    fn breakdown_counts() {
        let cap = TodoCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "content": "a"}), &ctx).unwrap();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "content": "b"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        cap.invoke(serde_json::json!({"action": "complete", "id": id}), &ctx).unwrap();

        let stats = cap.invoke(serde_json::json!({"action": "breakdown"}), &ctx).unwrap();
        assert_eq!(stats["stats"]["pending"], 1);
        assert_eq!(stats["stats"]["completed"], 1);
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