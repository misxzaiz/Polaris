//! cap.mcp — 插件 MCP 工具调用通道
//!
//! 前端没有「点对点调第三方插件 MCP 工具」的既有通道（tools/call 的 client 是
//! SimpleAI 引擎会话级私有）。本能力在 RouterBus 上补一条桥：
//!   payload: { action: "call", mcpServerId, tool, arguments }
//! → 按插件贡献的 stdio server 定义（command + args，含 {{pluginDir}}/{{appConfigDir}}
//!   模板替换）惰性拉起常驻 client → tools/call → 返回 content[0].text 聚合文本。
//!
//! 设计要点：
//! - **常驻注册表**：`RwLock<HashMap<String, Arc<McpClient>>>`，按 server_name 惰性拉起，
//!   跨多次 call 复用，避免重复拉起子进程（AGENTS.md「唯一权威，禁止多写路径」）。
//! - **归属**：client 生命周期归本能力持有，与 SimpleAI 会话级 `McpClientPool` 分离；
//!   同一 server 不会被两处同时拉起（会话 pool 会话级、本池进程级，各自持有实例）。
//! - **权限**：`Source::Bootstrap`（桌面主窗口 / Core 内部）、`Source::Plugin`（插件间），
//!   以及携带有效 token 的 `Source::Remote`（已鉴权 HTTP/WS 前端，含移动端）允许；
//!   空 token 的 `Source::Remote`（未鉴权固有 webview）拒绝，防远程滥用。
//!   token 由传输层 HTTP 鉴权后注入（`authenticated_remote_token`），本能力只复核非空。
//! - **同步 invoke 包异步**：`invoke` 是同步契约（`Result<Value, String>`），用
//!   `block_on_async`（对齐 `HttpCapability`）在 tokio 运行时上下文内 block_on 异步 MCP 调用。
//! - **失败语义**：拉起失败 / tools/call 失败 / isError 均回 `{ ok:false, error }`；
//!   成功回 `{ ok:true, resultJson }`（resultJson 即 content[0].text，前端 JSON.parse）。
//! - **命令门控**：只依赖 `tokio` + `serde_json` + `McpClient`，不引 `tauri` 类型，
//!   Web-only / 桌面双构建通吃。
//!
//! 依赖注入：server 定义列表由 create_app_state（state.rs）装配时解析并注入快照，
//! 能力内不自解析数据根/插件清单（避免重复解析与路径硬编码）。

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::ai::engine::simple_ai::mcp::client::McpClient;
use crate::contracts::{Capability, CapabilityId, Context, Source};
use crate::services::mcp_config_service::ResolvedExternalMcpServer;

/// cap.mcp 能力 ID。
pub const MCP_CAP_ID: &str = "cap.mcp";

/// call 请求参数（前端 payload）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallRequest {
    /// 插件贡献的 MCP server id（如 "mimo-tts"）。
    pub mcp_server_id: String,
    /// 工具名（如 "mimo_tts_synthesize"）。
    pub tool: String,
    /// 工具参数（JSON 对象）。
    pub arguments: Value,
}

/// 常驻 MCP client 注册表（cap.mcp 持有）。
struct McpClientRegistry {
    /// server_name → 常驻 client（惰性拉起）。
    clients: RwLock<HashMap<String, Arc<McpClient>>>,
    /// server_name → 定义（command/args）。由构造时的快照填充。
    defs: HashMap<String, ResolvedExternalMcpServer>,
}

impl McpClientRegistry {
    /// 用已解析的 server 定义快照构造（不拉起进程，进程惰性启动）。
    fn from_servers(servers: Vec<ResolvedExternalMcpServer>) -> Self {
        let defs = servers
            .into_iter()
            .map(|s| (s.server_name.clone(), s))
            .collect();
        Self {
            clients: RwLock::new(HashMap::new()),
            defs,
        }
    }

    /// 校验某 server_id 是否属于已解析插件（防绕权调用未注册 server）。
    fn known(&self, server_name: &str) -> bool {
        self.defs.contains_key(server_name)
    }

    /// 取出（或惰性拉起）server 的常驻 client。异步内部实现，由调用方 block_on 包一层。
    async fn client_for_inner(&self, server_name: &str) -> Result<Arc<McpClient>, String> {
        if let Some(c) = self.clients.read().await.get(server_name) {
            return Ok(c.clone());
        }
        let def = self
            .defs
            .get(server_name)
            .ok_or_else(|| format!("未注册的 MCP server: {server_name}"))?;
        // 弱锁去重：双并发同拉起时后者复用前者（Arc clone），避免双进程。
        let mut w = self.clients.write().await;
        if let Some(c) = w.get(server_name) {
            return Ok(c.clone());
        }
        let env: HashMap<String, String> = HashMap::new();
        let client = Arc::new(
            McpClient::spawn(
                def.server_name.clone(),
                &def.command,
                &def.args,
                &env,
            )
            .await
            .map_err(|e| format!("MCP server '{}' 拉起失败: {e}", def.server_name))?,
        );
        w.insert(server_name.to_string(), client.clone());
        Ok(client)
    }
}

/// cap.mcp 能力实现。
pub struct McpCapability {
    registry: McpClientRegistry,
    /// 数据根 config_dir（写 state.json 的 per-tool gates；装配时注入，空则禁用管理面）
    config_dir: Option<std::path::PathBuf>,
    /// 事件广播（set_plugin_tools 广播 plugin.lifecycle 触发前端刷新）
    broadcaster: Option<crate::web::EventBroadcaster>,
}

impl McpCapability {
    /// 用已解析 server 快照构造能力（create_app_state 装配时注入）。
    pub fn with_servers(
        servers: Vec<ResolvedExternalMcpServer>,
        config_dir: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            registry: McpClientRegistry::from_servers(servers),
            config_dir,
            broadcaster: None,
        }
    }

    /// 注入事件广播（set_plugin_tools 触发前端刷新）。
    pub fn with_broadcaster(mut self, broadcaster: crate::web::EventBroadcaster) -> Self {
        self.broadcaster = Some(broadcaster);
        self
    }

    /// 读取插件 per-tool 注入门（state.json `mcpToolGates`）。
    ///
    /// 返回 plugin_id → tool_name → enabled。缺省（无文件/无该插件/空 map）视为全放行。
    fn load_tool_gates(&self) -> std::collections::BTreeMap<String, std::collections::BTreeMap<String, bool>> {
        use crate::services::plugin_state_service::PluginStateService;
        let Some(config_dir) = &self.config_dir else {
            return Default::default();
        };
        PluginStateService::new(config_dir.clone())
            .load()
            .unwrap_or_default()
            .into_iter()
            .map(|(plugin_id, state)| (plugin_id, state.mcp_tool_gates))
            .collect()
    }

    /// 写插件 per-tool 注入门（state.json `mcpToolGates`），并广播 state_changed。
    ///
    /// 幂等边界：`state` 不存在该插件记录时自动补全（缺省全放行的其它字段），
    /// 保证 `mcpToolGates` 的写入不依赖既有状态。
    fn save_tool_gates(
        &self,
        plugin_id: &str,
        gates: &std::collections::BTreeMap<String, bool>,
        broadcaster: Option<&crate::web::EventBroadcaster>,
    ) -> std::result::Result<(), String> {
        use crate::models::plugin_state::PluginState;
        use crate::services::plugin_state_service::PluginStateService;
        let Some(config_dir) = &self.config_dir else {
            return Err("cap.mcp 管理面未启用（缺 config_dir）".to_string());
        };
        let service = PluginStateService::new(config_dir.clone());
        let mut states = service.load().map_err(|e| format!("读 state.json 失败: {e}"))?;
        let entry = states.entry(plugin_id.to_string()).or_insert(PluginState {
            enabled: true,
            ui_enabled: true,
            mcp_enabled: true,
            mcp_servers: Default::default(),
            mcp_tool_gates: Default::default(),
        });
        entry.mcp_tool_gates = gates.clone();
        service.save(&states).map_err(|e| format!("写 state.json 失败: {e}"))?;

        // 触发前端刷新：广播 plugin.lifecycle state_changed（P0 通道）
        if let Some(b) = broadcaster {
            crate::services::plugin_events::broadcast_plugin_lifecycle(
                b,
                plugin_id,
                "state_changed",
                Some(serde_json::json!({
                    "changed": ["mcpToolGates"],
                    "effectiveFrom": "nextTurn",
                })),
            );
        }
        Ok(())
    }

    /// 同步 invoke 包异步（对齐 HttpCapability::block_on_async）。
    fn block_on_async<F>(f: F) -> Result<Value, String>
    where
        F: std::future::Future<Output = Result<Value, String>>,
    {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            return tokio::task::block_in_place(move || handle.block_on(f));
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("构建 tokio runtime 失败: {e}"))?;
        rt.block_on(f)
    }
}

impl Capability for McpCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(MCP_CAP_ID.into())
    }

    /// 依赖能力：无（stdlib 直连，不需要其它 cap）。
    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }

    /// 能力自描述（cap.help 索引）。
    fn describe(&self) -> Value {
        json!({
            "id": MCP_CAP_ID,
            "description": "调用插件 MCP server 的工具（如 mimo-tts 语音合成）+ 工具注入管理面",
            "actions": {
                "call": {
                    "params": {
                        "mcpServerId": { "type": "string", "required": true },
                        "tool": { "type": "string", "required": true },
                        "arguments": { "type": "object" },
                    },
                    "returns": { "ok": "bool", "resultJson": "string?", "error": "string?" },
                },
                "list_plugin_tools": {
                    "params": { "pluginId": "string（空 = 全部插件）" },
                    "returns": "{ ok, pluginId, servers: [{ pluginId, server, tools, injected, gate, via }] }",
                },
                "set_plugin_tools": {
                    "params": {
                        "pluginId": "string（必填）",
                        "enabled": "bool（必填）",
                        "tools": "string[]?（缺省 = 整插件 mcpEnabled 开关）",
                    },
                    "returns": "{ ok, pluginId, enabled, effectiveFrom: 'nextTurn' }",
                },
            },
        })
    }

    fn invoke(&self, payload: Value, ctx: &dyn Context) -> Result<Value, String> {
        // 请求来源复核（不信任仅外部 gate）：Bootstrap/Plugin 允许；
        // Remote 仅当携带有效 token（已鉴权 HTTP/WS 前端，含移动端）允许——
        // token 由传输层鉴权后注入，空 token（未鉴权固有 webview）拒绝。
        match ctx.source() {
            Source::Bootstrap | Source::Plugin { .. } => {}
            Source::Remote { token } => {
                if token.is_empty() {
                    return Ok(json!({ "ok": false, "error": "cap.mcp 仅允许本地调用或携带有效 token 的远程调用" }));
                }
            }
        }

        // 解析 action（call + 管理面 list_plugin_tools / set_plugin_tools）
        let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
        match action {
            "call" => self.invoke_call(payload, ctx),
            "list_plugin_tools" => self.invoke_list_plugin_tools(payload),
            "set_plugin_tools" => self.invoke_set_plugin_tools(payload),
            _ => Ok(json!({
                "ok": false,
                "error": format!("不支持的 action: {action}"),
            })),
        }
    }
}

impl McpCapability {
    /// `call`：调用插件 MCP server 的工具（既有语义）。
    fn invoke_call(&self, payload: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let req: McpCallRequest = match serde_json::from_value(payload.clone()) {
            Ok(r) => r,
            Err(e) => {
                return Ok(json!({ "ok": false, "error": format!("参数解析失败: {e}") }));
            }
        };

        // 防绕权：只允许调用已解析插件声明的 server
        if !self.registry.known(&req.mcp_server_id) {
            return Ok(json!({ "ok": false, "error": format!(
                "MCP server 未注册或未启用: {}", req.mcp_server_id
            ) }));
        }

        // 取 client + tools/call 一次性包进 block_on（block_on_async 泛约束 Future 输出
        // 为 Result<Value, String>，故内层 async 块直接产出最终 reply JSON）。
        let registry = &self.registry;
        let mcp_server_id = req.mcp_server_id.clone();
        let tool = req.tool.clone();
        let arguments = req.arguments.clone();
        Self::block_on_async(async move {
            let client = match registry.client_for_inner(&mcp_server_id).await {
                Ok(c) => c,
                Err(e) => {
                    return Ok(json!({ "ok": false, "error": format!("MCP 连接失败: {e}") }));
                }
            };
            match client.call_tool(&tool, &arguments).await {
                Ok(res) => {
                    if res.is_error {
                        Ok(json!({
                            "ok": false, "error": res.text(), "isError": true
                        }))
                    } else {
                        let text = res.text();
                        if text.trim().is_empty() {
                            Ok(json!({ "ok": true, "resultJson": Value::Null }))
                        } else {
                            Ok(json!({ "ok": true, "resultJson": text }))
                        }
                    }
                }
                Err(e) => Ok(json!({ "ok": false, "error": format!("MCP 调用失败: {e}") })),
            }
        })
    }

    /// `list_plugin_tools`：列出插件注入 AI 的工具 + 门控状态（只读诊断）。
    ///
    /// 聚合 `defs`（server_name → 插件归属）。工具名来自已拉起 client 的 tools/list
    /// （未拉起 server 标 `injected: "lazy"`，下一轮注入后可见）。
    fn invoke_list_plugin_tools(&self, payload: Value) -> Result<Value, String> {
        let plugin_id = payload
            .get("pluginId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let gates = self.load_tool_gates();
        let gate_map = gates.get(&plugin_id);

        // 按 plugin_id 聚合 server；空 plugin_id = 全部插件
        let mut by_plugin: std::collections::BTreeMap<
            String,
            Vec<&ResolvedExternalMcpServer>,
        > = std::collections::BTreeMap::new();
        for def in self.registry.defs.values() {
            if plugin_id.is_empty() || def.plugin_id == plugin_id {
                by_plugin.entry(def.plugin_id.clone()).or_default().push(def);
            }
        }

        let rt = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.mcp list_plugin_tools 需在 tokio 运行时内调用".to_string())?;
        let registry = &self.registry;
        let servers = tokio::task::block_in_place(move || {
            rt.block_on(async move {
                let mut list: Vec<Value> = Vec::new();
                for (_pid, defs) in &by_plugin {
                    let plugin_gates = gates.get(&defs[0].plugin_id).cloned().unwrap_or_default();
                    for def in defs {
                        let tool_names: Vec<String> = match registry
                            .clients
                            .read()
                            .await
                            .get(&def.server_name)
                            .cloned()
                        {
                            Some(client) => client
                                .tools()
                                .await
                                .iter()
                                .map(|t| t.name.clone())
                                .collect(),
                            None => Vec::new(),
                        };
                        let injected = if tool_names.is_empty() {
                            "lazy" // 声明了但未拉起：工具名未知，下一轮注入后可见
                        } else {
                            "injected"
                        };
                        // per-tool gate：缺省 true（全放行）；显式 false 才是关闭
                        let tool_gates = tool_names
                            .iter()
                            .map(|n| (n.clone(), plugin_gates.get(n).copied().unwrap_or(true)))
                            .collect::<std::collections::BTreeMap<_, _>>();
                        list.push(json!({
                            "pluginId": def.plugin_id,
                            "server": def.server_name,
                            "tools": tool_names,
                            "toolGates": tool_gates,
                            "injected": injected,
                            "gate": "open",
                            "via": if def.builtin { "builtin" } else { "external" },
                        }));
                    }
                }
                list
            })
        });

        Ok(json!({
            "ok": true,
            "pluginId": plugin_id,
            "servers": servers,
        }))
    }

    /// `set_plugin_tools`：写 state.json per-tool 门 + 更新全局镜像 + 广播（下一轮生效）。
    ///
    /// 双语义：
    /// - 传 `tools: [..]` → per-tool 开关（写 `mcpToolGates`，全局镜像同步）；
    /// - 不传 `tools` → 整插件开关（走 state.json `mcpEnabled`，由装配层过滤，v1 不做 per-tool）。
    fn invoke_set_plugin_tools(&self, payload: Value) -> Result<Value, String> {
        use crate::models::plugin_state::PluginState;
        use crate::services::plugin_state_service::PluginStateService;
        use crate::services::mcp_tool_gates::put_mcp_tool_gates;

        let Some(config_dir) = &self.config_dir else {
            return Ok(json!({ "ok": false, "error": "cap.mcp 管理面未启用（缺 config_dir）" }));
        };
        let plugin_id = payload
            .get("pluginId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "cap.mcp set_plugin_tools 缺少 pluginId".to_string())?;
        let enabled = payload
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| "cap.mcp set_plugin_tools 缺少 enabled（boolean）".to_string())?;

        let service = PluginStateService::new(config_dir.clone());
        let mut states = match service.load() {
            Ok(s) => s,
            Err(e) => return Ok(json!({ "ok": false, "error": format!("读 state.json 失败: {e}") })),
        };
        let entry = states.entry(plugin_id.to_string()).or_insert(PluginState {
            enabled: true,
            ui_enabled: true,
            mcp_enabled: true,
            mcp_servers: Default::default(),
            mcp_tool_gates: Default::default(),
        });

        // 有 tools 列表 → per-tool 门（更新 state.json + 全局镜像）
        let has_tools = payload
            .get("tools")
            .and_then(Value::as_array)
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        let mut effective = std::collections::BTreeMap::new();
        if has_tools {
            for tool in payload["tools"].as_array().unwrap() {
                if let Some(name) = tool.as_str() {
                    entry.mcp_tool_gates.insert(name.to_string(), enabled);
                    effective.insert(name.to_string(), enabled);
                }
            }
        } else {
            // 整插件开关 → mcpEnabled（装配层直接过滤 server，per-tool 不细分）
            entry.mcp_enabled = enabled;
        }

        match service.save(&states) {
            Ok(()) => {}
            Err(e) => return Ok(json!({ "ok": false, "error": format!("写 state.json 失败: {e}") })),
        }

        // 全局镜像同步（引擎层 from_servers 下一轮读取）
        let global = PluginStateService::new(config_dir.clone())
            .load()
            .unwrap_or_default()
            .into_iter()
            .map(|(pid, st)| {
                let tools = st
                    .mcp_tool_gates
                    .into_iter()
                    .collect::<std::collections::HashMap<_, _>>();
                (pid, tools)
            })
            .collect::<std::collections::HashMap<_, _>>();
        put_mcp_tool_gates(global);

        // 广播 state_changed → 前端 PluginTab 刷新（P0 通道）
        if let Some(b) = self.broadcaster() {
            crate::services::plugin_events::broadcast_plugin_lifecycle(
                b,
                plugin_id,
                "state_changed",
                Some(json!({
                    "changed": ["mcpToolGates"],
                    "effectiveFrom": "nextTurn",
                })),
            );
        }

        Ok(json!({
            "ok": true,
            "pluginId": plugin_id,
            "enabled": enabled,
            "tools": if has_tools { json!(effective.values().cloned().collect::<Vec<_>>()) } else { json!([]) },
            "effectiveFrom": "nextTurn",
        }))
    }

    /// cap.mcp 装配时注入的 broadcaster（set_plugin_tools 广播用）。
    ///
    /// 当前由 `McpCapability::with_broadcaster` 装配时注入；无则跳过广播（不阻塞管理面）。
    fn broadcaster(&self) -> Option<&crate::web::EventBroadcaster> {
        self.broadcaster.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Context;

    /// 测试 Context：可编程 source，其余方法占位。
    struct TestCtx {
        source: Source,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            &self.source
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            static PID: &str = "test";
            static PLUGIN_ID: std::sync::OnceLock<crate::contracts::PluginId> = std::sync::OnceLock::new();
            PLUGIN_ID.get_or_init(|| crate::contracts::PluginId(PID.into()))
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    /// 空 server 快照（不拉起进程；gate 分支在取 client 前即裁决）。
    fn empty_cap() -> McpCapability {
        McpCapability::with_servers(Vec::new(), None)
    }

    #[test]
    fn remote_empty_token_denied() {
        let cap = empty_cap();
        let ctx = TestCtx {
            source: Source::Remote { token: String::new() },
        };
        let reply = cap
            .invoke(
                serde_json::json!({
                    "action": "call",
                    "mcpServerId": "mimo-tts",
                    "tool": "mimo_tts_synthesize",
                    "arguments": { "text": "你好" },
                }),
                &ctx,
            )
            .unwrap();
        // 空 token 的 Remote 必须在 gate 层拒绝（不进入取 client）
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("token"));
    }

    #[test]
    fn remote_with_token_passes_gate() {
        let cap = empty_cap();
        let ctx = TestCtx {
            source: Source::Remote { token: "已鉴权token".into() },
        };
        let reply = cap
            .invoke(
                serde_json::json!({
                    "action": "call",
                    "mcpServerId": "mimo-tts",
                    "tool": "mimo_tts_synthesize",
                    "arguments": { "text": "你好" },
                }),
                &ctx,
            )
            .unwrap();
        // gate 已放行（带 token），失败原因应是「未注册 server」而非 token 拒绝
        assert_eq!(reply["ok"], false);
        let err = reply["error"].as_str().unwrap();
        assert!(err.contains("mimo-tts"), "gate 应放行后报未注册，实际: {err}");
        assert!(!err.contains("token"), "不应再报 token 拒绝，实际: {err}");
    }
}