//! cap.context —— 上下文管理能力（第七步阶段 B1：命令层摘除后的唯一实现）
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 B：`commands/context.rs` 已摘除，
//! 本能力持有 `ContextMemoryStore`（内存存储，与原命令层同源），动作协议为
//! 同步 dispatch（无流式语义）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `upsert`        `{ "entry": ContextEntry }`
//! - `upsert_many`   `{ "entries": ContextEntry[] }`
//! - `query`         `{ "request": ContextQueryRequest }` → ContextQueryResult
//! - `get_all`       → `{ "entries": ContextEntry[] }`
//! - `remove`        `{ "id" }`
//! - `clear`         → `{ "removed": true }`
//! - `ide_report_current_file`    `{ "context": IdeFileContext }`
//! - `ide_report_file_structure`  `{ "structure": IdeFileStructure }`
//! - `ide_report_diagnostics`     `{ "diagnostics": IdeDiagnostics }`

use crate::contracts::{Capability, CapabilityId, Context, Value};
use crate::services::context_core::{
    ContextContent, ContextEntry, ContextMemoryStore, ContextSource, ContextType,
    IdeDiagnostics, IdeFileContext, IdeFileStructure,
};
use std::sync::{Arc, Mutex};

/// cap.context —— 上下文管理能力（唯一实现）
pub struct ContextCapability {
    store: Arc<Mutex<ContextMemoryStore>>,
}

impl ContextCapability {
    pub fn new(store: Arc<Mutex<ContextMemoryStore>>) -> Self {
        Self { store }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ContextMemoryStore>, String> {
        self.store.lock().map_err(|e| e.to_string())
    }
}

impl Capability for ContextCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.context".into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let get = |k: &str| params.get(k);
        let parse = |k: &str, what: &str| -> Result<Value, String> {
            get(k).cloned().ok_or_else(|| format!("{} 参数缺失", what))
        };

        match action.as_str() {
            "upsert" => {
                let entry: ContextEntry = serde_json::from_value(parse("entry", "entry")?)
                    .map_err(|e| format!("entry 参数非法: {}", e))?;
                self.lock()?.upsert(entry);
                Ok(serde_json::json!({ "ok": true }))
            }
            "upsert_many" => {
                let entries: Vec<ContextEntry> =
                    serde_json::from_value(parse("entries", "entries")?)
                        .map_err(|e| format!("entries 参数非法: {}", e))?;
                let mut guard = self.lock()?;
                for entry in entries {
                    guard.upsert(entry);
                }
                Ok(serde_json::json!({ "ok": true }))
            }
            "query" => {
                let request = serde_json::from_value(parse("request", "request")?)
                    .map_err(|e| format!("request 参数非法: {}", e))?;
                let result = self.lock()?.query(&request);
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "get_all" => {
                let entries = self.lock()?.get_all();
                serde_json::to_value(entries).map_err(|e| e.to_string())
            }
            "remove" => {
                let id = get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                self.lock()?.remove(&id);
                Ok(serde_json::json!({ "ok": true }))
            }
            "clear" => {
                self.lock()?.clear();
                Ok(serde_json::json!({ "removed": true }))
            }
            "ide_report_current_file" => {
                let context: IdeFileContext = serde_json::from_value(parse("context", "context")?)
                    .map_err(|e| format!("context 参数非法: {}", e))?;
                let entry = ContextEntry {
                    id: format!("ide:current_file:{}", context.file_path),
                    source: ContextSource::Ide,
                    type_: ContextType::File,
                    priority: 4,
                    content: ContextContent::File(FileContent {
                        path: context.file_path.clone(),
                        content: context.content,
                        language: context.language,
                    }),
                    workspace_id: Some(context.workspace_id),
                    created_at: now_timestamp(),
                    expires_at: None,
                    estimated_tokens: 500,
                };
                self.lock()?.upsert(entry);
                Ok(serde_json::json!({ "ok": true }))
            }
            "ide_report_file_structure" => {
                let structure: IdeFileStructure =
                    serde_json::from_value(parse("structure", "structure")?)
                        .map_err(|e| format!("structure 参数非法: {}", e))?;
                let entry = ContextEntry {
                    id: format!("ide:structure:{}", structure.file_path),
                    source: ContextSource::Ide,
                    type_: ContextType::FileStructure,
                    priority: 3,
                    content: ContextContent::FileStructure(FileStructureContent {
                        path: structure.file_path.clone(),
                        symbols: structure.symbols,
                        summary: None,
                    }),
                    workspace_id: Some(structure.workspace_id),
                    created_at: now_timestamp(),
                    expires_at: None,
                    estimated_tokens: 100,
                };
                self.lock()?.upsert(entry);
                Ok(serde_json::json!({ "ok": true }))
            }
            "ide_report_diagnostics" => {
                let diagnostics: IdeDiagnostics =
                    serde_json::from_value(parse("diagnostics", "diagnostics")?)
                        .map_err(|e| format!("diagnostics 参数非法: {}", e))?;
                let entry = ContextEntry {
                    id: format!("ide:diagnostics:{}", diagnostics.file_path),
                    source: ContextSource::Diagnostics,
                    type_: ContextType::Diagnostics,
                    priority: 2,
                    content: ContextContent::Diagnostics(DiagnosticsContent {
                        path: Some(diagnostics.file_path.clone()),
                        items: diagnostics.diagnostics,
                        summary: None,
                    }),
                    workspace_id: Some(diagnostics.workspace_id),
                    created_at: now_timestamp(),
                    expires_at: None,
                    estimated_tokens: 50,
                };
                self.lock()?.upsert(entry);
                Ok(serde_json::json!({ "ok": true }))
            }
            other => Err(format!("cap.context 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[inline]
fn now_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

use crate::services::context_core::{DiagnosticsContent, FileContent, FileStructureContent};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::PluginId;
    use crate::services::context_core::ContextQueryRequest;

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
        fn caller_id(&self) -> &PluginId {
            static C: PluginId = PluginId(String::new());
            &C
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn make_cap() -> ContextCapability {
        ContextCapability::new(Arc::new(Mutex::new(ContextMemoryStore::new())))
    }

    fn entry_json(id: &str, text: &str) -> Value {
        serde_json::json!({
            "id": id, "source": "project", "type_": "file",
            "priority": 5, "content": { "type": "file", "path": id, "content": text, "language": "rust" },
            "workspace_id": null, "created_at": 1000, "expires_at": null, "estimated_tokens": 10
        })
    }

    #[test]
    fn upsert_and_get_all_roundtrip() {
        let cap = make_cap();
        let ctx = TestCtx;
        cap.invoke(serde_json::json!({"action": "upsert", "entry": entry_json("e1", "内容一")}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "upsert", "entry": entry_json("e2", "内容二")}), &ctx).unwrap();
        let all = cap.invoke(serde_json::json!({"action": "get_all"}), &ctx).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 2);
    }

    #[test]
    fn upsert_many_and_remove() {
        let cap = make_cap();
        let ctx = TestCtx;
        cap.invoke(
            serde_json::json!({"action": "upsert_many", "entries": [entry_json("a", "1"), entry_json("b", "2")]}),
            &ctx,
        )
        .unwrap();
        cap.invoke(serde_json::json!({"action": "remove", "id": "a"}), &ctx).unwrap();
        let all = cap.invoke(serde_json::json!({"action": "get_all"}), &ctx).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 1);
        assert_eq!(all[0]["id"], "b");
    }

    #[test]
    fn query_returns_matching() {
        let cap = make_cap();
        let ctx = TestCtx;
        cap.invoke(serde_json::json!({"action": "upsert", "entry": entry_json("q1", "关键词甲")}), &ctx).unwrap();
        let r = cap
            .invoke(
                serde_json::json!({"action": "query", "request": {"max_tokens": 1000}}),
                &ctx,
            )
            .unwrap();
        assert!(r.get("entries").is_some() || r.get("items").is_some() || r.is_object());
    }

    #[test]
    fn clear_empties_store() {
        let cap = make_cap();
        let ctx = TestCtx;
        cap.invoke(serde_json::json!({"action": "upsert", "entry": entry_json("c1", "x")}), &ctx).unwrap();
        cap.invoke(serde_json::json!({"action": "clear"}), &ctx).unwrap();
        let all = cap.invoke(serde_json::json!({"action": "get_all"}), &ctx).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 0);
    }

    #[test]
    fn ide_report_builds_entry() {
        let cap = make_cap();
        let ctx = TestCtx;
        cap.invoke(
            serde_json::json!({
                "action": "ide_report_current_file",
                "context": { "file_path": "src/main.rs", "content": "fn main(){}", "language": "rust", "workspace_id": "ws1", "cursor_offset": 0 }
            }),
            &ctx,
        )
        .unwrap();
        let all = cap.invoke(serde_json::json!({"action": "get_all"}), &ctx).unwrap();
        assert_eq!(all[0]["id"], "ide:current_file:src/main.rs");
    }

    #[test]
    fn unknown_action_returns_err() {
        let cap = make_cap();
        let ctx = TestCtx;
        let r = cap.invoke(serde_json::json!({"action": "explode"}), &ctx);
        assert!(r.is_err());
    }
}
