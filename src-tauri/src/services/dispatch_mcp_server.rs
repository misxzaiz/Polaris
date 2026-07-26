//! Dispatch Task MCP Server
//!
//! Stdio JSON-RPC 2.0 server exposing two tools:
//!   - `dispatch_task`: forward a sub-task to another Polaris session (a new
//!     silent background session). Returns immediately with a dispatch id —
//!     the current session is NOT blocked while the task runs.
//!   - `check_dispatched_task`: query the status/summary of a dispatched task.
//!
//! On tool_call, it opens a TCP connection to the main Polaris process,
//! sends a `dispatch` / `dispatch_status` frame, reads the result frame,
//! and returns it as a normal MCP tool_result.
//!
//! Wire protocol (matches `services::ask_listener`):
//!   - Length-prefixed frames: u32 LE length + UTF-8 JSON body
//!   - dispatch frame (client -> server):
//!       { "type":"dispatch", "token":"<uuid>", "sessionId":"...",
//!         "dispatchId":"...", "prompt":"...", "title":"...",
//!         "workDir":null, "engineId":null }
//!   - dispatch_result frame (server -> client):
//!       { "type":"dispatch_result", "ok":true, "dispatchId":"...",
//!         "sessionId":"dispatch-1-xxxx" }
//!   - dispatch_status frame (client -> server):
//!       { "type":"dispatch_status", "token":"<uuid>", "dispatchId":"..." }
//!   - dispatch_status_result frame (server -> client):
//!       { "type":"dispatch_status_result", "ok":true, "task": {...} }

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};

const SERVER_NAME: &str = "polaris-dispatch-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";
const DISPATCH_TOOL_NAME: &str = "dispatch_task";
const CHECK_TOOL_NAME: &str = "check_dispatched_task";
const CONTINUE_TOOL_NAME: &str = "continue_dispatched_task";
const TARGETS_TOOL_NAME: &str = "list_dispatch_targets";
const ROSTER_TOOL_NAME: &str = "dispatch_roster";
const FIND_EXPERT_TOOL_NAME: &str = "find_expert";
const SAVE_AGENT_TOOL_NAME: &str = "save_agent";
const DELETE_AGENT_TOOL_NAME: &str = "delete_agent";
const LIST_AGENTS_TOOL_NAME: &str = "list_agents";
const SAVE_ROSTER_TOOL_NAME: &str = "save_roster";

/// Server-level configuration, parsed from CLI args.
pub struct DispatchMcpConfig {
    pub port: u16,
    pub token: String,
    pub session_id: Option<String>,
    /// 默认工作目录(save_agent/list_agents 等工具缺省 workDir 时回退)
    pub work_dir: Option<String>,
}

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

/// Run the dispatch MCP server: stdio JSON-RPC loop.
pub fn run_dispatch_mcp_server(config: DispatchMcpConfig) -> Result<()> {
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
            // JSON-RPC 2.0 §4.1: a Notification (no `id`) MUST NOT receive a reply.
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request, &config),
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

fn handle_request(request: JsonRpcRequest, config: &DispatchMcpConfig) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(handle_initialize()),
        "notifications/initialized" => Ok(json!({})),
        "notifications/cancelled" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, config),
        other => Err(AppError::ValidationError(format!(
            "Unsupported method: {}",
            other
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

fn handle_initialize() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": concat!(
            "Polaris dispatch & self-service expert MCP.\n\n",
            "You can delegate sub-tasks (dispatch_task) and ALSO build your own ",
            "experts and teams on the fly:\n",
            "1. list_agents(workDir?) — list existing project experts (slug/name/",
            "description) and user rosters; use before creating to avoid slug ",
            "collisions.\n",
            "2. save_agent(slug, name, description, systemPrompt, emoji?, tools?, ",
            "workDir?) — create/overwrite a project expert at ",
            "<workDir>/.polaris/agents/<slug>.md. systemPrompt should state the ",
            "mission, behavioral rules, deliverable standards, and tool whitelist. ",
            "slug must be lowercase-kebab, ≤64 chars.\n",
            "3. delete_agent(slug, workDir?) — remove a project expert.\n",
            "4. save_roster(slug, title, summary?, members[]) — assemble a team; ",
            "members are existing expert slugs ordered by dependency (upstream ",
            "producers first). Stored globally; consumed by dispatch_roster.\n",
            "5. find_expert(query, workDir?) — keyword search among project ",
            "experts if you need a recommendation.\n\n",
            "Created experts/teams are immediately usable via /dispatch <slug> and ",
            "/nexus <scenario> with no restart. Prefer creating focused, reusable ",
            "experts over writing ad-hoc prompts."
        )
    })
}

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": DISPATCH_TOOL_NAME,
                "description": concat!(
                    "Delegate a self-contained sub-task to a NEW background Polaris ",
                    "session that runs independently — the current conversation is NOT ",
                    "blocked and continues immediately. Typical use: after finishing an ",
                    "implementation, dispatch the testing/verification work; or fan out an ",
                    "independent follow-up task. The prompt must be fully self-contained ",
                    "(the new session has no access to this conversation's context): ",
                    "include the goal, relevant file paths, and acceptance criteria. ",
                    "Returns { dispatchId, sessionId } right away; the user is notified ",
                    "when the background session finishes. Use check_dispatched_task ",
                    "with the dispatchId to query progress/results later. ",
                    "Max 3 concurrent dispatched tasks; dispatch depth is limited to 2."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["prompt"],
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "Complete, self-contained task instruction for the new session (goal, context, file paths, acceptance criteria)."
                        },
                        "title": {
                            "type": "string",
                            "maxLength": 60,
                            "description": "Short session title shown to the user, e.g. '测试：登录需求回归'."
                        },
                        "workDir": {
                            "type": "string",
                            "description": "Absolute working directory for the new session. Omit to inherit the current session's workspace."
                        },
                        "engineId": {
                            "type": "string",
                            "description": "AI engine id for the new session (e.g. 'claude-code'). Omit to inherit the current session's engine. Ignored when role is set."
                        },
                        "role": {
                            "type": "string",
                            "description": "Team member preset name configured by the user (e.g. '测试员'). Takes precedence over engineId/provider. Use list_dispatch_targets to see available roles."
                        },
                        "provider": {
                            "type": "string",
                            "description": "Model provider (profile) name or id, or 'official' for the official endpoint. Use list_dispatch_targets to enumerate. Ignored when role is set."
                        },
                        "model": {
                            "type": "string",
                            "description": "Specific model name for the new session (e.g. a cheaper model for routine verification)."
                        },
                        "resultSchema": {
                            "type": "string",
                            "enum": ["qa-pass", "qa-fail", "qa-verdict", "phase-gate", "escalation"],
                            "description": "Require the session's final message to contain a structured JSON verdict of this schema. Use 'qa-verdict' for QA tasks (session picks qa-pass or qa-fail). The parsed verdict is validated and attached to check_dispatched_task results."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": CHECK_TOOL_NAME,
                "description": concat!(
                    "Query the status of a previously dispatched background task. ",
                    "Returns { status: pending|running|completed|failed, summary?, ",
                    "latestActivity?, sessionId, title }. `latestActivity` shows what the ",
                    "background session is doing right now; `summary` contains its final ",
                    "assistant answer once it completes."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["dispatchId"],
                    "properties": {
                        "dispatchId": {
                            "type": "string",
                            "description": "Dispatch id returned by dispatch_task."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": CONTINUE_TOOL_NAME,
                "description": concat!(
                    "Send a follow-up instruction to a FINISHED dispatched task — it ",
                    "continues in the SAME background session with full context preserved ",
                    "(e.g. after fixing a bug, ask the tester session to re-verify). ",
                    "Rejected while the task is still running. Fire-and-forget like ",
                    "dispatch_task: returns immediately, use check_dispatched_task to poll."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["dispatchId", "prompt"],
                    "properties": {
                        "dispatchId": {
                            "type": "string",
                            "description": "Dispatch id returned by dispatch_task."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Follow-up instruction for the background session."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": ROSTER_TOOL_NAME,
                "description": concat!(
                    "Deploy an expert team (roster) for a scenario as background ",
                    "sessions in topological waves (<=3 concurrent; next wave ",
                    "auto-dispatches when the previous wave finishes). ",
                    "scenario is the slug of a user-built roster (see list_agents / ",
                    "the rosters panel); built-in NEXUS scenarios have been removed. ",
                    "Returns { rosterId, waves, dispatchedNow }; track members with ",
                    "check_dispatched_task."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["scenario", "goal"],
                    "properties": {
                        "scenario": {
                            "type": "string",
                            "description": "User-built roster slug (created via save_roster). Built-in scenarios are no longer available."
                        },
                        "goal": {
                            "type": "string",
                            "description": "Team goal — complete, self-contained description of what to build/handle (each member session only sees this plus its own persona)."
                        },
                        "workDir": {
                            "type": "string",
                            "description": "Absolute working directory for member sessions. Omit to inherit."
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["sprint", "micro"],
                            "description": "sprint (default): full core team. micro: lightweight squad — first 5 core members only, for 1-5 day tasks."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": FIND_EXPERT_TOOL_NAME,
                "description": concat!(
                    "Find the right expert agent for a task from project custom ",
                    "experts (.polaris/agents). Keyword matching on slug/name/",
                    "description. Returns up to 8 candidates with slug/name/",
                    "description — pick one and use its slug with dispatch_task ",
                    "(prefix the prompt with the expert persona) or tell the user. ",
                    "If no match, consider creating one with save_agent."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Task type keyword (e.g. 'frontend', 'qa') or free-text task description (Chinese or English)."
                        },
                        "workDir": {
                            "type": "string",
                            "description": "Project dir to include its custom experts (.polaris/agents). Optional."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": TARGETS_TOOL_NAME,
                "description": concat!(
                    "List available dispatch targets: team member presets (roles), ",
                    "engines, and model providers with their models. Call this before ",
                    "dispatch_task when you want to pick a specific role/provider/model."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": SAVE_AGENT_TOOL_NAME,
                "description": concat!(
                    "Create or overwrite a project-level expert at ",
                    "<workDir>/.polaris/agents/<slug>.md (follows the project via git). ",
                    "The expert is immediately usable via /dispatch <slug> with no restart. ",
                    "Use list_agents first to avoid slug collisions."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["slug", "name", "description", "systemPrompt"],
                    "properties": {
                        "slug": {
                            "type": "string",
                            "pattern": "^[a-z0-9-]{1,64}$",
                            "description": "Lowercase-kebab identifier, ≤64 chars. Same slug overwrites."
                        },
                        "name": { "type": "string", "description": "Display name." },
                        "description": { "type": "string", "description": "One-line responsibility summary." },
                        "systemPrompt": {
                            "type": "string",
                            "description": "Persona body: mission, behavioral rules, deliverable standards, tool whitelist."
                        },
                        "emoji": { "type": "string", "description": "Optional display emoji." },
                        "tools": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional tool whitelist (empty = unrestricted)."
                        },
                        "workDir": {
                            "type": "string",
                            "description": "Project root containing .polaris/agents/. Omit to use the session workspace."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": DELETE_AGENT_TOOL_NAME,
                "description": "Delete a project-level expert (.polaris/agents/<slug>.md).",
                "inputSchema": {
                    "type": "object",
                    "required": ["slug"],
                    "properties": {
                        "slug": { "type": "string", "description": "Expert slug to delete." },
                        "workDir": {
                            "type": "string",
                            "description": "Project root. Omit to use the session workspace."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": LIST_AGENTS_TOOL_NAME,
                "description": concat!(
                    "List existing experts and user-built rosters to avoid slug ",
                    "collisions before creating new ones. Returns project experts ",
                    "(.polaris/agents) with slug/name/description, and user rosters ",
                    "with slug/title/members."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "workDir": {
                            "type": "string",
                            "description": "Project root. Omit to use the session workspace."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": SAVE_ROSTER_TOOL_NAME,
                "description": concat!(
                    "Create or overwrite a user-built expert team (roster). members ",
                    "are existing expert slugs ordered by dependency (upstream ",
                    "producers first). The roster is immediately consumable by ",
                    "dispatch_roster(scenario=<slug>)."
                ),
                "inputSchema": {
                    "type": "object",
                    "required": ["slug", "title", "members"],
                    "properties": {
                        "slug": {
                            "type": "string",
                            "pattern": "^[a-z0-9-]{1,64}$",
                            "description": "Roster slug. Same slug overwrites."
                        },
                        "title": { "type": "string", "description": "Team display name." },
                        "summary": { "type": "string", "description": "Optional team description." },
                        "members": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Expert slugs in dependency order (upstream producers first)."
                        }
                    },
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn handle_tools_call(params: Value, config: &DispatchMcpConfig) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".into()))?;

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let frame = match name {
        DISPATCH_TOOL_NAME => build_dispatch_frame(&arguments, config)?,
        CHECK_TOOL_NAME => build_status_frame(&arguments, config)?,
        CONTINUE_TOOL_NAME => build_continue_frame(&arguments, config)?,
        ROSTER_TOOL_NAME => build_roster_frame(&arguments, config)?,
        FIND_EXPERT_TOOL_NAME => {
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .ok_or_else(|| AppError::ValidationError("缺少 query 参数".into()))?;
            json!({
                "type": "find_expert",
                "token": config.token,
                "query": query,
                "workDir": arguments.get("workDir").and_then(Value::as_str),
            })
        }
        TARGETS_TOOL_NAME => json!({
            "type": "dispatch_targets",
            "token": config.token,
        }),
        SAVE_AGENT_TOOL_NAME => build_agent_save_frame(&arguments, config)?,
        DELETE_AGENT_TOOL_NAME => build_agent_delete_frame(&arguments, config)?,
        LIST_AGENTS_TOOL_NAME => build_agent_list_frame(&arguments, config)?,
        SAVE_ROSTER_TOOL_NAME => build_roster_save_frame(&arguments, config)?,
        other => return Err(AppError::ValidationError(format!("未知工具: {}", other))),
    };

    let outcome = match request_via_tcp(config.port, &frame) {
        Ok(value) => value,
        Err(error) => {
            // Surface as a tool error (not a JSON-RPC error) so the CLI can
            // continue the turn with the failure reason.
            return Ok(json!({
                "isError": true,
                "content": [{
                    "type": "text",
                    "text": format!("Failed to reach Polaris main process: {}", error.to_message())
                }]
            }));
        }
    };

    let is_error = outcome.get("ok").and_then(Value::as_bool) == Some(false);
    let body = serde_json::to_string(&outcome).unwrap_or_else(|_| "{}".to_string());
    if is_error {
        return Ok(json!({
            "isError": true,
            "content": [{ "type": "text", "text": body }]
        }));
    }
    Ok(json!({
        "content": [{ "type": "text", "text": body }]
    }))
}

fn build_dispatch_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 prompt 参数".into()))?;

    let dispatch_id = uuid::Uuid::new_v4().to_string();

    Ok(json!({
        "type": "dispatch",
        "token": config.token,
        "sessionId": config.session_id.clone().unwrap_or_default(),
        "dispatchId": dispatch_id,
        "prompt": prompt,
        "title": arguments.get("title").and_then(Value::as_str).unwrap_or_default(),
        "workDir": arguments.get("workDir").and_then(Value::as_str),
        "engineId": arguments.get("engineId").and_then(Value::as_str),
        "role": arguments.get("role").and_then(Value::as_str),
        "provider": arguments.get("provider").and_then(Value::as_str),
        "model": arguments.get("model").and_then(Value::as_str),
        "resultSchema": arguments.get("resultSchema").and_then(Value::as_str),
    }))
}

fn build_roster_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let scenario = arguments
        .get("scenario")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 scenario 参数".into()))?;
    let goal = arguments
        .get("goal")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 goal 参数".into()))?;

    Ok(json!({
        "type": "dispatch_roster",
        "token": config.token,
        "sessionId": config.session_id.clone().unwrap_or_default(),
        "scenario": scenario,
        "goal": goal,
        "workDir": arguments.get("workDir").and_then(Value::as_str),
        "mode": arguments.get("mode").and_then(Value::as_str),
    }))
}

fn build_continue_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let dispatch_id = arguments
        .get("dispatchId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 dispatchId 参数".into()))?;
    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 prompt 参数".into()))?;

    Ok(json!({
        "type": "dispatch_continue",
        "token": config.token,
        "dispatchId": dispatch_id,
        "prompt": prompt,
    }))
}

fn build_status_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let dispatch_id = arguments
        .get("dispatchId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 dispatchId 参数".into()))?;

    Ok(json!({
        "type": "dispatch_status",
        "token": config.token,
        "dispatchId": dispatch_id,
    }))
}

/// 解析 workDir:显式传入优先,缺省回退 config.work_dir
fn resolve_work_dir(arguments: &Value, config: &DispatchMcpConfig) -> Result<String> {
    let wd = arguments
        .get("workDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| config.work_dir.clone())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError(
            "缺少 workDir 参数且会话无默认工作目录".into()
        ))?;
    Ok(wd)
}

fn build_agent_save_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let work_dir = resolve_work_dir(arguments, config)?;
    let slug = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 slug 参数".into()))?;
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 name 参数".into()))?;
    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let system_prompt = arguments
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 systemPrompt 参数".into()))?;
    let emoji = arguments
        .get("emoji")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tools: Vec<String> = arguments
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    Ok(json!({
        "type": "agent_save",
        "token": config.token,
        "workDir": work_dir,
        "slug": slug,
        "name": name,
        "description": description,
        "systemPrompt": system_prompt,
        "emoji": emoji,
        "tools": tools,
    }))
}

fn build_agent_delete_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let work_dir = resolve_work_dir(arguments, config)?;
    let slug = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 slug 参数".into()))?;
    Ok(json!({
        "type": "agent_delete",
        "token": config.token,
        "workDir": work_dir,
        "slug": slug,
    }))
}

fn build_agent_list_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let work_dir = resolve_work_dir(arguments, config)?;
    Ok(json!({
        "type": "agent_list",
        "token": config.token,
        "workDir": work_dir,
    }))
}

fn build_roster_save_frame(arguments: &Value, config: &DispatchMcpConfig) -> Result<Value> {
    let slug = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 slug 参数".into()))?;
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::ValidationError("缺少 title 参数".into()))?;
    let summary = arguments
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let members: Vec<String> = arguments
        .get("members")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if members.is_empty() {
        return Err(AppError::ValidationError("members 不能为空".into()));
    }
    Ok(json!({
        "type": "roster_save",
        "token": config.token,
        "slug": slug,
        "title": title,
        "summary": summary,
        "members": members,
    }))
}

/// Connect to the main process, send the frame, read the result frame.
fn request_via_tcp(port: u16, frame: &Value) -> Result<Value> {
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e| AppError::ProcessError(format!("无效地址 {}: {}", addr, e)))?,
        Duration::from_secs(5),
    )
    .map_err(|e| AppError::ProcessError(format!("无法连接 {}: {}", addr, e)))?;

    // Both dispatch frames get an immediate reply — a short timeout is enough.
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

    write_frame(&mut stream, frame)?;

    let result = read_frame(&mut stream)?;

    // Close gracefully so the listener side knows we're done.
    let _ = stream.shutdown(Shutdown::Both);
    Ok(result)
}

/// Write a length-prefixed JSON frame: u32 LE length + UTF-8 bytes.
fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len())
        .map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    Ok(())
}

/// Read a length-prefixed JSON frame from the stream.
fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Err(AppError::ProcessError("帧长度为 0".into()));
    }
    // 1 MiB safety cap.
    if len > 1_048_576 {
        return Err(AppError::ProcessError(format!("帧长度过大: {}", len)));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    let value: Value = serde_json::from_slice(&body)?;
    Ok(value)
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_returns_all_tools() {
        let v = handle_tools_list();
        let tools = v.get("tools").and_then(|t| t.as_array()).unwrap();
        assert_eq!(tools.len(), 10);
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t.get("name").and_then(|s| s.as_str()).unwrap_or(""))
            .collect();
        assert!(names.contains(&DISPATCH_TOOL_NAME));
        assert!(names.contains(&CHECK_TOOL_NAME));
        assert!(names.contains(&CONTINUE_TOOL_NAME));
        assert!(names.contains(&TARGETS_TOOL_NAME));
        assert!(names.contains(&ROSTER_TOOL_NAME));
        assert!(names.contains(&FIND_EXPERT_TOOL_NAME));
        assert!(names.contains(&SAVE_AGENT_TOOL_NAME));
        assert!(names.contains(&DELETE_AGENT_TOOL_NAME));
        assert!(names.contains(&LIST_AGENTS_TOOL_NAME));
        assert!(names.contains(&SAVE_ROSTER_TOOL_NAME));
        let dispatch = tools
            .iter()
            .find(|t| t.get("name").and_then(|s| s.as_str()) == Some(DISPATCH_TOOL_NAME))
            .unwrap();
        let required = dispatch
            .pointer("/inputSchema/required")
            .and_then(|r| r.as_array())
            .unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0].as_str(), Some("prompt"));
    }

    #[test]
    fn continue_frame_requires_both_params() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: None,
        };
        assert!(build_continue_frame(&json!({ "dispatchId": "d1" }), &cfg).is_err());
        assert!(build_continue_frame(&json!({ "prompt": "go" }), &cfg).is_err());
        let frame = build_continue_frame(&json!({ "dispatchId": "d1", "prompt": "go" }), &cfg).unwrap();
        assert_eq!(
            frame.get("type").and_then(Value::as_str),
            Some("dispatch_continue")
        );
    }

    #[test]
    fn initialize_carries_protocol_version() {
        let v = handle_initialize();
        assert_eq!(
            v.get("protocolVersion").and_then(|s| s.as_str()),
            Some(PROTOCOL_VERSION)
        );
        assert_eq!(
            v.pointer("/serverInfo/name").and_then(|s| s.as_str()),
            Some(SERVER_NAME)
        );
    }

    #[test]
    fn dispatch_frame_requires_prompt() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: Some("session-abc".into()),
            work_dir: None,
        };
        let err = build_dispatch_frame(&json!({ "title": "x" }), &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
        let err = build_dispatch_frame(&json!({ "prompt": "   " }), &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
    }

    #[test]
    fn dispatch_frame_carries_session_and_token() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "tok".into(),
            session_id: Some("abc".into()),
            work_dir: None,
        };
        let frame = build_dispatch_frame(
            &json!({ "prompt": "run tests", "title": "测试", "workDir": "D:/x" }),
            &cfg,
        )
        .unwrap();
        assert_eq!(frame.get("type").and_then(Value::as_str), Some("dispatch"));
        assert_eq!(frame.get("token").and_then(Value::as_str), Some("tok"));
        assert_eq!(frame.get("sessionId").and_then(Value::as_str), Some("abc"));
        assert_eq!(frame.get("prompt").and_then(Value::as_str), Some("run tests"));
        assert_eq!(frame.get("workDir").and_then(Value::as_str), Some("D:/x"));
        assert!(frame.get("dispatchId").and_then(Value::as_str).is_some());
    }

    #[test]
    fn status_frame_requires_dispatch_id() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: None,
        };
        let err = build_status_frame(&json!({}), &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
        let frame = build_status_frame(&json!({ "dispatchId": "d1" }), &cfg).unwrap();
        assert_eq!(
            frame.get("type").and_then(Value::as_str),
            Some("dispatch_status")
        );
        assert_eq!(frame.get("dispatchId").and_then(Value::as_str), Some("d1"));
    }

    #[test]
    fn unknown_tool_yields_validation_error() {
        let params = json!({ "name": "not_a_tool", "arguments": {} });
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: None,
        };
        let err = handle_tools_call(params, &cfg).unwrap_err();
        assert!(matches!(err, AppError::ValidationError(_)));
    }

    #[test]
    fn agent_save_frame_requires_slug_and_prompt() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: Some("/proj".into()),
        };
        // 缺 slug
        assert!(build_agent_save_frame(
            &json!({ "name": "n", "systemPrompt": "p" }),
            &cfg
        ).is_err());
        // 缺 systemPrompt
        assert!(build_agent_save_frame(
            &json!({ "slug": "s", "name": "n" }),
            &cfg
        ).is_err());
        // 缺 workDir 且无默认 → 错误
        let cfg_no_wd = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: None,
        };
        assert!(build_agent_save_frame(
            &json!({ "slug": "s", "name": "n", "systemPrompt": "p" }),
            &cfg_no_wd
        ).is_err());
        // 完整 + 默认 workDir 回退
        let frame = build_agent_save_frame(
            &json!({ "slug": "code-reviewer", "name": "Code Reviewer", "description": "d", "systemPrompt": "你是审查员", "tools": ["bash"] }),
            &cfg,
        )
        .unwrap();
        assert_eq!(frame.get("type").and_then(Value::as_str), Some("agent_save"));
        assert_eq!(frame.get("workDir").and_then(Value::as_str), Some("/proj"));
        assert_eq!(frame.get("slug").and_then(Value::as_str), Some("code-reviewer"));
        // 显式 workDir 优先
        let frame2 = build_agent_save_frame(
            &json!({ "slug": "s", "name": "n", "systemPrompt": "p", "workDir": "/other" }),
            &cfg,
        )
        .unwrap();
        assert_eq!(frame2.get("workDir").and_then(Value::as_str), Some("/other"));
    }

    #[test]
    fn roster_save_frame_requires_members() {
        let cfg = DispatchMcpConfig {
            port: 0,
            token: "t".into(),
            session_id: None,
            work_dir: None,
        };
        assert!(build_roster_save_frame(
            &json!({ "slug": "t", "title": "T", "members": [] }),
            &cfg
        ).is_err());
        let frame = build_roster_save_frame(
            &json!({ "slug": "user-team", "title": "团队", "members": ["a", "b"] }),
            &cfg,
        )
        .unwrap();
        assert_eq!(frame.get("type").and_then(Value::as_str), Some("roster_save"));
        assert_eq!(
            frame.get("members").and_then(Value::as_array).map(|a| a.len()),
            Some(2)
        );
    }
}
