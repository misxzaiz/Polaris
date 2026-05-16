//! Tool execution handlers.

use std::sync::{Arc, Mutex, RwLock};

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use std::time::SystemTime;

use serde_json::json;
use serde_json::Value;

use crate::error::{KnowledgeError, Result};
use crate::extractor::matches_any;
use crate::models::{
    ChangeFrequency, Complexity, KnowledgeIndex, KnowledgeIndexV2, ModuleEntry, ModuleV2,
    ScopeSpec, WorkspaceInfo, V2_SCHEMA_VERSION,
};
use crate::seeder::{self, SeedOptions};

/// Maximum number of retries for transient file read failures.
const INDEX_READ_RETRIES: u32 = 3;

/// Delay between retries in milliseconds.
const INDEX_READ_RETRY_DELAY_MS: u64 = 100;

fn strip_utf8_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

/// Load and parse the index.json.
///
/// Includes retry logic for transient read failures on Windows (antivirus file locks,
/// file-system replication delays, etc.). After all retries are exhausted, returns
/// the last IO error.
pub fn load_index(index_path: &PathBuf) -> Result<KnowledgeIndex> {
    let mut last_err = None;
    for attempt in 0..=INDEX_READ_RETRIES {
        match fs::read_to_string(index_path) {
            Ok(content) => {
                return serde_json::from_str(strip_utf8_bom(&content))
                    .map_err(|e| KnowledgeError::Json(format!("知识索引格式错误: {}", e)));
            }
            Err(e) => {
                let kind = e.kind();
                // Only retry on transient errors (NotFound on Windows can be caused by
                // antivirus scanning, file-system replication delays, or oplocks).
                // Do NOT retry on permission denied — that's a real configuration error.
                if attempt < INDEX_READ_RETRIES
                    && (kind == std::io::ErrorKind::NotFound
                        || kind == std::io::ErrorKind::TimedOut
                        || kind == std::io::ErrorKind::Interrupted)
                {
                    eprintln!(
                        "[knowledge-mcp] index.json 读取失败 (尝试 {}/{}): {} — 重试中",
                        attempt + 1,
                        INDEX_READ_RETRIES,
                        e
                    );
                    std::thread::sleep(std::time::Duration::from_millis(INDEX_READ_RETRY_DELAY_MS));
                    last_err = Some(e);
                    continue;
                }
                return Err(KnowledgeError::Io(format!("无法读取知识索引: {}", e)));
            }
        }
    }
    // Should be unreachable, but satisfy the compiler
    Err(KnowledgeError::Io(format!(
        "无法读取知识索引 (重试耗尽): {}",
        last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "unknown"))
    )))
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
/// Uses `Arc<RwLock<>>` for thread-safe shared access.
/// Multiple read operations can proceed in parallel;
/// cache updates acquire a write lock exclusively.
pub type SharedCache = Arc<RwLock<KnowledgeCache>>;

/// Global write serialization lock.
/// Only one write operation (update_module, seed_assertions, etc.) may execute at a time.
/// Read-only tools do not acquire this lock.
pub type WriteLock = Arc<Mutex<()>>;

/// Load v1 index with mtime-based caching.
pub fn load_index_cached(index_path: &PathBuf, cache: &SharedCache) -> Result<KnowledgeIndex> {
    let mtime = std::fs::metadata(index_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let c = cache.read().unwrap();
        if let Some((ref idx, ref cached_mtime)) = c.v1 {
            if Some(*cached_mtime) == mtime {
                return Ok(idx.clone());
            }
        }
    }

    let index = load_index(index_path)?;
    if let Some(mtime) = mtime {
        cache.write().unwrap().v1 = Some((index.clone(), mtime));
    }
    Ok(index)
}

/// Load v2 index with mtime-based caching.
pub fn load_v2_cached(index_path: &PathBuf, cache: &SharedCache) -> Result<crate::models::KnowledgeIndexV2> {
    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
    })?;
    let v2_path = knowledge_dir.join("index.v2.json");

    if !v2_path.exists() {
        return Err(KnowledgeError::Validation(format!(
            "在 {} 未找到 index.v2.json — 请先运行迁移",
            v2_path.display()
        )));
    }

    let mtime = std::fs::metadata(&v2_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let c = cache.read().unwrap();
        if let Some((ref v2, ref cached_mtime)) = c.v2 {
            if Some(*cached_mtime) == mtime {
                return Ok(v2.clone());
            }
        }
    }

    let content = std::fs::read_to_string(&v2_path)
        .map_err(|e| KnowledgeError::Io(format!("无法读取 index.v2.json: {}", e)))?;
    let v2: crate::models::KnowledgeIndexV2 = serde_json::from_str(strip_utf8_bom(&content))?;
    if let Some(mtime) = mtime {
        cache.write().unwrap().v2 = Some((v2.clone(), mtime));
    }
    Ok(v2)
}

fn path_to_slash_string(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn infer_workspace_root(index_path: &PathBuf) -> String {
    index_path
        .parent()
        .and_then(|knowledge_dir| knowledge_dir.parent())
        .and_then(|polaris_dir| polaris_dir.parent())
        .map(|path| path_to_slash_string(path))
        .unwrap_or_default()
}

fn empty_v2_index(index_path: &PathBuf) -> KnowledgeIndexV2 {
    KnowledgeIndexV2 {
        version: "2.0.0".to_string(),
        schema_version: V2_SCHEMA_VERSION.to_string(),
        generated_at: Some(chrono_timestamp()),
        workspace: WorkspaceInfo {
            root_path: infer_workspace_root(index_path),
            language: Vec::new(),
            framework: Vec::new(),
        },
        domains: Vec::new(),
        modules: Vec::new(),
        global_conventions: Vec::new(),
    }
}

fn normalize_v2_index_for_write(mut raw: Value, index_path: &PathBuf) -> Value {
    let root_path = infer_workspace_root(index_path);

    if let Value::Object(ref mut obj) = raw {
        obj.entry("version".to_string())
            .or_insert_with(|| Value::String("2.0.0".to_string()));
        obj.entry("schemaVersion".to_string())
            .or_insert_with(|| Value::String(V2_SCHEMA_VERSION.to_string()));
        obj.entry("generatedAt".to_string())
            .or_insert_with(|| Value::String(chrono_timestamp()));
        obj.entry("domains".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        obj.entry("modules".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        obj.entry("workspace".to_string()).or_insert_with(|| {
            json!({
                "rootPath": root_path,
                "language": [],
                "framework": []
            })
        });

        if !matches!(obj.get("workspace"), Some(Value::Object(_))) {
            obj.insert(
                "workspace".to_string(),
                json!({
                    "rootPath": infer_workspace_root(index_path),
                    "language": [],
                    "framework": []
                }),
            );
        }

        if let Some(Value::Object(workspace)) = obj.get_mut("workspace") {
            workspace
                .entry("rootPath".to_string())
                .or_insert_with(|| Value::String(infer_workspace_root(index_path)));
            workspace
                .entry("language".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            workspace
                .entry("framework".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
        }
    }

    raw
}

fn load_v2_for_write(
    index_path: &PathBuf,
    v1_index: &KnowledgeIndex,
) -> Result<(PathBuf, KnowledgeIndexV2)> {
    let knowledge_dir = index_path
        .parent()
        .ok_or_else(|| KnowledgeError::Io("无法确定知识目录".to_string()))?;
    let v2_path = knowledge_dir.join("index.v2.json");

    if !v2_path.exists() {
        if !v1_index.modules.is_empty() {
            let workspace_root = infer_workspace_root(index_path);
            let (v2, _report) = crate::migrate::migrate_index(v1_index, &workspace_root)?;
            return Ok((v2_path, v2));
        }

        return Ok((v2_path, empty_v2_index(index_path)));
    }

    let content = fs::read_to_string(&v2_path)
        .map_err(|e| KnowledgeError::Io(format!("无法读取 index.v2.json: {}", e)))?;
    let raw: Value = serde_json::from_str(strip_utf8_bom(&content))
        .map_err(|e| KnowledgeError::Json(format!("index.v2.json 格式错误: {}", e)))?;
    let normalized = normalize_v2_index_for_write(raw, index_path);
    let mut v2: KnowledgeIndexV2 = serde_json::from_value(normalized)
        .map_err(|e| KnowledgeError::Json(format!("index.v2.json 格式错误: {}", e)))?;

    merge_missing_v1_modules_into_v2(index_path, v1_index, &mut v2)?;

    Ok((v2_path, v2))
}

fn merge_missing_v1_modules_into_v2(
    index_path: &PathBuf,
    v1_index: &KnowledgeIndex,
    v2: &mut KnowledgeIndexV2,
) -> Result<()> {
    if v1_index.modules.is_empty() {
        return Ok(());
    }

    let workspace_root = infer_workspace_root(index_path);
    let (migrated, _report) = crate::migrate::migrate_index(v1_index, &workspace_root)?;

    for migrated_domain in migrated.domains {
        if !v2.domains.iter().any(|domain| domain.id == migrated_domain.id) {
            let mut domain = migrated_domain.clone();
            domain.modules.clear();
            v2.domains.push(domain);
        }
    }

    for module in migrated.modules {
        if !v2.modules.iter().any(|existing| existing.id == module.id) {
            v2.modules.push(module.clone());
        }

        if let Some(domain) = v2.domains.iter_mut().find(|domain| domain.id == module.domain) {
            if !domain.modules.iter().any(|id| id == &module.id) {
                domain.modules.push(module.id.clone());
            }
        }
    }

    Ok(())
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
    write_lock: &WriteLock,
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
    write_lock: &WriteLock,
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

    // Generate Mermaid graph
    let mermaid = generate_mermaid_graph(&index);

    // Calculate statistics
    let stats = calculate_graph_stats(&index);

    Ok(json!({
        "structuredContent": {
            "totalModules": modules_overview.len(),
            "modules": modules_overview,
            "dependencyGraph": graph,
            "mermaidGraph": mermaid,
            "statistics": stats
        },
        "content": [{
            "type": "text",
            "text": format!("项目架构：{} 个模块，{} 条依赖边", index.modules.len(), stats["totalEdges"].as_u64().unwrap_or(0))
        }]
    }))
}

/// Execute search_modules tool.
pub fn execute_search_modules(
    arguments: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
    write_lock: &WriteLock,
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
    write_lock: &WriteLock,
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
    fs::create_dir_all(&meta_dir)
        .map_err(|e| KnowledgeError::Io(format!("无法创建 meta 目录: {}", e)))?;
    let timestamp = chrono_timestamp();
    fs::write(
        meta_dir.join(format!("{}.last-updated", id)),
        &timestamp,
    )
    .map_err(|e| KnowledgeError::Io(format!("无法写入更新时间戳: {}", e)))?;

    // Clear stale marker if exists (module is now up-to-date)
    let stale_file = meta_dir.join(format!("{}.stale", id));
    if stale_file.exists() {
        fs::remove_file(&stale_file)
            .map_err(|e| KnowledgeError::Io(format!("无法删除过期标记: {}", e)))?;
    }

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

/// Execute create_module tool.
///
/// Creates a new module in both v1 and v2 indexes, writes the markdown document,
/// and invalidates the cache. Returns an error if the module ID already exists
/// or the domain is not found in v2.
pub fn execute_create_module(
    arguments: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    cache: &SharedCache,
    _write_lock: &WriteLock,
) -> Result<Value> {
    // ── Parse arguments ──────────────────────────────────────────
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let domain = arguments
        .get("domain")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let dependencies = arguments
        .get("dependencies")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let complexity_str = arguments
        .get("complexity")
        .and_then(Value::as_str)
        .unwrap_or("medium")
        .to_string();
    let change_frequency_str = arguments
        .get("changeFrequency")
        .and_then(Value::as_str)
        .unwrap_or("medium")
        .to_string();

    // Parse scope
    let scope_json = arguments.get("scope").cloned().unwrap_or(json!({}));
    let scope_include = scope_json
        .get("include")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let scope_exclude = scope_json
        .get("exclude")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // ── Validate required fields ─────────────────────────────────
    if id.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块 ID".to_string()));
    }
    if name.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块名称".to_string()));
    }
    if domain.is_empty() {
        return Err(KnowledgeError::Validation("缺少所属领域（domain）".to_string()));
    }
    if content.is_empty() {
        return Err(KnowledgeError::Validation("缺少模块文档内容".to_string()));
    }
    if scope_include.is_empty() {
        return Err(KnowledgeError::Validation(
            "scope.include 不能为空，至少需要一个 glob 模式".to_string(),
        ));
    }

    // Parse enums with fallback
    let complexity = match complexity_str.as_str() {
        "low" => Complexity::Low,
        "high" => Complexity::High,
        _ => Complexity::Medium,
    };
    let change_frequency = match change_frequency_str.as_str() {
        "low" => ChangeFrequency::Low,
        "high" => ChangeFrequency::High,
        _ => ChangeFrequency::Medium,
    };

    // Document filename: <id>.md
    let document_file = format!("{}.md", id);

    // ── Load and validate indexes before writing files ───────────
    let mut index = load_index_cached(index_path, cache)?;
    if index.modules.iter().any(|m| m.id == id) {
        return Err(KnowledgeError::Validation(format!(
            "模块 ID '{}' 已存在，请使用 update_module 更新",
            id
        )));
    }

    let (v2_path, mut v2) = load_v2_for_write(index_path, &index)?;
    if v2.modules.iter().any(|m| m.id == id) {
        return Err(KnowledgeError::Validation(format!(
            "模块 ID '{}' 已存在于 v2 索引，请使用 update_module 更新",
            id
        )));
    }

    // ── Write markdown document ──────────────────────────────────
    let doc_path = modules_dir.join(&document_file);
    if doc_path.exists() {
        return Err(KnowledgeError::Validation(format!(
            "文档文件 {} 已存在，请检查是否有冲突",
            document_file
        )));
    }
    fs::write(&doc_path, &content).map_err(|e| {
        KnowledgeError::Io(format!("无法写入模块文档 {}: {}", document_file, e))
    })?;

    // ── Build v1 entry and reverse dependencies ─────────────────
    let v1_entry = ModuleEntry {
        id: id.clone(),
        name: name.clone(),
        scope: scope_include.clone(),
        dependencies: dependencies.clone(),
        dependents: Vec::new(),
        file: document_file.clone(),
        complexity: complexity_str.clone(),
        change_frequency: change_frequency_str.clone(),
    };

    for dep_id in &dependencies {
        if let Some(dep) = index.modules.iter_mut().find(|m| &m.id == dep_id) {
            if !dep.dependents.iter().any(|d| d == &id) {
                dep.dependents.push(id.clone());
            }
        }
    }

    // ── Append to v2 index.v2.json ──────────────────────────────
    let mut v2_domain_warning: Option<String> = None;

    // Validate domain exists in v2
    let domain_exists = v2.domains.iter().any(|d| d.id == domain);
    if !domain_exists {
        v2_domain_warning = Some(format!(
            "领域 '{}' 在 v2 domains 中不存在。模块已创建但领域引用可能无效。建议补充 domain 或修改 domain 参数。",
            domain
        ));
    }

    for dep_id in &dependencies {
        if let Some(dep) = v2.modules.iter_mut().find(|m| &m.id == dep_id) {
            if !dep.dependents.iter().any(|d| d == &id) {
                dep.dependents.push(id.clone());
            }
        }
    }

    // Build v2 module entry
    let v2_entry = ModuleV2 {
        id: id.clone(),
        name: name.clone(),
        domain: domain.clone(),
        scope: ScopeSpec {
            include: scope_include,
            exclude: scope_exclude,
        },
        dependencies,
        dependents: Vec::new(),
        document_file: document_file.clone(),
        structure_file: None,
        complexity,
        change_frequency,
        assertions: Vec::new(),
        traps: Vec::new(),
    };
    v2.modules.push(v2_entry);

    // Also register module ID in the domain's modules list
    if let Some(d) = v2.domains.iter_mut().find(|d| d.id == domain) {
        if !d.modules.iter().any(|m| m == &id) {
            d.modules.push(id.clone());
        }
    }

    let v2_content = serde_json::to_string_pretty(&v2)
        .map_err(|e| KnowledgeError::Json(format!("v2 索引序列化失败: {}", e)))?;
    if let Some(parent) = v2_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| KnowledgeError::Io(format!("无法创建知识目录: {}", e)))?;
    }
    fs::write(&v2_path, &v2_content)
        .map_err(|e| KnowledgeError::Io(format!("无法写入 index.v2.json: {}", e)))?;

    // ── Persist v1 index.json ───────────────────────────────────
    index.modules.push(v1_entry);

    let index_content = serde_json::to_string_pretty(&index)
        .map_err(|e| KnowledgeError::Json(format!("v1 索引序列化失败: {}", e)))?;
    fs::write(index_path, &index_content)
        .map_err(|e| KnowledgeError::Io(format!("无法写入 index.json: {}", e)))?;

    // ── Invalidate cache (indexes changed on disk) ───────────────
    {
        let mut cache = cache.write().unwrap();
        cache.v1 = None;
        cache.v2 = None;
    }

    // ── Build response ───────────────────────────────────────────
    let timestamp = chrono_timestamp();
    let mut structured = json!({
        "id": id,
        "name": name,
        "domain": domain,
        "created": true,
        "v1Updated": true,
        "v2Updated": true,
        "timestamp": timestamp,
        "contentLength": content.len()
    });
    if let Some(warning) = &v2_domain_warning {
        structured["domainWarning"] = json!(warning);
    }

    let mut text = format!(
        "模块 '{}' ({}) 创建成功。v1 已更新。",
        id, name
    );
    text.push_str(" v2 已更新。");
    if let Some(warning) = &v2_domain_warning {
        text.push_str(&format!(" ⚠️ {}", warning));
    }

    Ok(json!({
        "structuredContent": structured,
        "content": [{
            "type": "text",
            "text": text
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
    fs::create_dir_all(&meta_dir)
        .map_err(|e| KnowledgeError::Io(format!("无法创建 meta 目录: {}", e)))?;
    let timestamp = chrono_timestamp();

    for module_id in &affected {
        fs::write(
            meta_dir.join(format!("{}.stale", module_id)),
            format!("{}|{}", timestamp, normalized_changes.join(",")),
        )
        .map_err(|e| {
            KnowledgeError::Io(format!("无法写入 {} 过期标记: {}", module_id, e))
        })?;
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
    write_lock: &WriteLock,
) -> Result<Value> {
    let workspace_root = workspace_root.ok_or_else(|| {
        KnowledgeError::Validation(
            "validate_assertions 需要工作区模式 — 请使用 --workspace 启动服务".into(),
        )
    })?;

    let persist = arguments
        .get("persist")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let v2 = load_v2_cached(index_path, cache)?;

    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
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
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
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
        .map_err(|e| KnowledgeError::Io(format!("无法读取健康报告: {}", e)))?;
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
                "compile_context 参数无效: {} (收到 {})",
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
    write_lock: &WriteLock,
) -> Result<Value> {
    let workspace_root = workspace_root.ok_or_else(|| {
        KnowledgeError::Validation(
            "extract_structure 需要工作区模式 — 请使用 --workspace 启动服务".into(),
        )
    })?;

    let only_module = arguments
        .get("moduleId")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let v2 = load_v2_cached(index_path, cache)?;

    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
    })?;
    let structures_dir = knowledge_dir.join("structures");
    std::fs::create_dir_all(&structures_dir)
        .map_err(|e| KnowledgeError::Io(format!("无法创建 structures 目录: {}", e)))?;

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
            .map_err(|e| KnowledgeError::Io(format!("无法写入结构文件: {}", e)))?;
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
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
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

/// Execute seed_assertions tool. Auto-generates assertions from structure reports.
///
/// Workflow:
/// 1. Load all structure reports from `structures/` directory
/// 2. Call `seeder::seed_assertions` with user-provided options
/// 3. If `apply=true`, persist to index.v2.json
pub fn execute_seed_assertions(
    arguments: Value,
    index_path: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
    write_lock: &WriteLock,
) -> Result<Value> {
    let workspace_root = workspace_root.ok_or_else(|| {
        KnowledgeError::Validation(
            "seed_assertions 需要工作区模式 — 请使用 --workspace 启动服务".into(),
        )
    })?;

    let apply = arguments
        .get("apply")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_per_module = arguments
        .get("maxPerModule")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(5);
    let skip_if_has = arguments
        .get("skipIfHas")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(3);
    let only_module = arguments
        .get("onlyModule")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let opts = SeedOptions {
        max_per_module,
        skip_if_has,
        only_module,
        ..Default::default()
    };

    let v2 = load_v2_cached(index_path, cache)?;
    let knowledge_dir = index_path.parent().ok_or_else(|| {
        KnowledgeError::Io("无法从索引路径解析知识目录".into())
    })?;

    // Load all available structure reports
    let mut structures: BTreeMap<String, crate::extractor::StructureReport> = BTreeMap::new();
    let structures_dir = knowledge_dir.join("structures");
    if structures_dir.exists() {
        for entry in fs::read_dir(&structures_dir)
            .map_err(|e| KnowledgeError::Io(format!("无法读取 structures 目录: {}", e)))?
        {
            let entry = entry.map_err(|e| KnowledgeError::Io(format!("读取目录条目失败: {}", e)))?;
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(report) = serde_json::from_str::<crate::extractor::StructureReport>(&content) {
                        structures.insert(report.module_id.clone(), report);
                    }
                }
            }
        }
    }

    if structures.is_empty() {
        return Ok(json!({
            "structuredContent": {
                "generated": false,
                "reason": "no structure reports found — run extract_structure first"
            },
            "content": [{
                "type": "text",
                "text": "未找到结构报告。请先调用 extract_structure 抽取模块符号表。"
            }]
        }));
    }

    // Run the seeder
    let report = seeder::seed_assertions(&v2, &structures, workspace_root, &opts)?;

    // Optionally apply
    let applied_count = if apply && report.total_added > 0 {
        let v2_path = knowledge_dir.join("index.v2.json");
        let mut v2_mut = v2.clone();
        seeder::apply_seed(&mut v2_mut, &report, &v2_path)?
    } else {
        0
    };

    Ok(json!({
        "structuredContent": {
            "generated": true,
            "dryRun": !apply,
            "report": &report,
            "appliedCount": applied_count,
        },
        "content": [{
            "type": "text",
            "text": if apply {
                format!(
                    "已生成并写入 {} 条断言（{} 个模块）",
                    applied_count, report.modules_touched
                )
            } else {
                format!(
                    "预览：将生成 {} 条断言（{} 个模块）。使用 apply=true 写入。",
                    report.total_added, report.modules_touched
                )
            }
        }]
    }))
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

// ─── Visualization helpers ────────────────────────────────────────────

/// Generate a Mermaid graph from the knowledge index.
fn generate_mermaid_graph(index: &crate::models::KnowledgeIndex) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("graph TD".to_string());

    // v1 index has no domain grouping — emit a flat dependency graph.
    lines.push("  %% Modules".to_string());
    for m in &index.modules {
        lines.push(format!("  {}[\"{}\"]", m.id, m.name));
    }

    lines.push(String::new());
    lines.push("  %% Dependencies".to_string());
    for m in &index.modules {
        for dep in &m.dependencies {
            lines.push(format!("  {} --> {}", m.id, dep));
        }
    }

    lines.join("\n")
}

/// Calculate graph statistics.
fn calculate_graph_stats(index: &crate::models::KnowledgeIndex) -> Value {
    let total_modules = index.modules.len();
    let total_edges: usize = index.modules.iter().map(|m| m.dependencies.len()).sum();
    let avg_deps = if total_modules > 0 {
        total_edges as f64 / total_modules as f64
    } else {
        0.0
    };

    // Count in-degrees (how many modules depend on this one)
    let mut in_degrees: BTreeMap<String, usize> = BTreeMap::new();
    for m in &index.modules {
        *in_degrees.entry(m.id.clone()).or_default() += 0;
        for dep in &m.dependencies {
            *in_degrees.entry(dep.clone()).or_default() += 1;
        }
    }

    // Find most depended on (max in-degree)
    let most_depended = in_degrees
        .iter()
        .max_by_key(|(_, &count)| count)
        .map(|(id, _)| id.clone())
        .unwrap_or_default();

    // Find leaf modules (no dependents)
    let leaf_modules: Vec<String> = index
        .modules
        .iter()
        .filter(|m| m.dependents.is_empty())
        .map(|m| m.id.clone())
        .collect();

    json!({
        "totalModules": total_modules,
        "totalEdges": total_edges,
        "avgDependencies": (avg_deps * 10.0).round() / 10.0,
        "mostDependedOn": most_depended,
        "leafModules": leaf_modules
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, RwLock};

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

    #[test]
    fn load_index_accepts_utf8_bom() {
        let dir = tempfile::tempdir().unwrap();
        let index_path = dir.path().join("index.json");
        std::fs::write(
            &index_path,
            "\u{feff}{\"version\":\"1.0\",\"modules\":[]}",
        )
        .unwrap();

        let index = load_index(&index_path).unwrap();
        assert_eq!(index.version, "1.0");
        assert!(index.modules.is_empty());
    }

    fn test_context(workspace_root: &std::path::Path) -> crate::server::SharedContext {
        let knowledge_dir = workspace_root.join(".polaris").join("knowledge");
        Arc::new(crate::server::ServerContext {
            index_path: knowledge_dir.join("index.json"),
            modules_dir: knowledge_dir.join("modules"),
            workspace_root: Some(workspace_root.to_path_buf()),
            cache: Arc::new(RwLock::new(KnowledgeCache::new())),
            write_lock: Arc::new(Mutex::new(())),
        })
    }

    #[test]
    fn init_knowledge_writes_parseable_v2_index() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(workspace.join(".polaris").join("knowledge")).unwrap();
        let ctx = test_context(&workspace);

        execute_init_knowledge(&ctx).unwrap();

        let content = std::fs::read_to_string(
            workspace.join(".polaris").join("knowledge").join("index.v2.json"),
        )
        .unwrap();
        let v2: KnowledgeIndexV2 = serde_json::from_str(&content).unwrap();

        assert_eq!(v2.version, "2.0.0");
        assert_eq!(v2.schema_version, V2_SCHEMA_VERSION);
        assert_eq!(v2.workspace.root_path, path_to_slash_string(&workspace));
    }

    #[test]
    fn create_module_repairs_legacy_empty_v2_and_updates_modules() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let knowledge_dir = workspace.join(".polaris").join("knowledge");
        std::fs::create_dir_all(knowledge_dir.join("modules")).unwrap();
        std::fs::write(
            knowledge_dir.join("index.json"),
            r#"{"version":"1.0","modules":[]}"#,
        )
        .unwrap();
        std::fs::write(
            knowledge_dir.join("index.v2.json"),
            r#"{"version":"2.0","domains":[],"modules":[],"workspace":{"rootPath":"","language":[],"framework":[]}}"#,
        )
        .unwrap();
        let ctx = test_context(&workspace);

        let result = execute_create_module(
            json!({
                "id": "visual-index",
                "name": "Visual Index",
                "domain": "developer-tools",
                "scope": { "include": ["src/components/KnowledgePanel/**"] },
                "content": "# Visual Index\n",
                "dependencies": [],
                "complexity": "low",
                "changeFrequency": "medium"
            }),
            &ctx.index_path,
            &ctx.modules_dir,
            &ctx.cache,
            &ctx.write_lock,
        )
        .unwrap();

        assert_eq!(
            result["structuredContent"]["v2Updated"].as_bool(),
            Some(true)
        );

        let content = std::fs::read_to_string(knowledge_dir.join("index.v2.json")).unwrap();
        let v2: KnowledgeIndexV2 = serde_json::from_str(&content).unwrap();
        assert_eq!(v2.schema_version, V2_SCHEMA_VERSION);
        assert!(v2.modules.iter().any(|m| m.id == "visual-index"));
    }

    #[test]
    fn create_module_migrates_existing_v1_modules_when_v2_missing() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let knowledge_dir = workspace.join(".polaris").join("knowledge");
        std::fs::create_dir_all(knowledge_dir.join("modules")).unwrap();
        std::fs::write(
            knowledge_dir.join("index.json"),
            r#"{
                "version": "1.0",
                "modules": [{
                    "id": "git",
                    "name": "Git",
                    "scope": ["src/services/git/"],
                    "dependencies": [],
                    "dependents": [],
                    "file": "git.md",
                    "complexity": "medium",
                    "changeFrequency": "high"
                }]
            }"#,
        )
        .unwrap();
        let ctx = test_context(&workspace);

        execute_create_module(
            json!({
                "id": "visual-index",
                "name": "Visual Index",
                "domain": "developer-tools",
                "scope": { "include": ["src/components/KnowledgePanel/**"] },
                "content": "# Visual Index\n",
                "dependencies": ["git"],
                "complexity": "low",
                "changeFrequency": "medium"
            }),
            &ctx.index_path,
            &ctx.modules_dir,
            &ctx.cache,
            &ctx.write_lock,
        )
        .unwrap();

        let v2_content = std::fs::read_to_string(knowledge_dir.join("index.v2.json")).unwrap();
        let v2: KnowledgeIndexV2 = serde_json::from_str(&v2_content).unwrap();
        assert!(v2.modules.iter().any(|m| m.id == "git"));
        assert!(v2.modules.iter().any(|m| m.id == "visual-index"));
        let git = v2.modules.iter().find(|m| m.id == "git").unwrap();
        assert!(git.dependents.iter().any(|id| id == "visual-index"));

        let developer_tools = v2
            .domains
            .iter()
            .find(|domain| domain.id == "developer-tools")
            .unwrap();
        assert!(developer_tools.modules.iter().any(|id| id == "git"));
        assert!(developer_tools.modules.iter().any(|id| id == "visual-index"));
    }

    #[test]
    fn create_module_merges_existing_v1_modules_when_v2_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let knowledge_dir = workspace.join(".polaris").join("knowledge");
        std::fs::create_dir_all(knowledge_dir.join("modules")).unwrap();
        std::fs::write(
            knowledge_dir.join("index.json"),
            r#"{
                "version": "1.0",
                "modules": [{
                    "id": "git",
                    "name": "Git",
                    "scope": ["src/services/git/"],
                    "dependencies": [],
                    "dependents": [],
                    "file": "git.md",
                    "complexity": "medium",
                    "changeFrequency": "high"
                }]
            }"#,
        )
        .unwrap();
        std::fs::write(
            knowledge_dir.join("index.v2.json"),
            r#"{"version":"2.0","domains":[],"modules":[],"workspace":{"rootPath":"","language":[],"framework":[]}}"#,
        )
        .unwrap();
        let ctx = test_context(&workspace);

        execute_create_module(
            json!({
                "id": "visual-index",
                "name": "Visual Index",
                "domain": "developer-tools",
                "scope": { "include": ["src/components/KnowledgePanel/**"] },
                "content": "# Visual Index\n",
                "dependencies": ["git"],
                "complexity": "low",
                "changeFrequency": "medium"
            }),
            &ctx.index_path,
            &ctx.modules_dir,
            &ctx.cache,
            &ctx.write_lock,
        )
        .unwrap();

        let v2_content = std::fs::read_to_string(knowledge_dir.join("index.v2.json")).unwrap();
        let v2: KnowledgeIndexV2 = serde_json::from_str(&v2_content).unwrap();
        assert!(v2.modules.iter().any(|m| m.id == "git"));
        assert!(v2.modules.iter().any(|m| m.id == "visual-index"));

        let developer_tools = v2
            .domains
            .iter()
            .find(|domain| domain.id == "developer-tools")
            .unwrap();
        assert!(developer_tools.modules.iter().any(|id| id == "git"));
        assert!(developer_tools.modules.iter().any(|id| id == "visual-index"));
    }
}

/// Handle a tool call request.
///
/// Uses `SharedContext` (from server.rs) which bundles all shared state.
/// Tools that require an initialized knowledge base (i.e., index.json must
/// exist) are guarded — they return a friendly error directing the caller to
/// run `init_knowledge` first. The `init_knowledge` tool itself is exempt.
pub fn handle_tools_call(params: Value, ctx: &crate::server::SharedContext) -> Result<Value> {
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
        // ── Initialization tool (always available, no guard) ──────
        "init_knowledge" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_init_knowledge(ctx)
        }

        // ── Guard: all remaining tools require initialized state ─
        _ if !ctx.is_initialized() => {
            Err(KnowledgeError::Validation(
                "知识库未初始化，请先调用 init_knowledge 工具".to_string(),
            ))
        }

        // Read-only tools (no write lock needed)
        "list_modules" => execute_list_modules(&ctx.index_path, &ctx.cache),
        "get_module" => execute_get_module(arguments, &ctx.index_path, &ctx.modules_dir, &ctx.cache, &ctx.write_lock),
        "get_module_dependencies" => execute_get_dependencies(arguments, &ctx.index_path, &ctx.cache),
        "get_architecture_overview" => execute_architecture_overview(&ctx.index_path, &ctx.modules_dir, &ctx.cache, &ctx.write_lock),
        "search_modules" => execute_search_modules(arguments, &ctx.index_path, &ctx.modules_dir, &ctx.cache, &ctx.write_lock),
        "list_stale_modules" => execute_list_stale_modules(&ctx.index_path, &ctx.cache),
        "get_assertions_health" => execute_get_assertions_health(&ctx.index_path),
        "compile_context" => execute_compile_context(arguments, &ctx.index_path, &ctx.cache),
        "get_structure" => execute_get_structure(arguments, &ctx.index_path),
        // Write tools (acquire write lock for serialization)
        "update_module" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_update_module(arguments, &ctx.index_path, &ctx.modules_dir, &ctx.cache, &ctx.write_lock)
        }
        "create_module" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_create_module(arguments, &ctx.index_path, &ctx.modules_dir, &ctx.cache, &ctx.write_lock)
        }
        "mark_modules_stale" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_mark_stale(arguments, &ctx.index_path, &ctx.cache)
        }
        "clear_stale_marker" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_clear_stale_marker(arguments, &ctx.index_path)
        }
        "validate_assertions" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_validate_assertions(arguments, &ctx.index_path, ctx.workspace_root.as_deref(), &ctx.cache, &ctx.write_lock)
        }
        "extract_structure" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_extract_structure(arguments, &ctx.index_path, ctx.workspace_root.as_deref(), &ctx.cache, &ctx.write_lock)
        }
        "seed_assertions" => {
            let _guard = ctx.write_lock.lock().unwrap();
            execute_seed_assertions(arguments, &ctx.index_path, ctx.workspace_root.as_deref(), &ctx.cache, &ctx.write_lock)
        }
        _ => Err(KnowledgeError::Validation(format!("未知工具: {}", name))),
    }
}

// ─── init_knowledge ─────────────────────────────────────────────

/// Execute the `init_knowledge` tool.
///
/// Creates the knowledge base directory structure and empty index files.
/// Idempotent — if index.json already exists and is valid, returns success
/// without overwriting.
fn execute_init_knowledge(ctx: &crate::server::SharedContext) -> Result<Value> {
    let knowledge_dir = ctx.knowledge_dir().ok_or_else(|| {
        KnowledgeError::Io("无法确定知识目录路径".to_string())
    })?;

    let mut created: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // 1. Ensure knowledge directory exists
    if !knowledge_dir.exists() {
        fs::create_dir_all(knowledge_dir).map_err(|e| {
            KnowledgeError::Io(format!("无法创建知识目录: {}", e))
        })?;
        created.push(format!("目录: {}", knowledge_dir.display()));
    }

    // 2. Ensure modules/ subdirectory exists
    if !ctx.modules_dir.exists() {
        fs::create_dir_all(&*ctx.modules_dir).map_err(|e| {
            KnowledgeError::Io(format!("无法创建模块目录: {}", e))
        })?;
        created.push(format!("目录: {}", ctx.modules_dir.display()));
    }

    // 3. Ensure meta/ subdirectory exists
    let meta_dir = knowledge_dir.join("meta");
    if !meta_dir.exists() {
        fs::create_dir_all(&meta_dir).map_err(|e| {
            KnowledgeError::Io(format!("无法创建元数据目录: {}", e))
        })?;
        created.push(format!("目录: {}", meta_dir.display()));
    }

    // 4. Create index.json if missing (v1)
    if !ctx.index_path.exists() {
        let v1_content = serde_json::json!({
            "version": "1.0",
            "modules": []
        });
        let content = serde_json::to_string_pretty(&v1_content)
            .map_err(|e| KnowledgeError::Json(format!("序列化 v1 索引失败: {}", e)))?;
        fs::write(&*ctx.index_path, &content).map_err(|e| {
            KnowledgeError::Io(format!("无法写入 index.json: {}", e))
        })?;
        created.push(format!("文件: {}", ctx.index_path.display()));
    } else {
        skipped.push("index.json (已存在)".to_string());
    }

    // 5. Create index.v2.json if missing
    let v2_path = knowledge_dir.join("index.v2.json");
    if !v2_path.exists() {
        let root_path = ctx
            .workspace_root
            .as_deref()
            .map(|path| path_to_slash_string(path))
            .unwrap_or_default();
        let v2_content = serde_json::json!({
            "version": "2.0.0",
            "schemaVersion": V2_SCHEMA_VERSION,
            "generatedAt": chrono_timestamp(),
            "domains": [],
            "modules": [],
            "workspace": {
                "rootPath": root_path,
                "language": [],
                "framework": []
            }
        });
        let content = serde_json::to_string_pretty(&v2_content)
            .map_err(|e| KnowledgeError::Json(format!("序列化 v2 索引失败: {}", e)))?;
        fs::write(&v2_path, &content).map_err(|e| {
            KnowledgeError::Io(format!("无法写入 index.v2.json: {}", e))
        })?;
        created.push(format!("文件: {}", v2_path.display()));
    } else {
        skipped.push("index.v2.json (已存在)".to_string());
    }

    // 6. Invalidate caches so subsequent tool calls read the new files
    {
        let mut cache = ctx.cache.write().unwrap();
        cache.v1 = None;
        cache.v2 = None;
    }

    let summary = if created.is_empty() {
        "知识库已就绪，无需创建新文件".to_string()
    } else {
        format!("知识库初始化完成，创建了 {} 个项目", created.len())
    };

    Ok(json!({
        "structuredContent": {
            "initialized": true,
            "created": created,
            "skipped": skipped
        },
        "content": [{
            "type": "text",
            "text": summary
        }]
    }))
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
