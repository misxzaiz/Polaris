//! Requirements MCP Server
//!
//! MCP server for unified requirement management.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::requirement::{
    QueryScope, RequirementCreateParams, RequirementExecuteConfig, RequirementPriority,
    RequirementSource, RequirementStatus, RequirementUpdateParams,
};
use crate::services::unified_requirement_repository::UnifiedRequirementRepository;

const SERVER_NAME: &str = "polaris-requirements-mcp";
const SERVER_VERSION: &str = "0.2.0";
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

/// Run the requirements MCP server with unified repository
pub fn run_requirements_mcp_server(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let config_dir = normalize_path(config_dir)?;
    let workspace_path = workspace_path.and_then(|p| {
        let normalized = p.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(PathBuf::from(normalized))
        }
    });

    let repository = UnifiedRequirementRepository::new(config_dir, workspace_path);

    // Register workspace if provided
    repository.register_workspace()?;

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
            // JSON-RPC 2.0 §4.1: a Notification is a Request without an `id`
            // field. The server MUST NOT reply to notifications. Returning
            // any frame here makes strict clients (e.g. codex 0.130's rmcp)
            // fail to parse it as a valid JsonRpcMessage and tear down the
            // stdio transport. Silently consume and continue.
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request, &repository),
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

fn handle_request(
    request: JsonRpcRequest,
    repository: &UnifiedRequirementRepository,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(
            id,
            -32600,
            "Invalid Request: jsonrpc must be 2.0".to_string(),
        );
    }

    let result = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, repository),
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

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "list_requirements",
                "description": "列出需求。默认仅当前工作区，可通过 scope 参数查询全部。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["workspace", "all"],
                            "description": "workspace: 仅当前工作区（默认），all: 全部"
                        },
                        "status": { "type": "string", "enum": ["draft", "pending", "approved", "rejected", "executing", "completed", "failed"] },
                        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "create_requirement",
                "description": "创建一条新需求。需求将关联到当前工作区。",
                "inputSchema": {
                    "type": "object",
                    "required": ["title", "description"],
                    "properties": {
                        "title": { "type": "string", "minLength": 1 },
                        "description": { "type": "string", "minLength": 1 },
                        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] },
                        "tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                        "hasPrototype": { "type": "boolean" },
                        "generatedBy": { "type": "string", "enum": ["ai", "user"] },
                        "generatorTaskId": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "update_requirement",
                "description": "更新一条需求。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "title": { "type": "string" },
                        "description": { "type": "string" },
                        "status": { "type": "string", "enum": ["draft", "pending", "approved", "rejected", "executing", "completed", "failed"] },
                        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] },
                        "tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                        "prototypePath": { "type": "string" },
                        "hasPrototype": { "type": "boolean" },
                        "reviewNote": { "type": "string" },
                        "executeLog": { "type": "string" },
                        "executeError": { "type": "string" },
                        "generatedBy": { "type": "string", "enum": ["ai", "user"] },
                        "sessionId": { "type": "string" },
                        "executeConfig": {
                          "type": "object",
                          "properties": {
                            "scheduledAt": { "type": "integer" },
                            "engineId": { "type": "string" },
                            "workDir": { "type": "string" }
                          },
                          "additionalProperties": false
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "delete_requirement",
                "description": "删除一条需求。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "save_requirement_prototype",
                "description": "保存需求原型 HTML。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "html"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "html": { "type": "string", "minLength": 1 }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_workspace_breakdown",
                "description": "获取各工作区的需求数量统计。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, repository: &UnifiedRequirementRepository) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "list_requirements" => execute_list_requirements(arguments, repository),
        "create_requirement" => execute_create_requirement(arguments, repository),
        "update_requirement" => execute_update_requirement(arguments, repository),
        "delete_requirement" => execute_delete_requirement(arguments, repository),
        "save_requirement_prototype" => execute_save_prototype(arguments, repository),
        "get_workspace_breakdown" => execute_get_workspace_breakdown(repository),
        _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn execute_list_requirements(
    arguments: Value,
    repository: &UnifiedRequirementRepository,
) -> Result<Value> {
    let scope = parse_scope(arguments.get("scope"));
    let status_filter = arguments
        .get("status")
        .map(parse_status_value)
        .transpose()?;
    let priority_filter = arguments
        .get("priority")
        .map(parse_priority_value)
        .transpose()?;
    let limit = arguments.get("limit").map(parse_limit_value).transpose()?;

    let mut requirements = repository.list_requirements(scope)?;

    if let Some(status) = status_filter {
        requirements.retain(|req| req.status == status);
    }
    if let Some(priority) = priority_filter {
        requirements.retain(|req| req.priority == priority);
    }
    if let Some(limit) = limit {
        requirements.truncate(limit as usize);
    }

    let breakdown = if scope == QueryScope::All {
        Some(repository.get_workspace_breakdown()?)
    } else {
        None
    };

    Ok(tool_success_with_breakdown(
        format!("已返回 {} 条需求", requirements.len()),
        requirements,
        scope,
        breakdown,
    ))
}

fn execute_create_requirement(
    arguments: Value,
    repository: &UnifiedRequirementRepository,
) -> Result<Value> {
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError("title 不能为空".to_string()))?
        .to_string();

    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError("description 不能为空".to_string()))?
        .to_string();

    let params = RequirementCreateParams {
        title,
        description,
        priority: arguments
            .get("priority")
            .map(parse_priority_value)
            .transpose()?,
        tags: optional_string_array(arguments.get("tags"))?,
        has_prototype: arguments.get("hasPrototype").and_then(Value::as_bool),
        generated_by: arguments
            .get("generatedBy")
            .map(parse_source_value)
            .transpose()?,
        generator_task_id: optional_trimmed_string(arguments.get("generatorTaskId")),
    };

    let requirement = repository.create_requirement(params)?;

    let location = if let Some(name) = &requirement.workspace_name {
        name.as_str()
    } else {
        "全局"
    };

    Ok(tool_success_single(
        format!("已在【{}】创建需求：{}", location, requirement.title),
        requirement,
    ))
}

fn execute_update_requirement(
    arguments: Value,
    repository: &UnifiedRequirementRepository,
) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;

    let updates = RequirementUpdateParams {
        title: optional_trimmed_string(arguments.get("title")),
        description: optional_trimmed_string(arguments.get("description")),
        status: arguments
            .get("status")
            .map(parse_status_value)
            .transpose()?,
        priority: arguments
            .get("priority")
            .map(parse_priority_value)
            .transpose()?,
        tags: optional_string_array(arguments.get("tags"))?,
        prototype_path: optional_trimmed_string(arguments.get("prototypePath")),
        has_prototype: arguments.get("hasPrototype").and_then(Value::as_bool),
        review_note: optional_trimmed_string(arguments.get("reviewNote")),
        execute_config: arguments
            .get("executeConfig")
            .map(parse_execute_config)
            .transpose()?,
        execute_log: optional_trimmed_string(arguments.get("executeLog")),
        execute_error: optional_trimmed_string(arguments.get("executeError")),
        generated_by: arguments
            .get("generatedBy")
            .map(parse_source_value)
            .transpose()?,
        session_id: optional_trimmed_string(arguments.get("sessionId")),
    };

    let requirement = repository.update_requirement(&id, updates)?;
    Ok(tool_success_single(
        format!("已更新需求：{}", requirement.title),
        requirement,
    ))
}

fn execute_delete_requirement(
    arguments: Value,
    repository: &UnifiedRequirementRepository,
) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let requirement = repository.delete_requirement(&id)?;
    Ok(tool_success_single(
        format!("已删除需求：{}", requirement.title),
        requirement,
    ))
}

fn execute_save_prototype(
    arguments: Value,
    repository: &UnifiedRequirementRepository,
) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let html = arguments
        .get("html")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError("html 不能为空".to_string()))?;

    let prototype_path = repository.save_prototype(&id, html)?;
    let requirement = repository
        .get_requirement(&id)?
        .ok_or_else(|| AppError::ValidationError(format!("需求不存在: {}", id)))?;

    Ok(tool_success_single(
        format!("已保存原型：{}", requirement.title),
        json!({
            "prototypePath": prototype_path,
            "requirement": requirement
        }),
    ))
}

fn execute_get_workspace_breakdown(repository: &UnifiedRequirementRepository) -> Result<Value> {
    let breakdown = repository.get_workspace_breakdown()?;
    let total: usize = breakdown.values().sum();

    Ok(json!({
        "structuredContent": {
            "total": total,
            "breakdown": breakdown
        },
        "content": [
            {
                "type": "text",
                "text": format!("共 {} 条需求，分布：{}", total, format_breakdown(&breakdown))
            }
        ]
    }))
}

// ============================================================================
// Response helpers
// ============================================================================

fn tool_success_single(summary: String, data: impl serde::Serialize) -> Value {
    json!({
        "structuredContent": data,
        "content": [
            {
                "type": "text",
                "text": summary
            }
        ]
    })
}

fn tool_success_with_breakdown(
    summary: String,
    requirements: Vec<crate::models::requirement::RequirementItem>,
    scope: QueryScope,
    breakdown: Option<BTreeMap<String, usize>>,
) -> Value {
    let mut structured = json!({
        "count": requirements.len(),
        "requirements": requirements,
        "scope": if scope == QueryScope::All { "all" } else { "workspace" }
    });

    if let Some(bd) = breakdown {
        structured["workspaceBreakdown"] = json!(bd);
    }

    json!({
        "structuredContent": structured,
        "content": [
            {
                "type": "text",
                "text": summary
            }
        ]
    })
}

fn format_breakdown(breakdown: &BTreeMap<String, usize>) -> String {
    breakdown
        .iter()
        .map(|(name, count)| format!("{}: {}", name, count))
        .collect::<Vec<_>>()
        .join(", ")
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

// ============================================================================
// Argument parsers
// ============================================================================

fn normalize_path(path: &str) -> Result<PathBuf> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err(AppError::ValidationError("路径不能为空".to_string()));
    }
    Ok(PathBuf::from(normalized))
}

fn parse_id_arg(arguments: &Value) -> Result<String> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;
    Ok(id.to_string())
}

fn parse_scope(value: Option<&Value>) -> QueryScope {
    match value.and_then(Value::as_str) {
        Some("all") => QueryScope::All,
        _ => QueryScope::Workspace,
    }
}

fn parse_limit_value(value: &Value) -> Result<u64> {
    let limit = value
        .as_u64()
        .ok_or_else(|| AppError::ValidationError("limit 必须是正整数".to_string()))?;
    if limit == 0 || limit > 200 {
        return Err(AppError::ValidationError(
            "limit 必须在 1 到 200 之间".to_string(),
        ));
    }
    Ok(limit)
}

fn parse_status_value(value: &Value) -> Result<RequirementStatus> {
    match value.as_str() {
        Some("draft") => Ok(RequirementStatus::Draft),
        Some("pending") => Ok(RequirementStatus::Pending),
        Some("approved") => Ok(RequirementStatus::Approved),
        Some("rejected") => Ok(RequirementStatus::Rejected),
        Some("executing") => Ok(RequirementStatus::Executing),
        Some("completed") => Ok(RequirementStatus::Completed),
        Some("failed") => Ok(RequirementStatus::Failed),
        _ => Err(AppError::ValidationError("status 非法".to_string())),
    }
}

fn parse_priority_value(value: &Value) -> Result<RequirementPriority> {
    match value.as_str() {
        Some("low") => Ok(RequirementPriority::Low),
        Some("normal") => Ok(RequirementPriority::Normal),
        Some("high") => Ok(RequirementPriority::High),
        Some("urgent") => Ok(RequirementPriority::Urgent),
        _ => Err(AppError::ValidationError("priority 非法".to_string())),
    }
}

fn parse_source_value(value: &Value) -> Result<RequirementSource> {
    match value.as_str() {
        Some("ai") => Ok(RequirementSource::Ai),
        Some("user") => Ok(RequirementSource::User),
        _ => Err(AppError::ValidationError("generatedBy 非法".to_string())),
    }
}

fn parse_execute_config(value: &Value) -> Result<RequirementExecuteConfig> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::ValidationError("executeConfig 必须是对象".to_string()))?;

    Ok(RequirementExecuteConfig {
        scheduled_at: object.get("scheduledAt").and_then(Value::as_i64),
        engine_id: optional_trimmed_string(object.get("engineId")),
        work_dir: optional_trimmed_string(object.get("workDir")),
    })
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_string_array(value: Option<&Value>) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };

    let items = value
        .as_array()
        .ok_or_else(|| AppError::ValidationError("数组字段必须是数组".to_string()))?;

    let values = items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .ok_or_else(|| AppError::ValidationError("数组项必须是非空字符串".to_string()))
        })
        .collect::<Result<Vec<_>>>()?;

    if values.is_empty() {
        Ok(None)
    } else {
        Ok(Some(values))
    }
}

// ============================================================================
// Tool definitions for diagnostics
// ============================================================================

pub fn current_tool_definitions() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        (
            "list_requirements",
            "列出需求。默认仅当前工作区，可通过 scope 参数查询全部。",
        ),
        (
            "create_requirement",
            "创建一条新需求。需求将关联到当前工作区。",
        ),
        ("update_requirement", "更新一条需求。"),
        ("delete_requirement", "删除一条需求。"),
        ("save_requirement_prototype", "保存需求原型 HTML。"),
        ("get_workspace_breakdown", "获取各工作区的需求数量统计。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tool_count() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 6);
        assert!(defs.contains_key("create_requirement"));
        assert!(defs.contains_key("save_requirement_prototype"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize().unwrap();
        assert_eq!(
            value["protocolVersion"],
            Value::String(PROTOCOL_VERSION.to_string())
        );
        assert_eq!(
            value["serverInfo"]["name"],
            Value::String(SERVER_NAME.to_string())
        );
    }

    // Regression: JSON-RPC 2.0 §4.1 — a Notification is a Request whose `id`
    // field is absent. The main loop relies on `request.id.is_none()` to
    // suppress the response frame. If anyone changes `JsonRpcRequest::id`
    // (e.g. drops `Option`, adds `#[serde(default)]`), this test will catch
    // it before strict clients (codex 0.130+) break in production.
    #[test]
    fn notification_is_detected_when_id_field_is_absent() {
        let payload = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let request: JsonRpcRequest = serde_json::from_str(payload).unwrap();
        assert!(
            request.id.is_none(),
            "missing id field must deserialize to None"
        );
    }

    // Document a known spec edge case: see todo_mcp_server.rs for full notes.
    #[test]
    fn explicit_null_id_collapses_to_none_by_serde_default() {
        let payload = r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#;
        let request: JsonRpcRequest = serde_json::from_str(payload).unwrap();
        assert!(request.id.is_none());
    }
}
