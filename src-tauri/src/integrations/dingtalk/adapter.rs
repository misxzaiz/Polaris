/*! DingTalk (钉钉) 适配器
 *
 * 实现 PlatformIntegration Trait，提供钉钉机器人的连接、消息收发功能。
 *
 * 通信方式:
 *   - 收消息: WebSocket 长连接 (open-dingtalk.com)，纯 JSON 帧
 *   - 发消息: 企业机器人 Webhook (HTTP POST)
 *
 * 钉钉长连接协议:
 *   - 连接 URL: wss://wss-open.dingtalk.com/ws/v2?appkey=<AppKey>&token=<hmac_sha256(base64(timestamp), AppSecret)>
 *   - 连接验证: 服务端回复 {"type":"connection_result","success":true/false,"error":...}
 *   - 收消息: {"type":"message","conversationType":1|2,"conversationId":"...","senderStaffId":"...",
 *              "senderUserId":"...","senderCorpId":"...","isInAtList":true,
 *              "msgId":"...","robotMsgId":"...","msg":{"msgtype":"text","content":"..."}}
 *   - 回 ACK: {"msgId":"...","ackCommand":"message_ack"}
 *
 * 发消息 (企业机器人 Webhook):
 *   - POST <Webhook URL> {"msgtype":"text","text":{"content":"..."},"at":{"atMobiles":[],"atUserIds":[],"isAtAll":false}}
 *
 * 安全说明:
 *   - 在「钉钉开放平台 → 应用 → 消息推送」中启用「WebSocket 推送」
 *   - 同时在机器人配置中启用「企业内 Webhook」并获取 Webhook URL（用于回复）
 *   - 或在配置中指定机器人所在群的 Webhook URL
 */

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use hmac::Mac;
#[cfg(feature = "tauri-app")]
use tauri::Emitter;
use tokio::sync::{mpsc::Sender, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::error::{AppError, Result};
use crate::models::config::DingTalkRuntimeConfig;
use super::super::common::MessageDedup;
use super::super::traits::PlatformIntegration;
use super::super::types::*;

/// DingTalk WebSocket 长连接 URL 前缀
const DINGTALK_WS_BASE: &str = "wss://wss-open.dingtalk.com/ws/v2";

/// 连接超时时间（秒）
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// 内部共享状态
#[derive(Debug, Default)]
struct InnerState {
    connection_state: ConnectionState,
    error: Option<String>,
    error_detail: Option<String>,
    retry_count: u32,
}

/// 钉钉 WS 消息类型
#[derive(Debug)]
enum WsMsgType {
    ConnectionResult { success: bool, error: Option<String> },
    Message { payload: serde_json::Value },
    Heartbeat { msg_id: u64 },
    Unknown,
}

/// DingTalk 适配器
pub struct DingTalkAdapter {
    config: DingTalkRuntimeConfig,
    /// 企业机器人 Webhook URL（用于发送回复）
    webhook: Option<String>,
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

    /// 构造 WebSocket 连接 URL
    ///
    /// 钉钉长连接认证 token 计算方式:
    ///   1. 取当前 Unix 时间戳 (秒) 的字符串
    ///   2. Base64 编码时间戳字符串
    ///   3. HMAC-SHA256(AppSecret, step2)
    ///   4. Base64 编码 HMAC 结果 → token
    fn build_ws_url(&self) -> String {
        // 1. 取当前 Unix 时间戳 (秒) 的字符串
        let timestamp = Utc::now().timestamp_millis() / 1000;
        let ts_str = format!("{}", timestamp);

        // 2. Base64 编码时间戳
        let ts_b64 = base64::engine::general_purpose::STANDARD
            .encode(ts_str.as_bytes());

        // 3. HMAC-SHA256(AppSecret, ts_b64)
        let mut mac = <hmac::Hmac<sha2::Sha256>>::new_from_slice(
            self.config.app_secret.as_bytes(),
        )
        .expect("HMAC key length should be valid");
        mac.update(ts_b64.as_bytes());
        let signature = mac.finalize().into_bytes().to_vec();

        // 4. Base64 编码 HMAC 结果 → token
        let sig_b64 = base64::engine::general_purpose::STANDARD
            .encode(&signature);

        format!(
            "{}?appkey={}&token={}",
            DINGTALK_WS_BASE, self.config.app_id, sig_b64
        )
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

    /// 解析 WS JSON 消息
    fn parse_ws_message(payload: &str) -> Option<WsMsgType> {
        let parsed: serde_json::Value = serde_json::from_str(payload).ok()?;
        let msg_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match msg_type {
            "connection_result" => {
                let success = parsed.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                let error = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                Some(WsMsgType::ConnectionResult { success, error })
            }
            "message" => Some(WsMsgType::Message {
                payload: parsed.clone(),
            }),
            "heartbeat" => {
                let msg_id = parsed.get("msgId").and_then(|v| v.as_u64()).unwrap_or(0);
                Some(WsMsgType::Heartbeat { msg_id })
            }
            _ => Some(WsMsgType::Unknown),
        }
    }

    /// 处理消息事件
    fn handle_message_event(
        payload: &serde_json::Value,
        dedup: &mut MessageDedup,
    ) -> Option<IntegrationMessage> {
        // 去重 ID: robotMsgId 或 msgId
        let dedup_id = payload
            .get("robotMsgId")
            .or_else(|| payload.get("msgId"))
            .and_then(|v| v.as_str());
        let Some(dedup_id) = dedup_id else { return None };

        if dedup.is_processed(dedup_id) {
            tracing::debug!("[DingTalk] ⚠️ 重复消息被忽略: {}", dedup_id);
            return None;
        }

        // 会话 ID: 基于 conversationType + robotId + conversationId
        let conv_type = payload
            .get("conversationType")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let robot_id = payload
            .get("robotId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let chat_id = payload
            .get("conversationId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 钉钉消息格式: {"msgtype":"text","text":{"content":"hello"},"at":{...}}
        let empty_json = serde_json::json!({});
        let msg = payload.get("msg").unwrap_or(&empty_json);
        let msgtype = msg.get("msgtype").and_then(|v| v.as_str()).unwrap_or("text");

        // 会话标识 (含机器人 ID 以便按机器人回复)
        let conversation_id = match conv_type {
            1 => format!("dingtalk_dm_{}", chat_id), // 单聊
            2 => format!("dingtalk_group_{}", chat_id), // 群聊
            _ => format!("dingtalk_{}", chat_id),
        };

        // 发送者
        let sender_id = payload
            .get("senderStaffId")
            .or_else(|| payload.get("senderUserId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let sender_name = payload
            .get("senderNick")
            .or_else(|| payload.get("senderStaffName"))
            .and_then(|v| v.as_str())
            .unwrap_or(&sender_id)
            .to_string();

        // 解析消息内容
        let content = match msgtype {
            "text" => {
                let text = msg
                    .get("text")
                    .and_then(|t| t.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // 去掉 @机器人 标记
                let cleaned = Self::strip_at_mention(text);
                MessageContent::text(cleaned)
            }
            "markdown" => {
                let text = msg
                    .get("markdown")
                    .and_then(|t| t.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                MessageContent::text(text)
            }
            "link" => {
                let title = msg
                    .get("link")
                    .and_then(|t| t.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let text = msg
                    .get("link")
                    .and_then(|t| t.get("messageUrl"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                MessageContent::text(format!("{}: {}", title, text))
            }
            "actionCard" => {
                let title = msg
                    .get("actionCard")
                    .and_then(|t| t.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                MessageContent::text(format!("[卡片消息] {}", title))
            }
            _ => MessageContent::text(format!("[钉钉 {} 消息]", msgtype)),
        };

        let platform_msg_id = payload
            .get("msgId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        tracing::info!(
            "[DingTalk] 📝 消息: sender={}, conv={}, type={}, robot={}",
            sender_name, conversation_id, msgtype, robot_id
        );

        Some(
            IntegrationMessage::new(
                Platform::DingTalk,
                conversation_id,
                sender_id,
                sender_name,
                content,
            )
            .with_platform_message_id(platform_msg_id.unwrap_or_default())
            .with_raw(payload.clone()),
        )
    }

    /// 去掉 @机器人 的提及标记
    fn strip_at_mention(text: &str) -> String {
        // 钉钉 @格式: @12345 或 \n@12345
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
        tracing::info!("[DingTalk] 🔌 开始连接...");

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

        // 1. 构造 WS URL
        tracing::info!("[DingTalk] 🔐 构造长连接 URL...");
        let ws_url = self.build_ws_url();
        tracing::info!(
            "[DingTalk] ✅ WS URL: https://open-dingtalk.com/ws/v1?appkey={}...",
            &self.config.app_id[..self.config.app_id.len().min(12)]
        );

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

                    // 等待连接验证结果
                    let connection_result = {
                        let msg = read.next().await;
                        if let Some(Ok(WsMessage::Text(payload))) = msg {
                            match Self::parse_ws_message(&payload) {
                                Some(WsMsgType::ConnectionResult { success, error }) => {
                                    if success {
                                        tracing::info!("[DingTalk] ✅ 连接验证成功");
                                        Ok(())
                                    } else {
                                        let detail = error.unwrap_or_else(|| "未知错误".to_string());
                                        tracing::error!("[DingTalk] ❌ 连接验证失败: {}", detail);
                                        Err(AppError::AuthError(format!("连接验证失败: {}", detail)))
                                    }
                                }
                                _ => {
                                    tracing::warn!(
                                        "[DingTalk] 连接首条消息不是 connection_result: {}",
                                        payload
                                    );
                                    Err(AppError::AuthError("连接验证响应格式错误".to_string()))
                                }
                            }
                        } else {
                            tracing::error!("[DingTalk] 连接后未收到预期响应");
                            Err(AppError::NetworkError("连接后未收到响应".to_string()))
                        }
                    };

                    // 通知连接结果，同时判断是否成功
                    let is_connection_ok = match &connection_result {
                        Ok(()) => {
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(Ok(()));
                            }
                            true
                        }
                        Err(e) => {
                            let err_msg = e.to_string();
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(Err(AppError::AuthError(err_msg.clone())));
                            }
                            false
                        }
                    };

                    if !is_connection_ok {
                        let err_msg = match &connection_result {
                            Err(e) => e.to_string(),
                            Ok(()) => unreachable!(),
                        };
                        // 连接失败，退出任务
                        {
                            let mut state = inner_state.write().await;
                            state.connection_state = ConnectionState::Failed;
                            state.error = Some("连接验证失败".to_string());
                            state.error_detail = Some(err_msg.clone());
                        }
                        #[cfg(feature = "tauri-app")]
                        if let Some(ref ah) = app_handle {
                            let status = IntegrationStatus {
                                platform: Platform::DingTalk,
                                connected: false,
                                connection_state: ConnectionState::Failed,
                                error: Some("连接验证失败".to_string()),
                                error_detail: Some(err_msg),
                                last_activity: None,
                                stats: IntegrationStats::default(),
                                retry_count: 0,
                            };
                            let _ = ah.emit("integration:state_change", &status);
                        }
                        return;
                    }

                    // 标记 Ready
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

                    let mut dedup = MessageDedup::default();

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
                                match msg {
                                    Some(Ok(WsMessage::Text(payload))) => {
                                        let msg_type = Self::parse_ws_message(&payload);
                                        tracing::debug!(
                                            "[DingTalk] 📩 收到消息: {:?}",
                                            std::mem::discriminant(&msg_type)
                                        );

                                        match msg_type {
                                            Some(WsMsgType::Heartbeat { msg_id }) => {
                                                // 回复心跳
                                                let heartbeat_ack = serde_json::json!({
                                                    "type": "heartbeat",
                                                    "msgId": msg_id
                                                });
                                                if let Err(e) = write.send(WsMessage::Text(heartbeat_ack.to_string())).await {
                                                    tracing::error!("[DingTalk] ❌ 心跳回复失败: {}", e);
                                                    break;
                                                }
                                            }
                                            Some(WsMsgType::Message { payload: data }) => {
                                                // 回 ACK
                                                if let Some(msg_id) = data.get("msgId").and_then(|v| v.as_str()) {
                                                    let ack = serde_json::json!({
                                                        "msgId": msg_id,
                                                        "ackCommand": "message_ack"
                                                    });
                                                    let _ = write.send(WsMessage::Text(ack.to_string())).await;
                                                }

                                                if let Some(im) = Self::handle_message_event(&data, &mut dedup) {
                                                    if let Err(e) = tx.send(im).await {
                                                        tracing::error!("[DingTalk] ❌ 发送消息到通道失败: {}", e);
                                                    }
                                                }
                                            }
                                            Some(WsMsgType::ConnectionResult { .. })
                                            | Some(WsMsgType::Unknown) => {}
                                            None => {}
                                        }
                                    }
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
                                    _ => {}
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

        // 等待鉴权完成或超时
        tracing::info!("[DingTalk] ⏳ 等待连接验证...");
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
                tracing::error!("[DingTalk] ❌ 连接验证失败: {}", e);
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
            SendTarget::Conversation(_) | SendTarget::Channel(_) | SendTarget::User(_) => {
                // 使用实例配置的 Webhook 回复
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
