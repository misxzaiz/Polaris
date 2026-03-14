/**
 * 会话状态存储
 *
 * 管理每个会话的状态，包括当前引擎、工作目录、提示词等。
 */

use std::collections::HashMap;
use chrono::Utc;
use crate::ai::EngineId;
use super::super::commands::{ConversationState, PromptMode};

/// 会话状态存储
pub struct ConversationStore {
    /// 会话状态映射
    states: HashMap<String, ConversationState>,
    /// 引擎到最新会话 ID 的映射（用于 /resume）
    engine_last_conversation: HashMap<EngineId, String>,
}

impl ConversationStore {
    /// 创建新的会话存储
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
            engine_last_conversation: HashMap::new(),
        }
    }

    /// 获取或创建会话状态
    pub fn get_or_create(&mut self, conversation_id: &str) -> &mut ConversationState {
        self.states
            .entry(conversation_id.to_string())
            .or_insert_with(|| ConversationState::new(conversation_id))
    }

    /// 获取会话状态（只读）
    pub fn get(&self, conversation_id: &str) -> Option<&ConversationState> {
        self.states.get(conversation_id)
    }

    /// 获取会话状态（可变）
    pub fn get_mut(&mut self, conversation_id: &str) -> Option<&mut ConversationState> {
        self.states.get_mut(conversation_id)
    }

    /// 更新会话活动
    pub fn touch(&mut self, conversation_id: &str) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.touch();
        }
    }

    /// 设置会话的 AI session ID
    pub fn set_ai_session(&mut self, conversation_id: &str, ai_session_id: String) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.ai_session_id = Some(ai_session_id);
            // 更新引擎最新会话映射
            let engine_id = state.get_engine_id();
            self.engine_last_conversation.insert(engine_id, conversation_id.to_string());
        }
    }

    /// 设置会话的工作目录
    pub fn set_work_dir(&mut self, conversation_id: &str, work_dir: String) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.work_dir = Some(work_dir);
        }
    }

    /// 设置会话的引擎
    pub fn set_engine(&mut self, conversation_id: &str, engine_id: EngineId) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.set_engine(&engine_id);
        }
    }

    /// 设置自定义提示词
    pub fn set_custom_prompt(
        &mut self,
        conversation_id: &str,
        custom_prompt: Option<String>,
        prompt_mode: PromptMode,
    ) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.custom_prompt = custom_prompt;
            state.prompt_mode = prompt_mode;
        }
    }

    /// 添加用户消息到历史
    pub fn add_user_message(&mut self, conversation_id: &str, content: &str) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.add_user_message(content);
        }
    }

    /// 添加助手回复到历史
    pub fn add_assistant_message(&mut self, conversation_id: &str, content: &str) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.add_assistant_message(content);
        }
    }

    /// 获取消息历史
    pub fn get_message_history(&self, conversation_id: &str) -> Option<&[super::super::commands::HistoryMessage]> {
        self.states.get(conversation_id).map(|s| s.get_message_history())
    }

    /// 重置会话状态
    pub fn reset(&mut self, conversation_id: &str) {
        if let Some(state) = self.states.get_mut(conversation_id) {
            state.reset();
        }
    }

    /// 删除会话
    pub fn remove(&mut self, conversation_id: &str) -> Option<ConversationState> {
        self.states.remove(conversation_id)
    }

    /// 获取引擎的最新会话 ID
    pub fn get_last_conversation(&self, engine_id: EngineId) -> Option<&str> {
        self.engine_last_conversation.get(&engine_id).map(|s: &String| s.as_str())
    }

    /// 获取所有会话数量
    pub fn count(&self) -> usize {
        self.states.len()
    }

    /// 清理过期会话
    pub fn cleanup_inactive(&mut self, max_inactive_ms: i64) {
        let now = Utc::now().timestamp_millis();
        let threshold = now - max_inactive_ms;

        self.states.retain(|_, state| {
            state.last_activity > threshold
        });
    }

    /// 清空所有会话
    pub fn clear(&mut self) {
        self.states.clear();
        self.engine_last_conversation.clear();
    }
}

impl Default for ConversationStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_store() {
        let mut store = ConversationStore::new();

        // 创建会话
        let state = store.get_or_create("conv1");
        assert_eq!(state.conversation_id, "conv1");
        assert_eq!(state.engine_id, "claude");

        // 设置引擎
        store.set_engine("conv1", EngineId::IFlow);
        let state = store.get("conv1").unwrap();
        assert_eq!(state.engine_id, "iflow");

        // 设置工作目录
        store.set_work_dir("conv1", "/home/user".to_string());
        let state = store.get("conv1").unwrap();
        assert_eq!(state.work_dir, Some("/home/user".to_string()));

        // 重置
        store.reset("conv1");
        let state = store.get("conv1").unwrap();
        assert_eq!(state.work_dir, None);
        assert_eq!(state.message_count, 0);
    }

    #[test]
    fn test_last_conversation() {
        let mut store = ConversationStore::new();

        // 创建会话并设置 AI session
        store.get_or_create("conv1");
        store.set_ai_session("conv1", "ai_session_1".to_string());
        store.set_engine("conv1", EngineId::ClaudeCode);

        // 获取最新会话
        let last_conv = store.get_last_conversation(EngineId::ClaudeCode);
        assert_eq!(last_conv, Some("conv1"));
    }
}
