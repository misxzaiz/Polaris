/*! 后台任务注册表（bash background / 独立管理面板的统一进程生命周期管理）
 *
 * 职责：
 * - spawn 后台进程（独立进程组），stdout/stderr 写日志文件（不占管道，解决 64KB 阻塞）
 * - 维护任务状态：running / done / failed / killed / timeout
 * - 超时自动杀进程树（Windows taskkill /T /F；Unix kill 进程组）
 * - 日志文件读尾部、滚动上限
 * - 会话退出自动清理该会话全部任务
 *
 * 与 SimpleAI bash 工具的关系：
 * - bash 工具 `background: true` 时经本注册表 spawn，立即返回 taskId
 * - 前端管理面板 / Tauri command 经 `task_list / task_status / task_kill` 管理
 *
 * 进程组隔离：Windows 用 `CREATE_NEW_PROCESS_GROUP` + `taskkill /T /F` 连根杀；
 * Unix 用 `setsid()` 新进程组 + `kill(-pid)` 整组杀。杜绝「父进程退出子进程
 * 残留成孤儿」的问题（历史教训：8848 端口 python 孤儿服务）。
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::broadcast;

use crate::models::ai_event::{TaskCompletedEvent, TaskMetadataEvent, TaskStatus as EventTaskStatus};
use crate::models::AIEvent;
use crate::services::data_root::data_root;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 任务状态（注册表内部用，与事件枚举映射）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Done,
    Failed,
    Killed,
    Timeout,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Killed => "killed",
            TaskStatus::Timeout => "timeout",
        }
    }
    fn to_event(&self) -> EventTaskStatus {
        match self {
            TaskStatus::Running => EventTaskStatus::Running,
            TaskStatus::Done => EventTaskStatus::Success,
            TaskStatus::Failed => EventTaskStatus::Error,
            TaskStatus::Killed | TaskStatus::Timeout => EventTaskStatus::Canceled,
        }
    }
}

/// 任务信息（前端面板 / AI status 工具共享视图）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub task_id: String,
    pub session_id: String,
    pub command: String,
    pub pid: u32,
    pub status: String,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
    pub log_path: String,
    pub log_tail: String,
    pub elapsed_ms: u64,
}

/// 任务内部记录
struct TaskRecord {
    task_id: String,
    session_id: String,
    command: String,
    pid: u32,
    status: TaskStatus,
    started_at_ms: u64,
    ended_at_ms: Option<u64>,
    exit_code: Option<i32>,
    log_path: PathBuf,
    timeout_ms: Option<u64>,
}

/// 日志滚动上限（单任务日志超过该字节截断读取，防爆盘）
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
/// 日志尾部返回行数
const LOG_TAIL_LINES: usize = 200;

/// 后台任务注册表（进程级共享，挂 AppState 与 SimpleAI 引擎）
#[derive(Clone)]
pub struct TaskRegistry {
    inner: Arc<tokio::sync::RwLock<HashMap<String, TaskRecord>>>,
    /// 事件广播通道（task_metadata / task_completed），多订阅者
    event_tx: broadcast::Sender<AIEvent>,
    /// 日志根目录（<DataRoot>/tasks）
    log_root: PathBuf,
    /// 全局默认超时（秒）
    global_timeout_secs: u64,
}

/// 全局单例访问（与 `data_root()` 同模式）：启动期组件（SimpleAI 引擎 / bash 工具）
/// 无法持有 AppState，通过此函数共享同一个注册表。
static TASK_REGISTRY: std::sync::OnceLock<TaskRegistry> = std::sync::OnceLock::new();

/// 后台任务全局兜底超时（秒）：与 bash 工具同步路径默认值 600s 对齐。
pub(crate) const DEFAULT_TASK_TIMEOUT_SECS: u64 = 600;

/// 获取全局任务注册表单例（首次调用时初始化，日志根 <DataRoot>/tasks）
pub fn task_registry() -> &'static TaskRegistry {
    TASK_REGISTRY.get_or_init(|| {
        TaskRegistry::new(data_root().root().join("tasks"), DEFAULT_TASK_TIMEOUT_SECS)
    })
}

impl TaskRegistry {
    pub fn new(log_root: PathBuf, global_timeout_secs: u64) -> Self {
        let (event_tx, _rx) = broadcast::channel::<AIEvent>(256);
        Self {
            inner: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            event_tx,
            log_root,
            global_timeout_secs,
        }
    }

    fn ensure_log_dir(&self, session_id: &str) -> std::io::Result<PathBuf> {
        let dir = self.log_root.join(sanitize_session_id(session_id));
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 订阅任务事件（broadcast 语义，多订阅者）
    pub fn subscribe_events(&self) -> broadcast::Receiver<AIEvent> {
        self.event_tx.subscribe()
    }

    /// 后台启动任务
    ///
    /// - 立即返回 TaskInfo（status=running），不等待进程退出
    /// - timeout_ms: None = 用全局兜底；Some(0) = 不限制
    pub async fn spawn_task(
        &self,
        session_id: &str,
        command: &str,
        workdir: Option<&str>,
        env: &[(String, String)],
        timeout_ms: Option<u64>,
    ) -> Result<TaskInfo, String> {
        let task_id = format!("t_{}", uuid::Uuid::new_v4().simple());
        let log_dir = self.ensure_log_dir(session_id).map_err(|e| format!("创建任务日志目录失败: {e}"))?;
        let log_path = log_dir.join(format!("{task_id}.log"));

        let log_file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .await
            .map_err(|e| format!("打开任务日志失败: {e}"))?;

        let effective_timeout = match timeout_ms {
            Some(0) => None,
            Some(ms) => Some(ms),
            None => Some(self.global_timeout_secs * 1000),
        };

        // shell 检测与 bash 工具同源
        let (shell_name, shell_path) = detect_shell();
        let shell_exe = shell_path.as_deref().unwrap_or(shell_name);
        let mut cmd = Command::new(shell_exe);
        if let Some(wd) = workdir {
            cmd.current_dir(wd);
        }
        match shell_name {
            "git_bash" | "sh" => {
                cmd.arg("-l").arg("-c").arg(command);
            }
            "pwsh" => {
                cmd.arg("-Command").arg(command);
            }
            "cmd" => {
                cmd.arg("/C").arg(command);
            }
            _ => {
                cmd.arg("-c").arg(command);
            }
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW | 0x00000200 /* CREATE_NEW_PROCESS_GROUP */);
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        // stdout/stderr → 日志文件（不占管道）
        let stdout_cfg: std::process::Stdio = log_file
            .try_clone()
            .await
            .map_err(|e| format!("日志文件 clone 失败: {e}"))?
            .into_std()
            .await
            .into();
        cmd.stdout(stdout_cfg);
        let stderr_std: std::process::Stdio = log_file.into_std().await.into();
        cmd.stderr(stderr_std);

        let child = cmd.spawn().map_err(|e| format!("后台任务启动失败: {e}"))?;
        let pid = child.id().unwrap_or(0);
        let started_at_ms = now_ms();

        {
            let mut guard = self.inner.write().await;
            guard.insert(
                task_id.clone(),
                TaskRecord {
                    task_id: task_id.clone(),
                    session_id: session_id.to_string(),
                    command: command.to_string(),
                    pid,
                    status: TaskStatus::Running,
                    started_at_ms,
                    ended_at_ms: None,
                    exit_code: None,
                    log_path,
                    timeout_ms: effective_timeout,
                },
            );
        }

        // 发 task_metadata 事件
        let _ = self.event_tx.send(AIEvent::TaskMetadata(TaskMetadataEvent::new(
            session_id.to_string(),
            task_id.clone(),
            EventTaskStatus::Running,
        )));

        // 监控任务：wait + 超时 + 状态流转 + 完成事件
        self.monitor_task(task_id.clone(), child, session_id.to_string()).await;

        let info = self.task_info(&task_id).await;
        Ok(info.unwrap_or_else(empty_info))
    }

    async fn monitor_task(&self, task_id: String, mut child: Child, session_id: String) {
        let registry = self.clone();
        tokio::spawn(async move {
            let timeout = {
                let guard = registry.inner.read().await;
                guard.get(&task_id).and_then(|t| t.timeout_ms)
            };

            let wait_fut = child.wait();
            let result = if let Some(timeout_ms) = timeout {
                tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait_fut).await
            } else {
                Ok(wait_fut.await)
            };

            let (status, exit_code, ended_at_ms) = match result {
                Ok(Ok(st)) => {
                    let code = st.code().unwrap_or(-1);
                    let st = if st.success() { TaskStatus::Done } else { TaskStatus::Failed };
                    (st, Some(code), Some(now_ms()))
                }
                Ok(Err(e)) => {
                    tracing::warn!("[TaskRegistry] wait 错误 task={} err={}", task_id, e);
                    (TaskStatus::Failed, Some(-1), Some(now_ms()))
                }
                Err(_) => {
                    let pid = {
                        let guard = registry.inner.read().await;
                        guard.get(&task_id).map(|t| t.pid)
                    };
                    if let Some(pid) = pid {
                        let _ = kill_process_tree(pid).await;
                    }
                    let _ = child.kill().await;
                    tracing::warn!("[TaskRegistry] 任务超时已杀 task={}", task_id);
                    (TaskStatus::Timeout, None, Some(now_ms()))
                }
            };

            {
                let mut guard = registry.inner.write().await;
                if let Some(rec) = guard.get_mut(&task_id) {
                    // 用户已显式 kill（kill_task / 会话清理置为 Killed）：保留 Killed，
                    // 避免 wait() 返回后把状态覆盖回 Failed/Done。
                    if rec.status == TaskStatus::Killed {
                        rec.exit_code = rec.exit_code.or(exit_code);
                    } else {
                        rec.status = status;
                        rec.exit_code = exit_code;
                        rec.ended_at_ms = ended_at_ms;
                    }
                }
            }

            let tail = registry.read_log_tail(&task_id, LOG_TAIL_LINES).await;
            let _ = registry.event_tx.send(AIEvent::TaskCompleted(TaskCompletedEvent::new(
                session_id,
                task_id.clone(),
                status.to_event(),
            )));

            tracing::info!(
                "[TaskRegistry] 任务结束 task={} status={} exit={:?}",
                task_id,
                status.as_str(),
                exit_code
            );
            drop(tail);
        });
    }

    /// 读日志尾部
    pub async fn read_log_tail(&self, task_id: &str, max_lines: usize) -> String {
        let path = {
            let guard = self.inner.read().await;
            match guard.get(task_id) {
                Some(r) => r.log_path.clone(),
                None => return format!("任务 {} 不存在", task_id),
            }
        };
        read_tail(&path, max_lines).await
    }

    /// 任务状态 + 日志尾部
    pub async fn task_info(&self, task_id: &str) -> Option<TaskInfo> {
        let mut info = {
            let guard = self.inner.read().await;
            guard.get(task_id).map(|rec| self.make_info(rec))?
        };
        info.log_tail = self.read_log_tail(task_id, LOG_TAIL_LINES).await;
        Some(info)
    }

    /// 列出任务（session / status 过滤）
    pub async fn list_tasks(&self, session_id: Option<&str>, status: Option<&str>) -> Vec<TaskInfo> {
        let guard = self.inner.read().await;
        let mut items: Vec<TaskInfo> = guard
            .values()
            .filter(|t| {
                session_id.map_or(true, |s| t.session_id == s)
                    && status.map_or(true, |s| t.status.as_str() == s)
            })
            .map(|t| self.make_info(t))
            .collect();
        items.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
        items
    }

    /// 杀任务（进程树）
    pub async fn kill_task(&self, task_id: &str) -> Result<bool, String> {
        let (pid, exists) = {
            let mut guard = self.inner.write().await;
            match guard.get_mut(task_id) {
                Some(rec) if rec.status == TaskStatus::Running => {
                    let pid = rec.pid;
                    rec.status = TaskStatus::Killed;
                    rec.ended_at_ms = Some(now_ms());
                    (pid, true)
                }
                Some(_) => (0, true),
                None => (0, false),
            }
        };
        if !exists {
            return Ok(false);
        }
        if pid != 0 {
            let ok = kill_process_tree(pid).await;
            tracing::info!("[TaskRegistry] kill task={} pid={} ok={}", task_id, pid, ok);
        }
        Ok(true)
    }

    /// 会话结束清理：杀该会话全部 running 任务
    pub async fn cleanup_session(&self, session_id: &str) {
        let pids: Vec<u32> = {
            let mut guard = self.inner.write().await;
            guard
                .values_mut()
                .filter(|t| t.session_id == session_id && t.status == TaskStatus::Running)
                .map(|t| {
                    t.status = TaskStatus::Killed;
                    t.ended_at_ms = Some(now_ms());
                    t.pid
                })
                .collect()
        };
        let count = pids.len();
        for pid in pids {
            let _ = kill_process_tree(pid).await;
        }
        if count > 0 {
            tracing::info!("[TaskRegistry] 会话 {} 清理 {} 个后台任务", session_id, count);
        }
    }

    /// 会话级退出清理钩子（引擎在会话结束时调用，异步不阻塞）
    pub fn cleanup_session_hook(&self, session_id: &str) {
        let registry = self.clone();
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            registry.cleanup_session(&session_id).await;
        });
    }

    fn make_info(&self, rec: &TaskRecord) -> TaskInfo {
        let now = now_ms();
        let elapsed = rec.ended_at_ms.unwrap_or(now).saturating_sub(rec.started_at_ms);
        TaskInfo {
            task_id: rec.task_id.clone(),
            session_id: rec.session_id.clone(),
            command: rec.command.clone(),
            pid: rec.pid,
            status: rec.status.as_str().to_string(),
            started_at_ms: rec.started_at_ms,
            exit_code: rec.exit_code,
            ended_at_ms: rec.ended_at_ms,
            log_path: rec.log_path.to_string_lossy().to_string(),
            log_tail: String::new(),
            elapsed_ms: elapsed,
        }
    }
}

fn empty_info() -> TaskInfo {
    TaskInfo {
        task_id: String::new(),
        session_id: String::new(),
        command: String::new(),
        pid: 0,
        status: "unknown".to_string(),
        started_at_ms: 0,
        exit_code: None,
        ended_at_ms: None,
        log_path: String::new(),
        log_tail: String::new(),
        elapsed_ms: 0,
    }
}

/// 读文件尾部 N 行（限长，防大文件）
async fn read_tail(path: &PathBuf, max_lines: usize) -> String {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return "(无法读取日志)".to_string(),
    };
    let content = if bytes.len() as u64 > MAX_LOG_BYTES {
        let start = bytes.len().saturating_sub(MAX_LOG_BYTES as usize);
        String::from_utf8_lossy(&bytes[start..]).to_string()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max_lines {
        lines.join("\n")
    } else {
        lines[lines.len() - max_lines..].join("\n")
    }
}

/// 杀进程树（Windows taskkill /T /F；Unix kill 进程组）
async fn kill_process_tree(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match output {
            Ok(o) => {
                if !o.status.success() {
                    tracing::warn!(
                        "[TaskRegistry] taskkill 非零退出 pid={} code={:?} stderr={}",
                        pid,
                        o.status.code(),
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                }
                true
            }
            Err(e) => {
                tracing::warn!("[TaskRegistry] taskkill 执行失败 pid={} err={}", pid, e);
                false
            }
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let output = Command::new("kill").arg("-TERM").arg(format!("-{pid}")).output();
        match output {
            Ok(o) if o.status.success() => true,
            _ => Command::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_session_id(session_id: &str) -> String {
    let s: String = session_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() {
        "unknown".to_string()
    } else {
        s
    }
}

/// 检测可用 shell（与 bash 工具同源逻辑）
fn detect_shell() -> (&'static str, Option<String>) {
    #[cfg(windows)]
    {
        use std::path::Path;
        const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
        if let Ok(git_root) = std::env::var("GIT_INSTALL_ROOT") {
            let bash_path = Path::new(&git_root).join("usr/bin/bash.exe");
            if bash_path.exists() {
                return ("git_bash", Some(bash_path.to_string_lossy().to_string()));
            }
        }
        let mut where_cmd = std::process::Command::new("where");
        where_cmd.arg("bash");
        where_cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
        if let Ok(output) = where_cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let p = line.trim();
                    if p.is_empty() || !Path::new(p).exists() {
                        continue;
                    }
                    let lower = p.to_ascii_lowercase();
                    if !(lower.contains("system32")
                        || lower.contains("syswow64")
                        || lower.contains("windowsapps"))
                    {
                        return ("git_bash", Some(p.to_string()));
                    }
                }
            }
        }
        let pwsh_path =
            Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        if pwsh_path.exists() {
            return ("pwsh", Some(pwsh_path.to_string_lossy().to_string()));
        }
        ("cmd", None)
    }
    #[cfg(not(windows))]
    {
        ("sh", None)
    }
}
