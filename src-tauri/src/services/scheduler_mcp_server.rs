//! Scheduler MCP Server
//!
//! MCP server for unified scheduler management.
//! Provides tools for CRUD operations on scheduled tasks.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::scheduler::{CreateTaskParams, TriggerType};
use crate::services::mcp_server_common::{self, McpServerHandler};
use crate::services::scheduler::TaskUpdateParams;
use crate::services::unified_scheduler_repository::UnifiedSchedulerRepository;

const SERVER_NAME: &str = "polaris-scheduler-mcp";
const SERVER_VERSION: &str = "0.2.0";

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

    let handler = SchedulerMcpHandler { repository };
    mcp_server_common::run_mcp_server_loop(handler)
}

struct SchedulerMcpHandler {
    repository: UnifiedSchedulerRepository,
}

impl McpServerHandler for SchedulerMcpHandler {
    fn server_name(&self) -> &str {
        SERVER_NAME
    }

    fn server_version(&self) -> &str {
        SERVER_VERSION
    }

    fn tools_list(&self) -> Value {
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

    fn tools_call(&self, name: &str, arguments: &Value) -> Result<Value> {
        match name {
            "list_tasks" => execute_list_tasks(&self.repository),
            "get_task" => execute_get_task(arguments, &self.repository),
            "create_task" => execute_create_task(arguments, &self.repository),
            "update_task" => execute_update_task(arguments, &self.repository),
            "delete_task" => execute_delete_task(arguments, &self.repository),
            "toggle_task" => execute_toggle_task(arguments, &self.repository),
            "get_workspace_breakdown" => execute_get_workspace_breakdown(&self.repository),
            _ => Err(AppError::ValidationError(format!("未知工具: {}", name))),
        }
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

fn execute_get_task(arguments: &Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
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

fn execute_create_task(arguments: &Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
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
        workspace_path: None,
        workspace_name: None,
        mode: Default::default(),
        category: Default::default(),
        mission: None,
        template_id: None,
        template_params: None,
        max_runs: None,
        max_retries: None,
        retry_interval: None,
        timeout_minutes: None,
        group: None,
        notify_on_complete: true,
        executor_type: String::new(),
        executor_params: None,
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

fn execute_update_task(arguments: &Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
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
        ..Default::default()
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

fn execute_delete_task(arguments: &Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
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

fn execute_toggle_task(arguments: &Value, repository: &UnifiedSchedulerRepository) -> Result<Value> {
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
        "after_completion" => Ok(TriggerType::AfterCompletion),
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
}
