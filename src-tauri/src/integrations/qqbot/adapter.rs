/*! QQ Bot 适配器
 *
 * 实现 PlatformIntegration Trait，提供 QQ Bot 的连接、消息收发功能。
 */

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::Sender;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::error::{AppError, Result};
use crate::models::config::QQBotConfig;
use super::super::common::MessageDedup;
use super::super::traits::PlatformIntegration;
use super::super::types::*;

/// QQ Bot Intents
/// 参考: https://bot.q.qq.com/wiki/develop/api-v2/
/// 注意: 只请求必要的 intents，避免权限不足导致连接失败
const INTENTS_DEFAULT: u32 =
    (1 << 9) |   // GUILD_MESSAGES - 频道消息
    (1 << 12) |  // DIRECT_MESSAGE - 私信
    (1 << 25) |  // AT_MESSAGES - @消息
    (1 << 30);   // PUBLIC_GUILD_MESSAGES - 公域频道消息

/// QQ Bot 适配器
pub struct QQBotAdapter {
    /// 配置
    config: QQBotConfig,
    /// Access Token
    access_token: Option<String>,
    /// Token 过期时间
    token_expire_at: i64,
    /// 消息发送通道
    message_tx: Option<Sender<IntegrationMessage>>,
    /// 状态
    status: IntegrationStatus,
    /// 消息去重器
    dedup: MessageDedup,
    /// WebSocket 任务句柄
    ws_task: Option<tokio::task::JoinHandle<()>>,
    /// 关闭信号发送端
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl QQBotAdapter {
    /// 创建新的 QQ Bot 适配器
    pub fn new(config: QQBotConfig) -> Self {
        Self {
            config,
            access_token: None,
            token_expire_at: 0,
            message_tx: None,
            status: IntegrationStatus::new(Platform::QQBot),
            dedup: MessageDedup::default(),
            ws_task: None,
            shutdown_tx: None,
        }
    }

    /// 获取 API 基础 URL
    fn api_base(&self) -> &'static str {
        if self.config.sandbox {
            "https://sandbox.api.sgroup.qq.com"
        } else {
            "https://api.sgroup.qq.com"
        }
    }

    /// 获取 Access Token
    async fn get_access_token(&mut self) -> Result<()> {
        let client = reqwest::Client::new();

        let response = client
            .post("https://bots.qq.com/app/getAppAccessToken")
            .json(&serde_json::json!({
                "appId": self.config.app_id,
                "clientSecret": self.config.client_secret
            }))
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            return Err(AppError::AuthError(format!("获取 Access Token 失败: {}", error)));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;

        self.access_token = data
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let expires_in = data
            .get("expires_in")
            .and_then(|v| v.as_i64())
            .unwrap_or(7200);

        // 提前 5 分钟过期
        self.token_expire_at = chrono::Utc::now().timestamp() + expires_in - 300;

        // 打印 token 信息（只显示前8个字符）
        if let Some(ref token) = self.access_token {
            let token_preview: String = token.chars().take(8).collect();
            tracing::info!("[QQBot] ✅ Access token obtained: {}..., expires in {}s", token_preview, expires_in);
        }

        if self.access_token.is_none() {
            return Err(AppError::AuthError("响应中没有 access_token".to_string()));
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
            self.get_access_token().await?;
        }
        Ok(())
    }

    /// 获取 WebSocket Gateway URL
    async fn get_gateway_url(&self) -> Result<String> {
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{}/gateway/bot", self.api_base()))
            .header(
                "Authorization",
                format!("QQBot {}", self.access_token.as_ref().unwrap()),
            )
            .header("User-Agent", "Polaris/1.0")
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let error = response.text().await.unwrap_or_default();
            return Err(AppError::ApiError(format!("获取 Gateway URL 失败: {}", error)));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::ParseError(e.to_string()))?;

        // 打印完整响应用于调试
        tracing::info!("[QQBot] 📋 Gateway 响应: {}", serde_json::to_string(&data).unwrap_or_default());

        // 检查 session_start_limit
        if let Some(limit) = data.get("session_start_limit") {
            let total = limit.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
            let remaining = limit.get("remaining").and_then(|v| v.as_i64()).unwrap_or(0);
            let reset_after = limit.get("reset_after").and_then(|v| v.as_i64()).unwrap_or(0);

            tracing::info!(
                "[QQBot] 📊 Session 限制: total={}, remaining={}, reset_after={}ms",
                total, remaining, reset_after
            );

            if remaining <= 0 {
                return Err(AppError::ApiError(format!(
                    "会话启动次数已用完，{}ms 后重置",
                    reset_after
                )));
            }
        }

        // 检查 shards 配置
        if let Some(shards) = data.get("shards").and_then(|v| v.as_i64()) {
            tracing::info!("[QQBot] 📊 建议的 shards 数量: {}", shards);
        }

        data.get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::ApiError("响应中没有 gateway URL".to_string()))
    }

    /// 解析消息内容
    fn parse_content(raw: &serde_json::Value) -> MessageContent {
        let content = raw
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // 检查附件
        if let Some(attachments) = raw.get("attachments").and_then(|v| v.as_array()) {
            if !attachments.is_empty() {
                let mut items = vec![MessageContent::text(content)];

                for att in attachments {
                    let content_type = att
                        .get("content_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if content_type.starts_with("image/") {
                        items.push(MessageContent::Image {
                            url: att
                                .get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            local_path: None,
                        });
                    } else if content_type.starts_with("audio/") {
                        items.push(MessageContent::Audio {
                            url: att
                                .get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            transcript: None,
                        });
                    }
                }

                return MessageContent::Mixed { items };
            }
        }

        MessageContent::text(content)
    }

    /// 处理消息事件
    fn handle_message_event(
        event_type: &str,
        event_data: &serde_json::Value,
        dedup: &mut MessageDedup,
    ) -> Option<IntegrationMessage> {
        // 获取消息 ID
        let msg_id = event_data.get("id").and_then(|v| v.as_str())?;

        // 根据事件类型确定消息类型
        let msg_type = match event_type {
            "C2C_MESSAGE_CREATE" => "c2c",
            "GROUP_AT_MESSAGE_CREATE" => "group_at",
            "AT_MESSAGE_CREATE" => "at",
            "DIRECT_MESSAGE_CREATE" => "direct",
            "MESSAGE_CREATE" => "channel",
            _ => "unknown",
        };
        let message_id = format!("{}_{}", msg_type, msg_id);

        // 去重检查
        if dedup.is_processed(&message_id) {
            tracing::debug!("[QQBot] ⚠️ 重复消息被忽略: {}", message_id);
            return None;
        }

        // 获取会话 ID（根据不同事件类型）
        let conversation_id = match event_type {
            "C2C_MESSAGE_CREATE" => {
                // C2C 私信
                format!(
                    "c2c_{}",
                    event_data
                        .get("author")
                        .and_then(|a| a.get("user_openid"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                )
            }
            "GROUP_AT_MESSAGE_CREATE" => {
                // 群聊@消息
                let group_id = event_data
                    .get("group_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                format!("group_{}", group_id)
            }
            "AT_MESSAGE_CREATE" | "MESSAGE_CREATE" => {
                // 频道消息
                event_data
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
            "DIRECT_MESSAGE_CREATE" => {
                // 私信
                event_data
                    .get("guild_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
            _ => {
                // 默认使用 channel_id
                event_data
                    .get("channel_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
        };

        // 获取发送者信息
        let author = event_data.get("author").cloned().unwrap_or_default();
        let sender_id = author
            .get("id")
            .or_else(|| author.get("member_openid"))  // 群聊使用 member_openid
            .or_else(|| author.get("user_openid"))    // C2C 使用 user_openid
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let sender_name = author
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string();

        // 获取消息内容
        let content = event_data
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // 使用字符安全的截断方式
        let content_preview: String = content.chars().take(50).collect();
        let content_preview = if content_preview.len() < content.len() { format!("{}...", content_preview) } else { content_preview };
        tracing::info!(
            "[QQBot] 📝 消息详情: type={}, sender={}, conversation={}, content={}",
            msg_type,
            sender_name,
            conversation_id,
            content_preview
        );

        // 构造消息
        Some(
            IntegrationMessage::new(
                Platform::QQBot,
                conversation_id,
                sender_id,
                sender_name,
                Self::parse_content(event_data),
            )
            .with_raw(event_data.clone()),
        )
    }
}

#[async_trait]
impl PlatformIntegration for QQBotAdapter {
    fn platform(&self) -> Platform {
        Platform::QQBot
    }

    async fn connect(&mut self, message_tx: Sender<IntegrationMessage>) -> Result<()> {
        tracing::info!("[QQBot] 🔌 开始连接...");

        // 1. 确保 Token 有效
        tracing::info!("[QQBot] 🔐 获取 Access Token...");
        self.ensure_valid_token().await?;
        tracing::info!("[QQBot] ✅ Access Token 有效");

        // 2. 获取 Gateway URL
        tracing::info!("[QQBot] 🌐 获取 WebSocket Gateway...");
        let gateway_url = self.get_gateway_url().await?;
        tracing::info!(
            "[QQBot] ✅ Gateway URL: {}",
            &gateway_url[..std::cmp::min(60, gateway_url.len())]
        );

        // 3. 创建关闭通道
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);

        // 4. 克隆必要的数据
        let access_token = self.access_token.clone().unwrap();
        let tx = message_tx.clone();

        // 5. 启动 WebSocket 任务
        tracing::info!("[QQBot] 🚀 启动 WebSocket 连接...");
        let task = tokio::spawn(async move {
            tracing::info!("[QQBot] 🔌 正在建立 WebSocket 连接...");
            match connect_async(&gateway_url).await {
                Ok((ws_stream, _)) => {
                    tracing::info!("[QQBot] ✅ WebSocket 连接成功");

                    let (mut write, mut read) = ws_stream.split();

                    // 发送鉴权消息
                    tracing::info!("[QQBot] 📤 发送鉴权消息 (op=2)...");
                    let auth_payload = serde_json::json!({
                        "op": 2,
                        "d": {
                            "token": format!("QQBot {}", access_token),
                            "intents": INTENTS_DEFAULT,
                            "shard": [0, 1],
                            "properties": {
                                "$os": std::env::consts::OS,
                                "$browser": "polaris",
                                "$device": "desktop"
                            }
                        }
                    });

                    tracing::info!("[QQBot] 📋 鉴权载荷: intents={}", INTENTS_DEFAULT);

                    if let Err(e) = write
                        .send(WsMessage::Text(auth_payload.to_string()))
                        .await
                    {
                        tracing::error!("[QQBot] Failed to send auth: {}", e);
                        return;
                    }

                    tracing::debug!("[QQBot] Auth message sent");

                    // 心跳相关变量
                    let mut heartbeat_interval = 41250u64; // 默认心跳间隔
                    let mut last_heartbeat = std::time::Instant::now();
                    let mut seq: Option<u32> = None;
                    let mut dedup = MessageDedup::default();

                    loop {
                        tokio::select! {
                            // 检查关闭信号
                            _ = &mut shutdown_rx => {
                                tracing::info!("[QQBot] Shutdown signal received");
                                let _ = write.send(WsMessage::Close(None)).await;
                                break;
                            }

                            // 读取消息
                            msg = read.next() => {
                                match msg {
                                    Some(Ok(WsMessage::Text(text))) => {
                                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) {
                                            let op = payload.get("op").and_then(|v| v.as_u64()).unwrap_or(0);

                                            match op {
                                                0 => { // DISPATCH - 事件消息
                                                    // 更新序列号
                                                    if let Some(s) = payload.get("s").and_then(|v| v.as_u64()) {
                                                        seq = Some(s as u32);
                                                    }

                                                    let event_type = payload
                                                        .get("t")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("");

                                                    let event_data = payload.get("d").cloned().unwrap_or_default();

                                                    // 输出所有接收到的事件类型（调试用）
                                                    tracing::info!("[QQBot] 📩 收到事件: {}", event_type);

                                                    // 处理 READY 事件
                                                    if event_type == "READY" {
                                                        tracing::info!("[QQBot] ✅ Ready! Session: {:?}",
                                                            event_data.get("session_id"));
                                                        continue;
                                                    }

                                                    // 处理消息事件（包括各种类型的 MESSAGE_CREATE）
                                                    // 支持: MESSAGE_CREATE, AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE,
                                                    //       DIRECT_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE
                                                    if event_type.ends_with("MESSAGE_CREATE") {
                                                        tracing::info!("[QQBot] 📨 收到消息事件: {}", event_type);

                                                        if let Some(msg) = Self::handle_message_event(
                                                            event_type,
                                                            &event_data,
                                                            &mut dedup,
                                                        ) {
                                                            tracing::info!("[QQBot] ✅ 消息处理成功: id={}, conversation={}",
                                                                msg.id, msg.conversation_id);
                                                            if let Err(e) = tx.send(msg).await {
                                                                tracing::error!("[QQBot] ❌ 发送消息到通道失败: {}", e);
                                                            }
                                                        } else {
                                                            tracing::debug!("[QQBot] ⚠️ 消息被忽略（可能是重复消息）");
                                                        }
                                                    }
                                                }
                                                10 => { // HELLO
                                                    if let Some(interval) = payload
                                                        .get("d")
                                                        .and_then(|d| d.get("heartbeat_interval"))
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        heartbeat_interval = interval;
                                                        tracing::info!("[QQBot] 💓 HELLO 收到，心跳间隔: {}ms", heartbeat_interval);
                                                    }
                                                    // 收到 HELLO 后发送鉴权
                                                    tracing::info!("[QQBot] 🔐 发送鉴权消息...");
                                                }
                                                11 => { // HEARTBEAT_ACK
                                                    tracing::debug!("[QQBot] 💓 心跳确认");
                                                }
                                                7 => { // RECONNECT
                                                    tracing::warn!("[QQBot] ⚠️ 服务器请求重连");
                                                    break;
                                                }
                                                _ => {
                                                    tracing::debug!("[QQBot] 📩 未处理的 op: {}", op);
                                                }
                                            }
                                        }
                                    }
                                    Some(Ok(WsMessage::Ping(data))) => {
                                        let _ = write.send(WsMessage::Pong(data)).await;
                                    }
                                    Some(Ok(WsMessage::Close(frame))) => {
                                        tracing::warn!("[QQBot] Connection closed: {:?}", frame);

                                        // 诊断常见错误码
                                        if let Some(close_frame) = &frame {
                                            let code = close_frame.code.into();
                                            tracing::error!(
                                                "[QQBot] ❌ 关闭码: {} ({})",
                                                code,
                                                close_frame.reason
                                            );

                                            match code {
                                                4903 => {
                                                    tracing::error!(
                                                        "[QQBot] 诊断: 4903 错误通常是以下原因之一:\n\
                                                        1. 并发连接限制 - 同一个 Bot 只能有一个 WebSocket 连接\n\
                                                        2. Token 无效或过期\n\
                                                        3. 应用未开通所请求的 intents 权限\n\
                                                        4. Shard 配置与 Gateway 返回的不匹配"
                                                    );
                                                }
                                                4004 => {
                                                    tracing::error!("[QQBot] 诊断: Token 无效");
                                                }
                                                4010 => {
                                                    tracing::error!("[QQBot] 诊断: 无效的 Shard 配置");
                                                }
                                                4011 => {
                                                    tracing::error!("[QQBot] 诊断: Shard 数量超过限制");
                                                }
                                                4012 => {
                                                    tracing::error!("[QQBot] 诊断: 无效的 Intents");
                                                }
                                                4013 => {
                                                    tracing::error!("[QQBot] 诊断: Intents 超出白名单范围");
                                                }
                                                _ => {}
                                            }
                                        }
                                        break;
                                    }
                                    Some(Ok(WsMessage::Pong(_))) => {
                                        tracing::trace!("[QQBot] Pong received");
                                    }
                                    Some(Err(e)) => {
                                        tracing::error!("[QQBot] WebSocket error: {}", e);
                                        break;
                                    }
                                    None => {
                                        tracing::warn!("[QQBot] WebSocket stream ended");
                                        break;
                                    }
                                    _ => {}
                                }
                            }

                            // 发送心跳
                            _ = tokio::time::sleep(tokio::time::Duration::from_millis(heartbeat_interval)) => {
                                let now = std::time::Instant::now();
                                if now.duration_since(last_heartbeat).as_millis() as u64 >= heartbeat_interval - 1000 {
                                    let heartbeat = serde_json::json!({
                                        "op": 1,
                                        "d": seq
                                    });

                                    if let Err(e) = write.send(WsMessage::Text(heartbeat.to_string())).await {
                                        tracing::error!("[QQBot] Failed to send heartbeat: {}", e);
                                        break;
                                    }

                                    last_heartbeat = now;
                                    tracing::trace!("[QQBot] Heartbeat sent, seq: {:?}", seq);
                                }
                            }
                        }
                    }

                    tracing::info!("[QQBot] WebSocket loop ended");
                }
                Err(e) => {
                    tracing::error!("[QQBot] Failed to connect WebSocket: {}", e);
                }
            }
        });

        self.ws_task = Some(task);
        self.message_tx = Some(message_tx);
        self.status = IntegrationStatus::new(Platform::QQBot).connected();

        tracing::info!("[QQBot] Adapter connected");
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        tracing::info!("[QQBot] 🔌 开始断开连接...");

        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            tracing::debug!("[QQBot] 关闭信号已发送");
        }

        // 2. 等待任务结束（带超时）
        if let Some(task) = self.ws_task.take() {
            // 给任务一点时间优雅关闭
            let result = tokio::time::timeout(
                tokio::time::Duration::from_secs(3),
                task
            ).await;

            match result {
                Ok(Ok(())) => {
                    tracing::debug!("[QQBot] WebSocket 任务已正常结束");
                }
                Ok(Err(_)) => {
                    tracing::debug!("[QQBot] WebSocket 任务已结束");
                }
                Err(_) => {
                    tracing::warn!("[QQBot] WebSocket 任务超时，已强制终止");
                }
            }
        }

        // 3. 清理状态
        self.status = self.status.clone().disconnected();
        self.message_tx = None;
        self.dedup.clear();

        tracing::info!("[QQBot] ✅ 已断开连接");
        Ok(())
    }

    async fn send(&mut self, target: SendTarget, content: MessageContent) -> Result<()> {
        // 关键：发送前确保 Token 有效
        self.ensure_valid_token().await?;

        let text = content.as_text().ok_or_else(|| {
            AppError::ValidationError("目前只支持发送文本消息".to_string())
        })?;

        let access_token = self.access_token.as_ref().ok_or_else(|| {
            AppError::AuthError("未认证".to_string())
        })?;

        let client = reqwest::Client::new();

        match target {
            SendTarget::User(ref openid) => {
                // C2C 私信
                let url = format!("{}/v2/users/{}/messages", self.api_base(), openid);

                let response = client
                    .post(&url)
                    .header("Authorization", format!("QQBot {}", access_token))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({ "content": text }))
                    .send()
                    .await
                    .map_err(|e| AppError::NetworkError(e.to_string()))?;

                if !response.status().is_success() {
                    let error = response.text().await.unwrap_or_default();
                    // 检查是否是 Token 过期错误
                    if error.contains("token") || error.contains("expire") {
                        tracing::warn!("[QQBot] Token 可能已过期，尝试刷新后重试");
                        self.get_access_token().await?;
                        // 重试一次 - clone target for recursive call
                        let target_clone = SendTarget::User(openid.clone());
                        return self.send(target_clone, content).await;
                    }
                    return Err(AppError::ApiError(format!("发送 C2C 消息失败: {}", error)));
                }

                tracing::debug!("[QQBot] C2C message sent to {}", openid);
            }
            SendTarget::Channel(ref channel_id) => {
                // 频道消息
                let url = format!("{}/channels/{}/messages", self.api_base(), channel_id);

                let response = client
                    .post(&url)
                    .header("Authorization", format!("QQBot {}", access_token))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({ "content": text }))
                    .send()
                    .await
                    .map_err(|e| AppError::NetworkError(e.to_string()))?;

                if !response.status().is_success() {
                    let error = response.text().await.unwrap_or_default();
                    // 检查是否是 Token 过期错误
                    if error.contains("token") || error.contains("expire") {
                        tracing::warn!("[QQBot] Token 可能已过期，尝试刷新后重试");
                        self.get_access_token().await?;
                        // 重试一次
                        let target_clone = SendTarget::Channel(channel_id.clone());
                        return self.send(target_clone, content).await;
                    }
                    return Err(AppError::ApiError(format!("发送频道消息失败: {}", error)));
                }

                tracing::debug!("[QQBot] Channel message sent to {}", channel_id);
            }
            SendTarget::Conversation(ref conv_id) => {
                // 自动判断类型
                if conv_id.starts_with("c2c_") {
                    let openid = conv_id.strip_prefix("c2c_").unwrap();
                    return self.send(SendTarget::User(openid.to_string()), content).await;
                } else {
                    return self.send(SendTarget::Channel(conv_id.clone()), content).await;
                }
            }
            SendTarget::Webhook(_) => {
                return Err(AppError::ValidationError("QQBot 不支持 Webhook 发送".to_string()));
            }
        }

        Ok(())
    }

    fn status(&self) -> IntegrationStatus {
        self.status.clone()
    }
}