/*! Simple AI 会话状态 */

use tokio::sync::watch;

/// 压缩状态。所有字段由 sessions HashMap 的 mutex 保护。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CompactionStatus {
    Idle,
    Preparing,
    Summarizing,
    Committing,
    Cooldown,
    Disabled,
}

#[derive(Debug, Clone)]
pub(super) struct CompactionState {
    pub(super) generation: u64,
    pub(super) status: CompactionStatus,
    pub(super) active_checkpoint: Option<u64>,
    pub(super) pending_manual_request: bool,
    pub(super) last_compacted_at_ms: Option<i64>,
    pub(super) consecutive_failures: u32,
}

impl Default for CompactionState {
    fn default() -> Self {
        Self {
            generation: 0,
            status: CompactionStatus::Idle,
            active_checkpoint: None,
            pending_manual_request: false,
            last_compacted_at_ms: None,
            consecutive_failures: 0,
        }
    }
}

/// SimpleAI 会话
pub(super) struct SimpleAISession {
    /// 消息历史（OpenAI 格式）
    pub(super) messages: Vec<serde_json::Value>,
    /// 工作目录
    #[allow(dead_code)]
    pub(super) work_dir: String,
    /// 中断信号发送端
    pub(super) abort_tx: watch::Sender<bool>,
    /// 中断信号接收端
    pub(super) abort_rx: watch::Receiver<bool>,
    /// 是否正在运行
    pub(super) is_running: bool,
    /// 是否已被压缩归档（归档后不可继续）
    pub(super) is_archived: bool,
    /// 稳定对话 ID（前端 SessionMetadata.id），用于跨 runtime session 的上下文交接
    pub(super) stable_conversation_id: String,
    /// bootstrap 固定上下文结束位置（system、环境、项目指令、skill index）
    pub(super) bootstrap_end: usize,
    /// 上一次最终 wire request 的本地估算 token 数
    pub(super) latest_request_tokens: Option<usize>,
    /// 压缩状态
    pub(super) compaction_state: CompactionState,
    /// 回写世代号：每个 turn 启动时递增；仅同一世代可回写消息历史。
    pub(super) turn_generation: u64,
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
            is_archived: false,
            stable_conversation_id: String::new(),
            bootstrap_end: 0,
            latest_request_tokens: None,
            compaction_state: CompactionState::default(),
            turn_generation: 0,
        }
    }

    /// 在 session mutex 下为下一个 turn 分配 generation。
    pub(super) fn next_turn_generation(&mut self) -> u64 {
        self.turn_generation = self.turn_generation.saturating_add(1);
        self.turn_generation
    }
}
