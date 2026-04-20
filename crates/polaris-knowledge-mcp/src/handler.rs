//! Tool execution handlers.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::json;
use serde_json::Value;

use crate::error::{KnowledgeError, Result};
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

// ─── Tool Execution ─────────────────────────────────────────────

/// Execute list_modules tool.
pub fn execute_list_modules(index_path: &PathBuf) -> Result<Value> {
    let index = load_index(index_path)?;

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
) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }

    let index = load_index(index_path)?;
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
pub fn execute_get_dependencies(arguments: Value, index_path: &PathBuf) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }

    let index = load_index(index_path)?;
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
) -> Result<Value> {
    let index = load_index(index_path)?;

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
) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if query.is_empty() {
        return Err(KnowledgeError::Validation("搜索关键词不能为空".to_string()));
    }

    let index = load_index(index_path)?;
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

    let index = load_index(index_path)?;
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
pub fn execute_mark_stale(arguments: Value, index_path: &PathBuf) -> Result<Value> {
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

    let index = load_index(index_path)?;

    // Normalize changed files: convert backslashes, remove leading ./
    let normalized_changes: Vec<String> = changed_files
        .iter()
        .map(|f| f.replace('\\', "/").trim_start_matches("./").to_string())
        .collect();

    // Find which modules are affected by the changed files
    let mut affected = Vec::new();
    for m in &index.modules {
        let mut is_affected = false;
        for scope_pattern in &m.scope {
            // Simple prefix/blob matching: check if any changed file starts with scope
            let scope_normalized = scope_pattern.replace('\\', "/").trim_end_matches('/').to_string();
            for changed in &normalized_changes {
                if changed.starts_with(&scope_normalized) || changed.contains(&scope_normalized) {
                    is_affected = true;
                    break;
                }
            }
            if is_affected { break; }
        }
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

// ─── Helpers ────────────────────────────────────────────────────

/// Generate a timestamp string (ISO 8601 format).
fn chrono_timestamp() -> String {
    // Use std::time for timestamp to avoid chrono dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple ISO-like format without chrono
    let secs = now.as_secs();
    // This is a simplified timestamp - for production use chrono
    format!("{}Z", secs)
}

/// Handle a tool call request.
pub fn handle_tools_call(
    params: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
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
        "list_modules" => execute_list_modules(index_path),
        "get_module" => execute_get_module(arguments, index_path, modules_dir),
        "get_module_dependencies" => execute_get_dependencies(arguments, index_path),
        "get_architecture_overview" => execute_architecture_overview(index_path, modules_dir),
        "search_modules" => execute_search_modules(arguments, index_path, modules_dir),
        "update_module" => execute_update_module(arguments, index_path, modules_dir),
        "mark_modules_stale" => execute_mark_stale(arguments, index_path),
        _ => Err(KnowledgeError::Validation(format!("未知工具: {}", name))),
    }
}
