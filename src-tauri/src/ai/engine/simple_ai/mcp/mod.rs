/*! MCP 客户端池（Phase 4b）
 *
 * 会话级聚合：spawn 所有已启用 MCP server，缓存工具列表，
 * 按 `mcp__{server}__{tool}` 命名路由调用。
 *
 * 生命周期：会话启动时 `from_servers` 创建，多轮 tool_call 复用，会话结束 drop（kill 子进程）。
 */

mod client;
mod types;

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::services::mcp_config_service::ResolvedExternalMcpServer;

use super::tools::ToolOutcome;
use client::McpClient;
use types::McpTool;

/// MCP 工具名前缀分隔符：`mcp__{server}__{tool}`。
const MCP_PREFIX: &str = "mcp__";

pub(crate) struct McpClientPool {
    clients: HashMap<String, Arc<McpClient>>,
    /// `mcp__{server}__{tool}` → (server_name, tool_name)
    tool_index: HashMap<String, (String, String)>,
    /// 已缓存的 OpenAI function spec（spawn 后固定）。
    cached_specs: Vec<Value>,
}

impl McpClientPool {
    /// 并发 spawn 所有 server；失败的跳过并 log，不阻断会话。
    pub(crate) async fn from_servers(servers: Vec<ResolvedExternalMcpServer>) -> Self {
        let mut clients: HashMap<String, Arc<McpClient>> = HashMap::new();
        let mut tool_index: HashMap<String, (String, String)> = HashMap::new();
        let mut cached_specs: Vec<Value> = Vec::new();

        for server in &servers {
            // env：ResolvedExternalMcpServer 当前不携带 env，传空（后续扩展）。
            let env: HashMap<String, String> = HashMap::new();
            match McpClient::spawn(
                server.server_name.clone(),
                &server.command,
                &server.args,
                &env,
            )
            .await
            {
                Ok(client) => {
                    let client = Arc::new(client);
                    let tools = client.tools().await;
                    for tool in &tools {
                        let mcp_name = format!(
                            "{}{}__{}",
                            MCP_PREFIX, server.server_name, tool.name
                        );
                        tool_index.insert(
                            mcp_name.clone(),
                            (server.server_name.clone(), tool.name.clone()),
                        );
                        cached_specs.push(mcp_tool_to_spec(&mcp_name, tool));
                    }
                    clients.insert(server.server_name.clone(), client);
                }
                Err(e) => {
                    tracing::warn!(
                        "[SimpleAI-MCP] 启动 MCP server '{}' 失败，跳过: {}",
                        server.server_name,
                        e
                    );
                }
            }
        }

        Self {
            clients,
            tool_index,
            cached_specs,
        }
    }

    /// 全部工具的 OpenAI function spec（同步，spawn 后缓存）。
    pub(crate) fn tool_specs(&self) -> &[Value] {
        &self.cached_specs
    }

    /// 按 `mcp__{srv}__{tool}` 名调用。
    pub(crate) async fn call(&self, mcp_name: &str, args: &Value) -> ToolOutcome {
        let (server_name, tool_name) = match self.tool_index.get(mcp_name) {
            Some(v) => v.clone(),
            None => return ToolOutcome::fail(format!("Unknown MCP tool: {}", mcp_name)),
        };
        let client = match self.clients.get(&server_name) {
            Some(c) => Arc::clone(c),
            None => {
                return ToolOutcome::fail(format!("MCP server not connected: {}", server_name))
            }
        };
        match client.call_tool(&tool_name, args).await {
            Ok(result) => {
                let text = result.text();
                if result.is_error {
                    ToolOutcome::fail(text)
                } else if text.trim().is_empty() {
                    ToolOutcome::ok("(empty MCP result)")
                } else {
                    ToolOutcome::ok(text)
                }
            }
            Err(e) => ToolOutcome::fail(format!(
                "MCP '{}.{}' call failed: {}",
                server_name, tool_name, e
            )),
        }
    }

    /// 解析 `mcp__{srv}__{tool}` 名为 (server, tool)。
    pub(crate) fn parse_tool_name(name: &str) -> Option<(String, String)> {
        let rest = name.strip_prefix(MCP_PREFIX)?;
        let (srv, tool) = rest.split_once("__")?;
        if srv.is_empty() || tool.is_empty() {
            return None;
        }
        Some((srv.to_string(), tool.to_string()))
    }

    /// 已连接的 server 数量（诊断用）。
    pub(crate) fn connected_count(&self) -> usize {
        self.clients.len()
    }
}

/// `McpTool` → OpenAI function spec。
fn mcp_tool_to_spec(mcp_name: &str, tool: &McpTool) -> Value {
    let parameters = tool.input_schema.clone().unwrap_or_else(|| {
        json!({ "type": "object", "properties": {}, "additionalProperties": true })
    });
    json!({
        "type": "function",
        "function": {
            "name": mcp_name,
            "description": tool.description.as_deref().unwrap_or(""),
            "parameters": parameters,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_name_extracts_server_and_tool() {
        assert_eq!(
            McpClientPool::parse_tool_name("mcp__polaris-todo__create_todo"),
            Some(("polaris-todo".to_string(), "create_todo".to_string()))
        );
        assert_eq!(
            McpClientPool::parse_tool_name("mcp__bb-browser__site_google_search"),
            Some(("bb-browser".to_string(), "site_google_search".to_string()))
        );
    }

    #[test]
    fn parse_tool_name_rejects_invalid() {
        assert_eq!(McpClientPool::parse_tool_name("bash"), None);
        assert_eq!(McpClientPool::parse_tool_name("mcp__onlyone"), None);
        assert_eq!(McpClientPool::parse_tool_name("mcp__a__"), None);
        assert_eq!(McpClientPool::parse_tool_name("mcp____b"), None);
    }

    #[test]
    fn mcp_tool_to_spec_uses_input_schema() {
        let tool = McpTool {
            name: "create".to_string(),
            description: Some("Create a todo".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": { "title": { "type": "string" } },
                "required": ["title"]
            })),
        };
        let spec = mcp_tool_to_spec("mcp__todo__create", &tool);
        assert_eq!(spec["function"]["name"], "mcp__todo__create");
        assert_eq!(spec["function"]["description"], "Create a todo");
        assert_eq!(spec["function"]["parameters"]["required"][0], "title");
    }

    #[test]
    fn mcp_tool_to_spec_defaults_missing_schema() {
        let tool = McpTool {
            name: "x".to_string(),
            description: None,
            input_schema: None,
        };
        let spec = mcp_tool_to_spec("mcp__s__x", &tool);
        assert_eq!(spec["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn empty_pool_has_no_specs() {
        let pool = futures_executor_pool();
        assert!(pool.tool_specs().is_empty());
        assert_eq!(pool.connected_count(), 0);
    }

    /// 直接构造空 pool（避免 async from_servers 在测试里 spawn 子进程）。
    fn futures_executor_pool() -> McpClientPool {
        McpClientPool {
            clients: HashMap::new(),
            tool_index: HashMap::new(),
            cached_specs: Vec::new(),
        }
    }
}
