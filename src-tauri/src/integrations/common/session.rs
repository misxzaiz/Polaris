/*! 会话管理器
 *
 * 管理平台会话的创建、更新和删除。
 */

use std::collections::HashMap;
use chrono::Utc;
use super::super::types::IntegrationSession;

/// 会话管理器
#[allow(dead_code)]
pub struct SessionManager {
    sessions: HashMap<String, IntegrationSession>,
}

#[allow(dead_code)]
impl SessionManager {
    /// 创建新的会话管理器
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// 获取或创建会话
    ///
    /// 如果会话已存在，返回现有会话；否则创建新会话。
    pub fn get_or_create(&mut self, conversation_id: &str) -> IntegrationSession {
        let _now = Utc::now().timestamp_millis();

        self.sessions
            .entry(conversation_id.to_string())
            .or_insert_with(|| IntegrationSession::new(conversation_id))
            .clone()
    }

    /// 更新会话
    ///
    /// 更新会话的最后活动时间和消息计数。
    pub fn update(&mut self, conversation_id: &str) {
        if let Some(session) = self.sessions.get_mut(conversation_id) {
            session.touch();
        }
    }

    /// 获取会话
    pub fn get(&self, conversation_id: &str) -> Option<&IntegrationSession> {
        self.sessions.get(conversation_id)
    }

    /// 删除会话
    pub fn remove(&mut self, conversation_id: &str) -> Option<IntegrationSession> {
        self.sessions.remove(conversation_id)
    }

    /// 获取所有会话
    pub fn all(&self) -> Vec<&IntegrationSession> {
        self.sessions.values().collect()
    }

    /// 获取会话数量
    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    /// 清空所有会话
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// 清理过期会话
    ///
    /// 删除超过指定时间未活跃的会话。
    pub fn cleanup_inactive(&mut self, max_inactive_ms: i64) {
        let now = Utc::now().timestamp_millis();
        let threshold = now - max_inactive_ms;

        self.sessions.retain(|_, session| {
            session.updated_at > threshold
        });
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_manager() {
        let mut manager = SessionManager::new();

        // 创建会话
        let session = manager.get_or_create("conv1");
        assert_eq!(session.conversation_id, "conv1");
        assert_eq!(session.message_count, 0);

        // 更新会话
        manager.update("conv1");
        let session = manager.get("conv1").unwrap();
        assert_eq!(session.message_count, 1);

        // 获取所有会话
        assert_eq!(manager.count(), 1);
    }
}