//! 内嵌代理服务模块
//!
//! 提供本地 HTTP 代理，透明地将 Anthropic Messages API 格式的请求
//! 转换为 OpenAI Chat Completions 格式发送给上游端点。
//!
//! 核心流程：
//! ```text
//! Claude CLI → (Anthropic Messages) → Polaris Proxy → (OpenAI Chat Completions) → 上游 API
//! Claude CLI ← (Anthropic Messages) ← Polaris Proxy ← (OpenAI Chat Completions) ← 上游 API
//! ```

pub mod codex_chat;
pub mod error;
pub mod forwarder;
pub mod handlers;
pub mod models;
pub mod sanitizer;
pub mod server;
pub mod sse;
pub mod streaming;
pub mod transform;

use error::ProxyError;
use forwarder::ForwarderConfig;
pub use forwarder::ProxyWireApi;
use server::ProxyHandle;
use std::collections::HashMap;
use std::net::SocketAddr;
use tokio::sync::Mutex;

/// 代理管理器 — 管理多个会话的代理实例生命周期
///
/// 存储在 `AppState` 中，线程安全。
///
/// 内部以 **session_id** 为 key 索引代理，而非 profile_id。
/// 两个会话共用同一个 Profile 时各自持有独立代理实例，避免跨会话杀代理。
pub struct ProxyManager {
    /// 活跃的代理实例：session_id → ProxyHandle
    proxies: Mutex<HashMap<String, ProxyHandle>>,
}

impl ProxyManager {
    pub fn new() -> Self {
        Self {
            proxies: Mutex::new(HashMap::new()),
        }
    }

    /// 为指定会话启动代理服务器
    ///
    /// 代理以 **session_id** 为 key 存储，不同会话互不干扰。
    /// 即使多个会话共用同一个 Profile（同一 `profile_id`、`base_url`、`api_key`），
    /// 也各自持有独立的代理实例。
    ///
    /// `profile_id` 仅用于日志，不参与 key 索引。
    pub async fn start_proxy(
        &self,
        session_id: &str,
        profile_id: &str,
        base_url: &str,
        api_key: &str,
        wire_api: ProxyWireApi,
        custom_headers: HashMap<String, String>,
    ) -> Result<SocketAddr, ProxyError> {
        let mut proxies = self.proxies.lock().await;

        // 不杀旧代理：索引是 session_id，新会话天然不会冲突。
        // （旧逻辑按 profile_id 索引会无差别 kill 同一 profile 下的其他会话代理，
        //  导致其他会话收到 ConnectionRefused。）

        let forwarder_config =
            ForwarderConfig::with_options(base_url, api_key, wire_api, custom_headers);
        let handle = server::start_proxy_server(forwarder_config, 0).await?;
        let addr = handle.addr;

        tracing::info!(
            "[ProxyManager] 为 session {} (profile={}) 启动代理: http://{}",
            session_id, profile_id, addr
        );

        proxies.insert(session_id.to_string(), handle);

        Ok(addr)
    }

    /// 获取指定会话的代理地址
    pub async fn get_proxy_addr(&self, session_id: &str) -> Option<SocketAddr> {
        let proxies = self.proxies.lock().await;
        proxies.get(session_id).map(|h| h.addr)
    }

    /// 停止指定会话的代理
    pub async fn stop_proxy(&self, session_id: &str) {
        let mut proxies = self.proxies.lock().await;
        if let Some(handle) = proxies.remove(session_id) {
            tracing::info!(
                "[ProxyManager] 停止 session {} 的代理: http://{}",
                session_id, handle.addr
            );
            handle.shutdown();
        } else {
            tracing::info!(
                "[ProxyManager] session {} 无活跃代理可停",
                session_id
            );
        }
    }

    /// 停止所有代理
    pub async fn stop_all(&self) {
        let mut proxies = self.proxies.lock().await;
        for (id, handle) in proxies.drain() {
            tracing::info!(
                "[ProxyManager] 停止 session {} 的代理: http://{}",
                id, handle.addr
            );
            handle.shutdown();
        }
    }
}

impl Default for ProxyManager {
    fn default() -> Self {
        Self::new()
    }
}
