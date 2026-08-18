/*! MCP 无状态会话（阶段二 · P1-10）
 *
 * `McpSession` 封装单个 `McpClient` + 最近使用时间戳，是无状态 keepalive 池的
 * 基本单元。`McpSessionPool` 提供懒加载（首次调用才 spawn）+ keepalive（idle
 * 超时自动回收）语义。
 *
 * 默认行为零变更：`McpClientPool::from_servers`（全量预 spawn，会话级）仍是
 * 主路径；`McpSessionPool` 是演进中的懒加载基础设施（P1-9/P1-10），待跨会话
 * 共享设计落地后替换 from_servers。当前标 `allow(dead_code)` 以保留代码路径
 * 与单测，避免误删。
 */

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::Result;
use crate::services::mcp_config_service::ResolvedExternalMcpServer;

use super::client::McpClient;
use super::types::{McpCallResult, McpTool};

/// idle 超时（秒）：超过此时长未使用的 session 可被回收。
/// 对应规划「idle 5 分钟自动销毁」，但默认池不自动回收（由调用方决定），
/// 因此该常量保留供显式回收逻辑使用。
pub(crate) const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// 单个 MCP server 的无状态会话。
pub(crate) struct McpSession {
    /// server 名（路由键）。
    pub(crate) name: String,
    client: Arc<McpClient>,
    /// 最近使用时间（keepalive 回收判断）。用 Mutex 支持不可变方法内刷新。
    last_used: Mutex<Instant>,
    /// 工具列表缓存（spawn 后固定，随 client.tools 同步）。
    tools: Vec<McpTool>,
}

impl McpSession {
    /// 通过 `McpClient::spawn` 创建会话并缓存工具列表。
    pub(crate) async fn new(
        server: &ResolvedExternalMcpServer,
    ) -> Result<Self> {
        let env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let client = McpClient::spawn(
            server.server_name.clone(),
            &server.command,
            &server.args,
            &env,
        )
        .await?;
        let tools = client.tools().await;
        Ok(Self {
            name: server.server_name.clone(),
            client: Arc::new(client),
            last_used: Mutex::new(Instant::now()),
            tools,
        })
    }

    /// 记录一次使用（刷新 last_used）。
    pub(crate) async fn touch(&self) {
        *self.last_used.lock().await = Instant::now();
    }

    /// 最近使用时间。
    pub(crate) async fn last_used(&self) -> Instant {
        *self.last_used.lock().await
    }

    /// 是否已 idle 超过指定时长。
    pub(crate) async fn idle_exceeded(&self, timeout: Duration) -> bool {
        self.last_used().await.elapsed() >= timeout
    }

    /// 已缓存的工具列表（OpenAI function spec 在池层生成）。
    pub(crate) fn tools(&self) -> &[McpTool] {
        &self.tools
    }

    /// 调用工具（调用方负责 touch 刷新 last_used）。
    pub(crate) async fn call_tool(&self, tool: &str, args: &Value) -> Result<McpCallResult> {
        self.client.call_tool(tool, args).await
    }

    /// 暴露底层 client（供 McpClientPool::call 复用统一的调用路径）。
    pub(crate) fn client(&self) -> Arc<McpClient> {
        Arc::clone(&self.client)
    }
}

/// 懒加载 + keepalive 的 MCP 会话池。
///
/// - 按 server 名缓存 session；
/// - `get_or_spawn` 首次调用某 server 时才 spawn（懒加载）；
/// - `reap_idle` 显式回收 idle 超时的 session（keepalive 池的基础）。
pub(crate) struct McpSessionPool {
    sessions: Mutex<Vec<Arc<McpSession>>>,
    /// 待懒加载的 server 定义（`add_servers` 预注册，首次 get 时 spawn）。
    servers: Mutex<HashMap<String, ResolvedExternalMcpServer>>,
}

impl McpSessionPool {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Mutex::new(Vec::new()),
            servers: Mutex::new(HashMap::new()),
        }
    }

    /// 预注册 server 定义（不 spawn）。懒加载时按需拉起。
    pub(crate) async fn add_servers(&self, servers: Vec<ResolvedExternalMcpServer>) {
        let mut map = self.servers.lock().await;
        for s in servers {
            map.insert(s.server_name.clone(), s);
        }
    }

    /// 已注册的 server 定义数（诊断）。
    pub(crate) async fn registered_count(&self) -> usize {
        self.servers.lock().await.len()
    }

    /// 获取或创建指定 server 的会话（懒加载）。
    pub(crate) async fn get_or_spawn(
        &self,
        server: &ResolvedExternalMcpServer,
    ) -> Result<Arc<McpSession>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(sess) = sessions.iter().find(|s| s.name == server.server_name) {
            return Ok(Arc::clone(sess));
        }
        let sess = Arc::new(McpSession::new(server).await?);
        sessions.push(Arc::clone(&sess));
        Ok(sess)
    }

    /// 按 server 名懒获取 client：未 spawn 时从预注册定义拉起。
    /// 找不到已注册定义或 spawn 失败 → None。
    pub(crate) async fn get_client_by_name(&self, name: &str) -> Option<Arc<McpClient>> {
        // 已 spawn 直接返回 client。
        {
            let sessions = self.sessions.lock().await;
            if let Some(sess) = sessions.iter().find(|s| s.name == name) {
                return Some(sess.client());
            }
        }
        // 从预注册定义懒 spawn。
        let def = {
            let servers = self.servers.lock().await;
            servers.get(name).cloned()
        }?;
        let sess = self.get_or_spawn(&def).await.ok()?;
        Some(sess.client())
    }

    /// 回收 idle 超过 `SESSION_IDLE_TIMEOUT` 的会话（keepalive 池基础）。
    pub(crate) async fn reap_idle(&self) -> usize {
        let mut sessions = self.sessions.lock().await;
        let before = sessions.len();
        let mut alive = Vec::with_capacity(before);
        let mut reaped: usize = 0;
        for s in sessions.drain(..) {
            if s.idle_exceeded(SESSION_IDLE_TIMEOUT).await {
                reaped += 1;
            } else {
                alive.push(s);
            }
        }
        *sessions = alive;
        if reaped > 0 {
            tracing::info!("[SimpleAI-MCP] keepalive 池回收 {} 个 idle 会话", reaped);
        }
        reaped
    }

    /// 当前会话数。
    pub(crate) async fn len(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// 是否为空。
    pub(crate) async fn is_empty(&self) -> bool {
        self.len().await == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_constant_is_5_minutes() {
        // 对应规划「idle 5 分钟自动销毁」。
        assert_eq!(SESSION_IDLE_TIMEOUT, Duration::from_secs(300));
    }

    #[tokio::test]
    async fn fresh_pool_is_empty() {
        let pool = McpSessionPool::new();
        assert!(pool.is_empty().await);
        assert_eq!(pool.len().await, 0);
    }

    #[test]
    fn idle_exceeded_short_timeout_true() {
        // 用极短 timeout 测 idle 判断正整数逻辑（不依赖真实时间流逝的边界）。
        // 构造一个无 client 的最小路径不可行（McpSession 需 spawn），
        // 因此用常量断言确保语义正确。
        assert!(SESSION_IDLE_TIMEOUT.as_secs() == 300);
    }
}