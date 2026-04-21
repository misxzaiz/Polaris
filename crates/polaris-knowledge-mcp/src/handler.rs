//! Tool execution handlers.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::SystemTime;

use serde_json::json;
use serde_json::Value;

use crate::error::{KnowledgeError, Result};
use crate::extractor::matches_any;
use crate::models::{KnowledgeIndex, ModuleEntry};

/// Load and parse the index.json.
pub fn load_index(index_path: &PathBuf) -> Result<KnowledgeIndex> {
    let content = fs::read_to_string(index_path)
        .map_err(|e| KnowledgeError::Io(format!("无法读取知识索引: {}", e)))?;
    serde_json::from_str(&content)
        .map_err(|e| KnowledgeError::Json(format!("知识索引格式错误: {}", e)))
}

/// Read a module document file.
pub fn read_module_doc(modules_dir: &PathBuf, filename: &str) -> Result<String> {
    let path = modules_dir.join(filename);
    fs::read_to_string(&path)
        .map_err(|e| KnowledgeError::Io(format!("无法读取模块文档 {}: {}", filename, e)))
}

/// Find a module by ID.
pub fn find_module<'a>(index: &'a KnowledgeIndex, id: &str) -> Result<&'a ModuleEntry> {
    index
        .modules
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| KnowledgeError::NotFound(format!("模块不存在: {}", id)))
}

// ─── Cache ─────────────────────────────────────────────────────

/// In-memory cache for parsed knowledge indices with mtime-based invalidation.
///
/// Each variant stores the parsed index alongside the file's last-modified timestamp.
/// When the file hasn't changed (same mtime), the cached data is returned directly,
/// avoiding repeated disk I/O and JSON deserialization across tool calls.
pub struct KnowledgeCache {
    v1: Option<(KnowledgeIndex, SystemTime)>,
    v2: Option<(crate::models::KnowledgeIndexV2, SystemTime)>,
}

impl KnowledgeCache {
    pub fn new() -> Self {
        Self { v1: None, v2: None }
    }
}

/// Shared reference to the cache.
///
/// The server event loop is single-threaded. `RefCell` provides interior mutability
/// without requiring `&mut` throughout the call chain.
pub type SharedCache = Rc<RefCell<KnowledgeCache>>;

/// Load v1 index with mtime-based caching.
pub fn load_index_cached(index_path: &PathBuf, cache: &SharedCache) -> Result<KnowledgeIndex> {
    let mtime = std::fs::metadata(index_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let c = cache.borrow();
        if let Some((ref idx, ref cached_mtime)) = c.v1 {
            if Some(*cached_mtime) == mtime {
                return Ok(idx.clone());
            }
        }
    }

    let index = load_index(index_path)?;
    if let Some(mtime) = mtime {
        cache.borrow_mut().v1 = Some((index.clone(), mtime));
    }
    Ok(index)
}

/// Load v2 index with mtime-based caching.
pub fn load_v2_cached(index_path: &PathBuf, cache: &SharedCache) -> Result<crate::models::KnowledgeIndexV2> {
    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("cannot resolve knowledge dir from index path".into())
    })?;
    let v2_path = knowledge_dir.join("index.v2.json");

    if !v2_path.exists() {
        return Err(KnowledgeError::Validation(format!(
            "index.v2.json not found at {} — run migrate first",
            v2_path.display()
        )));
    }

    let mtime = std::fs::metadata(&v2_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let c = cache.borrow();
        if let Some((ref v2, ref cached_mtime)) = c.v2 {
            if Some(*cached_mtime) == mtime {
                return Ok(v2.clone());
            }
        }
    }

    let content = std::fs::read_to_string(&v2_path)
        .map_err(|e| KnowledgeError::Io(format!("cannot read index.v2.json: {}", e)))?;
    let v2: crate::models::KnowledgeIndexV2 = serde_json::from_str(&content)?;
    if let Some(mtime) = mtime {
        cache.borrow_mut().v2 = Some((v2.clone(), mtime));
    }
    Ok(v2)
}

// ─── Tool Execution ─────────────────────────────────────────────

/// Execute list_modules tool.
pub fn execute_list_modules(index_path: &PathBuf, cache: &SharedCache) -> Result<Value> {
    let index = load_index_cached(index_path, cache)?;

    let modules: Vec<Value> = index
        .modules
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "complexity": m.complexity,
                "changeFrequency": m.change_frequency,
                "dependencyCount": m.dependencies.len(),
                "dependentCount": m.dependents.len()
            })
        })
        .collect();

    Ok(json!({
        "structuredContent": {
            "totalModules": modules.len(),
            "modules": modules
        },
        "content": [{
            "type": "text",
            "text": format!("项目共 {} 个知识模块", modules.len())
        }]
    }))
}

/// Execute get_module tool.
pub fn execute_get_module(
    arguments: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }

    let index = load_index_cached(index_path, cache)?;
    let module = find_module(&index, &id)?;

    let doc_content = read_module_doc(modules_dir, &module.file)?;

    Ok(json!({
        "structuredContent": {
            "id": module.id,
            "name": module.name,
            "dependencies": module.dependencies,
            "dependents": module.dependents,
            "complexity": module.complexity,
            "document": doc_content
        },
        "content": [{
            "type": "text",
            "text": format!("模块: {} ({})", module.name, module.id)
        }]
    }))
}

/// Execute get_module_dependencies tool.
pub fn execute_get_dependencies(arguments: Value, index_path: &PathBuf, cache: &SharedCache) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }

    let index = load_index_cached(index_path, cache)?;
    let module = find_module(&index, &id)?;

    // Resolve dependency names
    let dep_names: Vec<Value> = module
        .dependencies
        .iter()
        .map(|dep_id| {
            let name = index
                .modules
                .iter()
                .find(|m| &m.id == dep_id)
                .map(|m| m.name.as_str())
                .unwrap_or(dep_id);
            json!({ "id": dep_id, "name": name })
        })
        .collect();

    let dependent_names: Vec<Value> = module
        .dependents
        .iter()
        .map(|dep_id| {
            let name = index
                .modules
                .iter()
                .find(|m| &m.id == dep_id)
                .map(|m| m.name.as_str())
                .unwrap_or(dep_id);
            json!({ "id": dep_id, "name": name })
        })
        .collect();

    Ok(json!({
        "structuredContent": {
            "module": { "id": module.id, "name": module.name },
            "dependsOn": dep_names,
            "dependedBy": dependent_names
        },
        "content": [{
            "type": "text",
            "text": format!(
                "{} 依赖 {} 个模块，被 {} 个模块依赖",
                module.name,
                module.dependencies.len(),
                module.dependents.len()
            )
        }]
    }))
}

/// Execute get_architecture_overview tool.
pub fn execute_architecture_overview(
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
) -> Result<Value> {
    let index = load_index_cached(index_path, cache)?;

    // Build a concise overview: module id + name + one-line summary from doc
    let mut modules_overview = Vec::new();
    for m in &index.modules {
        // Read first non-empty, non-header line from doc as summary
        let summary = read_module_doc(modules_dir, &m.file)
            .ok()
            .and_then(|doc| {
                doc.lines()
                    .find(|l| {
                        let trimmed = l.trim();
                        !trimmed.is_empty()
                            && !trimmed.starts_with('#')
                            && !trimmed.starts_with('>')
                    })
                    .map(|l| l.trim().to_string())
            })
            .unwrap_or_else(|| "（无描述）".to_string());

        modules_overview.push(json!({
            "id": m.id,
            "name": m.name,
            "summary": summary,
            "dependencies": m.dependencies,
            "complexity": m.complexity
        }));
    }

    // Build dependency graph as adjacency list
    let graph: BTreeMap<String, Vec<String>> = index
        .modules
        .iter()
        .map(|m| (m.id.clone(), m.dependencies.clone()))
        .collect();

    Ok(json!({
        "structuredContent": {
            "totalModules": modules_overview.len(),
            "modules": modules_overview,
            "dependencyGraph": graph
        },
        "content": [{
            "type": "text",
            "text": format!("项目架构：{} 个模块", index.modules.len())
        }]
    }))
}

/// Execute search_modules tool.
pub fn execute_search_modules(
    arguments: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if query.is_empty() {
        return Err(KnowledgeError::Validation("搜索关键词不能为空".to_string()));
    }

    let index = load_index_cached(index_path, cache)?;
    let query_lower = query.to_lowercase();

    let mut results = Vec::new();
    for m in &index.modules {
        // Match against id, name
        let id_match = m.id.to_lowercase().contains(&query_lower);
        let name_match = m.name.to_lowercase().contains(&query_lower);

        // Also search in the document content
        let doc_match = read_module_doc(modules_dir, &m.file)
            .map(|doc| doc.to_lowercase().contains(&query_lower))
            .unwrap_or(false);

        if id_match || name_match || doc_match {
            results.push(json!({
                "id": m.id,
                "name": m.name,
                "matchReason": if id_match { "id匹配" }
                    else if name_match { "名称匹配" }
                    else { "内容匹配" },
                "complexity": m.complexity,
                "dependencies": m.dependencies
            }));
        }
    }

    Ok(json!({
        "structuredContent": {
            "query": query,
            "totalResults": results.len(),
            "results": results
        },
        "content": [{
            "type": "text",
            "text": format!("搜索「{}」找到 {} 个匹配模块", query, results.len())
        }]
    }))
}

/// Execute update_module tool.
pub fn execute_update_module(
    arguments: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }
    if content.is_empty() {
        return Err(KnowledgeError::Validation("文档内容不能为空".to_string()));
    }

    let index = load_index_cached(index_path, cache)?;
    let module = find_module(&index, &id)?;

    // Write updated document
    let doc_path = modules_dir.join(&module.file);
    fs::write(&doc_path, &content)
        .map_err(|e| KnowledgeError::Io(format!("无法写入模块文档 {}: {}", module.file, e)))?;

    // Also update last-analyzed timestamp in meta/
    let knowledge_dir = index_path
        .parent()
        .ok_or_else(|| KnowledgeError::Io("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");
    let _ = fs::create_dir_all(&meta_dir);
    let timestamp = chrono_timestamp();
    let _ = fs::write(
        meta_dir.join(format!("{}.last-updated", id)),
        &timestamp,
    );

    // Clear stale marker if exists (module is now up-to-date)
    let stale_file = meta_dir.join(format!("{}.stale", id));
    let _ = fs::remove_file(&stale_file);

    Ok(json!({
        "structuredContent": {
            "id": id,
            "updated": true,
            "timestamp": timestamp,
            "contentLength": content.len()
        },
        "content": [{
            "type": "text",
            "text": format!("模块 {} 文档已更新（{} 字符）", id, content.len())
        }]
    }))
}

/// Execute mark_modules_stale tool.
pub fn execute_mark_stale(arguments: Value, index_path: &PathBuf, cache: &SharedCache) -> Result<Value> {
    let changed_files = arguments
        .get("changedFiles")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if changed_files.is_empty() {
        return Err(KnowledgeError::Validation("变更文件列表不能为空".to_string()));
    }

    let v2 = load_v2_cached(index_path, cache)?;

    // Normalize changed files: convert backslashes, remove leading ./
    let normalized_changes: Vec<String> = changed_files
        .iter()
        .map(|f| f.replace('\\', "/").trim_start_matches("./").to_string())
        .collect();

    // Find which modules are affected by the changed files using glob matching
    let mut affected = Vec::new();
    for m in &v2.modules {
        let include: Vec<&str> = m.scope.include.iter().map(|s| s.as_str()).collect();
        let exclude: Vec<&str> = m.scope.exclude.iter().map(|s| s.as_str()).collect();

        let is_affected = normalized_changes.iter().any(|changed| {
            matches_any(changed, &include) && !matches_any(changed, &exclude)
        });

        if is_affected {
            affected.push(m.id.clone());
        }
    }

    // Write stale markers
    let knowledge_dir = index_path
        .parent()
        .ok_or_else(|| KnowledgeError::Io("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");
    let _ = fs::create_dir_all(&meta_dir);
    let timestamp = chrono_timestamp();

    for module_id in &affected {
        let _ = fs::write(
            meta_dir.join(format!("{}.stale", module_id)),
            format!("{}|{}", timestamp, normalized_changes.join(",")),
        );
    }

    Ok(json!({
        "structuredContent": {
            "changedFiles": normalized_changes,
            "affectedModules": affected,
            "staleCount": affected.len(),
            "timestamp": timestamp
        },
        "content": [{
            "type": "text",
            "text": format!(
                "{} 个文件变更影响 {} 个模块: {}",
                normalized_changes.len(),
                affected.len(),
                affected.join(", ")
            )
        }]
    }))
}

// ─── Assertion validator tools (v2) ─────────────────────────────

/// Execute validate_assertions tool.
///
/// Reads `index.v2.json` next to the v1 index, runs the validator over all
/// assertions, and (unless `persist=false`) writes the health report to
/// `meta/assertions-health.json`. Requires workspace_root to locate files.
pub fn execute_validate_assertions(
    arguments: Value,
    index_path: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
) -> Result<Value> {
    let workspace_root = workspace_root.ok_or_else(|| {
        KnowledgeError::Validation(
            "validate_assertions requires workspace mode — start server with --workspace".into(),
        )
    })?;

    let persist = arguments
        .get("persist")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let v2 = load_v2_cached(index_path, cache)?;

    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("cannot resolve knowledge dir from index path".into())
    })?;
    let report = crate::validator::validate_index_with_structures(&v2, workspace_root, knowledge_dir)?;

    let persisted_path = if persist {
        Some(crate::validator::write_health_report(&report, knowledge_dir)?)
    } else {
        None
    };

    Ok(json!({
        "structuredContent": {
            "totals": &report.totals,
            "weakModules": &report.weak_modules,
            "generatedAt": &report.generated_at,
            "persistedTo": persisted_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
        },
        "content": [{
            "type": "text",
            "text": format!(
                "校验完成：{} 条断言，通过 {}，失败 {}，跳过 {}。薄弱模块: {}",
                report.totals.total,
                report.totals.passed,
                report.totals.failed,
                report.totals.skipped,
                if report.weak_modules.is_empty() {
                    "无".to_string()
                } else {
                    report.weak_modules.join(", ")
                }
            )
        }]
    }))
}

/// Execute get_assertions_health tool.
///
/// Returns the most recent health report from disk. Does NOT re-run validation
/// — callers who need freshness should invoke `validate_assertions` first.
pub fn execute_get_assertions_health(index_path: &PathBuf) -> Result<Value> {
    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("cannot resolve knowledge dir from index path".into())
    })?;
    let health_path = knowledge_dir.join("meta").join("assertions-health.json");

    if !health_path.exists() {
        return Ok(json!({
            "structuredContent": {
                "available": false,
                "reason": "no validation report yet — run validate_assertions first"
            },
            "content": [{
                "type": "text",
                "text": "暂无校验报告。请先调用 validate_assertions。"
            }]
        }));
    }

    let body = std::fs::read_to_string(&health_path)
        .map_err(|e| KnowledgeError::Io(format!("read health: {}", e)))?;
    let report: crate::validator::HealthReport = serde_json::from_str(&body)?;

    Ok(json!({
        "structuredContent": {
            "available": true,
            "report": report,
        },
        "content": [{
            "type": "text",
            "text": format!(
                "最近校验：{} 条，通过 {}（生成于 {}）",
                report.totals.total, report.totals.passed, report.generated_at
            )
        }]
    }))
}

/// Execute compile_context tool. Loads v2 index and runs the context compiler.
pub fn execute_compile_context(arguments: Value, index_path: &PathBuf, cache: &SharedCache) -> Result<Value> {
    let request: crate::compiler::CompileRequest = serde_json::from_value(arguments.clone())
        .map_err(|e| {
            KnowledgeError::Validation(format!(
                "invalid compile_context arguments: {} (got {})",
                e, arguments
            ))
        })?;

    let v2 = load_v2_cached(index_path, cache)?;

    let pack = crate::compiler::compile_context(&request, &v2)?;

    Ok(json!({
        "structuredContent": &pack,
        "content": [{
            "type": "text",
            "text": format!(
                "编译完成：{} facts / {} assertions / {} traps / {} patterns (预算 {}/{})",
                pack.facts.len(),
                pack.assertions.len(),
                pack.traps.len(),
                pack.patterns.len(),
                pack.budget_used,
                pack.budget_total
            )
        }]
    }))
}

/// Execute extract_structure tool. Walks the workspace once and writes one
/// `<moduleId>.structure.json` per module under `meta/../structures/`.
pub fn execute_extract_structure(
    arguments: Value,
    index_path: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
) -> Result<Value> {
    let workspace_root = workspace_root.ok_or_else(|| {
        KnowledgeError::Validation(
            "extract_structure requires workspace mode — start server with --workspace".into(),
        )
    })?;

    let only_module = arguments
        .get("moduleId")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let v2 = load_v2_cached(index_path, cache)?;

    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("cannot resolve knowledge dir from index path".into())
    })?;
    let structures_dir = knowledge_dir.join("structures");
    std::fs::create_dir_all(&structures_dir)
        .map_err(|e| KnowledgeError::Io(format!("structures dir: {}", e)))?;

    let mut written: Vec<serde_json::Value> = Vec::new();
    let mut total_symbols = 0usize;
    let mut total_files = 0usize;

    for module in &v2.modules {
        if let Some(id) = &only_module {
            if &module.id != id {
                continue;
            }
        }
        let report = crate::extractor::extract_module(module, workspace_root)?;
        let path = structures_dir.join(format!("{}.structure.json", module.id));
        std::fs::write(&path, serde_json::to_vec_pretty(&report)?)
            .map_err(|e| KnowledgeError::Io(format!("write structure: {}", e)))?;
        total_files += report.file_count;
        total_symbols += report.symbol_count;
        written.push(json!({
            "moduleId": report.module_id,
            "files": report.file_count,
            "symbols": report.symbol_count,
            "path": path.to_string_lossy(),
        }));
    }

    Ok(json!({
        "structuredContent": {
            "modulesProcessed": written.len(),
            "totalFiles": total_files,
            "totalSymbols": total_symbols,
            "reports": written,
        },
        "content": [{
            "type": "text",
            "text": format!(
                "抽取完成：{} 个模块 / {} 个文件 / {} 个符号",
                written.len(),
                total_files,
                total_symbols
            )
        }]
    }))
}

/// Execute get_structure tool. Loads a previously persisted structure report.
pub fn execute_get_structure(arguments: Value, index_path: &PathBuf) -> Result<Value> {
    let id = arguments
        .get("moduleId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少 moduleId".into()));
    }

    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("cannot resolve knowledge dir from index path".into())
    })?;

    match crate::extractor::load_structure(&id, knowledge_dir)? {
        Some(report) => {
            let symbol_count = report.symbol_count;
            let file_count = report.file_count;
            Ok(json!({
                "structuredContent": {
                    "available": true,
                    "report": report,
                },
                "content": [{
                    "type": "text",
                    "text": format!(
                        "模块 {}: {} 文件 / {} 符号（生成于 {}）",
                        id, file_count, symbol_count, report.generated_at
                    )
                }]
            }))
        }
        None => Ok(json!({
            "structuredContent": {
                "available": false,
                "reason": "no structure report yet — run extract_structure first"
            },
            "content": [{
                "type": "text",
                "text": format!("模块 {} 暂无结构报告。请先调用 extract_structure。", id)
            }]
        })),
    }
}

// ─── Helpers ────────────────────────────────────────────────────

/// Generate a timestamp string in strict ISO 8601 / RFC 3339 format.
///
/// Returns a UTC timestamp like `2026-04-21T10:30:45.123+00:00`.
/// The frontend (`knowledgeService.ts`) consumes this via `StaleModule.staleSince`
/// and `JavaScript Date` / `new Date(staleSince)` — must be a real ISO string.
fn chrono_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guard rail: timestamp MUST be ISO 8601 parseable.
    /// Previous implementation produced strings like "1776776576Z" which broke
    /// `new Date(...)` on the frontend. This test prevents regression.
    #[test]
    fn test_chrono_timestamp_is_rfc3339() {
        let ts = chrono_timestamp();

        // 1. Must be parseable as RFC 3339.
        let parsed = chrono::DateTime::parse_from_rfc3339(&ts);
        assert!(
            parsed.is_ok(),
            "timestamp `{}` is not valid RFC 3339: {:?}",
            ts,
            parsed.err()
        );

        // 2. Must contain ISO 8601 separator characters.
        assert!(ts.contains('T'), "missing 'T' separator in `{}`", ts);
        assert!(
            ts.ends_with("+00:00") || ts.ends_with('Z'),
            "timestamp `{}` must end with UTC marker",
            ts
        );

        // 3. Must NOT be the old "<unix_secs>Z" format.
        //    That format would be all-digits before 'Z'.
        let before_z = ts.trim_end_matches('Z').trim_end_matches("+00:00");
        assert!(
            before_z.chars().any(|c| !c.is_ascii_digit()),
            "timestamp `{}` looks like a raw unix epoch (regression)",
            ts
        );
    }
}

/// Handle a tool call request.
pub fn handle_tools_call(
    params: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name.as_str() {
        "list_modules" => execute_list_modules(index_path, cache),
        "get_module" => execute_get_module(arguments, index_path, modules_dir, cache),
        "get_module_dependencies" => execute_get_dependencies(arguments, index_path, cache),
        "get_architecture_overview" => execute_architecture_overview(index_path, modules_dir, cache),
        "search_modules" => execute_search_modules(arguments, index_path, modules_dir, cache),
        "update_module" => execute_update_module(arguments, index_path, modules_dir, cache),
        "mark_modules_stale" => execute_mark_stale(arguments, index_path, cache),
        "list_stale_modules" => execute_list_stale_modules(index_path, cache),
        "clear_stale_marker" => execute_clear_stale_marker(arguments, index_path),
        "validate_assertions" => execute_validate_assertions(arguments, index_path, workspace_root, cache),
        "get_assertions_health" => execute_get_assertions_health(index_path),
        "compile_context" => execute_compile_context(arguments, index_path, cache),
        "extract_structure" => execute_extract_structure(arguments, index_path, workspace_root, cache),
        "get_structure" => execute_get_structure(arguments, index_path),
        _ => Err(KnowledgeError::Validation(format!("未知工具: {}", name))),
    }
}

pub fn execute_list_stale_modules(index_path: &PathBuf, cache: &SharedCache) -> Result<Value> {
    let knowledge_dir = index_path
        .parent()
        .ok_or_else(|| KnowledgeError::Io("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");

    if !meta_dir.exists() {
        return Ok(json!({
            "structuredContent": {
                "staleModules": [],
                "totalCount": 0
            },
            "content": [{
                "type": "text",
                "text": "没有过期模块"
            }]
        }));
    }

    let index = load_index_cached(index_path, cache)?;
    let mut stale_modules = Vec::new();

    // Read all .stale files
    for entry in fs::read_dir(&meta_dir)
        .map_err(|e| KnowledgeError::Io(format!("无法读取 meta 目录: {}", e)))?
    {
        let entry = entry.map_err(|e| KnowledgeError::Io(format!("读取目录条目失败: {}", e)))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_name.ends_with(".stale") {
            let module_id = file_name.trim_end_matches(".stale").to_string();

            // Check if module still exists in index
            let module_name = index
                .modules
                .iter()
                .find(|m| m.id == module_id)
                .map(|m| m.name.as_str())
                .unwrap_or(&module_id);

            // Read stale file content: timestamp|changed_files
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            let parts: Vec<&str> = content.splitn(2, '|').collect();
            let timestamp = parts.first().unwrap_or(&"").to_string();
            let changed_files: Vec<String> = parts
                .get(1)
                .map(|s| s.split(',').map(|s| s.to_string()).collect())
                .unwrap_or_default();

            stale_modules.push(json!({
                "id": module_id,
                "name": module_name,
                "staleSince": timestamp,
                "changedFiles": changed_files
            }));
        }
    }

    // Sort by module id for consistent output
    stale_modules.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });

    Ok(json!({
        "structuredContent": {
            "staleModules": stale_modules,
            "totalCount": stale_modules.len()
        },
        "content": [{
            "type": "text",
            "text": format!("{} 个模块需要更新", stale_modules.len())
        }]
    }))
}

/// Execute clear_stale_marker tool.
pub fn execute_clear_stale_marker(arguments: Value, index_path: &PathBuf) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }

    let knowledge_dir = index_path
        .parent()
        .ok_or_else(|| KnowledgeError::Io("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");
    let stale_file = meta_dir.join(format!("{}.stale", id));

    if !stale_file.exists() {
        return Ok(json!({
            "structuredContent": {
                "id": id,
                "cleared": false,
                "reason": "模块未被标记为过期"
            },
            "content": [{
                "type": "text",
                "text": format!("模块 {} 未被标记为过期", id)
            }]
        }));
    }

    fs::remove_file(&stale_file)
        .map_err(|e| KnowledgeError::Io(format!("无法删除过期标记: {}", e)))?;

    Ok(json!({
        "structuredContent": {
            "id": id,
            "cleared": true
        },
        "content": [{
            "type": "text",
            "text": format!("已清除模块 {} 的过期标记", id)
        }]
    }))
}
