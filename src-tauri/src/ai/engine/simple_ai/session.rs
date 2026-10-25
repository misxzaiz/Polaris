/*! Simple AI 会话状态 */

use serde_json::Value;
use tokio::sync::watch;

use super::tools::FileStateRegistry;

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
    /// 会话级文件状态缓存：read_file 登记，写工具 read-before-write + mtime 校验。
    /// 存于会话而非 run_chat_loop 局部，保证 continue / 子 agent 共享同一份登记。
    /// 用 Arc 便于 start/continue 时无锁 clone 后跨 await 使用。
    pub(super) file_states: std::sync::Arc<FileStateRegistry>,
    /// 轮次串行化锁（引擎级互斥）：start/continue 任务持锁贯穿整个 run，
    /// 并发 continue 在此排队——消除双 run_chat_loop 并发（旧轮迟到
    /// SessionEnd 与新轮事件交错 / 历史双写覆盖 / is_running 被旧轮 epilogue 误清）。
    pub(super) turn_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// 当前 run 的收尾信号：run 任务持有 sender，epilogue 置 true 后 drop；
    /// 下一次 continue 启动前 clone receiver 等待旧轮真正退出。
    /// sender 异常 drop（panic 未走 epilogue）时 changed() 返回 Err，
    /// 等待方按「已收尾」处理，不会死锁。
    pub(super) run_done_rx: Option<watch::Receiver<bool>>,
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
            file_states: std::sync::Arc::new(FileStateRegistry::new()),
            turn_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            run_done_rx: None,
        }
    }
}
