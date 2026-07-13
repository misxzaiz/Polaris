/*! Simple AI 会话状态 */

use serde_json::Value;
use tokio::sync::watch;

/// SimpleAI 会话
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
    /// bootstrap 消息的结束索引（含 system、environment_context、项目指令、Skill 索引）。
    /// 压缩区间从该索引之后开始，保护这些消息不被压缩。
    pub(super) bootstrap_end: usize,
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
            bootstrap_end: 1, // 默认只含 system prompt
        }
    }
}
