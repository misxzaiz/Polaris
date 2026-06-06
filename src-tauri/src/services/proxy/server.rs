//! 代理 HTTP 服务器
//!
//! 启动本地 Axum HTTP 服务器，监听 Claude CLI 请求并转发到上游。

use axum::{routing::post, Router};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::forwarder::ForwarderConfig;
use super::handlers::{handle_messages, handle_responses, ProxyState};

/// 代理服务器句柄
///
/// 持有监听地址和关闭信号。通过调用 `shutdown()` 停止服务器。
#[derive(Debug)]
pub struct ProxyHandle {
    /// 服务器监听地址
    pub addr: SocketAddr,
    /// 关闭信号发送器
    shutdown_tx: watch::Sender<bool>,
}

impl ProxyHandle {
    /// 停止代理服务器
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

/// 启动代理服务器
///
/// `port = 0` 时由操作系统分配可用端口。
pub async fn start_proxy_server(
    forwarder_config: ForwarderConfig,
    port: u16,
) -> Result<ProxyHandle, super::error::ProxyError> {
    let state = ProxyState {
        forwarder: forwarder_config,
    };

    let app = Router::new()
        .route("/v1/messages", post(handle_messages))
        .route("/v1/responses", post(handle_responses))
        .route("/responses", post(handle_responses))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| super::error::ProxyError::Server(format!("绑定代理端口失败: {}", e)))?;

    let actual_addr = listener
        .local_addr()
        .map_err(|e| super::error::ProxyError::Server(format!("获取监听地址失败: {}", e)))?;

    tracing::info!("[Proxy] 启动代理服务器: http://{}", actual_addr);

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    tokio::spawn(async move {
        let shutdown_signal = async move {
            let _ = shutdown_rx.changed().await;
        };

        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal)
            .await
        {
            tracing::error!("[Proxy] 服务器错误: {}", e);
        }
        tracing::info!("[Proxy] 代理服务器已停止: {}", actual_addr);
    });

    Ok(ProxyHandle {
        addr: actual_addr,
        shutdown_tx,
    })
}
