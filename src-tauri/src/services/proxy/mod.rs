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

/// 代理管理器 — 管理多个 profile 的代理实例生命周期
///
/// 存储在 `AppState` 中，线程安全。
pub struct ProxyManager {
    /// 活跃的代理实例：profile_id → ProxyHandle
    proxies: Mutex<HashMap<String, ProxyHandle>>,
}

impl ProxyManager {
    pub fn new() -> Self {
        Self {
            proxies: Mutex::new(HashMap::new()),
        }
    }

    /// 为指定 profile 启动代理服务器
    ///
    /// 如果该 profile 已有活跃代理，先停止旧的再启动新的。
    /// 返回代理监听地址（`127.0.0.1:<port>`）。
    pub async fn start_proxy(
        &self,
        profile_id: &str,
        base_url: &str,
        api_key: &str,
        wire_api: ProxyWireApi,
        custom_headers: HashMap<String, String>,
    ) -> Result<SocketAddr, ProxyError> {
        let mut proxies = self.proxies.lock().await;

        // 停止已有的代理
        if let Some(old) = proxies.remove(profile_id) {
            tracing::info!("[ProxyManager] 停止 profile {} 的旧代理", profile_id);
            old.shutdown();
        }

        let forwarder_config =
            ForwarderConfig::with_options(base_url, api_key, wire_api, custom_headers);
        let handle = server::start_proxy_server(forwarder_config, 0).await?;
        let addr = handle.addr;

        tracing::info!(
            "[ProxyManager] 为 profile {} 启动代理: http://{}",
            profile_id,
            addr
        );

        proxies.insert(profile_id.to_string(), handle);

        Ok(addr)
    }

    /// 获取指定 profile 的代理地址
    pub async fn get_proxy_addr(&self, profile_id: &str) -> Option<SocketAddr> {
        let proxies = self.proxies.lock().await;
        proxies.get(profile_id).map(|h| h.addr)
    }

    /// 停止指定 profile 的代理
    pub async fn stop_proxy(&self, profile_id: &str) {
        let mut proxies = self.proxies.lock().await;
        if let Some(handle) = proxies.remove(profile_id) {
            tracing::info!("[ProxyManager] 停止 profile {} 的代理", profile_id);
            handle.shutdown();
        }
    }

    /// 停止所有代理
    pub async fn stop_all(&self) {
        let mut proxies = self.proxies.lock().await;
        for (id, handle) in proxies.drain() {
            tracing::info!("[ProxyManager] 停止 profile {} 的代理", id);
            handle.shutdown();
        }
    }
}

impl Default for ProxyManager {
    fn default() -> Self {
        Self::new()
    }
}
