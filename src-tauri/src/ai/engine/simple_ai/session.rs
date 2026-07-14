/*! Simple AI 会话状态 */

use serde_json::Value;
use tokio::sync::watch;

use crate::error::{AppError, Result};

/// 压缩状态。所有字段由 `SimpleAIEngine.sessions` 的 mutex 保护。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionStatus {
    Idle,
    Planning,
    Cooldown,
    Disabled,
}

#[derive(Debug, Clone)]
pub(super) struct CompactionState {
    pub(super) generation: u64,
    pub(super) status: CompactionStatus,
    pub(super) active_checkpoint: Option<u64>,
    pub(super) last_compacted_at_ms: Option<i64>,
    pub(super) consecutive_failures: u32,
    /// 下一条正常用户请求发出前允许恢复到该 checkpoint。
    pub(super) undo_checkpoint: Option<u64>,
}

impl Default for CompactionState {
    fn default() -> Self {
        Self {
            generation: 0,
            status: CompactionStatus::Idle,
            active_checkpoint: None,
            last_compacted_at_ms: None,
            consecutive_failures: 0,
            undo_checkpoint: None,
        }
    }
}

/// SimpleAI 会话
pub(super) struct SimpleAISession {
    /// 消息历史（OpenAI 格式）
    pub(super) messages: Vec<Value>,
    /// 工作目录
    #[allow(dead_code)]
    pub(super) work_dir: String,
    /// 中断信号发送端
    pub(super) abort_tx: watch::Sender<bool>,
    /// 中断信号接收端
    pub(super) abort_rx: watch::Receiver<bool>,
    /// 是否正在运行
    pub(super) is_running: bool,
    /// 前端稳定会话 ID。正常压缩不改变此 ID 或 runtime session ID。
    pub(super) stable_conversation_id: String,
    /// 固定 bootstrap 的结束索引：system、环境、项目指令与 skill index 均位于其前。
    pub(super) bootstrap_end: usize,
    /// 每次 turn/压缩提交递增，用于阻止过期异步任务覆盖新状态。
    pub(super) turn_generation: u64,
    /// 最近一次最终 wire request 的本地估算 token 数。
    pub(super) latest_request_tokens: Option<usize>,
    /// 最近一次 provider 返回的 input token，用于校准本地估算。
    pub(super) latest_provider_input_tokens: Option<u64>,
    /// 与 provider usage 同一次请求的本地 wire 估算，避免拿“响应追加后的快照”错误校准。
    pub(super) latest_local_input_tokens: Option<usize>,
    /// 最近一次请求使用的工具定义，供 idle 手动压缩准确估算。
    pub(super) latest_tool_specs: Vec<Value>,
    /// 最近一次实际使用的模型 Profile，供 idle 手动压缩和恢复使用。
    pub(super) latest_profile: Option<crate::models::config::ModelProfile>,
    /// Profile 稳定 ID，仅写入 checkpoint 元数据，不包含密钥。
    pub(super) latest_profile_id: Option<String>,
    pub(super) compaction_state: CompactionState,
}

impl SimpleAISession {
    pub(super) fn new(work_dir: String) -> Self {
        let (abort_tx, abort_rx) = watch::channel(false);
        Self {
            messages: Vec::new(),
            work_dir,
            abort_tx,
            abort_rx,
            is_running: false,
            stable_conversation_id: String::new(),
            bootstrap_end: 0,
            turn_generation: 0,
            latest_request_tokens: None,
            latest_provider_input_tokens: None,
            latest_local_input_tokens: None,
            latest_tool_specs: Vec::new(),
            latest_profile: None,
            latest_profile_id: None,
            compaction_state: CompactionState::default(),
        }
    }

    pub(super) fn next_turn_generation(&mut self) -> u64 {
        self.turn_generation = self.turn_generation.saturating_add(1);
        self.turn_generation
    }

    /// Atomically claim ownership of the next turn while the session mutex is held.
    /// A second overlapping continue is rejected before either task can clone history.
    pub(super) fn claim_turn(&mut self) -> Result<(u64, watch::Receiver<bool>)> {
        if self.is_running {
            return Err(AppError::StateError(
                "SimpleAI 会话已有正在运行的 turn".to_string(),
            ));
        }
        self.is_running = true;
        self.compaction_state.undo_checkpoint = None;
        let generation = self.next_turn_generation();
        let (new_tx, new_rx) = watch::channel(false);
        self.abort_tx = new_tx;
        self.abort_rx = new_rx.clone();
        Ok((generation, new_rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_turn_claim_is_rejected_and_generation_is_stable() {
        let mut session = SimpleAISession::new(".".to_string());
        let (generation, _) = session.claim_turn().unwrap();
        assert_eq!(generation, 1);
        assert!(session.claim_turn().is_err());
        assert_eq!(session.turn_generation, 1);
    }

    #[test]
    fn a_new_turn_gets_a_fresh_abort_channel_and_invalidates_undo() {
        let mut session = SimpleAISession::new(".".to_string());
        session.compaction_state.undo_checkpoint = Some(4);
        let (_, first_rx) = session.claim_turn().unwrap();
        session.abort_tx.send(true).unwrap();
        assert!(*first_rx.borrow());

        session.is_running = false;
        session.compaction_state.undo_checkpoint = Some(5);
        let (generation, second_rx) = session.claim_turn().unwrap();
        assert_eq!(generation, 2);
        assert!(!*second_rx.borrow());
        assert_eq!(session.compaction_state.undo_checkpoint, None);
    }
}
