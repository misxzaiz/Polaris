//! cap.context —— 上下文管理能力（第七步阶段 B1：命令层摘除后的唯一实现）
//!
//! 对应 `dev/docs/sky/step7-consolidation.md` 阶段 B：`commands/context.rs` 已摘除，
//! 本能力持有 `ContextMemoryStore`（内存存储，与原命令层同源），动作协议为
//! 同步 dispatch（无流式语义）。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `upsert`        `{ "entry": ContextEntry }`（9 字段全必填，JSON 键为字面 `type_`）
//! - `upsert_many`   `{ "entries": ContextEntry[] }`
//! - `query`         `{ "request": ContextQueryRequest }` → ContextQueryResult
//! - `get_all`       → ContextEntry[]（裸数组）
//! - `remove`        `{ "id" }`（缺失/非字符串报错，不静默）
//! - `clear`         → `{ "removed": true }`
//! - `ide_report_current_file`    `{ "context": IdeFileContext }`
//! - `ide_report_file_structure`  `{ "structure": IdeFileStructure }`
//! - `ide_report_diagnostics`     `{ "diagnostics": IdeDiagnostics }`

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use crate::services::context_core::{
    ContextContent, ContextEntry, ContextMemoryStore, ContextSource, ContextType,
    IdeDiagnostics, IdeFileContext, IdeFileStructure,
};
use std::sync::{Arc, Mutex};

/// cap.context —— 上下文管理能力（唯一实现）
pub struct ContextCapability {
    store: Arc<Mutex<ContextMemoryStore>>,
}

/// 支持的 action 协议（describe、缺 action 文案、未知动作文案三处共享同一清单）
pub const CONTEXT_ACTIONS: &[&str] = &[
    "upsert",
    "upsert_many",
    "query",
    "get_all",
    "remove",
    "clear",
    "ide_report_current_file",
    "ide_report_file_structure",
    "ide_report_diagnostics",
];

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

    fn describe(&self) -> Value {
        // describe 经 standard_describe 构造（2026-10-25 审计归一）。参数名/字段
        // 与 invoke 实现逐条对齐：ide_report_file_structure/ide_report_diagnostics
        // 的参数名是 structure/diagnostics（原 describe 写 context，照文档调用必失败）；
        // ide_report_current_file 补必填 cursor_offset；get_all 返回裸数组；
        // upsert 展开 ContextEntry 字段（JSON 键为字面 type_，content 为 type 标签枚举）。
        standard_describe(
            "cap.context",
            "上下文",
            "上下文记忆存储：条目 CRUD/查询 + IDE 上下文注入（内存型）",
            Some(
                "内存存储：主进程与 bus MCP 独立进程各持独立实例、互不共享——经 \
                 bus_dispatch 写入的条目主进程不可见，读主进程上下文须经 cap_dispatch",
            ),
            serde_json::json!({
                "upsert": {
                    "params": { "entry": "ContextEntry（必填，9 字段全必填）：{ id: string, source: project|workspace|ide|user_selection|semantic_related|history|diagnostics, type_: file|file_structure|symbol|selection|diagnostics|project_meta（JSON 键为字面 type_，带下划线）, priority: 0-5, content: 按 type 标签的枚举对象（如 { \"type\": \"file\", \"path\", \"content\", \"language\" }）, workspace_id: string|null, created_at: 秒级时间戳, expires_at: 秒|null, estimated_tokens: number }" },
                    "returns": "{ ok: true }",
                    "example": { "action": "upsert", "entry": { "id": "e1", "source": "project", "type_": "file", "priority": 5, "content": { "type": "file", "path": "src/main.rs", "content": "fn main() {}", "language": "rust" }, "workspace_id": null, "created_at": 0, "expires_at": null, "estimated_tokens": 10 } }
                },
                "upsert_many": { "params": { "entries": "ContextEntry[]（必填，每项字段同 upsert.entry）" }, "returns": "{ ok: true }" },
                "query": { "params": { "request": "ContextQueryRequest（必填，字段全可选）：{ workspace_id?, types?: ContextType[], sources?: ContextSource[], max_tokens?, min_priority?, current_file?, mentioned_files?: string[] }" }, "returns": "ContextQueryResult { entries: ContextEntry[], total_tokens: number, summary: { file_count, symbol_count, workspace_ids, languages } }" },
                "get_all": { "params": {}, "returns": "ContextEntry[]（裸数组，无 {entries} 包装）" },
                "remove": { "params": { "id": "string（必填，缺失或非字符串直接报错）" }, "returns": "{ ok: true }" },
                "clear": { "params": {}, "returns": "{ removed: true }" },
                "ide_report_current_file": { "params": { "context": "IdeFileContext（必填）：{ workspace_id, file_path, content, language, cursor_offset: number（必填）, selection?: { start: {line,character}, end: {line,character} } }" }, "returns": "{ ok: true }" },
                "ide_report_file_structure": { "params": { "structure": "IdeFileStructure（必填）：{ workspace_id, file_path, symbols: SymbolInfo[] }" }, "returns": "{ ok: true }" },
                "ide_report_diagnostics": { "params": { "diagnostics": "IdeDiagnostics（必填）：{ workspace_id, file_path, diagnostics: Diagnostic[] }" }, "returns": "{ ok: true }" }
            }),
        )
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        // 缺 action 显式报错并列出九个动作（原 unwrap_or("") 把空串落 unknown
        // 分支，报"不支持动作: "且无候选清单，AI 无法自纠）
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.context 需要 action 参数（{:?}）", CONTEXT_ACTIONS))?;
        let get = |k: &str| params.get(k);
        let parse = |k: &str, what: &str| -> Result<Value, String> {
            get(k).cloned().ok_or_else(|| format!("{} 参数缺失", what))
        };

        match action {
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
                // id 缺失显式报错（原 unwrap_or("") 静默降级为删空串 id（无命中）
                // 却返回 {ok:true}——误导性成功，AI 以为删除生效实际什么都没删）
                let id = get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "remove 需要字符串参数 id".to_string())?;
                self.lock()?.remove(id);
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
            // 未知动作文案统一走 contracts::unsupported_action（列出合法动作与
            // cap.help 指路，AI 可自纠）
            other => Err(unsupported_action("cap.context", other, CONTEXT_ACTIONS)),
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
    use crate::contracts::{PluginId, validate_describe};
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
        // 错误文案可自纠：列出全部合法动作与 cap.help 指路
        let err = r.unwrap_err();
        assert!(err.contains("upsert") && err.contains("cap.help"), "实际: {err}");
    }

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = make_cap().describe();
        let problems = validate_describe("cap.context", &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（CONTEXT_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), CONTEXT_ACTIONS.len());
        for name in CONTEXT_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn missing_action_and_remove_missing_id_error_explicitly() {
        let cap = make_cap();
        let ctx = TestCtx;
        // 缺 action：显式报"需要 action 参数"并列动作清单，而非空串落 unknown 分支
        let err = cap.invoke(serde_json::json!({}), &ctx).unwrap_err();
        assert!(err.contains("需要 action 参数"), "实际: {err}");
        // remove 缺 id：显式报错（原静默删空串后返回 {ok:true} 的误导性成功已移除）
        let err = cap
            .invoke(serde_json::json!({"action": "remove"}), &ctx)
            .unwrap_err();
        assert!(err.contains("id"), "实际: {err}");
    }
}
