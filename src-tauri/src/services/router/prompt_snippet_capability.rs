//! cap.prompt_snippet —— 快捷片段的唯一实现（第四步迁移第二块）
//!
//! 对应 `dev/docs/sky/step4-migration.md` §2 playbook：命令层 `commands/prompt_snippet.rs`
//! + `services/prompt_snippet_service.rs`（JSON 文件存储 `config/prompt-snippets.json`）
//! 已摘除，本 capability 成为片段数据的**唯一入口**（前端经
//! `router_dispatch("cap.prompt_snippet", ...)`）。
//!
//! # 存储
//!
//! 经 `ctx.storage()` 读写 SqliteStorage（domain=`prompt_snippet`，落
//! `<DataRoot>/stores/prompt_snippet.db`）。每条 `PromptSnippet` 是
//! `Item { id: snippet.id, data: camelCase JSON }`。写路径与域审计同库同事务
//! （第五步阶段 D 模式）。
//!
//! # 旧数据衔接
//!
//! 不做后台迁移（重构原则：旧系统照常运行），只做**一次性只读导入**：
//! `state.rs` 装配时若 domain 为空且旧 `prompt-snippets.json` 存在，把既有片段
//! 导入新库；旧文件原地保留（可回退），导入后不再读取。
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `list`    `{}` → `{ "items": [PromptSnippet...] }`
//! - `get`     `{ "id" }` → `{ "item": PromptSnippet | null }`
//! - `create`  `{ "name", "description"?, "content", "variables"?, "enabled"? }` → `{ "item" }`
//! - `update`  `{ "id", ...fields }` → `{ "item": PromptSnippet | null }`
//! - `delete`  `{ "id" }` → `{ "deleted": bool, "item": PromptSnippet | null }`

use crate::contracts::{
    AuditEntry, Capability, CapabilityId, Context, Id, Item, Query, Value,
};
use crate::models::prompt_snippet::{PromptSnippet, SnippetVariable};
use chrono::Utc;

/// cap.prompt_snippet —— 快捷片段能力（唯一实现）
pub struct PromptSnippetCapability;

const DOMAIN: &str = "prompt_snippet";
const CAP_ID: &str = "cap.prompt_snippet";

// ---------------------------------------------------------------------------
// 存储 helpers
// ---------------------------------------------------------------------------

fn load_all(ctx: &dyn Context) -> Result<Vec<PromptSnippet>, String> {
    let storage = ctx.storage()?;
    let items = storage
        .query(DOMAIN, &Query { filter: Value::Null, limit: None })
        .map_err(|e| format!("cap.prompt_snippet 读取失败: {}", e))?;
    let mut snippets = Vec::with_capacity(items.len());
    for item in items {
        if let Ok(s) = serde_json::from_value::<PromptSnippet>(item.data) {
            snippets.push(s);
        }
    }
    snippets.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.name.cmp(&b.name)));
    Ok(snippets)
}

fn load_one(ctx: &dyn Context, id: &str) -> Result<Option<PromptSnippet>, String> {
    let storage = ctx.storage()?;
    match storage.load(DOMAIN, &Id(id.to_string())) {
        Ok(item) => Ok(Some(
            serde_json::from_value(item.data)
                .map_err(|e| format!("cap.prompt_snippet 反序列化片段失败: {}", e))?,
        )),
        Err(e) if e.contains("不存在") => Ok(None),
        Err(e) => Err(e),
    }
}

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

/// 事务写：业务写 + 域审计同库同事务
fn write_with_audit(ctx: &dyn Context, snippet: &PromptSnippet, action: &str) -> Result<(), String> {
    let storage = ctx.storage()?;
    let data =
        serde_json::to_value(snippet).map_err(|e| format!("cap.prompt_snippet 序列化失败: {}", e))?;
    let mut txn = storage
        .begin()
        .map_err(|e| format!("cap.prompt_snippet 开启事务失败: {}", e))?;
    txn.store(DOMAIN, &Item { id: Id(snippet.id.clone()), data })
        .map_err(|e| format!("cap.prompt_snippet 写入失败: {}", e))?;
    txn.append_audit(DOMAIN, &audit_entry(ctx, action))
        .map_err(|e| format!("cap.prompt_snippet 审计写入失败: {}", e))?;
    txn.commit()
        .map_err(|e| format!("cap.prompt_snippet 事务提交失败: {}", e))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn parse_variables(v: Option<&Value>) -> Vec<SnippetVariable> {
    v.and_then(|v| serde_json::from_value::<Vec<SnippetVariable>>(v.clone()).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 一次性只读导入（旧 JSON 文件 → SqliteStorage domain）
// ---------------------------------------------------------------------------

/// 把旧 `prompt-snippets.json`（PromptSnippetService 的存储）导入 SqliteStorage。
///
/// 语义：文件不存在 → Ok(0)；domain 非空（已导入/已建数据）→ Ok(0) 跳过；
/// 否则逐条 `Storage::store`（导入不落域审计——这是装配动作，非用户 dispatch）。
/// 旧文件原地保留，不删除不改写。
pub fn import_legacy_store(storage: &dyn crate::contracts::Storage, legacy_path: &std::path::Path) -> Result<usize, String> {
    if !legacy_path.exists() {
        return Ok(0);
    }
    let existing = storage
        .query(DOMAIN, &Query { filter: Value::Null, limit: None })
        .map_err(|e| format!("cap.prompt_snippet 导入前查询失败: {}", e))?;
    if !existing.is_empty() {
        return Ok(0);
    }
    let content = std::fs::read_to_string(legacy_path)
        .map_err(|e| format!("读取旧片段文件失败: {}", e))?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyStore {
        #[serde(default)]
        snippets: Vec<PromptSnippet>,
    }
    let legacy: LegacyStore = serde_json::from_str(&content)
        .map_err(|e| format!("解析旧片段文件失败: {}", e))?;
    let mut imported = 0usize;
    for snippet in &legacy.snippets {
        let data = serde_json::to_value(snippet)
            .map_err(|e| format!("cap.prompt_snippet 导入序列化失败: {}", e))?;
        storage
            .store(DOMAIN, &Item { id: Id(snippet.id.clone()), data })
            .map_err(|e| format!("cap.prompt_snippet 导入写入失败: {}", e))?;
        imported += 1;
    }
    Ok(imported)
}

// ---------------------------------------------------------------------------
// 动作分发
// ---------------------------------------------------------------------------

impl PromptSnippetCapability {
    fn action_list(ctx: &dyn Context) -> Result<Value, String> {
        Ok(serde_json::json!({ "items": load_all(ctx)? }))
    }

    fn action_get(ctx: &dyn Context, id: &str) -> Result<Value, String> {
        let item = load_one(ctx, id)?;
        Ok(serde_json::json!({ "item": item }))
    }

    fn action_create(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let name = params
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .ok_or_else(|| "cap.prompt_snippet create 需要 name 参数".to_string())?;
        let content = params
            .get("content")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "cap.prompt_snippet create 需要 content 参数".to_string())?;

        // 名称唯一（对齐旧命令层 ValidationError 语义）
        if load_all(ctx)?.iter().any(|s| s.name == name) {
            return Err(format!("片段名称 '{}' 已存在", name));
        }

        let now = now_ms();
        let snippet = PromptSnippet {
            id: format!("snippet-{}", uuid::Uuid::new_v4()),
            name: name.to_string(),
            description: params.get("description").and_then(|d| d.as_str()).map(String::from),
            content: content.to_string(),
            variables: parse_variables(params.get("variables")),
            enabled: params.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
            created_at: now,
            updated_at: now,
        };
        write_with_audit(ctx, &snippet, "snippet.create")?;
        Ok(serde_json::json!({ "item": snippet }))
    }

    fn action_update(ctx: &dyn Context, params: &Value) -> Result<Value, String> {
        let id = params
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "cap.prompt_snippet update 需要 id 参数".to_string())?;
        let mut snippet = load_one(ctx, id)?.ok_or_else(|| format!("片段不存在: {}", id))?;

        if let Some(new_name) = params.get("name").and_then(|n| n.as_str()).map(str::trim) {
            if !new_name.is_empty() && new_name != snippet.name {
                if load_all(ctx)?.iter().any(|s| s.name == new_name) {
                    return Err(format!("片段名称 '{}' 已存在", new_name));
                }
                snippet.name = new_name.to_string();
            }
        }
        if let Some(v) = params.get("description") {
            snippet.description = v.as_str().map(String::from);
        }
        if let Some(v) = params.get("content").and_then(|c| c.as_str()) {
            snippet.content = v.to_string();
        }
        if let Some(v) = params.get("variables") {
            snippet.variables = parse_variables(Some(v));
        }
        if let Some(v) = params.get("enabled").and_then(|e| e.as_bool()) {
            snippet.enabled = v;
        }
        snippet.updated_at = now_ms();

        write_with_audit(ctx, &snippet, "snippet.update")?;
        Ok(serde_json::json!({ "item": snippet }))
    }

    fn action_delete(ctx: &dyn Context, id: &str) -> Result<Value, String> {
        let snippet = load_one(ctx, id)?;
        let Some(snippet) = snippet else {
            // 对齐旧命令层：删除不存在的片段返回 false，不报错
            return Ok(serde_json::json!({ "deleted": false, "item": Value::Null }));
        };
        let storage = ctx.storage()?;
        let mut txn = storage
            .begin()
            .map_err(|e| format!("cap.prompt_snippet 开启事务失败: {}", e))?;
        txn.delete(DOMAIN, &Id(id.to_string()))
            .map_err(|e| format!("cap.prompt_snippet 删除失败: {}", e))?;
        txn.append_audit(DOMAIN, &audit_entry(ctx, "snippet.delete"))
            .map_err(|e| format!("cap.prompt_snippet 审计写入失败: {}", e))?;
        txn.commit()
            .map_err(|e| format!("cap.prompt_snippet 事务提交失败: {}", e))?;
        Ok(serde_json::json!({ "deleted": true, "item": snippet }))
    }
}

impl Capability for PromptSnippetCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.prompt_snippet 需要 action 参数（list/get/create/update/delete）".to_string())?;
        match action {
            "list" => Self::action_list(ctx),
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
            other => Err(format!("cap.prompt_snippet 不支持动作: {}", other)),
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
        let name = format!("polaris-snippet-cap-test-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let storage = Arc::new(SqliteStorage::new(&tmp).unwrap());
        TestCtx {
            storage,
            caller: crate::contracts::PluginId("cap.prompt_snippet".into()),
        }
    }

    #[test]
    fn create_get_roundtrip() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(
                serde_json::json!({
                    "action": "create",
                    "name": "周报",
                    "content": "写 {{week}} 周报",
                    "variables": [
                        { "key": "week", "label": "周次", "type": "text", "required": true }
                    ]
                }),
                &ctx,
            )
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("snippet-"));
        assert_eq!(created["item"]["enabled"], true);
        assert_eq!(created["item"]["variables"][0]["key"], "week");

        let got = cap.invoke(serde_json::json!({"action": "get", "id": id}), &ctx).unwrap();
        assert_eq!(got["item"]["name"], "周报");
    }

    #[test]
    fn list_sorted_by_created_at() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "name": "a", "content": "x"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "create", "name": "b", "content": "y"}), &ctx).unwrap();
        let list = cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        let names: Vec<_> = list["items"].as_array().unwrap()
            .iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn duplicate_name_rejected() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "name": "重复", "content": "x"}), &ctx).unwrap();
        let r = cap.invoke(serde_json::json!({"action": "create", "name": "重复", "content": "y"}), &ctx);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("已存在"));
    }

    #[test]
    fn update_partial_fields_and_rename_check() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        cap.invoke(serde_json::json!({"action": "create", "name": "one", "content": "x"}), &ctx).unwrap();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "name": "two", "content": "y"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let updated = cap
            .invoke(
                serde_json::json!({"action": "update", "id": id, "content": "y2", "enabled": false}),
                &ctx,
            )
            .unwrap();
        assert_eq!(updated["item"]["content"], "y2");
        assert_eq!(updated["item"]["enabled"], false);
        assert_eq!(updated["item"]["name"], "two");

        // 改名撞 existing 名 → 拒绝
        let r = cap.invoke(serde_json::json!({"action": "update", "id": id, "name": "one"}), &ctx);
        assert!(r.is_err());
    }

    #[test]
    fn delete_returns_item_and_missing_is_false() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "name": "待删", "content": "x"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let del = cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(del["deleted"], true);
        assert_eq!(del["item"]["id"], id);

        // 删除不存在 → false 不报错（对齐旧命令层）
        let again = cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(again["deleted"], false);

        let got = cap.invoke(serde_json::json!({"action": "get", "id": id}), &ctx).unwrap();
        assert_eq!(got["item"], Value::Null);
    }

    #[test]
    fn writes_leave_domain_audit() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        let created = cap
            .invoke(serde_json::json!({"action": "create", "name": "审计", "content": "x"}), &ctx)
            .unwrap();
        let id = created["item"]["id"].as_str().unwrap().to_string();
        cap.invoke(serde_json::json!({"action": "update", "id": id, "content": "y"}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "delete", "id": id}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("prompt_snippet").unwrap(), 3);
        // 读路径不落审计
        cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        assert_eq!(ctx.storage.audit_count("prompt_snippet").unwrap(), 3);
    }

    #[test]
    fn legacy_import_and_skip_when_nonempty() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        // 旧 JSON 文件（PromptSnippetService 的 SnippetStore 形态）
        let legacy_dir = std::env::temp_dir().join(format!(
            "polaris-snippet-legacy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_path = legacy_dir.join("prompt-snippets.json");
        std::fs::write(
            &legacy_path,
            serde_json::json!({
                "version": "1.0.0",
                "snippets": [
                    { "id": "snippet-legacy-1", "name": "旧片段", "content": "旧内容",
                      "variables": [], "enabled": true,
                      "createdAt": 1000, "updatedAt": 1000 }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let imported = import_legacy_store(ctx.storage.as_ref(), &legacy_path).unwrap();
        assert_eq!(imported, 1);
        let list = cap.invoke(serde_json::json!({"action": "list"}), &ctx).unwrap();
        assert_eq!(list["items"][0]["name"], "旧片段");

        // domain 非空 → 再导入跳过
        let again = import_legacy_store(ctx.storage.as_ref(), &legacy_path).unwrap();
        assert_eq!(again, 0);
        let _ = std::fs::remove_dir_all(&legacy_dir);
    }

    #[test]
    fn import_missing_file_is_noop() {
        let ctx = make_ctx();
        let imported =
            import_legacy_store(ctx.storage.as_ref(), &std::path::Path::new("Z:/definitely/not/here.json")).unwrap();
        assert_eq!(imported, 0);
    }

    #[test]
    fn unknown_action_returns_err() {
        let cap = PromptSnippetCapability;
        let ctx = make_ctx();
        let r = cap.invoke(serde_json::json!({"action": "explode"}), &ctx);
        assert!(r.is_err());
    }
}
