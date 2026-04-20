//! Project Knowledge MCP Server
//!
//! MCP server for AI-native project knowledge management.
//! Reads .polaris/knowledge/ module documents and exposes them as MCP tools
//! for Claude Code to query project architecture, module details, and dependencies.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-knowledge-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse<'a> {
    jsonrpc: &'a str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// Knowledge index structure (mirrors .polaris/knowledge/index.json)
#[derive(Debug, Deserialize)]
struct KnowledgeIndex {
    #[allow(dead_code)]
    version: String,
    modules: Vec<ModuleEntry>,
}

#[derive(Debug, Deserialize)]
struct ModuleEntry {
    id: String,
    name: String,
    #[allow(dead_code)]
    scope: Vec<String>,
    dependencies: Vec<String>,
    #[serde(default)]
    dependents: Vec<String>,
    file: String,
    complexity: String,
    #[serde(rename = "changeFrequency")]
    change_frequency: String,
}

// ─── Server Entry ───────────────────────────────────────────────

pub fn run_knowledge_mcp_server(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let config_dir = normalize_path(config_dir)?;
    let workspace_path = workspace_path.and_then(|p| {
        let normalized = p.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(PathBuf::from(normalized))
        }
    });

    // Knowledge lives in the workspace's .polaris/knowledge/ directory
    let knowledge_dir = match &workspace_path {
        Some(wp) => wp.join(".polaris").join("knowledge"),
        None => {
            return Err(AppError::ValidationError(
                "项目知识 MCP 需要工作区路径参数".to_string(),
            ));
        }
    };

    if !knowledge_dir.exists() {
        return Err(AppError::ValidationError(format!(
            "知识目录不存在: {}",
            knowledge_dir.display()
        )));
    }

    let index_path = knowledge_dir.join("index.json");
    let modules_dir = knowledge_dir.join("modules");

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(request) => handle_request(
                request,
                &index_path,
                &modules_dir,
            ),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {}", error),
                }),
            },
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

// ─── Request Handling ───────────────────────────────────────────

fn handle_request(
    request: JsonRpcRequest,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, index_path, modules_dir),
        _ => Err(AppError::ValidationError(format!(
            "Unsupported method: {}",
            request.method
        ))),
    };

    match result {
        Ok(result) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}

fn handle_initialize() -> Result<Value> {
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    }))
}

// ─── Tool Definitions ───────────────────────────────────────────

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "list_modules",
                "description": "列出项目所有知识模块（ID、名称、复杂度、变更频率）。返回项目架构的全局视图。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "get_module",
                "description": "获取指定模块的完整知识文档。包含概述、核心组件、数据流、设计决策和已知陷阱。用于深入理解某个子系统。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID（如 chat-render, ai-engine, scheduler）"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_module_dependencies",
                "description": "获取指定模块的依赖关系，包括上游依赖和下游被依赖模块。用于分析修改影响面。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_architecture_overview",
                "description": "获取项目架构概览，包含所有模块列表及其依赖关系图。用于全面了解项目结构。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "search_modules",
                "description": "按关键词搜索模块。匹配模块 ID、名称和文档内容。用于定位「登录相关的模块在哪」等问题。",
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "minLength": 1,
                            "description": "搜索关键词"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "update_module",
                "description": "更新指定模块的知识文档内容。AI 修改代码后应调用此工具同步更新文档。只有文档内容会被替换，元数据保持不变。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "content"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "模块 ID"
                        },
                        "content": {
                            "type": "string",
                            "minLength": 1,
                            "description": "新的模块文档 Markdown 内容"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "mark_modules_stale",
                "description": "将指定模块标记为需要更新。git commit 后检测到文件变更时自动调用，或手动标记。",
                "inputSchema": {
                    "type": "object",
                    "required": ["changedFiles"],
                    "properties": {
                        "changedFiles": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "变更的文件路径列表（相对工作区根目录）"
                        }
                    },
                    "additionalProperties": false
                }
            }
        ]
    })
}

// ─── Tool Execution ─────────────────────────────────────────────

fn handle_tools_call(
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
        _ => Err(AppError::ValidationError(format!(
            "未知工具: {}",
            name
        ))),
    }
}

/// Load and parse the index.json
fn load_index(index_path: &PathBuf) -> Result<KnowledgeIndex> {
    let content = fs::read_to_string(index_path).map_err(|e| {
        AppError::ProcessError(format!("无法读取知识索引: {}", e))
    })?;
    serde_json::from_str(&content).map_err(|e| {
        AppError::ValidationError(format!("知识索引格式错误: {}", e))
    })
}

/// Read a module document file
fn read_module_doc(modules_dir: &PathBuf, filename: &str) -> Result<String> {
    let path = modules_dir.join(filename);
    fs::read_to_string(&path).map_err(|e| {
        AppError::ProcessError(format!("无法读取模块文档 {}: {}", filename, e))
    })
}

fn execute_list_modules(index_path: &PathBuf) -> Result<Value> {
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

fn execute_get_module(
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
        return Err(AppError::ValidationError("缺少模块 ID".to_string()));
    }

    let index = load_index(index_path)?;
    let module = index
        .modules
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

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

fn execute_get_dependencies(arguments: Value, index_path: &PathBuf) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if id.is_empty() {
        return Err(AppError::ValidationError("缺少模块 ID".to_string()));
    }

    let index = load_index(index_path)?;
    let module = index
        .modules
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

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

fn execute_architecture_overview(
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

fn execute_search_modules(
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
        return Err(AppError::ValidationError("搜索关键词不能为空".to_string()));
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

// ─── Write Operations ──────────────────────────────────────────

fn execute_update_module(
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
        return Err(AppError::ValidationError("缺少模块 ID".to_string()));
    }
    if content.is_empty() {
        return Err(AppError::ValidationError("文档内容不能为空".to_string()));
    }

    let index = load_index(index_path)?;
    let module = index
        .modules
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

    // Write updated document
    let doc_path = modules_dir.join(&module.file);
    fs::write(&doc_path, &content).map_err(|e| {
        AppError::ProcessError(format!("无法写入模块文档 {}: {}", module.file, e))
    })?;

    // Also update last-analyzed timestamp in meta/
    let knowledge_dir = index_path.parent()
        .ok_or_else(|| AppError::ProcessError("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");
    let _ = fs::create_dir_all(&meta_dir);
    let timestamp = chrono::Utc::now().to_rfc3339();
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

fn execute_mark_stale(
    arguments: Value,
    index_path: &PathBuf,
) -> Result<Value> {
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
        return Err(AppError::ValidationError("变更文件列表不能为空".to_string()));
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
    let knowledge_dir = index_path.parent()
        .ok_or_else(|| AppError::ProcessError("无法确定知识目录".to_string()))?;
    let meta_dir = knowledge_dir.join("meta");
    let _ = fs::create_dir_all(&meta_dir);
    let timestamp = chrono::Utc::now().to_rfc3339();

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

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

fn normalize_path(path: &str) -> Result<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::ValidationError("路径不能为空".to_string()));
    }
    let mut buf = PathBuf::from(path);
    // Remove trailing separator for consistency
    if buf.as_os_str().to_string_lossy().ends_with('\\')
        || buf.as_os_str().to_string_lossy().ends_with('/')
    {
        buf.pop();
    }
    Ok(buf)
}
