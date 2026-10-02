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

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::{CapabilityId, Envelope, MsgId, PluginId, Router as _, Source, TraceId};
use crate::error::{AppError, Result};
use crate::services::context_core::ContextMemoryStore;
use crate::services::mcp_server_common::{self, McpServerHandler};
use crate::services::router::{
    audit_sink, ContextCapability, EventAdapter, FileAuditSink, HttpCapability, PolicyPermission,
    RouterBus, TodoCapability,
};

const SERVER_NAME: &str = "polaris-bus-mcp";
const SERVER_VERSION: &str = "0.1.0";
const CALLER: &str = "polaris-bus-mcp";

/// bus_dispatch 白名单：AI 可经通用转发触达的能力（逐域放开，见 step7 阶段 C）
///
/// 边界规则（与 polaris-dispatch MCP 的职责切分，防工具冲突）：
/// - 本 server = 应用数据域（持久化数据 CRUD，全局视角，与会话无关）
/// - polaris-dispatch = 会话桥接域（任务派发生命周期，会话绑定视角）
/// - 永久排除：cap.ai.chat（AI 自递归）及一切任务派发/会话桥接类能力——
///   那是 polaris-dispatch 的领地，两 server 的工具描述互不重叠
const DISPATCH_WHITELIST: &[&str] = &["cap.todo", "cap.http"];

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
        // cap.http —— 通用 HTTP 转发（AI 经 bus_dispatch 调用外部 API）。
        // SSRF 校验内建于能力（见 http_capability.rs），Remote 由策略 deny。
        let _ = router.register_handle(Box::new(HttpCapability));
        let _ = router.register_handle(Box::new(crate::services::router::ContextCapability::new(
            Arc::new(std::sync::Mutex::new(ContextMemoryStore::new())),
        )));
    }

    let handler = BusMcpHandler { router };
    mcp_server_common::run_mcp_server_loop(handler)
}

/// Bus MCP handler（实现 McpServerHandler）。
struct BusMcpHandler {
    router: RouterBus,
}

impl McpServerHandler for BusMcpHandler {
    fn server_name(&self) -> &str {
        SERVER_NAME
    }

    fn server_version(&self) -> &str {
        SERVER_VERSION
    }

    fn tools_list(&self) -> Value {
        json!({
            "tools": [
                mcp_server_common::tool_def("bus_help", "查询总线能力与工具说明：本 server 已注册的能力（cap.*）、全部工具及入参、bus_dispatch 白名单；并列出主进程总线全部 cap.* 能力经 polaris-dispatch 的 cap_dispatch/cap_list 工具的触达入口。首次使用请先调用本工具", &[], json!({})),
                mcp_server_common::tool_def("bus_dispatch", "调用 Polaris 总线能力：读写应用持久化数据（cap.todo，待办）或发起外部 HTTP 请求（cap.http，通用转发）。注意：这是数据读写/网络工具，不是任务派发——把工作委托给后台 AI 会话请用 polaris-dispatch 的 dispatch_task 工具", &["target", "payload"], json!({
                    "target": { "type": "string", "enum": ["cap.todo", "cap.http"] },
                    "payload": { "type": "object" }
                })),
            ]
        })
    }

    fn tools_call(&self, name: &str, arguments: &Value) -> Result<Value> {
        match name {
            "bus_help" => {
                Ok(mcp_server_common::tool_text(&self.bus_help().to_string()))
            }
            "bus_dispatch" => {
                let target = arguments
                    .get("target")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::ValidationError("bus_dispatch 缺少 target".into()))?;
                if !DISPATCH_WHITELIST.contains(&target) {
                    return Ok(tool_error(format!(
                        "target {target} 不在 bus_dispatch 白名单内（当前仅 cap.todo / cap.http）"
                    )));
                }

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

                let reply = self
                    .router
                    .dispatch(env)
                    .map_err(|e| AppError::ProcessError(e))?;
                match reply.result {
                    Ok(value) => Ok(mcp_server_common::tool_text(&value.to_string())),
                    Err(err) => Ok(tool_error(err)),
                }
            }
            other => Ok(tool_error(format!("未知工具: {other}"))),
        }
    }
}

/// 构造 MCP tools/call 错误返回（isError=true）。
fn tool_error(message: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

/// bus_help：总线能力与工具的说明（发现/文档工具）
///
/// 返回：本 server 全部工具及入参��总线上已注册的能力、bus_dispatch 白名单、
/// 各业务域的迁移状态与可用入口（主应用 dispatch / 本 server 工具）。
fn handle_bus_help_impl(router: &RouterBus) -> Value {
    let tools = BusMcpHandler::tools_list_placeholder();
    let registered: Vec<String> = router
        .list_capabilities()
        .iter()
        .map(|c| c.0.clone())
        .collect();

    json!({
        "server": { "name": SERVER_NAME, "version": SERVER_VERSION, "protocol": mcp_server_common::PROTOCOL_VERSION },
        "tools": tools["tools"],
        "capabilities": {
            "registered_here": registered,
            "dispatch_whitelist": DISPATCH_WHITELIST,
            "说明": "registered_here = 本进程总线已注册能力；dispatch_whitelist = bus_dispatch 可转发的目标（按阶段 C 权限策略逐域放开）"
        },
        "modules": [
            { "domain": "todo", "capability": "cap.todo", "storage": "SqliteStorage stores/todo.db（与本server/主应用共享）",
              "状态": "✅ bus_dispatch 可用（动作协议见 protocol.cap.todo）；主应用亦经 cap_dispatch 触达" },
            { "domain": "http", "capability": "cap.http", "入口": "bus_dispatch / 主应用 dispatch（面板）",
              "协议": "{ action: request|ping, request: { method, url, headers?, body?, bodyType?, timeoutMs? } } → { status, statusText, ok, contentType, headers, body, isBase64, timeMs }",
              "状态": "✅ bus_dispatch 可用；目标校验已完全放开（http/https 任意目标可转发，含内网/localhost）；二进制响应 base64；Remote 策略 deny（本地面板与 AI 均可用）" },
            { "domain": "ai-chat", "capability": "cap.ai.chat", "入口": "polaris-dispatch 的 cap_dispatch 工具（target=cap.ai.chat）", "状态": "✅ 主进程总线；AI 可经 cap_dispatch 同步动作（start/continue/interrupt 等），流式走 WS 事件" },
            { "domain": "context", "capability": "cap.context", "storage": "内存（主应用进程）", "状态": "✅ 主进程总线；经 cap_dispatch 触达（本 server 不注册内存型能力，跨进程不共享）" },
            { "domain": "history", "capability": "cap.history", "入口": "主应用总线（读文件系统会话树）", "状态": "✅ 主进程总线；经 cap_dispatch 触达" },
            { "domain": "kv / prompt_snippet / config / data_root / pluginDiscovery / pluginServiceManager", "入口": "主进程总线 cap_dispatch", "状态": "✅ 可触达；config/data_root/plugin* 属管理面，改动全局配置需谨慎（先确认用户意图）" },
            { "domain": "dialog / requirement / scheduler / browser 等", "状态": "⏳ 阶段 B 尾/C/D 迁移后逐域接入" }
        ],
        "cap_dispatch": {
            "说明": "主进程总线全部 cap.* 能力的统一入口，由 polaris-dispatch MCP 提供（工具 cap_dispatch / cap_list）。本 server 的 bus_dispatch 仍是应用数据域白名单（当前仅 cap.todo），两 server 职责不重叠",
            "cap_list": "列出主进程总线当前已注册的全部 cap.* 能力 id 与说明",
            "cap_dispatch": { "参数": { "target": "cap.* 能力 id（如 cap.ai.chat / cap.history / cap.todo / cap.config）", "payload": "{ action, ...动作参数 }（不同能力动作协议见 cap_list 返回）" } }
        },
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
            },
            "cap.http": {
                "ping":    { "参数": {}, "返回": "{ pong: true }" },
                "request": { "参数": { "method": "GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS（默认 GET）", "url": "string（必填，仅 http/https）", "headers": "{ k: v }（可含 Cookie/UA/Referer 等浏览器禁发头——宿主转发不受浏览器限制）", "body": "string?", "bodyType": "text|json|form|binary?", "timeoutMs": "number?（默认 15000）" }, "返回": "{ status, statusText, ok, contentType, headers, body, isBase64, url, timeMs }" },
                "边界": "目标校验已完全放开：http/https 任意目标可转发（含 localhost / 内网 / 云元数据等）；仅非 http(s) 协议拒绝。二进制响应（image/* 等）base64 编码返回（isBase64:true）。Remote 来源策略 deny，仅本地面板/AI 可用。"
            }
        },
        "usage_examples": [
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "create", "content": "完成代码评审", "priority": "high" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "list", "scope": "all", "status": "pending" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "complete", "id": "<todo id>" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.http", "payload": { "action": "request", "method": "GET", "url": "https://api.github.com/repos/rust-lang/rust" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.http", "payload": { "action": "request", "method": "POST", "url": "https://httpbin.org/post", "body": "{\"q\":\"test\"}", "bodyType": "json" } } },
            { "tool": "cap_list", "arguments": {} },
            { "tool": "cap_dispatch", "arguments": { "target": "cap.history", "payload": { "action": "list_sessions" } } },
            { "tool": "cap_dispatch", "arguments": { "target": "cap.ai.chat", "payload": { "action": "start", "message": "<用户消息>" } } },
        ]
    })
}

impl BusMcpHandler {
    fn bus_help(&self) -> Value {
        handle_bus_help_impl(&self.router)
    }

    /// 占位：返回 tools_list 的静态部分（供 handle_bus_help_impl 引用）。
    fn tools_list_placeholder() -> Value {
        json!({
            "tools": [
                mcp_server_common::tool_def("bus_help", "查询总线能力与工具说明", &[], json!({})),
                mcp_server_common::tool_def("bus_dispatch", "调用 Polaris 总线能力", &["target", "payload"], json!({
                    "target": { "type": "string", "enum": ["cap.todo", "cap.http"] },
                    "payload": { "type": "object" }
                })),
            ]
        })
    }
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
