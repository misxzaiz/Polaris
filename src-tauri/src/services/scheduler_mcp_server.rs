//! Scheduler MCP Server
//!
//! MCP server for unified scheduler management.
//! Provides tools for CRUD operations on scheduled tasks.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::scheduler::{CreateTaskParams, TriggerType};
use crate::services::unified_scheduler_repository::{
    TaskUpdateParams, UnifiedSchedulerRepository,
};

const SERVER_NAME: &str = "polaris-scheduler-mcp";
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

/// Run the scheduler MCP server with unified repository
pub fn run_scheduler_mcp_server(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let config_dir = normalize_path(config_dir)?;
    let workspace_path = workspace_path.and_then(|p| {
        let normalized = p.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(PathBuf::from(normalized))
        }
    });

    let repository = UnifiedSchedulerRepository::new(config_dir, workspace_path);
    repository.register_workspace()?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = io::BufReader::new(stdin.lock());
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

fn handle_request(request: JsonRpcRequest, repository: &UnifiedSchedulerRepository) -> JsonRpcResponse<'static> {
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
                "name": "list_tasks",
                "description": "列出定时任务。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "get_task",
                "description": "获取单个定时任务详情。",
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
                "name": "create_task",
                "description": "创建定时任务。",
                "inputSchema": {
                    "type": "object",
                    "required": ["name", "triggerType", "triggerValue", "engineId", "prompt"],
                    "properties": {
                        "name": { "type": "string", "minLength": 1 },
                        "enabled": { "type": "boolean" },
                        "triggerType": { "type": "string", "enum": ["once", "cron", "interval"] },
                        "triggerValue": { "type": "string", "minLength": 1 },
                        "engineId": { "type": "string", "minLength": 1 },
                        "prompt": { "type": "string", "minLength": 1 },
                        "workDir": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "update_task",
                "description": "更新定时任务。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "name": { "type": "string" },
                        "enabled": { "type": "boolean" },
                        "triggerType": { "type": "string", "enum": ["once", "cron", "interval"] },
                        "triggerValue": { "type": "string" },
                        "engineId": { "type": "string" },
                        "prompt": { "type": "string" },
                        "workDir": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "delete_task",
                "description": "删除定时任务。",
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
                "name": "toggle_task",
                "description": "切换任务启用状态。",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "enabled"],
                    "properties": {
                        "id": { "type": "string", "minLength": 1 },
                        "enabled": { "type": "boolean" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_workspace_breakdown",
                "description": "获取各工作区的任务数量统计。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "list_tasks" => execute_list_tasks(repository),
        "get_task" => execute_get_task(arguments, repository),
        "create_task" => execute_create_task(arguments, repository),
        "update_task" => execute_update_task(arguments, repository),
        "delete_task" => execute_delete_task(arguments, repository),
        "toggle_task" => execute_toggle_task(arguments, repository),
        "get_workspace_breakdown" => execute_get_workspace_breakdown(repository),
        _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn execute_list_tasks(repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let tasks = repository.list_tasks()?;

    Ok(json!({
        "structuredContent": {
            "count": tasks.len(),
            "tasks": tasks
        },
        "content": [
            {
                "type": "text",
                "text": format!("已返回 {} 条任务", tasks.len())
            }
        ]
    }))
}

fn execute_get_task(arguments: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let task = repository
        .get_task(id)?
        .ok_or_else(|| AppError::ValidationError(format!("任务不存在: {}", id)))?;

    Ok(json!({
        "structuredContent": task,
        "content": [
            {
                "type": "text",
                "text": format!("任务: {}", task.name)
            }
        ]
    }))
}

fn execute_create_task(arguments: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ValidationError("name 不能为空".to_string()))?
        .to_string();

    let trigger_type_str = arguments
        .get("triggerType")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("triggerType 不能为空".to_string()))?;

    let trigger_type = parse_trigger_type(trigger_type_str)?;

    let trigger_value = arguments
        .get("triggerValue")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ValidationError("triggerValue 不能为空".to_string()))?
        .to_string();

    let engine_id = arguments
        .get("engineId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ValidationError("engineId 不能为空".to_string()))?
        .to_string();

    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ValidationError("prompt 不能为空".to_string()))?
        .to_string();

    let params = CreateTaskParams {
        name,
        enabled: arguments.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        trigger_type,
        trigger_value,
        engine_id,
        prompt,
        work_dir: optional_trimmed_string(arguments.get("workDir")),
        description: optional_trimmed_string(arguments.get("description")),
        document_config: None,
    };

    let task = repository.create_task(params)?;

    let location = if let Some(name) = &task.workspace_name {
        name.as_str()
    } else {
        "全局"
    };

    Ok(json!({
        "structuredContent": task,
        "content": [
            {
                "type": "text",
                "text": format!("已在【{}】创建任务：{}", location, task.name)
            }
        ]
    }))
}

fn execute_update_task(arguments: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let trigger_type = arguments
        .get("triggerType")
        .and_then(Value::as_str)
        .map(parse_trigger_type)
        .transpose()?;

    let updates = TaskUpdateParams {
        name: optional_trimmed_string(arguments.get("name")),
        enabled: arguments.get("enabled").and_then(Value::as_bool),
        trigger_type,
        trigger_value: optional_trimmed_string(arguments.get("triggerValue")),
        engine_id: optional_trimmed_string(arguments.get("engineId")),
        prompt: optional_trimmed_string(arguments.get("prompt")),
        work_dir: optional_trimmed_string(arguments.get("workDir")),
        description: optional_trimmed_string(arguments.get("description")),
        document_config: None,
    };

    let task = repository.update_task(id, updates)?;

    Ok(json!({
        "structuredContent": task,
        "content": [
            {
                "type": "text",
                "text": format!("已更新任务：{}", task.name)
            }
        ]
    }))
}

fn execute_delete_task(arguments: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let task = repository.delete_task(id)?;

    Ok(json!({
        "structuredContent": task,
        "content": [
            {
                "type": "text",
                "text": format!("已删除任务：{}", task.name)
            }
        ]
    }))
}

fn execute_toggle_task(arguments: Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let enabled = arguments
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::ValidationError("enabled 不能为空".to_string()))?;

    let task = repository.toggle_task(id, enabled)?;

    let status = if enabled { "已启用" } else { "已禁用" };

    Ok(json!({
        "structuredContent": task,
        "content": [
            {
                "type": "text",
                "text": format!("任务【{}】{}", task.name, status)
            }
        ]
    }))
}

fn execute_get_workspace_breakdown(repository: &UnifiedSchedulerRepository) -> Result<Value> {
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
                "text": format!("共 {} 条任务", total)
            }
        ]
    }))
}

// ============================================================================
// Helper functions
// ============================================================================

fn normalize_path(path: &str) -> Result<PathBuf> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err(AppError::ValidationError("路径不能为空".to_string()));
    }
    Ok(PathBuf::from(normalized))
}

fn parse_trigger_type(value: &str) -> Result<TriggerType> {
    match value {
        "once" => Ok(TriggerType::Once),
        "cron" => Ok(TriggerType::Cron),
        "interval" => Ok(TriggerType::Interval),
        _ => Err(AppError::ValidationError(format!("无效的 triggerType: {}", value))),
    }
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
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
// Tool definitions for diagnostics
// ============================================================================

pub fn current_tool_definitions() -> std::collections::BTreeMap<&'static str, &'static str> {
    std::collections::BTreeMap::from([
        ("list_tasks", "列出定时任务。"),
        ("get_task", "获取单个定时任务详情。"),
        ("create_task", "创建定时任务。"),
        ("update_task", "更新定时任务。"),
        ("delete_task", "删除定时任务。"),
        ("toggle_task", "切换任务启用状态。"),
        ("get_workspace_breakdown", "获取各工作区的任务数量统计。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tool_count() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 7);
        assert!(defs.contains_key("create_task"));
        assert!(defs.contains_key("toggle_task"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize().unwrap();
        assert_eq!(value["protocolVersion"], Value::String(PROTOCOL_VERSION.to_string()));
        assert_eq!(value["serverInfo"]["name"], Value::String(SERVER_NAME.to_string()));
    }
}
