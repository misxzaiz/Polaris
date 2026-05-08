//! Long goal MCP Server.
//!
//! MCP server for document-backed long goal execution tools.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::long_goal::{
    AppendLongGoalSupplementParams, CompleteLongGoalParams, CreateLongGoalParams,
    RecordLongGoalStepParams, SetLongGoalStatusParams,
};
use crate::services::long_goal_service::LongGoalService;

const SERVER_NAME: &str = "polaris-long-goal-mcp";
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

pub fn run_long_goal_mcp_server(_config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    let workspace_path = workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let workspace_path = workspace_path.to_string_lossy().to_string();

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
            Ok(request) => handle_request(request, &workspace_path),
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

fn handle_request(request: JsonRpcRequest, workspace_path: &str) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, workspace_path),
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
                "name": "long_goal_list",
                "description": "列出当前工作区的长期目标。",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_read",
                "description": "读取单个长期目标的配置和协议文档。",
                "inputSchema": {
                    "type": "object",
                    "required": ["goalId"],
                    "properties": {
                        "goalId": { "type": "string", "minLength": 1 }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_create",
                "description": "创建长期目标文档结构。宿主仍负责自动规划会话和后续调度。",
                "inputSchema": {
                    "type": "object",
                    "required": ["title", "goal", "engineId"],
                    "properties": {
                        "title": { "type": "string", "minLength": 1 },
                        "goal": { "type": "string", "minLength": 1 },
                        "engineId": { "type": "string", "minLength": 1 },
                        "interval": { "type": "string" },
                        "maxRetries": { "type": "integer", "minimum": 0 },
                        "retryBackoff": { "type": "string" },
                        "autoPauseOnComplete": { "type": "boolean" },
                        "allowCodeChanges": { "type": "boolean" },
                        "allowGitCommit": { "type": "boolean" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_append_supplement",
                "description": "追加用户或 AI 补充，后续会话会读取 supplement.md。",
                "inputSchema": {
                    "type": "object",
                    "required": ["goalId", "content"],
                    "properties": {
                        "goalId": { "type": "string", "minLength": 1 },
                        "content": { "type": "string", "minLength": 1 },
                        "priority": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_record_progress",
                "description": "记录执行进度、验证、修改文件、commit 和下一步建议。",
                "inputSchema": {
                    "type": "object",
                    "required": ["goalId", "stepId", "summary"],
                    "properties": {
                        "goalId": { "type": "string", "minLength": 1 },
                        "stepId": { "type": "string", "minLength": 1 },
                        "summary": { "type": "string", "minLength": 1 },
                        "changedFiles": { "type": "array", "items": { "type": "string" } },
                        "testsRun": { "type": "array", "items": { "type": "string" } },
                        "commitSha": { "type": "string" },
                        "result": { "type": "string" },
                        "nextStep": { "type": "string" },
                        "goalStatus": {
                            "type": "string",
                            "enum": ["planning", "active", "running", "paused", "maintenance", "blocked", "completed", "failed"]
                        },
                        "retryFailure": { "type": "boolean" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_set_status",
                "description": "更新长期目标状态。不要用它绕过用户暂停或宿主调度策略。",
                "inputSchema": {
                    "type": "object",
                    "required": ["goalId", "status"],
                    "properties": {
                        "goalId": { "type": "string", "minLength": 1 },
                        "status": {
                            "type": "string",
                            "enum": ["planning", "active", "running", "paused", "maintenance", "blocked", "completed", "failed"]
                        },
                        "phase": {
                            "type": "string",
                            "enum": ["planning", "execution", "maintenance", "review"]
                        },
                        "nextRunAt": { "type": "integer" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "long_goal_complete",
                "description": "记录完成判定、剩余风险和复审建议，并将目标置为 completed/review。",
                "inputSchema": {
                    "type": "object",
                    "required": ["goalId", "completionSummary"],
                    "properties": {
                        "goalId": { "type": "string", "minLength": 1 },
                        "completionSummary": { "type": "string", "minLength": 1 },
                        "remainingRisks": { "type": "array", "items": { "type": "string" } },
                        "reviewSuggestions": { "type": "array", "items": { "type": "string" } }
                    },
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, workspace_path: &str) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("缺少工具名称".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    match name {
        "long_goal_list" => tool_success(json!({
            "workspacePath": workspace_path,
            "goals": LongGoalService::list_goals(workspace_path)?
        })),
        "long_goal_read" => {
            let goal_id = require_string(&arguments, "goalId")?;
            tool_success(json!(LongGoalService::read_goal(workspace_path, &goal_id)?))
        }
        "long_goal_create" => {
            let params_value = with_workspace_path(arguments, workspace_path);
            let params: CreateLongGoalParams = serde_json::from_value(params_value)
                .map_err(|error| AppError::ValidationError(format!("创建长期目标参数无效: {}", error)))?;
            tool_success(json!(LongGoalService::create_goal(params)?))
        }
        "long_goal_append_supplement" => {
            let params = AppendLongGoalSupplementParams {
                workspace_path: workspace_path.to_string(),
                goal_id: require_string(&arguments, "goalId")?,
                content: require_string(&arguments, "content")?,
                priority: optional_string(&arguments, "priority"),
            };
            tool_success(json!(LongGoalService::append_supplement(params)?))
        }
        "long_goal_record_progress" => {
            let params = RecordLongGoalStepParams {
                workspace_path: workspace_path.to_string(),
                goal_id: require_string(&arguments, "goalId")?,
                step_id: require_string(&arguments, "stepId")?,
                summary: require_string(&arguments, "summary")?,
                changed_files: optional_string_array(&arguments, "changedFiles")?.unwrap_or_default(),
                tests_run: optional_string_array(&arguments, "testsRun")?.unwrap_or_default(),
                commit_sha: optional_string(&arguments, "commitSha"),
                result: optional_string(&arguments, "result").unwrap_or_default(),
                next_step: optional_string(&arguments, "nextStep"),
                goal_status: optional_status(&arguments)?,
                retry_failure: arguments
                    .get("retryFailure")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            tool_success(json!(LongGoalService::record_step(params)?))
        }
        "long_goal_set_status" => {
            let params_value = with_workspace_path(arguments, workspace_path);
            let params: SetLongGoalStatusParams = serde_json::from_value(params_value)
                .map_err(|error| AppError::ValidationError(format!("状态参数无效: {}", error)))?;
            tool_success(json!(LongGoalService::set_goal_status(params)?))
        }
        "long_goal_complete" => {
            let params = CompleteLongGoalParams {
                workspace_path: workspace_path.to_string(),
                goal_id: require_string(&arguments, "goalId")?,
                completion_summary: require_string(&arguments, "completionSummary")?,
                remaining_risks: optional_string_array(&arguments, "remainingRisks")?.unwrap_or_default(),
                review_suggestions: optional_string_array(&arguments, "reviewSuggestions")?.unwrap_or_default(),
            };
            tool_success(json!(LongGoalService::complete_goal(params)?))
        }
        _ => Err(AppError::ValidationError(format!("Unknown tool: {}", name))),
    }
}

fn tool_success(value: Value) -> Result<Value> {
    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string_pretty(&value)?
            }
        ]
    }))
}

fn with_workspace_path(mut arguments: Value, workspace_path: &str) -> Value {
    if let Some(object) = arguments.as_object_mut() {
        object.insert("workspacePath".to_string(), Value::String(workspace_path.to_string()));
    }
    arguments
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

fn require_string(arguments: &Value, key: &str) -> Result<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::ValidationError(format!("缺少必填字段: {}", key)))
}

fn optional_string(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn optional_string_array(arguments: &Value, key: &str) -> Result<Option<Vec<String>>> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    let items = value
        .as_array()
        .ok_or_else(|| AppError::ValidationError(format!("{} 必须是数组", key)))?;
    let values = items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| AppError::ValidationError(format!("{} 数组项必须是非空字符串", key)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(values))
}

fn optional_status(arguments: &Value) -> Result<Option<crate::models::long_goal::LongGoalStatus>> {
    let Some(value) = arguments.get("goalStatus") else {
        return Ok(None);
    };
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|error| AppError::ValidationError(format!("goalStatus 无效: {}", error)))
}

pub fn current_tool_definitions() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("long_goal_list", "列出当前工作区的长期目标。"),
        ("long_goal_read", "读取单个长期目标的配置和协议文档。"),
        ("long_goal_create", "创建长期目标文档结构。"),
        ("long_goal_append_supplement", "追加长期目标补充。"),
        ("long_goal_record_progress", "记录长期目标执行进度。"),
        ("long_goal_set_status", "更新长期目标状态。"),
        ("long_goal_complete", "记录长期目标完成判定。"),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_expected_tools() {
        let defs = current_tool_definitions();
        assert_eq!(defs.len(), 7);
        assert!(defs.contains_key("long_goal_list"));
        assert!(defs.contains_key("long_goal_record_progress"));
        assert!(defs.contains_key("long_goal_set_status"));
    }

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize().unwrap();
        assert_eq!(value["protocolVersion"], Value::String(PROTOCOL_VERSION.to_string()));
        assert_eq!(value["serverInfo"]["name"], Value::String(SERVER_NAME.to_string()));
    }

    #[test]
    fn tools_list_contains_long_goal_tools() {
        let value = handle_tools_list();
        let tools = value["tools"].as_array().unwrap();
        let names = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"long_goal_list"));
        assert!(names.contains(&"long_goal_complete"));
    }
}
