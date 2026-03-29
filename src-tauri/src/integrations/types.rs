/*! 集成模块统一类型定义
 *
 * 定义所有平台通用的消息、状态、目标等类型。
 */

use serde::{Deserialize, Serialize};

/// 支持的平台
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    QQBot,
    // 后续扩展
    // DingTalk,
    // WeChat,
    // Telegram,
}

/// 连接状态（细化状态机）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    /// 未连接
    Disconnected,
    /// 连接中（正在建立 WebSocket）
    Connecting,
    /// 鉴权中（WebSocket 已建立，等待 READY）
    Authenticating,
    /// 已就绪（收到 READY，可以收发消息）
    Ready,
    /// 连接失败
    Failed,
    /// 重连中
    Reconnecting,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self::Disconnected
    }
}

impl std::fmt::Display for ConnectionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionState::Disconnected => write!(f, "未连接"),
            ConnectionState::Connecting => write!(f, "连接中"),
            ConnectionState::Authenticating => write!(f, "鉴权中"),
            ConnectionState::Ready => write!(f, "已就绪"),
            ConnectionState::Failed => write!(f, "连接失败"),
            ConnectionState::Reconnecting => write!(f, "重连中"),
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Platform::QQBot => write!(f, "qqbot"),
        }
    }
}

impl std::str::FromStr for Platform {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "qqbot" | "qq" => Ok(Platform::QQBot),
            _ => Err(format!("Unknown platform: {}", s)),
        }
    }
}

/// 统一消息结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationMessage {
    /// 消息唯一 ID
    pub id: String,
    /// 来源平台
    pub platform: Platform,
    /// 会话 ID
    pub conversation_id: String,
    /// 发送者 ID
    pub sender_id: String,
    /// 发送者名称
    pub sender_name: String,
    /// 消息内容
    pub content: MessageContent,
    /// 时间戳 (毫秒)
    pub timestamp: i64,
    /// 原始消息 (平台特定)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl IntegrationMessage {
    /// 创建新消息
    pub fn new(
        platform: Platform,
        conversation_id: String,
        sender_id: String,
        sender_name: String,
        content: MessageContent,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            platform,
            conversation_id,
            sender_id,
            sender_name,
            content,
            timestamp: chrono::Utc::now().timestamp_millis(),
            raw: None,
        }
    }

    /// 设置原始消息
    pub fn with_raw(mut self, raw: serde_json::Value) -> Self {
        self.raw = Some(raw);
        self
    }
}

/// 消息内容类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MessageContent {
    Text { text: String },
    Image {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        local_path: Option<String>,
    },
    File { name: String, url: String, size: u64 },
    Audio {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        transcript: Option<String>,
    },
    Mixed { items: Vec<MessageContent> },
}

impl MessageContent {
    /// 创建文本内容
    pub fn text(text: impl Into<String>) -> Self {
        MessageContent::Text { text: text.into() }
    }

    /// 获取文本内容
    pub fn as_text(&self) -> Option<&str> {
        match self {
            MessageContent::Text { text } => Some(text),
            MessageContent::Mixed { items } => items
                .iter()
                .find_map(|item| item.as_text()),
            _ => None,
        }
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        match self {
            MessageContent::Text { text } => text.is_empty(),
            MessageContent::Mixed { items } => items.is_empty(),
            _ => false,
        }
    }
}

/// 发送目标
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SendTarget {
    /// 会话 ID (通用)
    Conversation(String),
    /// 频道 ID (QQ)
    Channel(String),
    /// 用户 OpenID (QQ C2C)
    User(String),
    /// Webhook URL (钉钉等)
    Webhook(String),
}

/// 集成状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    /// 平台
    pub platform: Platform,
    /// 是否已连接（兼容旧字段）
    pub connected: bool,
    /// 连接状态（细化状态）
    #[serde(default)]
    pub connection_state: ConnectionState,
    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 错误详情（诊断信息）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    /// 最后活动时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<i64>,
    /// 统计信息
    #[serde(default)]
    pub stats: IntegrationStats,
    /// 重试次数
    #[serde(default)]
    pub retry_count: u32,
}

impl IntegrationStatus {
    pub fn new(platform: Platform) -> Self {
        Self {
            platform,
            connected: false,
            connection_state: ConnectionState::Disconnected,
            error: None,
            error_detail: None,
            last_activity: None,
            stats: IntegrationStats::default(),
            retry_count: 0,
        }
    }

    pub fn connected(mut self) -> Self {
        self.connected = true;
        self.connection_state = ConnectionState::Ready;
        self.error = None;
        self.error_detail = None;
        self.last_activity = Some(chrono::Utc::now().timestamp_millis());
        self
    }

    pub fn disconnected(mut self) -> Self {
        self.connected = false;
        self.connection_state = ConnectionState::Disconnected;
        self
    }

    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        self.error = Some(error.into());
        self.connection_state = ConnectionState::Failed;
        self
    }

    pub fn with_error_detail(mut self, error: impl Into<String>, detail: impl Into<String>) -> Self {
        self.error = Some(error.into());
        self.error_detail = Some(detail.into());
        self.connection_state = ConnectionState::Failed;
        self
    }

    /// 设置连接状态
    pub fn with_state(mut self, state: ConnectionState) -> Self {
        self.connection_state = state;
        self.connected = state == ConnectionState::Ready;
        self
    }

    /// 增加重试次数
    pub fn increment_retry(mut self) -> Self {
        self.retry_count += 1;
        self
    }

    /// 重置重试次数
    pub fn reset_retry(mut self) -> Self {
        self.retry_count = 0;
        self
    }
}

/// 统计信息
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStats {
    pub messages_received: u64,
    pub messages_sent: u64,
    pub errors: u64,
}

/// 会话信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSession {
    pub conversation_id: String,
    pub session_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: u32,
}

impl IntegrationSession {
    pub fn new(conversation_id: impl Into<String>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            conversation_id: conversation_id.into(),
            session_id: uuid::Uuid::new_v4().to_string(),
            created_at: now,
            updated_at: now,
            message_count: 0,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().timestamp_millis();
        self.message_count += 1;
    }
}
