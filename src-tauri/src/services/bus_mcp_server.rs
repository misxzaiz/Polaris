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
//! - `bus_dispatch`：通用转发 {target, payload}——白名单为应用数据域（cap.todo /
//!   cap.http / cap.fs / cap.bash）+ UI 域（cap.ui.theme / cap.ui.chat），
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
    audit_sink, BashCapability, EventAdapter, FileAuditSink, FsCapability,
    HttpCapability, PolicyPermission, RouterBus, TodoCapability,
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
const DISPATCH_WHITELIST: &[&str] = &["cap.todo", "cap.http", "cap.bash", "cap.fs", "cap.ui.theme", "cap.ui.chat"];

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
        // cap.fs —— 文件系统只读访问（list / getFileInfo / exists）。
        // AI 经 bus_dispatch 读取应用数据文件/工作区结构；Remote 由策略 deny。
        let _ = router.register_handle(Box::new(FsCapability));
        // cap.bash —— 宿主级 shell 命令执行（与 DISPATCH_WHITELIST、工具描述对齐；
        // 曾因缺失导致 bus_dispatch 报"能力未注册: cap.bash"）
        let _ = router.register_handle(Box::new(BashCapability::new()));
        let _ = router.register_handle(Box::new(crate::services::router::ContextCapability::new(
            Arc::new(std::sync::Mutex::new(ContextMemoryStore::new())),
        )));
    }

    let handler = BusMcpHandler {
        router,
        config_dir: config_dir.clone(),
    };
    mcp_server_common::run_mcp_server_loop(handler)
}

/// Bus MCP handler（实现 McpServerHandler）。
struct BusMcpHandler {
    router: RouterBus,
    /// 应用配置根（argv 传入的 config_dir；bus_mcp_status/regenerate 用它定位 mcp.json）
    config_dir: String,
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
                mcp_server_common::tool_def("bus_dispatch", "调用 Polaris 总线能力：读写应用持久化数据（cap.todo，待办）、发起外部 HTTP 请求（cap.http，通用转发）、在宿主 shell 执行命令（cap.bash，后台任务）、读取文件系统（cap.fs，只读 list/getFileInfo/exists）、控制界面主题配色（cap.ui.theme）与对话渲染配置（cap.ui.chat）。注意：这是数据读写/网络/文件/UI 工具，不是任务派发——把工作委托给后台 AI 会话请用 polaris-dispatch 的 dispatch_task 工具", &["target", "payload"], json!({
                    "target": { "type": "string", "enum": ["cap.todo", "cap.http", "cap.bash", "cap.fs", "cap.ui.theme", "cap.ui.chat"] },
                    "payload": { "type": "object" }
                })),
                mcp_server_common::tool_def("bus_mcp_status", "查询 MCP Bridge 链路健康状态：列出各候选数据根的 ask_listener 元数据（真实端口/token/pid 及存活状态），并对比 mcp.json 固化的端口/token 是否与活跃主进程一致。失联时先用它定位是端口漂移、token 漂移还是主进程未启动。纯读，无副作用。常与 bus_mcp_regenerate 搭配：status 定位 → regenerate 修复", &[], json!({})),
                mcp_server_common::tool_def("bus_mcp_regenerate", "一键修复 MCP Bridge 配置漂移：读取当前活跃 ask_listener 的真实端口/token，把所有存在的 .polaris/claude/mcp.json 中 --polaris-port/--polaris-token 参数改写为真实值后原子写回。适用于 status 显示配置与活跃主进程不一致但仍连不上的场景。返回更新了哪些文件与计数。注意：新配置对**新启动**的 bridge 生效，当前已连接的会话由运行时自愈", &[], json!({})),
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
                        "target {target} 不在 bus_dispatch 白名单内（当前仅 cap.todo / cap.http / cap.bash / cap.fs / cap.ui.theme / cap.ui.chat）"
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
                    .map_err(AppError::ProcessError)?;
                match reply.result {
                    Ok(value) => Ok(mcp_server_common::tool_text(&value.to_string())),
                    Err(err) => Ok(tool_error(err)),
                }
            }
            "bus_mcp_status" => {
                let report = bus_mcp_status_report(&self.config_dir);
                Ok(mcp_server_common::tool_text(&report.to_string()))
            }
            "bus_mcp_regenerate" => {
                match bus_mcp_regenerate(&self.config_dir) {
                    Ok(report) => Ok(mcp_server_common::tool_text(&report.to_string())),
                    Err(e) => Ok(tool_error(e.to_string())),
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

/// 读取 mcp.json 里固化的 bridge 参数（--polaris-port / --polaris-token）。
///
/// 返回 `Some((port, token_present, server_count))`；文件缺失/解析失败返回 None。
fn read_mcp_bridge_params(path: &std::path::Path) -> Option<(u16, bool, usize)> {
    let content = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&content).ok()?;
    let servers = root.get("mcpServers")?.as_object()?;
    let mut port = None;
    let mut token_present = false;
    let mut bridge_count = 0;

    for server in servers.values() {
        let Some(args) = server.get("args").and_then(|v| v.as_array()) else {
            continue;
        };
        let mut has_port = false;
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                Some("--polaris-port") => {
                    if let Some(v) = iter.next().and_then(|v| v.as_str()) {
                        if let Ok(p) = v.parse::<u16>() {
                            port = Some(p);
                            has_port = true;
                        }
                    }
                }
                Some("--polaris-token") => {
                    if iter.next().is_some() {
                        token_present = true;
                        has_port = true; // 标记为 bridge server
                    }
                }
                _ => {}
            }
        }
        if has_port {
            bridge_count += 1;
        }
    }

    port.map(|p| (p, token_present, bridge_count))
}

/// `bus_mcp_status`：诊断链路健康，纯读无副作用。
fn bus_mcp_status_report(config_dir: &str) -> Value {
    let config_dir = normalize_config_dir(config_dir);
    let active = crate::services::ask_listener_meta::resolve_active_meta();

    // 各候选根的状态
    let candidates: Vec<Value> = crate::services::ask_listener_meta::candidate_roots()
        .iter()
        .map(|root| {
            let meta = crate::services::ask_listener_meta::read_meta_at(root);
            match meta {
                Some(m) => json!({
                    "root": root.to_string_lossy(),
                    "port": m.port,
                    "token_present": !m.token.is_empty(),
                    "pid": m.pid,
                    "pid_alive": crate::services::ask_listener_meta::pid_alive(m.pid),
                    "started_at": m.started_at,
                    "active": active.as_ref().is_some_and(|a| a.port == m.port && a.token == m.token),
                }),
                None => json!({
                    "root": root.to_string_lossy(),
                    "meta": "缺失",
                }),
            }
        })
        .collect();

    let mcp_configs: Vec<Value> =
        crate::services::ask_listener_meta::mcp_config_paths(&config_dir)
            .iter()
            .map(|p| {
                let configured = read_mcp_bridge_params(p);
                let matches = match (&active, &configured) {
                    (
                        Some(a),
                        Some((c_port, c_token, _)),
                    ) => c_port == &a.port && *c_token,
                    _ => false,
                };
                json!({
                    "path": p.to_string_lossy(),
                    "configured_port": configured.as_ref().map(|c| c.0),
                    "bridge_server_count": configured.as_ref().map(|c| c.2),
                    "matches_active": matches,
                })
            })
            .collect();

    let ok = active.is_some();
    let mut report = json!({
        "ok": ok,
        "meta_file": "candidates[].root + .meta/ask-listener.json",
        "note": if ok {
            "ask_listener 元数据存在（活跃主进程可自愈）。若 mcp.json matches_active=false，配置已过旧，可用 bus_mcp_regenerate 修复"
        } else {
            "未发现存活主进程的 ask_listener 元数据。请先启动 Polaris，或等待其重启后再诊断"
        },
        "candidates": candidates,
        "mcp_configs": mcp_configs,
    });
    // 并入活跃 meta 摘要（顶层便于一眼定位）
    if let Some(a) = &active {
        report["active"] = json!({
            "port": a.port,
            "token_present": !a.token.is_empty(),
            "pid": a.pid,
            "pid_alive": crate::services::ask_listener_meta::pid_alive(a.pid),
            "started_at": a.started_at,
        });
    }
    report
}

/// `bus_mcp_regenerate`：把 mcp.json 固化的 bridge 参数改写为活跃主进程的真实值。
///
/// 策略：找到所有存在的 `.polaris/claude/mcp.json`，凡是 args 里含
/// `--polaris-port`/`--polaris-token` 的 server 都替换为 meta 的真实值。
/// 保留其它字段与 server，不做全集重生成（避免破坏插件 server 与用户自定义）。
fn bus_mcp_regenerate(config_dir: &str) -> Result<Value> {
    let config_dir = normalize_config_dir(config_dir);
    let active = crate::services::ask_listener_meta::resolve_active_meta().ok_or_else(|| {
        AppError::ProcessError("未发现存活主进程的 ask_listener 元数据，无法 regenerate".into())
    })?;

    let mut updated = Vec::new();
    for path in crate::services::ask_listener_meta::mcp_config_paths(&config_dir) {
        match rewrite_mcp_bridge_args(&path, &active) {
            Ok(Some((server_count, total_args))) => {
                updated.push(json!({
                    "path": path.to_string_lossy(),
                    "bridge_server_count": server_count,
                    "args_replaced": total_args,
                }));
            }
            Ok(None) => {
                // 无 bridge server，跳过
            }
            Err(e) => {
                tracing::warn!("[bus-mcp] 改写 {} 失败（跳过）: {}", path.display(), e);
            }
        }
    }

    if updated.is_empty() {
        return Ok(json!({
            "ok": true,
            "updated": [],
            "note": "未找到需要更新的 mcp.json（可能已与活跃主进程一致，或没有含 bridge 参数的配置）",
        }));
    }

    Ok(json!({
        "ok": true,
        "port": active.port,
        "updated": updated,
        "note": "新配置对下次启动的连接生效；已连接会话由运行时自愈。若 Claude 缓存了旧配置，可重启会话或 reload 使其生效",
    }))
}

/// 改写一份 mcp.json 中所有 bridge server 的 port/token 参数，原子写回。
///
/// 返回 `Ok(Some((bridge_server_count, replaced_arg_count)))`；无 bridge server
/// 返回 `Ok(None)`。
fn rewrite_mcp_bridge_args(
    path: &std::path::Path,
    meta: &crate::services::ask_listener_meta::AskListenerMeta,
) -> Result<Option<(usize, usize)>> {
    let content = std::fs::read_to_string(path)?;
    let mut root: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::ProcessError(format!("mcp.json 解析失败: {e}")))?;

    let servers = root
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| AppError::ProcessError("mcp.json 缺少 mcpServers".into()))?;

    let port_str = meta.port.to_string();
    let mut bridge_count = 0usize;
    let mut replaced = 0usize;

    for server in servers.values_mut() {
        let Some(args) = server.get_mut("args").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        let mut has_bridge_arg = false;
        let mut i = 0;
        while i < args.len() {
            let is_port = args[i].as_str() == Some("--polaris-port");
            let is_token = args[i].as_str() == Some("--polaris-token");
            if is_port || is_token {
                has_bridge_arg = true;
                // 该参数后面应紧跟值
                if i + 1 < args.len() {
                    if is_port {
                        args[i + 1] = Value::String(port_str.clone());
                    } else {
                        args[i + 1] = Value::String(meta.token.clone());
                    }
                    replaced += 1;
                }
                i += 2;
                continue;
            }
            i += 1;
        }
        if has_bridge_arg {
            bridge_count += 1;
        }
    }

    if bridge_count == 0 {
        return Ok(None);
    }

    write_json_atomically(path, &root)?;
    Ok(Some((bridge_count, replaced)))
}

/// 原子写 JSON（temp + rename），与 mcp_config_service 同款。
fn write_json_atomically(path: &std::path::Path, value: &Value) -> Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value)?;
    std::fs::write(&temp_path, format!("{}\n", content))?;
    std::fs::rename(&temp_path, path)?;
    Ok(())
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
            { "domain": "fs", "capability": "cap.fs", "入口": "bus_dispatch / 主应用 dispatch（面板）",
              "协议": "{ action: list|getFileInfo|exists, path } → { items / item / exists }（文件：size+modified+created；目录：child_count）",
              "状态": "✅ bus_dispatch 可用；只读边界（list/getFileInfo/exists），写操作仍走 tauri command；Remote 策略 deny" },
            { "domain": "ai-chat", "capability": "cap.ai.chat", "入口": "polaris-dispatch 的 cap_dispatch 工具（target=cap.ai.chat）", "状态": "✅ 主进程总线；AI 可经 cap_dispatch 同步动作（start/continue/interrupt 等），流式走 WS 事件" },
            { "domain": "context", "capability": "cap.context", "storage": "内存（主应用进程）", "状态": "✅ 主进程总线；经 cap_dispatch 触达（本 server 不注册内存型能力，跨进程不共享）" },
            { "domain": "history", "capability": "cap.history", "入口": "主应用总线（读文件系统会话树）", "状态": "✅ 主进程总线；经 cap_dispatch 触达" },
            { "domain": "kv / prompt_snippet / config / data_root / pluginDiscovery / pluginServiceManager", "入口": "主进程总线 cap_dispatch", "状态": "✅ 可触达；config/data_root/plugin* 属管理面，改动全局配置需谨慎（先确认用户意图）" },
            { "domain": "mcp-健康诊断", "工具": "bus_mcp_status / bus_mcp_regenerate", "说明": "诊断 ask_listener 元数据与 mcp.json 配置是否一致，失联时一键改写固化的旧端口/token。均为本 server 直接实现，不依赖 ask 端口（独立通道）", "状态": "✅ 可用" },
            { "domain": "ui", "capability": "cap.ui.theme / cap.ui.chat", "入口": "bus_dispatch",
              "协议": "cap.ui.theme: { action: get|patch|applyPreset|listThemes|setActive|export|import }（palette 键=语义色，映射 88 维度 token）；cap.ui.chat: { action: get|patch|reset }（config 字段对齐 ChatDisplaySettings：fontSize/lineHeight/messageSpacing/codeFontSize/fontFamily 等）",
              "状态": "✅ bus_dispatch 可用；状态真相在前端 store，本能力校验+审计，效果经 tool_call_end 事件落前端" },
            { "domain": "dialog / requirement / scheduler / browser 等", "状态": "⏳ 阶段 B 尾/C/D 迁移后逐域接入" }
        ],
        "cap_dispatch": {
            "说明": "主进程总线全部 cap.* 能力的统一入口，由 polaris-dispatch MCP 提供（工具 cap_dispatch / cap_list）。本 server 的 bus_dispatch 为应用数据域 + UI 域白名单（cap.todo / cap.http / cap.bash / cap.fs / cap.ui.theme / cap.ui.chat），两 server 职责不重叠",
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
            },
            "cap.bash": {
                "run":    { "参数": { "command": "string（必填，shell 命令）", "workdir": "string?（默认调用方工作目录）", "env": "{ k: v }?", "timeoutMs": "number?（默认 600000，0=不限）", "async": "bool?（默认 false：同步等待完成）", "onSessionEnd": "keep|kill?（默认 keep——任务归宿主，不随会话结束）" }, "返回": "{ taskId, pid, status, logPath }（async=false 时含 exitCode/startedAt/finishedAt）" },
                "status": { "参数": { "taskId": "string（必填）" }, "返回": "{ taskId, status, exitCode?, startedAt, finishedAt? }" },
                "log":    { "参数": { "taskId": "string（必填）", "offset": "int?（默认 0）", "limit": "int?（默认全部）" }, "返回": "{ taskId, offset, total, lines: string[] }" },
                "wait":   { "参数": { "taskId": "string（必填）", "timeoutMs": "number?（默认 30000）" }, "返回": "{ taskId, status, exitCode?, finishedAt? }（超时返回 status=running）" },
                "kill":   { "参数": { "taskId": "string（必填）" }, "返回": "{ taskId, killed, status }（Windows 杀进程树）" },
                "list":   { "参数": { "sessionId": "string?（按发起方 caller 过滤）", "status": "string?（running|completed|failed|killed|timeout）" }, "返回": "{ tasks: [{ taskId, status, command, pid, sessionId, startedAt, finishedAt, logLines }] }" },
                "边界": "任务归宿主进程（TaskManager 单例），不随 AI 会话结束而终止——会话解耦。Remote 来源策略 deny，仅本地面板/AI 可用。SimpleAI 内建 bash 工具仍是会话级同步执行；cap.bash 提供后台/跨会话的长任务管理。"
            },
            "cap.fs": {
                "list":     { "参数": { "path": "string（必填，绝对路径，目录）" }, "返回": "{ items: FileInfo[] }（直接子项，含 size/modified/created）" },
                "getFileInfo": { "参数": { "path": "string（必填，绝对路径）" }, "返回": "{ item: FileInfo|null }（文件：size+modified+created；目录：child_count+modified+created，size=null）" },
                "exists":   { "参数": { "path": "string（必填，绝对路径）" }, "返回": "{ exists: bool }" },
                "边界": "只读能力（list/getFileInfo/exists）；创建/删除/重命名/复制等写操作走既有 tauri command 通道。FileInfo 的 modified/created 是秒级 Unix 时间戳字符串，前端需 Number(v)*1000 转 Date。Remote 来源策略 deny，仅本地面板/AI 可用。"
            }
        },
        "usage_examples": [
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "create", "content": "完成代码评审", "priority": "high" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "list", "scope": "all", "status": "pending" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.todo", "payload": { "action": "complete", "id": "<todo id>" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.http", "payload": { "action": "request", "method": "GET", "url": "https://api.github.com/repos/rust-lang/rust" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.http", "payload": { "action": "request", "method": "POST", "url": "https://httpbin.org/post", "body": "{\"q\":\"test\"}", "bodyType": "json" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.fs", "payload": { "action": "list", "path": "<绝对路径>" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.fs", "payload": { "action": "getFileInfo", "path": "<绝对路径>" } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.bash", "payload": { "action": "run", "command": "npm run build", "async": true } } },
            { "tool": "bus_dispatch", "arguments": { "target": "cap.bash", "payload": { "action": "status", "taskId": "<taskId>" } } },
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
                    "target": { "type": "string", "enum": ["cap.todo", "cap.http", "cap.bash", "cap.fs", "cap.ui.theme", "cap.ui.chat"] },
                    "payload": { "type": "object" }
                })),
                mcp_server_common::tool_def("bus_mcp_status", "查询 MCP Bridge 链路健康状态", &[], json!({})),
                mcp_server_common::tool_def("bus_mcp_regenerate", "一键修复 MCP Bridge 配置漂移", &[], json!({})),
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
