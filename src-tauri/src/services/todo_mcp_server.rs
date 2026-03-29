//! Todo MCP Server
//!
//! MCP server for unified todo management across global and workspace scopes.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::todo::{QueryScope, TodoCreateParams, TodoPriority, TodoStatus, TodoUpdateParams};
use crate::services::unified_todo_repository::UnifiedTodoRepository;

const SERVER_NAME: &str = "polaris-todo-mcp";
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

/// Run the todo MCP server with unified repository
pub fn run_todo_mcp_server(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let config_dir = normalize_path(config_dir)?;
    let workspace_path = workspace_path.and_then(|p| {
        let normalized = p.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(PathBuf::from(normalized))
        }
    });

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

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

fn handle_request(request: JsonRpcRequest, repository: &UnifiedTodoRepository) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, repository),
        _ => Err(AppError::ValidationError(format!("Unsupported method: {}", request.method))),
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
                "name": "list_todos",
                "description": "列出待办事项。默认仅当前工作区，可通过 scope 参数查询全局和所有工作区。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["workspace", "all"],
                            "description": "workspace: 仅当前工作区（默认），all: 全局+所有工作区"
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed", "cancelled"]
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["low", "normal", "high", "urgent"]
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "create_todo",
                "description": "创建一条新待办事项。默认创建到当前工作区，设置 isGlobal=true 创建全局待办。",
                "inputSchema": {
                    "type": "object",
                    "required": ["content"],
                    "properties": {
                        "content": {
                            "type": "string",
                            "minLength": 1,
                            "description": "待办内容"
                        },
                        "description": {
                            "type": "string",
                            "description": "详细描述"
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["low", "normal", "high", "urgent"],
                            "description": "优先级，默认 normal"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "标签"
                        },
                        "relatedFiles": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "关联文件"
                        },
                        "dueDate": {
                            "type": "string",
                            "description": "截止日期"
                        },
                        "estimatedHours": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "description": "预估工时"
                        },
                        "isGlobal": {
                            "type": "boolean",
                            "description": "是否创建为全局待办，默认 false"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "update_todo",
                "description": "更新一条待办事项。会自动定位待办所在的工作区或全局。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "待办 ID"
                        },
                        "content": {
                            "type": "string",
                            "description": "待办内容"
                        },
                        "description": {
                            "type": "string",
                            "description": "详细描述"
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed", "cancelled"],
                            "description": "状态"
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["low", "normal", "high", "urgent"],
                            "description": "优先级"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "标签"
                        },
                        "relatedFiles": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "关联文件"
                        },
                        "dueDate": {
                            "type": "string",
                            "description": "截止日期"
                        },
                        "estimatedHours": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "description": "预估工时"
                        },
                        "spentHours": {
                            "type": "number",
                            "minimum": 0,
                            "description": "已花费工时"
                        },
                        "reminderTime": {
                            "type": "string",
                            "description": "提醒时间"
                        },
                        "dependsOn": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1 },
                            "description": "依赖项"
                        },
                        "lastProgress": {
                            "type": "string",
                            "description": "最近进度"
                        },
                        "lastError": {
                            "type": "string",
                            "description": "最近错误"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "delete_todo",
                "description": "删除一条待办事项。会自动定位待办所在的工作区或全局。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "待办 ID"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "start_todo",
                "description": "将待办标记为进行中。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "待办 ID"
                        },
                        "lastProgress": {
                            "type": "string",
                            "description": "进度备注"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "complete_todo",
                "description": "将待办标记为已完成。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "待办 ID"
                        },
                        "lastProgress": {
                            "type": "string",
                            "description": "完成备注"
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_workspace_breakdown",
                "description": "获取各工作区的待办数量统计。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "list_todos" => execute_list_todos(arguments, repository),
        "create_todo" => execute_create_todo(arguments, repository),
        "update_todo" => execute_update_todo(arguments, repository),
        "delete_todo" => execute_delete_todo(arguments, repository),
        "start_todo" => execute_start_todo(arguments, repository),
        "complete_todo" => execute_complete_todo(arguments, repository),
        "get_workspace_breakdown" => execute_get_workspace_breakdown(repository),
        _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn execute_list_todos(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let scope = parse_scope(arguments.get("scope"));
    let status_filter = arguments.get("status").map(parse_status_value).transpose()?;
    let priority_filter = arguments.get("priority").map(parse_priority_value).transpose()?;
    let limit = arguments
        .get("limit")
        .map(parse_limit_value)
        .transpose()?;

    let mut todos = repository.list_todos(scope)?;

    // Apply filters
    if let Some(status) = status_filter {
        todos.retain(|todo| todo.status == status);
    }
    if let Some(priority) = priority_filter {
        todos.retain(|todo| todo.priority == priority);
    }
    if let Some(limit) = limit {
        todos.truncate(limit as usize);
    }

    // Get workspace breakdown for all scope
    let breakdown = if scope == QueryScope::All {
        Some(repository.get_workspace_breakdown()?)
    } else {
        None
    };

    Ok(tool_success_with_breakdown(
        format!("已返回 {} 条待办", todos.len()),
        todos,
        scope,
        breakdown,
    ))
}

fn execute_create_todo(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::ValidationError("content 不能为空".to_string()))?
        .to_string();

    let is_global = arguments
        .get("isGlobal")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let params = TodoCreateParams {
        content,
        description: optional_trimmed_string(arguments.get("description")),
        priority: arguments.get("priority").map(parse_priority_value).transpose()?,
        tags: optional_string_array(arguments.get("tags"))?,
        related_files: optional_string_array(arguments.get("relatedFiles"))?,
        due_date: optional_trimmed_string(arguments.get("dueDate")),
        estimated_hours: arguments
            .get("estimatedHours")
            .map(parse_positive_number)
            .transpose()?,
        is_global,
        ..Default::default()
    };

    let todo = repository.create_todo(params)?;

    let location = if todo.workspace_path.is_some() {
        todo.workspace_name.as_deref().unwrap_or("工作区")
    } else {
        "全局"
    };

    Ok(tool_success_single(
        format!("已在【{}】创建待办：{}", location, todo.content),
        todo,
    ))
}

fn execute_update_todo(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let estimated_hours = arguments
        .get("estimatedHours")
        .map(parse_positive_number)
        .transpose()?;
    let spent_hours = arguments
        .get("spentHours")
        .map(parse_non_negative_number)
        .transpose()?;

    let params = TodoUpdateParams {
        content: optional_trimmed_string(arguments.get("content")),
        description: optional_trimmed_string(arguments.get("description")),
        status: arguments.get("status").map(parse_status_value).transpose()?,
        priority: arguments.get("priority").map(parse_priority_value).transpose()?,
        tags: optional_string_array(arguments.get("tags"))?,
        related_files: optional_string_array(arguments.get("relatedFiles"))?,
        due_date: optional_trimmed_string(arguments.get("dueDate")),
        estimated_hours,
        spent_hours,
        reminder_time: optional_trimmed_string(arguments.get("reminderTime")),
        depends_on: optional_string_array(arguments.get("dependsOn"))?,
        last_progress: optional_trimmed_string(arguments.get("lastProgress")),
        last_error: optional_trimmed_string(arguments.get("lastError")),
        ..Default::default()
    };

    let todo = repository.update_todo(&id, params)?;
    Ok(tool_success_single(format!("已更新待办：{}", todo.content), todo))
}

fn execute_delete_todo(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let todo = repository.delete_todo(&id)?;
    Ok(tool_success_single(format!("已删除待办：{}", todo.content), todo))
}

fn execute_start_todo(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let last_progress = optional_trimmed_string(arguments.get("lastProgress"));

    let todo = repository.update_todo(
        &id,
        TodoUpdateParams {
            status: Some(TodoStatus::InProgress),
            last_progress,
            ..Default::default()
        },
    )?;

    Ok(tool_success_single(format!("已开始待办：{}", todo.content), todo))
}

fn execute_complete_todo(arguments: Value, repository: &UnifiedTodoRepository) -> Result<Value> {
    let id = parse_id_arg(&arguments)?;
    let last_progress = optional_trimmed_string(arguments.get("lastProgress"));

    let todo = repository.update_todo(
        &id,
        TodoUpdateParams {
            status: Some(TodoStatus::Completed),
            last_progress,
            ..Default::default()
        },
    )?;

    Ok(tool_success_single(format!("已完成待办：{}", todo.content), todo))
}

fn execute_get_workspace_breakdown(repository: &UnifiedTodoRepository) -> Result<Value> {
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
                "text": format!("共 {} 条待办，分布：{}", total, format_breakdown(&breakdown))
            }
        ]
    }))
}

// ============================================================================
// Response helpers
// ============================================================================

fn tool_success_single(summary: String, todo: crate::models::todo::TodoItem) -> Value {
    json!({
        "structuredContent": {
            "todo": todo
        },
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
    todos: Vec<crate::models::todo::TodoItem>,
    scope: QueryScope,
    breakdown: Option<BTreeMap<String, usize>>,
) -> Value {
    let mut structured = json!({
        "count": todos.len(),
        "todos": todos,
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
        return Err(AppError::ValidationError("limit 必须在 1 到 200 之间".to_string()));
    }
    Ok(limit)
}

fn parse_positive_number(value: &Value) -> Result<f64> {
    let number = value
        .as_f64()
        .ok_or_else(|| AppError::ValidationError("数值字段必须是数字".to_string()))?;
    if number <= 0.0 {
        return Err(AppError::ValidationError("数值字段必须大于 0".to_string()));
    }
    Ok(number)
}

fn parse_non_negative_number(value: &Value) -> Result<f64> {
    let number = value
        .as_f64()
        .ok_or_else(|| AppError::ValidationError("数值字段必须是数字".to_string()))?;
    if number < 0.0 {
        return Err(AppError::ValidationError("数值字段必须大于等于 0".to_string()));
    }
    Ok(number)
}

fn parse_status_value(value: &Value) -> Result<TodoStatus> {
    match value.as_str() {
        Some("pending") => Ok(TodoStatus::Pending),
        Some("in_progress") => Ok(TodoStatus::InProgress),
        Some("completed") => Ok(TodoStatus::Completed),
        Some("cancelled") => Ok(TodoStatus::Cancelled),
        _ => Err(AppError::ValidationError("status 非法".to_string())),
    }
}

fn parse_priority_value(value: &Value) -> Result<TodoPriority> {
    match value.as_str() {
        Some("low") => Ok(TodoPriority::Low),
        Some("normal") => Ok(TodoPriority::Normal),
        Some("high") => Ok(TodoPriority::High),
        Some("urgent") => Ok(TodoPriority::Urgent),
        _ => Err(AppError::ValidationError("priority 非法".to_string())),
    }
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
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
        ("list_todos", "列出待办事项。默认仅当前工作区，可通过 scope 参数查询全局和所有工作区。"),
        ("create_todo", "创建一条新待办事项。默认创建到当前工作区，设置 isGlobal=true 创建全局待办。"),
        ("update_todo", "更新一条待办事项。"),
        ("delete_todo", "删除一条待办事项。"),
        ("start_todo", "将待办标记为进行中。"),
        ("complete_todo", "将待办标记为已完成。"),
        ("get_workspace_breakdown", "获取各工作区的待办数量统计。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tool_count() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 7);
        assert!(defs.contains_key("create_todo"));
        assert!(defs.contains_key("complete_todo"));
        assert!(defs.contains_key("get_workspace_breakdown"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize().unwrap();
        assert_eq!(value["protocolVersion"], Value::String(PROTOCOL_VERSION.to_string()));
        assert_eq!(value["serverInfo"]["name"], Value::String(SERVER_NAME.to_string()));
    }

    #[test]
    fn tools_list_contains_new_tools() {
        let value = handle_tools_list();
        let tools = value["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"get_workspace_breakdown"));
        assert!(names.contains(&"list_todos"));
    }
}
