/*! Feishu (飞书) 适配器
 *
 * 实现 PlatformIntegration Trait，提供飞书机器人的连接、消息收发功能。
 * 使用 reqwest 调用 HTTP REST API，tokio-tungstenite 管理 WebSocket 长连接。
 * WS 协议使用飞书 pbbp2 二进制帧格式（protobuf 编码），与官方 SDK 一致。
 */

#![allow(dead_code)]

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{mpsc::Sender, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::error::{AppError, Result};
use crate::models::config::FeishuRuntimeConfig;
use super::super::common::MessageDedup;
use super::super::traits::PlatformIntegration;
use super::super::types::*;
use super::frame::{Frame, ClientConfig, MESSAGE_TYPE_EVENT};

/// 飞书 API 基础 URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn";

/// 连接超时时间（秒）
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// WebSocket 心跳间隔（秒）
const WS_PING_INTERVAL_SECS: u64 = 30;

/// 内部共享状态
#[derive(Debug, Default)]
struct InnerState {
    /// 当前连接状态
    connection_state: ConnectionState,
    /// 错误信息
    error: Option<String>,
    /// 错误详情
    error_detail: Option<String>,
    /// 重试次数
    retry_count: u32,
}

/// Feishu 适配器
pub struct FeishuAdapter {
    /// 配置
    config: FeishuRuntimeConfig,
    /// Tenant Access Token
    access_token: Option<String>,
    /// Token 过期时间（Unix 时间戳）
    token_expire_at: i64,
    /// 消息发送通道
    message_tx: Option<Sender<IntegrationMessage>>,
    /// 内部状态（共享给 WebSocket 任务）
    inner_state: Arc<RwLock<InnerState>>,
    /// 消息去重器
    dedup: MessageDedup,
    /// WebSocket 任务句柄
    ws_task: Option<tokio::task::JoinHandle<()>>,
    /// 关闭信号发送端
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// App Handle（用于发送状态变化事件）
    app_handle: Option<tauri::AppHandle>,
}

impl FeishuAdapter {
    /// 创建新的 Feishu 适配器
    pub fn new(config: FeishuRuntimeConfig) -> Self {
        Self {
            config,
            access_token: None,
            token_expire_at: 0,
            message_tx: None,
            inner_state: Arc::new(RwLock::new(InnerState::default())),
            dedup: MessageDedup::default(),
            ws_task: None,
            shutdown_tx: None,
            app_handle: None,
        }
    }

    /// 设置 App Handle
    pub fn with_app_handle(mut self, app_handle: tauri::AppHandle) -> Self {
        self.app_handle = Some(app_handle);
        self
    }

    /// 更新内部状态并发送事件
    async fn update_state(&self, new_state: ConnectionState) {
        {
            let mut state = self.inner_state.write().await;
            state.connection_state = new_state;
        }
        if let Some(ref app_handle) = self.app_handle {
            let status = self.status();
            let _ = app_handle.emit("integration:state_change", &status);
        }
    }

    /// 设置错误状态
    async fn set_error(&self, error: String, detail: Option<String>) {
        let mut state = self.inner_state.write().await;
        state.connection_state = ConnectionState::Failed;
        state.error = Some(error);
        state.error_detail = detail;
    }

    /// 获取 Tenant Access Token
    async fn get_tenant_access_token(&mut self) -> Result<()> {
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{}/open-apis/auth/v3/tenant_access_token/internal/", FEISHU_API_BASE))
            .json(&serde_json::json!({
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            return Err(AppError::AuthError(format!("获取 Tenant Access Token 失败: {}", error)));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;

        let code = data.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(AppError::AuthError(format!("飞书认证失败: code={}, msg={}", code, msg)));
        }

        self.access_token = data
            .get("tenant_access_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let expire = data
            .get("expire")
            .and_then(|v| v.as_i64())
            .unwrap_or(7200);

        // 提前 5 分钟过期
        self.token_expire_at = chrono::Utc::now().timestamp() + expire - 300;

        if let Some(ref token) = self.access_token {
            let preview: String = token.chars().take(8).collect();
            tracing::info!("[Feishu] ✅ Tenant access token obtained: {}..., expires in {}s", preview, expire);
        }

        if self.access_token.is_none() {
            return Err(AppError::AuthError("响应中没有 tenant_access_token".to_string()));
        }

        Ok(())
    }

    /// 检查 Token 是否过期
    fn is_token_expired(&self) -> bool {
        self.access_token.is_none() || chrono::Utc::now().timestamp() >= self.token_expire_at
    }

    /// 确保 Token 有效
    async fn ensure_valid_token(&mut self) -> Result<()> {
        if self.is_token_expired() {
            self.get_tenant_access_token().await?;
        }
        Ok(())
    }

    /// 获取 WebSocket 端点 URL 和完整响应数据
    ///
    /// 参考飞书官方 Go SDK (larksuite/oapi-sdk-go/ws/client.go):
    /// POST /callback/ws/endpoint，body 为 {"AppID":"...","AppSecret":"..."}
    /// 响应 data 中字段名为大写 "URL"
    async fn get_ws_endpoint(&self) -> Result<(String, serde_json::Value)> {
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{}/callback/ws/endpoint", FEISHU_API_BASE))
            .header("locale", "zh")
            .json(&serde_json::json!({
                "AppID": self.config.app_id,
                "AppSecret": self.config.app_secret,
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let error = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!(
                "获取 WebSocket 端点失败: HTTP {}, body={}", status, error
            )));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;

        let code = data.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");

            // 针对常见错误码提供详细指引
            let hint = match code {
                9499 => format!(
                    "获取 WebSocket 端点失败: code={}, msg={}\n\
                    \n\
                    此错误通常由飞书开放平台应用配置不完整导致，请检查以下设置：\n\
                    1. 在「应用能力」中启用「机器人」能力\n\
                    2. 在「事件订阅」中将接收模式设为「长连接」（而非 Webhook）\n\
                    3. 确保已开通所需权限（如 im:message）\n\
                    4. 创建应用版本并发布（或使用测试企业）",
                    code, msg
                ),
                _ => format!("获取 WebSocket 端点失败: code={}, msg={}", code, msg),
            };

            return Err(AppError::ApiError(hint));
        }

        // 官方 SDK 响应字段为大写 "URL"（参见 ws/model.go Endpoint.Url 的 json tag）
        let url = data
            .get("data")
            .and_then(|d| d.get("URL").or_else(|| d.get("url")).or_else(|| d.get("endpoint")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::ApiError(format!("响应中没有 WebSocket 端点 URL: {}", data)))?;

        Ok((url, data))
    }

    /// 解析飞书消息事件
    fn handle_message_event(
        event: &serde_json::Value,
        dedup: &mut MessageDedup,
    ) -> Option<IntegrationMessage> {
        let header = event.get("header")?;
        let event_body = event.get("event")?;
        let message = event_body.get("message")?;
        let sender = event_body.get("sender")?;
        let sender_id_obj = sender.get("sender_id")?;

        // 获取事件 ID 用于去重
        let event_id = header.get("event_id").and_then(|v| v.as_str())?;

        // 去重检查
        if dedup.is_processed(event_id) {
            tracing::debug!("[Feishu] ⚠️ 重复事件被忽略: {}", event_id);
            return None;
        }

        // 获取 chat_id 作为会话 ID
        let chat_id = message.get("chat_id").and_then(|v| v.as_str()).unwrap_or("");
        let conversation_id = format!("feishu_{}", chat_id);

        // 获取发送者 ID
        let sender_id = sender_id_obj
            .get("union_id")
            .or_else(|| sender_id_obj.get("user_id"))
            .or_else(|| sender_id_obj.get("open_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 获取发送者名称（飞书 im.message.receive_v1 事件不包含 nickname，
        // 需通过 contact API 获取，此处使用 sender_id 作为标识）
        let sender_name = event_body
            .get("sender")
            .and_then(|s| s.get("nickname"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                // 使用 open_id 前 8 位作为显示名
                let short_id = &sender_id[..sender_id.len().min(8)];
                format!("用户#{}", short_id)
            });

        // 解析消息内容
        let msg_type = message.get("message_type").and_then(|v| v.as_str()).unwrap_or("text");
        let content_str = message.get("content").and_then(|v| v.as_str()).unwrap_or("{}");

        let content = match msg_type {
            "text" => {
                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content_str) {
                    let text = content_json
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    // 去掉 @机器人 的提及
                    let cleaned = Self::strip_at_mention(text);
                    MessageContent::text(cleaned)
                } else {
                    MessageContent::text("")
                }
            }
            "image" => {
                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content_str) {
                    let image_key = content_json
                        .get("image_key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    MessageContent::Image {
                        url: image_key.to_string(),
                        file_name: None,
                        local_path: None,
                    }
                } else {
                    MessageContent::text("[图片]")
                }
            }
            "audio" => {
                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content_str) {
                    let file_key = content_json
                        .get("file_key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    MessageContent::Audio {
                        url: file_key.to_string(),
                        file_name: None,
                        transcript: None,
                    }
                } else {
                    MessageContent::text("[语音]")
                }
            }
            "file" => {
                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content_str) {
                    let file_key = content_json
                        .get("file_key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let file_name = content_json
                        .get("file_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown_file")
                        .to_string();
                    MessageContent::File {
                        name: file_name,
                        url: file_key.to_string(),
                        size: 0,
                    }
                } else {
                    MessageContent::text("[文件]")
                }
            }
            "video" => {
                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content_str) {
                    let file_key = content_json
                        .get("file_key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    MessageContent::File {
                        name: "video.mp4".to_string(),
                        url: file_key.to_string(),
                        size: 0,
                    }
                } else {
                    MessageContent::text("[视频]")
                }
            }
            _ => MessageContent::text(format!("[{}消息]", msg_type)),
        };

        tracing::info!(
            "[Feishu] 📝 消息详情: sender={}, conversation={}, type={}",
            sender_name,
            conversation_id,
            msg_type
        );

        let platform_msg_id = message
            .get("message_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Some(
            IntegrationMessage::new(
                Platform::Feishu,
                conversation_id,
                sender_id,
                sender_name,
                content,
            )
            .with_platform_message_id(platform_msg_id.unwrap_or_default())
            .with_raw(event.clone()),
        )
    }

    /// 去掉 @机器人 的提及标记
    fn strip_at_mention(text: &str) -> String {
        // 飞书 @mentions 格式: @_user_1 内容
        let re = regex::Regex::new(r"@_\w+\s*").unwrap();
        re.replace(text, "").trim().to_string()
    }

    /// 下载飞书消息中的媒体资源
    ///
    /// 飞书 API: GET /open-apis/im/v1/messages/{message_id}/resources/{key}?type={image|file}
    async fn download_resource(
        &self,
        message_id: &str,
        resource_key: &str,
        resource_type: &str, // "image" 或 "file"
    ) -> Result<Vec<u8>> {
        let client = reqwest::Client::new();
        let token = self.access_token.as_ref()
            .ok_or_else(|| AppError::AuthError("未获取 access token".to_string()))?;

        let url = format!(
            "{}/open-apis/im/v1/messages/{}/resources/{}?type={}",
            FEISHU_API_BASE, message_id, resource_key, resource_type
        );

        tracing::info!("[Feishu] 📥 下载资源: type={}, key={}", resource_type, resource_key);

        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!(
                "下载资源失败: HTTP {}, body={}", status, body
            )));
        }

        let bytes = response.bytes().await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        tracing::info!("[Feishu] ✅ 资源下载完成: {} bytes", bytes.len());
        Ok(bytes.to_vec())
    }

    /// 从 MessageContent 提取媒体项
    fn collect_media_items(content: &MessageContent) -> Vec<(String, String, String)> {
        // 返回 (key, type_param, fallback_name)
        let mut items = Vec::new();
        match content {
            MessageContent::Image { url, .. } => {
                items.push((url.clone(), "image".to_string(), "image.png".to_string()));
            }
            MessageContent::Audio { url, .. } => {
                items.push((url.clone(), "file".to_string(), "audio.ogg".to_string()));
            }
            MessageContent::File { name, url, .. } => {
                items.push((url.clone(), "file".to_string(), name.clone()));
            }
            MessageContent::Mixed { items: inner } => {
                for item in inner {
                    items.extend(Self::collect_media_items(item));
                }
            }
            _ => {}
        }
        items
    }

    /// 发送消息到飞书
    async fn send_feishu_message(&self, receive_id: &str, msg_type: &str, content: &str) -> Result<()> {
        let client = reqwest::Client::new();
        let token = self.access_token.as_ref().ok_or_else(|| {
            AppError::AuthError("未认证".to_string())
        })?;

        let url = format!(
            "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
            FEISHU_API_BASE
        );

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "receive_id": receive_id,
                "msg_type": msg_type,
                "content": content
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!("发送飞书消息失败: {}", error)));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;

        let code = data.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(AppError::ApiError(format!("发送飞书消息失败: code={}, msg={}", code, msg)));
        }

        tracing::debug!("[Feishu] ✅ 消息已发送到 {}", receive_id);
        Ok(())
    }
}

#[async_trait]
impl PlatformIntegration for FeishuAdapter {
    fn platform(&self) -> Platform {
        Platform::Feishu
    }

    async fn connect(&mut self, message_tx: Sender<IntegrationMessage>) -> Result<()> {
        tracing::info!("[Feishu] 🔌 开始连接...");

        // 防重入：如果已有活跃的 WebSocket 任务，先断开旧连接
        if self.ws_task.is_some() {
            tracing::warn!("[Feishu] ⚠️ 检测到已有连接，先断开旧连接再重连");
            let _ = self.disconnect().await;
        }

        // 重置状态
        {
            let mut state = self.inner_state.write().await;
            state.connection_state = ConnectionState::Connecting;
            state.error = None;
            state.error_detail = None;
        }

        // 1. 获取 Tenant Access Token
        tracing::info!("[Feishu] 🔐 获取 Tenant Access Token...");
        self.update_state(ConnectionState::Connecting).await;

        if let Err(e) = self.ensure_valid_token().await {
            self.set_error("获取 Tenant Access Token 失败".to_string(), Some(e.to_string())).await;
            return Err(e);
        }
        tracing::info!("[Feishu] ✅ Tenant Access Token 有效");

        // 2. 获取 WebSocket 端点 URL
        tracing::info!("[Feishu] 🌐 获取 WebSocket 端点...");
        let (ws_url, endpoint_data) = match self.get_ws_endpoint().await {
            Ok(url) => url,
            Err(e) => {
                self.set_error("获取 WebSocket 端点失败".to_string(), Some(e.to_string())).await;
                return Err(e);
            }
        };
        tracing::info!(
            "[Feishu] ✅ WebSocket URL: {}",
            &ws_url[..std::cmp::min(60, ws_url.len())]
        );

        // 3. 创建关闭通道
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);

        // 4. 创建 READY 通知通道
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<()>>();
        let ready_tx = Some(ready_tx);

        // 5. 从 WS URL 提取 service_id（Ping 帧需要）
        let service_id = Frame::extract_service_id(&ws_url);

        // 6. 获取服务端下发的 ping 间隔（秒），默认 90s
        let ping_interval = endpoint_data.get("data")
            .and_then(|d| d.get("ClientConfig"))
            .and_then(|cc| serde_json::from_value::<ClientConfig>(cc.clone()).ok())
            .map(|c| c.PingInterval)
            .unwrap_or(90);
        let ping_duration = tokio::time::Duration::from_secs(ping_interval);
        tracing::info!("[Feishu] Ping interval: {}s (from ClientConfig)", ping_interval);

        // 7. 克隆必要的数据
        let tx = message_tx.clone();
        let inner_state = self.inner_state.clone();
        let app_handle = self.app_handle.clone();

        // 8. 更新状态为鉴权中
        self.update_state(ConnectionState::Authenticating).await;

        // 9. 启动 WebSocket 任务
        tracing::info!("[Feishu] 🚀 启动 WebSocket 连接...");
        let task = tokio::spawn(async move {
            tracing::info!("[Feishu] 🔌 正在建立 WebSocket 连接...");
            let mut ready_tx = ready_tx;

            match connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    tracing::info!("[Feishu] ✅ WebSocket 连接成功");

                    let (mut write, mut read) = ws_stream.split();
                    let mut dedup = MessageDedup::default();
                    let mut last_ping = std::time::Instant::now();
                    let mut current_service_id = service_id;

                    // 发送初始 Ping 帧
                    let ping = Frame::new_ping(current_service_id);
                    if let Err(e) = write.send(WsMessage::Binary(ping.encode().into())).await {
                        tracing::error!("[Feishu] ❌ 初始 Ping 发送失败: {}", e);
                    } else {
                        tracing::debug!("[Feishu] Initial Ping sent (service_id={})", current_service_id);
                    }

                    // 连接成功，标记 Ready
                    {
                        let mut state = inner_state.write().await;
                        state.connection_state = ConnectionState::Ready;
                        state.error = None;
                        state.error_detail = None;
                    }

                    if let Some(ref app_handle) = app_handle {
                        let status = IntegrationStatus {
                            platform: Platform::Feishu,
                            connected: true,
                            connection_state: ConnectionState::Ready,
                            error: None,
                            error_detail: None,
                            last_activity: Some(chrono::Utc::now().timestamp_millis()),
                            stats: IntegrationStats::default(),
                            retry_count: 0,
                        };
                        let _ = app_handle.emit("integration:state_change", &status);
                    }

                    // 通知 connect 方法鉴权成功
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Ok(()));
                    }

                    loop {
                        tokio::select! {
                            // 检查关闭信号
                            result = &mut shutdown_rx => {
                                match result {
                                    Ok(()) => {
                                        tracing::info!("[Feishu] Shutdown signal received");
                                    }
                                    Err(_) => {
                                        tracing::warn!("[Feishu] Shutdown sender dropped unexpectedly, closing connection");
                                    }
                                }
                                let _ = write.send(WsMessage::Close(None)).await;

                                {
                                    let mut state = inner_state.write().await;
                                    state.connection_state = ConnectionState::Disconnected;
                                }
                                if let Some(ref app_handle) = app_handle {
                                    let status = IntegrationStatus {
                                        platform: Platform::Feishu,
                                        connected: false,
                                        connection_state: ConnectionState::Disconnected,
                                        error: None,
                                        error_detail: None,
                                        last_activity: None,
                                        stats: IntegrationStats::default(),
                                        retry_count: 0,
                                    };
                                    let _ = app_handle.emit("integration:state_change", &status);
                                }
                                break;
                            }

                            // 读取消息
                            msg = read.next() => {
                                match msg {
                                    Some(Ok(WsMessage::Binary(data))) => {
                                        // 飞书 pbbp2 协议：所有业务消息都是 Binary
                                        tracing::info!("[Feishu] 📦 Binary recv: {} bytes", data.len());

                                        match Frame::decode(&data) {
                                            Some(frame) => {
                                                let msg_type = frame.get_header("type").unwrap_or("?");
                                                tracing::info!(
                                                    "[Feishu] 📦 Frame decoded: method={}, type={}, seq={}, service={}",
                                                    frame.method, msg_type, frame.seq_id, frame.service
                                                );

                                                match frame.method {
                                                    0 => {
                                                        // 控制帧 (Pong)
                                                        tracing::info!("[Feishu] Pong received, service_id={}", frame.service);

                                                        // 更新 service_id
                                                        if frame.service != 0 {
                                                            current_service_id = frame.service;
                                                            tracing::info!(
                                                                "[Feishu] Updated service_id={}",
                                                                current_service_id
                                                            );
                                                        }

                                                        // 解析 ClientConfig
                                                        if !frame.payload.is_empty() {
                                                            if let Ok(config) = serde_json::from_slice::<ClientConfig>(&frame.payload) {
                                                                tracing::info!(
                                                                    "[Feishu] ClientConfig: ping={}s, reconnect={}s",
                                                                    config.PingInterval,
                                                                    config.ReconnectInterval
                                                                );
                                                            }
                                                        }
                                                    }
                                                    1 => {
                                                        // 数据帧 (Event/Card)
                                                        tracing::info!(
                                                            "[Feishu] 📩 Data frame: type={}, seq={}",
                                                            msg_type, frame.seq_id
                                                        );

                                                        if msg_type == MESSAGE_TYPE_EVENT {
                                                            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                                                                let event_type = payload.get("header")
                                                                    .and_then(|h| h.get("event_type"))
                                                                    .and_then(|v| v.as_str())
                                                                    .unwrap_or("");

                                                                tracing::info!("[Feishu] Event: {}", event_type);

                                                                if event_type == "im.message.receive_v1" {
                                                                    if let Some(msg) = Self::handle_message_event(
                                                                        &payload,
                                                                        &mut dedup,
                                                                    ) {
                                                                        tracing::info!(
                                                                            "[Feishu] ✅ 消息处理成功: id={}, conversation={}",
                                                                            msg.id, msg.conversation_id
                                                                        );
                                                                        if let Err(e) = tx.send(msg).await {
                                                                            tracing::error!("[Feishu] ❌ 发送消息到通道失败: {}", e);
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }

                                                        // 发送 ACK 响应帧
                                                        let ack = Frame::new_ack(&frame);
                                                        if let Err(e) = write.send(WsMessage::Binary(ack.encode().into())).await {
                                                            tracing::warn!("[Feishu] ACK 发送失败: {}", e);
                                                        }
                                                    }
                                                    _ => {
                                                        tracing::debug!(
                                                            "[Feishu] Unknown frame method: {}",
                                                            frame.method
                                                        );
                                                    }
                                                }
                                            }
                                            None => {
                                                tracing::warn!(
                                                    "[Feishu] 无法解码帧, len={}",
                                                    data.len()
                                                );
                                            }
                                        }
                                    }
                                    Some(Ok(WsMessage::Ping(data))) => {
                                        // WebSocket 协议级 Ping
                                        let _ = write.send(WsMessage::Pong(data)).await;
                                    }
                                    Some(Ok(WsMessage::Close(frame))) => {
                                        tracing::warn!("[Feishu] Connection closed: {:?}", frame);

                                        let error_detail = frame.as_ref().map(|f| f.reason.to_string());
                                        let close_reason = frame.as_ref()
                                            .map(|f| f.reason.to_string())
                                            .unwrap_or_else(|| "未知原因".to_string());

                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Failed;
                                            state.error = Some("连接关闭".to_string());
                                            state.error_detail = Some(close_reason);
                                        }

                                        if let Some(ref app_handle) = app_handle {
                                            let status = IntegrationStatus {
                                                platform: Platform::Feishu,
                                                connected: false,
                                                connection_state: ConnectionState::Failed,
                                                error: Some("连接关闭".to_string()),
                                                error_detail,
                                                last_activity: None,
                                                stats: IntegrationStats::default(),
                                                retry_count: 0,
                                            };
                                            let _ = app_handle.emit("integration:state_change", &status);
                                        }
                                        break;
                                    }
                                    Some(Ok(WsMessage::Text(text))) => {
                                        // 飞书通常不发送 Text 帧，但做兜底处理
                                        tracing::warn!("[Feishu] Unexpected Text frame: {}...", &text[..text.len().min(100)]);
                                    }
                                    Some(Err(e)) => {
                                        tracing::error!("[Feishu] WebSocket error: {}", e);

                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Failed;
                                            state.error = Some("WebSocket 错误".to_string());
                                            state.error_detail = Some(e.to_string());
                                        }
                                        break;
                                    }
                                    None => {
                                        tracing::warn!("[Feishu] WebSocket stream ended");
                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Disconnected;
                                        }
                                        break;
                                    }
                                    _ => {}
                                }
                            }

                            // 发送 protobuf Ping 帧
                            _ = tokio::time::sleep(ping_duration) => {
                                let now = std::time::Instant::now();
                                if now.duration_since(last_ping) >= ping_duration {
                                    let ping = Frame::new_ping(current_service_id);
                                    if let Err(e) = write.send(WsMessage::Binary(ping.encode().into())).await {
                                        tracing::error!("[Feishu] Ping 发送失败: {}", e);
                                        break;
                                    }
                                    last_ping = now;
                                    tracing::info!("[Feishu] 💓 Ping sent (service_id={})", current_service_id);
                                }
                            }
                        }
                    }

                    tracing::info!("[Feishu] WebSocket loop ended");
                }
                Err(e) => {
                    tracing::error!("[Feishu] Failed to connect WebSocket: {}", e);

                    {
                        let mut state = inner_state.write().await;
                        state.connection_state = ConnectionState::Failed;
                        state.error = Some("WebSocket 连接失败".to_string());
                        state.error_detail = Some(e.to_string());
                    }

                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Err(AppError::NetworkError(e.to_string())));
                    }
                }
            }
        });

        self.ws_task = Some(task);
        self.message_tx = Some(message_tx);

        // 等待 READY 事件或超时
        tracing::info!("[Feishu] ⏳ 等待鉴权完成...");
        let timeout_duration = tokio::time::Duration::from_secs(CONNECT_TIMEOUT_SECS);

        match tokio::time::timeout(timeout_duration, ready_rx).await {
            Ok(Ok(Ok(()))) => {
                tracing::info!("[Feishu] ✅ 连接成功，已就绪");
                Ok(())
            }
            Ok(Ok(Err(e))) => {
                tracing::error!("[Feishu] ❌ 鉴权失败: {}", e);
                Err(e)
            }
            Ok(Err(_)) => {
                tracing::error!("[Feishu] ❌ READY 通道关闭");
                self.set_error("鉴权超时".to_string(), Some("READY 通道意外关闭".to_string())).await;
                Err(AppError::AuthError("鉴权过程中发生错误".to_string()))
            }
            Err(_) => {
                tracing::error!("[Feishu] ❌ 等待鉴权超时（{}秒）", CONNECT_TIMEOUT_SECS);
                self.set_error("连接超时".to_string(), Some(format!("等待 {} 秒后超时", CONNECT_TIMEOUT_SECS))).await;
                Err(AppError::AuthError(format!("连接超时（{}秒）", CONNECT_TIMEOUT_SECS)))
            }
        }
    }

    async fn disconnect(&mut self) -> Result<()> {
        tracing::info!("[Feishu] 🔌 开始断开连接...");

        self.update_state(ConnectionState::Disconnected).await;

        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            tracing::debug!("[Feishu] 关闭信号已发送");
        }

        // 2. 等待任务结束
        if let Some(task) = self.ws_task.take() {
            let result = tokio::time::timeout(
                tokio::time::Duration::from_secs(3),
                task,
            ).await;

            match result {
                Ok(Ok(())) => {
                    tracing::debug!("[Feishu] WebSocket 任务已正常结束");
                }
                Ok(Err(e)) => {
                    tracing::debug!("[Feishu] WebSocket 任务已结束: {:?}", e);
                }
                Err(_) => {
                    tracing::warn!("[Feishu] WebSocket 任务超时，已强制终止");
                }
            }
        }

        // 3. 清理状态
        self.message_tx = None;
        self.dedup.clear();

        // 发送最终状态
        if let Some(ref app_handle) = self.app_handle {
            let status = IntegrationStatus {
                platform: Platform::Feishu,
                connected: false,
                connection_state: ConnectionState::Disconnected,
                error: None,
                error_detail: None,
                last_activity: None,
                stats: IntegrationStats::default(),
                retry_count: 0,
            };
            let _ = app_handle.emit("integration:state_change", &status);
        }

        tracing::info!("[Feishu] ✅ 已断开连接");
        Ok(())
    }

    async fn download_media(
        &mut self,
        msg: &IntegrationMessage,
        save_dir: &std::path::Path,
    ) -> Vec<MediaDownload> {
        let message_id = match &msg.platform_message_id {
            Some(id) if !id.is_empty() => id.as_str(),
            _ => {
                tracing::warn!("[Feishu] ⚠️ 缺少 message_id，无法下载媒体");
                return vec![MediaDownload {
                    label: "媒体文件".to_string(),
                    local_path: None,
                }];
            }
        };

        // 确保 token 有效
        if let Err(e) = self.ensure_valid_token().await {
            tracing::error!("[Feishu] ❌ Token 刷新失败: {}", e);
            return vec![MediaDownload {
                label: "媒体文件".to_string(),
                local_path: None,
            }];
        }

        let media_items = Self::collect_media_items(&msg.content);
        let mut results = Vec::new();

        for (key, type_param, fallback_name) in media_items {
            let label = if fallback_name.starts_with("image") || fallback_name.starts_with("audio") {
                match type_param.as_str() {
                    "image" => "图片".to_string(),
                    _ => "语音".to_string(),
                }
            } else {
                format!("文件「{}」", fallback_name)
            };

            match self.download_resource(message_id, &key, &type_param).await {
                Ok(bytes) => {
                    let timestamp = chrono::Utc::now().timestamp();
                    let safe_name = fallback_name.replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_', "_");
                    let file_name = format!("{}_{}", timestamp, safe_name);
                    let file_path = save_dir.join(&file_name);

                    match tokio::fs::write(&file_path, &bytes).await {
                        Ok(_) => {
                            tracing::info!("[Feishu] ✅ 媒体已保存: {}", file_path.display());
                            results.push(MediaDownload {
                                label,
                                local_path: Some(file_path.to_string_lossy().to_string()),
                            });
                        }
                        Err(e) => {
                            tracing::error!("[Feishu] ❌ 写入文件失败: {}", e);
                            results.push(MediaDownload { label, local_path: None });
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[Feishu] ❌ 下载资源失败: {}", e);
                    results.push(MediaDownload { label, local_path: None });
                }
            }
        }

        results
    }

    async fn send(&mut self, target: SendTarget, content: MessageContent) -> Result<()> {
        self.ensure_valid_token().await?;

        let text = content.as_text().ok_or_else(|| {
            AppError::ValidationError("目前只支持发送文本消息".to_string())
        })?;

        match target {
            SendTarget::Conversation(ref conv_id) => {
                // 从 conversation_id 提取 chat_id
                let chat_id = if conv_id.starts_with("feishu_") {
                    conv_id.strip_prefix("feishu_").unwrap()
                } else {
                    conv_id.as_str()
                };

                let content_json = serde_json::json!({"text": text}).to_string();
                self.send_feishu_message(chat_id, "text", &content_json).await
            }
            SendTarget::Channel(ref chat_id) => {
                let content_json = serde_json::json!({"text": text}).to_string();
                self.send_feishu_message(chat_id, "text", &content_json).await
            }
            SendTarget::User(ref _user_id) => {
                Err(AppError::ValidationError("飞书暂不支持按用户 ID 直接发送，请使用 chat_id".to_string()))
            }
            SendTarget::Webhook(_) => {
                Err(AppError::ValidationError("飞书不支持 Webhook 发送".to_string()))
            }
        }
    }

    fn status(&self) -> IntegrationStatus {
        match self.inner_state.try_read() {
            Ok(state) => IntegrationStatus {
                platform: Platform::Feishu,
                connected: state.connection_state == ConnectionState::Ready,
                connection_state: state.connection_state,
                error: state.error.clone(),
                error_detail: state.error_detail.clone(),
                last_activity: None,
                stats: IntegrationStats::default(),
                retry_count: state.retry_count,
            },
            Err(_) => IntegrationStatus {
                platform: Platform::Feishu,
                connected: false,
                connection_state: ConnectionState::Disconnected,
                error: Some("无法读取状态".to_string()),
                error_detail: None,
                last_activity: None,
                stats: IntegrationStats::default(),
                retry_count: 0,
            },
        }
    }
}
