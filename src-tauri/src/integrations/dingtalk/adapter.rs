/*! DingTalk (钉钉) 适配器 — Stream Mode 实现
 *
 * 实现 PlatformIntegration Trait，使用钉钉 Stream Mode（流式推送）进行连接。
 *
 * 通信流程:
 *   Step 1: POST https://api.dingtalk.com/v1.0/gateway/connections/open
 *           → 获取 { endpoint, ticket }
 *   Step 2: 连接 WebSocket {endpoint}?ticket={ticket}
 *           → 接收 SYSTEM / EVENT / CALLBACK 消息
 *
 * Stream Mode 消息协议:
 *   - SYSTEM: { "type":"SYSTEM", "headers":{"topic":"CONNECTED|REGISTERED|KEEPALIVE|ping"} }
 *   - EVENT:  { "type":"EVENT",  "headers":{"topic":"/v1.0/im/bot/messages/get","messageId":"..."},
 *               "data":"{\"senderNick\":\"...\",\"text\":{\"content\":\"...\"},...}" }
 *               → 需要回 ACK: { "code":200, "headers":{"messageId":"..."}, "data":"{\"status\":\"SUCCESS\"}" }
 *   - CALLBACK: { "type":"CALLBACK", "headers":{"topic":"/v1.0/im/bot/messages/get","messageId":"..."},
 *                 "data":"..." }
 *
 * 发消息 (企业机器人 Webhook):
 *   - POST <Webhook URL> {"msgtype":"text","text":{"content":"..."},"at":{...}}
 *
 * 参考:
 *   - dingtalk-stream SDK (npm): https://www.npmjs.com/package/dingtalk-stream
 *   - 钉钉 Stream Mode 文档: https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/overview
 */

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
#[cfg(feature = "tauri-app")]
use tauri::Emitter;
use tokio::sync::{mpsc::Sender, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::error::{AppError, Result};
use crate::models::config::DingTalkRuntimeConfig;
use super::super::common::MessageDedup;
use super::super::traits::PlatformIntegration;
use super::super::types::*;

// ─── 常量 ──────────────────────────────────────────────────

/// 钉钉 Stream Mode 网关 URL - 用于获取 WebSocket 连接点
const GATEWAY_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";

/// 机器人消息 Topic
const TOPIC_ROBOT: &str = "/v1.0/im/bot/messages/get";

/// 连接超时时间（秒）
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// 内部共享状态
#[derive(Debug, Default)]
struct InnerState {
    connection_state: ConnectionState,
    error: Option<String>,
    error_detail: Option<String>,
    retry_count: u32,
    /// 当前 WebSocket endpoint（重连时复用）
    endpoint: Option<String>,
    ticket: Option<String>,
    /// 会话 Webhook URL 映射 (conversationId → sessionWebhook)
    session_webhooks: HashMap<String, String>,
}

/// DingTalk Stream Mode 适配器
pub struct DingTalkAdapter {
    config: DingTalkRuntimeConfig,
    /// 企业机器人 Webhook URL（用于发送回复）
    webhook: Option<String>,
    /// 消息发送通道
    message_tx: Option<Sender<IntegrationMessage>>,
    /// 内部状态
    inner_state: Arc<RwLock<InnerState>>,
    /// 消息去重器
    dedup: MessageDedup,
    /// WebSocket 任务句柄
    ws_task: Option<tokio::task::JoinHandle<()>>,
    /// 关闭信号发送端
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    #[cfg(feature = "tauri-app")]
    app_handle: Option<tauri::AppHandle>,
}

impl DingTalkAdapter {
    pub fn new(config: DingTalkRuntimeConfig) -> Self {
        Self {
            config,
            webhook: None,
            message_tx: None,
            inner_state: Arc::new(RwLock::new(InnerState::default())),
            dedup: MessageDedup::default(),
            ws_task: None,
            shutdown_tx: None,
            #[cfg(feature = "tauri-app")]
            app_handle: None,
        }
    }

    /// 设置 Webhook URL（用于发消息回复）
    pub fn with_webhook(mut self, webhook: impl Into<String>) -> Self {
        self.webhook = Some(webhook.into());
        self
    }

    #[cfg(feature = "tauri-app")]
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
        #[cfg(feature = "tauri-app")]
        if let Some(ref app_handle) = self.app_handle {
            let status = self.status();
            let _ = app_handle.emit("integration:state_change", &status);
        }
    }

    async fn set_error(&self, error: String, detail: Option<String>) {
        let mut state = self.inner_state.write().await;
        state.connection_state = ConnectionState::Failed;
        state.error = Some(error);
        state.error_detail = detail;
    }

    /// 步骤 1: 通过 DingTalk Gateway API 获取 WebSocket 连接点
    async fn get_endpoint(&self) -> Result<(String, String)> {
        tracing::info!("[DingTalk] 🔐 请求网关连接点...");

        let client = reqwest::Client::new();
        let response = client
            .post(GATEWAY_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "clientId": self.config.app_id,
                "clientSecret": self.config.app_secret,
                "subscriptions": [
                    { "type": "EVENT", "topic": "*" },
                    { "type": "CALLBACK", "topic": TOPIC_ROBOT }
                ]
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(format!("网关请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!(
                "网关返回错误: HTTP {}, body={}", status, body
            )));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(format!("解析网关响应失败: {}", e)))?;

        let endpoint = data
            .get("endpoint")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::ApiError("网关响应缺少 endpoint".to_string()))?
            .to_string();

        let ticket = data
            .get("ticket")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::ApiError("网关响应缺少 ticket".to_string()))?
            .to_string();

        tracing::info!(
            "[DingTalk] ✅ 获取连接点成功: endpoint={}, ticket={}...",
            endpoint,
            &ticket[..ticket.len().min(8)]
        );

        // 缓存到内部状态，重连时复用
        {
            let mut state = self.inner_state.write().await;
            state.endpoint = Some(endpoint.clone());
            state.ticket = Some(ticket.clone());
        }

        Ok((endpoint, ticket))
    }

    /// 构造 WebSocket URL（优先使用缓存的 endpoint）
    fn build_ws_url(endpoint: &str, ticket: &str) -> String {
        // endpoint 可能已包含端口，如 wss://wss-open-connection.dingtalk.com:443/connect
        format!("{}?ticket={}", endpoint, ticket)
    }

    /// 发送 ACK 响应给钉钉 Stream 服务
    async fn send_ack(write: &mut (impl futures_util::Sink<WsMessage> + Unpin), message_id: &str) {
        let data_str = serde_json::to_string(&serde_json::json!({
            "status": "SUCCESS"
        }))
        .unwrap_or_else(|_| "{\"status\":\"SUCCESS\"}".to_string());

        let ack = serde_json::json!({
            "code": 200,
            "headers": {
                "contentType": "application/json",
                "messageId": message_id
            },
            "message": "OK",
            "data": data_str
        });
        if let Err(_e) = write
            .send(WsMessage::Text(ack.to_string()))
            .await
        {
            tracing::warn!("[DingTalk] ACK 发送失败");
        }
    }

    /// 发送 ping 响应
    async fn send_pong(write: &mut (impl futures_util::Sink<WsMessage> + Unpin), headers: &serde_json::Value) {
        let pong = serde_json::json!({
            "code": 200,
            "headers": headers,
            "message": "OK",
            "data": null
        });
        if let Err(_e) = write
            .send(WsMessage::Text(pong.to_string()))
            .await
        {
            tracing::warn!("[DingTalk] PONG 发送失败");
        }
    }

    /// 处理 EVENT 消息（机器人消息）
    fn handle_event(
        payload: &serde_json::Value,
        dedup: &mut MessageDedup,
    ) -> Option<(IntegrationMessage, Option<String>)> {
        // Stream Mode EVENT 消息格式:
        // { "type":"EVENT", "headers":{"messageId":"...","topic":"/v1.0/im/bot/messages/get"},
        //   "data":"{\"senderNick\":\"...\",\"text\":{\"content\":\"...\"},...}" }
        let raw_data = payload.get("data").and_then(|v| v.as_str())?;
        let data: serde_json::Value = serde_json::from_str(raw_data).ok()?;

        // 去重
        let message_id = payload
            .get("headers")
            .and_then(|h| h.get("messageId"))
            .and_then(|v| v.as_str());
        let dedup_id = message_id.unwrap_or("");
        if dedup.is_processed(dedup_id) {
            tracing::debug!("[DingTalk] ⚠️ 重复消息被忽略: {}", dedup_id);
            return None;
        }

        // 解析消息内容
        let conversation_id = data
            .get("conversationId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let sender_id = data
            .get("senderId")
            .or_else(|| data.get("senderStaffId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let sender_name = data
            .get("senderNick")
            .or_else(|| data.get("senderName"))
            .and_then(|v| v.as_str())
            .unwrap_or(&sender_id)
            .to_string();

        // 钉钉消息格式: { "text":{"content":"hello"},"msgtype":"text" }
        let msgtype = data.get("msgtype").and_then(|v| v.as_str()).unwrap_or("text");
        let content = match msgtype {
            "text" => {
                let text = data
                    .get("text")
                    .and_then(|t| t.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let cleaned = Self::strip_at_mention(text);
                MessageContent::text(cleaned)
            }
            "markdown" => {
                let text = data
                    .get("markdown")
                    .and_then(|t| t.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                MessageContent::text(text)
            }
            _ => MessageContent::text(format!("[钉钉 {} 消息]", msgtype)),
        };

        // 会话标识
        let conv_type = data.get("conversationType").and_then(|v| v.as_u64()).unwrap_or(0);
        let full_conversation_id = match conv_type {
            1 => format!("dingtalk_dm_{}", conversation_id),
            2 => format!("dingtalk_group_{}", conversation_id),
            _ => format!("dingtalk_{}", conversation_id),
        };

        // 会话 Webhook URL（用于回复）
        let session_webhook = data
            .get("sessionWebhook")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        tracing::info!(
            "[DingTalk] 📝 消息: sender={}, conv={}, type={}, webhook={}",
            sender_name, full_conversation_id, msgtype, session_webhook.as_deref().unwrap_or("无")
        );

        Some((
            IntegrationMessage::new(
                Platform::DingTalk,
                full_conversation_id,
                sender_id,
                sender_name,
                content,
            )
            .with_platform_message_id(dedup_id.to_string())
            .with_raw(data),
            session_webhook,
        ))
    }

    /// 去掉 @机器人 的提及标记
    fn strip_at_mention(text: &str) -> String {
        let re = regex::Regex::new(r"\n?@[^\n\s]+\s*").unwrap();
        re.replace(text, "").trim().to_string()
    }

    /// 发送 Webhook 消息到钉钉群
    async fn send_via_webhook(&self, webhook: &str, text: &str) -> Result<()> {
        let client = reqwest::Client::new();

        let response = client
            .post(webhook)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "msgtype": "text",
                "text": { "content": text },
                "at": {
                    "atMobiles": [],
                    "atUserIds": [],
                    "atAll": false
                }
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!(
                "Webhook 发送失败: HTTP {}, body={}", status, body
            )));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;
        let errcode = data.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
        if errcode != 0 {
            let errmsg = data.get("errmsg").and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(AppError::ApiError(format!(
                "Webhook 发送失败: errcode={}, errmsg={}", errcode, errmsg
            )));
        }

        tracing::debug!("[DingTalk] ✅ Webhook 消息已发送");
        Ok(())
    }
}

#[async_trait]
impl PlatformIntegration for DingTalkAdapter {
    fn platform(&self) -> Platform {
        Platform::DingTalk
    }

    async fn connect(&mut self, message_tx: Sender<IntegrationMessage>) -> Result<()> {
        tracing::info!("[DingTalk] 🔌 开始连接 (Stream Mode)...");

        if self.ws_task.is_some() {
            tracing::warn!("[DingTalk] ⚠️ 已有连接，先断开旧连接再重连");
            let _ = self.disconnect().await;
        }

        {
            let mut state = self.inner_state.write().await;
            state.connection_state = ConnectionState::Connecting;
            state.error = None;
            state.error_detail = None;
        }

        // 1. 通过 Gateway API 获取 WebSocket 连接点
        let (endpoint, ticket) = self.get_endpoint().await?;
        let ws_url = Self::build_ws_url(&endpoint, &ticket);
        tracing::info!("[DingTalk] ✅ WS URL: {}", ws_url);

        // 2. 创建关闭通道
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);

        // 3. 创建 READY 通知通道
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<()>>();
        let ready_tx = Some(ready_tx);

        // 4. 克隆数据
        let tx = message_tx.clone();
        let inner_state = self.inner_state.clone();
        #[cfg(feature = "tauri-app")]
        let app_handle = self.app_handle.clone();

        self.update_state(ConnectionState::Authenticating).await;

        // 5. 启动 WebSocket 任务
        tracing::info!("[DingTalk] 🚀 启动 WebSocket 连接...");
        let task = tokio::spawn(async move {
            tracing::info!("[DingTalk] 🔌 正在建立 WebSocket 连接...");
            let mut ready_tx = ready_tx;

            match connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    tracing::info!("[DingTalk] ✅ WebSocket 连接成功");
                    let (mut write, mut read) = ws_stream.split();

                    let mut dedup = MessageDedup::default();

                    // 立即标记为 Ready（不等待服务器消息）
                    {
                        let mut state = inner_state.write().await;
                        state.connection_state = ConnectionState::Ready;
                        state.error = None;
                        state.error_detail = None;
                    }
                    #[cfg(feature = "tauri-app")]
                    if let Some(ref ah) = app_handle {
                        let status = IntegrationStatus {
                            platform: Platform::DingTalk,
                            connected: true,
                            connection_state: ConnectionState::Ready,
                            error: None,
                            error_detail: None,
                            last_activity: Some(Utc::now().timestamp_millis()),
                            stats: IntegrationStats::default(),
                            retry_count: 0,
                        };
                        let _ = ah.emit("integration:state_change", &status);
                    }

                    // 通知外部连接成功
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Ok(()));
                    }

                    // 主消息循环
                    loop {
                        tokio::select! {
                            result = &mut shutdown_rx => {
                                match result {
                                    Ok(()) => tracing::info!("[DingTalk] Shutdown signal received"),
                                    Err(_) => tracing::warn!("[DingTalk] Shutdown sender dropped"),
                                }
                                let _ = write.send(WsMessage::Close(None)).await;
                                {
                                    let mut state = inner_state.write().await;
                                    state.connection_state = ConnectionState::Disconnected;
                                }
                                #[cfg(feature = "tauri-app")]
                                if let Some(ref ah) = app_handle {
                                    let status = IntegrationStatus {
                                        platform: Platform::DingTalk,
                                        connected: false,
                                        connection_state: ConnectionState::Disconnected,
                                        error: None,
                                        error_detail: None,
                                        last_activity: None,
                                        stats: IntegrationStats::default(),
                                        retry_count: 0,
                                    };
                                    let _ = ah.emit("integration:state_change", &status);
                                }
                                break;
                            }

                            msg = read.next() => {
                                // 辅助函数：将 WS Message 转为文本
                                let payload_text = match msg {
                                    Some(Ok(WsMessage::Text(payload))) => Some(payload),
                                    Some(Ok(WsMessage::Binary(data))) => String::from_utf8(data).ok(),
                                    Some(Ok(WsMessage::Ping(data))) => {
                                        let _ = write.send(WsMessage::Pong(data)).await;
                                        continue;
                                    }
                                    Some(Ok(WsMessage::Pong(_))) => continue,
                                    Some(Ok(WsMessage::Frame(_))) => continue,
                                    Some(Ok(WsMessage::Close(frame))) => {
                                        tracing::warn!("[DingTalk] Connection closed: {:?}", frame);
                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Failed;
                                            state.error = Some("连接关闭".to_string());
                                            state.error_detail = frame.map(|f| f.reason.to_string());
                                        }
                                        break;
                                    }
                                    Some(Err(e)) => {
                                        tracing::error!("[DingTalk] WebSocket error: {}", e);
                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Failed;
                                            state.error = Some("WebSocket 错误".to_string());
                                            state.error_detail = Some(e.to_string());
                                        }
                                        break;
                                    }
                                    None => {
                                        tracing::warn!("[DingTalk] WebSocket stream ended");
                                        {
                                            let mut state = inner_state.write().await;
                                            state.connection_state = ConnectionState::Disconnected;
                                        }
                                        break;
                                    }
                                };

                                let Some(payload) = payload_text else { continue; };

                                let parsed: serde_json::Value =
                                    match serde_json::from_str(&payload) {
                                        Ok(v) => v,
                                        Err(_) => {
                                            tracing::warn!("[DingTalk] 无法解析消息: {}", &payload[..payload.len().min(200)]);
                                            continue;
                                        }
                                    };

                                let msg_type = parsed
                                    .get("type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();

                                tracing::debug!("[DingTalk] 📩 收到消息: type={}", msg_type);

                                match msg_type.as_str() {
                                    "SYSTEM" => {
                                        let topic = parsed
                                            .get("headers")
                                            .and_then(|h| h.get("topic"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");

                                        match topic {
                                            "KEEPALIVE" => {
                                                // 心跳，无需回复
                                            }
                                            "ping" => {
                                                let _ = Self::send_pong(
                                                    &mut write,
                                                    parsed.get("headers").unwrap_or(&serde_json::json!({})),
                                                ).await;
                                            }
                                            "disconnect" => {
                                                tracing::warn!("[DingTalk] 服务端要求断开");
                                                break;
                                            }
                                            _ => {
                                                tracing::debug!("[DingTalk] SYSTEM 消息: topic={}", topic);
                                            }
                                        }
                                    }
                                    "EVENT" => {
                                        // 回 ACK
                                        let message_id = parsed
                                            .get("headers")
                                            .and_then(|h| h.get("messageId"))
                                            .and_then(|v| v.as_str());

                                        if let Some(mid) = message_id {
                                            let _ = Self::send_ack(&mut write, mid).await;
                                        }

                                        // 处理消息
                                        if let Some((im, webhook)) = Self::handle_event(&parsed, &mut dedup) {
                                            // 存储会话 Webhook 用于回复
                                            if let Some(wh) = webhook {
                                                let conv_id = im.conversation_id.clone();
                                                inner_state.write().await.session_webhooks.insert(conv_id, wh);
                                            }
                                            if let Err(e) = tx.send(im).await {
                                                tracing::error!("[DingTalk] ❌ 发送消息到通道失败: {}", e);
                                            }
                                        }
                                    }
                                    "CALLBACK" => {
                                        let topic = parsed
                                            .get("headers")
                                            .and_then(|h| h.get("topic"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");

                                        tracing::debug!("[DingTalk] CALLBACK 消息: topic={}", topic);

                                        if topic == TOPIC_ROBOT {
                                            // 回 ACK
                                            let message_id = parsed
                                                .get("headers")
                                                .and_then(|h| h.get("messageId"))
                                                .and_then(|v| v.as_str());

                                            if let Some(mid) = message_id {
                                                let _ = Self::send_ack(&mut write, mid).await;
                                            }

                                            // 处理消息
                                            if let Some((im, webhook)) = Self::handle_event(&parsed, &mut dedup) {
                                                // 存储会话 Webhook 用于回复
                                                if let Some(wh) = webhook {
                                                    let conv_id = im.conversation_id.clone();
                                                    inner_state.write().await.session_webhooks.insert(conv_id, wh);
                                                }
                                                if let Err(e) = tx.send(im).await {
                                                    tracing::error!("[DingTalk] ❌ 发送消息到通道失败: {}", e);
                                                }
                                            }
                                        }
                                    }
                                    _ => {
                                        tracing::debug!("[DingTalk] 未知消息类型: {}", msg_type);
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[DingTalk] Failed to connect WebSocket: {}", e);
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

        // 等待连接就绪或超时
        tracing::info!("[DingTalk] ⏳ 等待连接就绪...");
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
            ready_rx,
        )
        .await
        {
            Ok(Ok(Ok(()))) => {
                tracing::info!("[DingTalk] ✅ 连接成功，已就绪");
                Ok(())
            }
            Ok(Ok(Err(e))) => {
                tracing::error!("[DingTalk] ❌ 连接失败: {}", e);
                Err(e)
            }
            Ok(Err(_)) => {
                self.set_error("连接超时".to_string(), Some("READY 通道意外关闭".to_string()))
                    .await;
                Err(AppError::AuthError("连接验证过程中发生错误".to_string()))
            }
            Err(_) => {
                self.set_error("连接超时".to_string(), Some(format!("等待 {} 秒后超时", CONNECT_TIMEOUT_SECS)))
                    .await;
                Err(AppError::AuthError(format!("连接超时（{}秒）", CONNECT_TIMEOUT_SECS)))
            }
        }
    }

    async fn disconnect(&mut self) -> Result<()> {
        tracing::info!("[DingTalk] 🔌 开始断开连接...");
        self.update_state(ConnectionState::Disconnected).await;

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(task) = self.ws_task.take() {
            let _ = tokio::time::timeout(tokio::time::Duration::from_secs(3), task).await;
        }

        self.message_tx = None;
        self.dedup.clear();

        #[cfg(feature = "tauri-app")]
        if let Some(ref app_handle) = self.app_handle {
            let status = IntegrationStatus {
                platform: Platform::DingTalk,
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

        tracing::info!("[DingTalk] ✅ 已断开连接");
        Ok(())
    }

    async fn send(&mut self, target: SendTarget, content: MessageContent) -> Result<()> {
        let text = content.as_text().ok_or_else(|| {
            AppError::ValidationError("钉钉目前只支持发送文本消息".to_string())
        })?;

        match target {
            SendTarget::Webhook(ref url) => {
                if !url.is_empty() {
                    return self.send_via_webhook(url, text).await;
                }
                Err(AppError::ValidationError("Webhook URL 为空".to_string()))
            }
            SendTarget::Conversation(ref conv_id) => {
                // 优先使用会话中的 sessionWebhook（Stream Mode）
                let webhook_url = self.inner_state.try_read()
                    .ok()
                    .and_then(|state| state.session_webhooks.get(conv_id).cloned())
                    .or_else(|| self.webhook.clone());

                if let Some(ref url) = webhook_url {
                    if !url.is_empty() {
                        return self.send_via_webhook(url, text).await;
                    }
                }
                Err(AppError::ValidationError(
                    "未配置 Webhook URL，请在钉钉配置中填写 Webhook 地址以启用回复功能"
                        .to_string(),
                ))
            }
            SendTarget::Channel(_) | SendTarget::User(_) => {
                if let Some(ref webhook) = self.webhook {
                    self.send_via_webhook(webhook, text).await
                } else {
                    Err(AppError::ValidationError(
                        "未配置 Webhook URL，请在钉钉配置中填写 Webhook 地址以启用回复功能"
                            .to_string(),
                    ))
                }
            }
        }
    }

    fn status(&self) -> IntegrationStatus {
        match self.inner_state.try_read() {
            Ok(state) => IntegrationStatus {
                platform: Platform::DingTalk,
                connected: state.connection_state == ConnectionState::Ready,
                connection_state: state.connection_state,
                error: state.error.clone(),
                error_detail: state.error_detail.clone(),
                last_activity: None,
                stats: IntegrationStats::default(),
                retry_count: state.retry_count,
            },
            Err(_) => IntegrationStatus {
                platform: Platform::DingTalk,
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