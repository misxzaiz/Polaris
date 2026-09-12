//! Bus MCP Server（第七步阶段 E 前置：把总线能力以 MCP 工具开放给 AI）
//!
//! 独立 stdio 进程（polaris-mcp bus <config_dir>），在进程内构建一条
//! **与主应用同源**的轻量总线：同 DataRoot 的 SqliteStorage（stores/todo.db
//! 与主应用共享，WAL + busy_timeout）+ 同一 TodoCapability 业务核 +
//! PolicyPermission（Plugin 来源默认放行）+ 独立审计链（dispatch-mcp.jsonl，
//! 避免与主应用 dispatch.jsonl 的跨进程哈希链竞争）。
//!
//! # 工具面
//!
//! - 精选 todo 工具：todo_list / todo_get / todo_create / todo_update /
//!   todo_complete / todo_delete（对 AI 更友好的显式工具面）
//! - `bus_dispatch`：通用转发 {target, payload}——白名单当前仅 cap.todo，
//!   后续按阶段 C 的权限策略逐域放开
//!
//! # 与主应用的关系
//!
//! 同一业务核（TodoCapability）+ 同一存储文件，单份逻辑双入口（step7 阶段 E
//! 的"MCP 共享业务核"形态）。context 等内存型能力不进本 server（跨进程不共享）。

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::{
    CapabilityId, Envelope, MsgId, PluginId, Router as _, Source, TraceId,
};
use crate::error::{AppError, Result};
use crate::services::context_core::ContextMemoryStore;
use crate::services::router::{
    audit_sink, ContextCapability, EventAdapter, FileAuditSink, PolicyPermission, RouterBus,
    TodoCapability,
};

const SERVER_NAME: &str = "polaris-bus-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";
const CALLER: &str = "polaris-bus-mcp";

/// bus_dispatch 白名单：AI 可经通用转发触达的能力（逐域放开，见 step7 阶段 C）
///
/// 边界规则（与 polaris-dispatch MCP 的职责切分，防工具冲突）：
/// - 本 server = 应用数据域（持久化数据 CRUD，全局视角，与会话无关）
/// - polaris-dispatch = 会话桥接域（任务派发生命周期，会话绑定视角）
/// - 永久排除：cap.ai.chat（AI 自递归）及一切任务派发/会话桥接类能力——
///   那是 polaris-dispatch 的领地，两 server 的工具描述互不重叠
const DISPATCH_WHITELIST: &[&str] = &["cap.todo"];

/// 运行 bus MCP server（stdio JSON-RPC）
pub fn run_bus_mcp_server(config_dir: &str) -> Result<()> {
    let config_dir = normalize_config_dir(config_dir);

    let storage: Arc<dyn crate::contracts::Storage> = Arc::new(
        crate::services::storage::SqliteStorage::new(Path::new(&config_dir))
            .map_err(|e| AppError::ProcessError(format!("SqliteStorage 初始化失败: {e}")))?,
    );
    let adapter = Arc::new(EventAdapter::new(64));
    let permission = Box::new(PolicyPermission::from_config(None));
    let audit: Option<Arc<dyn crate::contracts::AuditSink>> = {
        match FileAuditSink::open(&audit_sink::audit_file_path_named("dispatch-mcp.jsonl")) {
            Ok(sink) => Some(Arc::new(sink)),
            Err(e) => {
                tracing::warn!("[bus-mcp] 审计打开失败（不阻塞）: {e}");
                None
            }
        }
    };

    let router = RouterBus::new(adapter, permission, Some(storage), audit);
    {
        use crate::contracts::Router as _;
        let _ = router.register_handle(Box::new(TodoCapability));
        let _ = router.register_handle(Box::new(crate::services::router::ContextCapability::new(
            Arc::new(std::sync::Mutex::new(ContextMemoryStore::new())),
        )));
    }

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
            Ok(request) => handle_request(request, &router),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {error}"),
                }),
            },
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

#[derive(Debug, serde::Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, serde::Serialize)]
struct JsonRpcResponse<'a> {
    jsonrpc: &'a str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, serde::Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

fn normalize_config_dir(config_dir: &str) -> String {
    let trimmed = config_dir.trim();
    if trimmed.is_empty() {
        crate::services::data_root::data_root()
            .config_dir()
            .to_string_lossy()
            .to_string()
    } else {
        trimmed.to_string()
    }
}

fn handle_request(request: JsonRpcRequest, router: &RouterBus) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".into());
    }

    let result: Result<Value> = match request.method.as_str() {
        "initialize" => handle_initialize(),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params, router),
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
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    }))
}

fn tool_def(name: &str, description: &str, required: &[&str], properties: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "required": required,
            "properties": properties,
            "additionalProperties": name.starts_with("bus_") || name == "todo_create" || name == "todo_update"
        }
    })
}

fn handle_tools_list() -> Value {
    json!({
        "tools": [
            tool_def("bus_help", "查询总线能力与工具说明：已注册的能力（cap.*）、本 server 全部工具及入参、bus_dispatch 白名单、域迁移路线图。首次使用请先调用本工具", &[], json!({})),
            tool_def("bus_dispatch", "读写 Polaris 应用持久化数据（当前仅待办 cap.todo）。注意：这是数据读写工具，不是任务派发——把工作委托给后台 AI 会话请用 polaris-dispatch 的 dispatch_task 工具", &["target", "payload"], json!({
                "target": { "type": "string", "enum": ["cap.todo"] },
                "payload": { "type": "object" }
            })),

        ]
    })
}

fn handle_tools_call(params: Value, router: &RouterBus) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".into()))?;
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);

    let target = match name {
        "bus_help" => {
            // 统一 MCP tools/call 返回形态（content 文本承载 JSON）
            return Ok(tool_text(&handle_bus_help(router).to_string()));
        }
        "bus_dispatch" => {
            let target = arguments
                .get("target")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::ValidationError("bus_dispatch 缺少 target".into()))?;
            if !DISPATCH_WHITELIST.contains(&target) {
                return Ok(tool_error(format!(
                    "target {target} 不在 bus_dispatch 白名单内（当前仅 cap.todo）"
                )));
            }
            target
        }
        other => {
            return Ok(tool_error(format!("未知工具: {other}")));
        }
    };

    let payload = arguments.get("payload").cloned().unwrap_or(json!({}));

    let env = Envelope {
        id: MsgId(format!("bus-mcp-{}", uuid::Uuid::new_v4())),
        source: Source::Plugin {
            caller: PluginId(CALLER.into()),
        },
        target: CapabilityId(target.into()),
        payload,
        trace: TraceId(format!("bus-mcp-{}", uuid::Uuid::new_v4())),
    };

    let reply = router.dispatch(env).map_err(|e| AppError::ProcessError(e))?;
    match reply.result {
        Ok(value) => Ok(tool_text(&value.to_string())),
        Err(err) => Ok(tool_error(err)),
    }
}

fn tool_error(message: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

/// bus_help：总线能力与工具的说明（发现/文档工具）
///
/// 返回：本 server 全部工具及入参、总线上已注册的能力、bus_dispatch 白名单、
/// 各业务域的迁移状态与可用入口（主应用 dispatch / 本 server 工具）。
fn handle_bus_help(router: &RouterBus) -> Value {
    let tools = handle_tools_list();
    let registered: Vec<String> = router
        .list_capabilities()
        .iter()
        .map(|c| c.0.clone())
        .collect();

    json!({
        "server": { "name": SERVER_NAME, "version": SERVER_VERSION, "protocol": PROTOCOL_VERSION },
        "tools": tools["tools"],
        "capabilities": {
            "registered_here": registered,
            "dispatch_whitelist": DISPATCH_WHITELIST,
            "说明": "registered_here = 本进程总线已注册能力；dispatch_whitelist = bus_dispatch 可转发的目标（按阶段 C 权限策略逐域放开）"
        },
        "modules": [
            { "domain": "todo", "capability": "cap.todo", "storage": "SqliteStorage stores/todo.db（与本server/主应用共享）",
              "状态": "✅ bus_dispatch 可用（动作协议见 protocol.cap.todo）" },
            { "domain": "ai-chat", "capability": "cap.ai.chat", "入口": "主应用总线（流式 + 同步）", "状态": "🚚 仅主应用进程；MCP 侧待接" },
            { "domain": "context", "capability": "cap.context", "storage": "内存（主应用进程）", "状态": "🚚 仅主应用进程；内存不跨进程，MCP 侧不提供" },
            { "domain": "history", "capability": "cap.history", "入口": "主应用总线（读文件系统会话树）", "状态": "🚚 仅主应用进程" },
            { "domain": "dialog / requirement / scheduler / browser / config 等", "状态": "⏳ 阶段 B 尾/C/D 迁移后逐域接入" }
        ],
        "protocol": {
            "说明": "bus_dispatch 的 payload = { \"action\": <动作>, ...动作参数 }。各白名单能力的动作协议如下（与能力实现逐一对应）",
            "cap.todo": {
                "list":      { "参数": { "scope": "workspace|all（默认 workspace）", "workspacePath": "string?", "status": "pending|in_progress|completed", "priority": "low|normal|high|urgent", "limit": "int?" }, "返回": "{ items: TodoItem[] }" },
                "get":       { "参数": { "id": "string（必填）" }, "返回": "{ item: TodoItem|null }" },
                "create":    { "参数": { "content": "string（必填，非空）", "priority": "low|normal|high|urgent?", "description": "string?", "tags": "string[]?", "workspacePath": "string?", "workspaceName": "string?", "dueDate": "string?", "estimatedHours": "number?" }, "返回": "{ item: TodoItem }" },
                "update":    { "参数": { "id": "string（必填）", "content/status/priority/description/tags/dueDate/spentHours/lastProgress 等": "均可选部分更新" }, "返回": "{ item: TodoItem }" },
                "start":     { "参数": { "id": "string（必填）", "lastProgress": "string?" }, "返回": "{ item }（status→in_progress）" },
                "complete":  { "参数": { "id": "string（必填）", "lastProgress": "string?" }, "返回": "{ item }（置 completed_at）" },
                "delete":    { "参数": { "id": "string（必填）" }, "返回": "{ item }（被删条目）" },
                "breakdown": { "参数": {}, "返回": "{ stats: {工作区名: 数量} }" }
            }
        },
        "usage_examples": [
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "create", "content": "完成代码评审", "priority": "high" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "list", "scope": "all", "status": "pending" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "complete", "id": "<todo id>" } } }
        ]
    })
}

fn tool_text(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}
