//! cap.bash —— 宿主级 shell 命令执行能力（cap.bash 契约）
//!
//! 定位：提供在本机 shell 中运行命令的能力，支持长任务/后台任务管理
//! （run/status/log/wait/kill/list），并对 AI 会话解耦——任务由宿主进程
//! （TaskManager 单例）持有，不随会话结束而终止，可跨会话查询/回收。
//!
//! # 与 SimpleAI 内建 bash 工具的关系
//!
//! SimpleAI 的 bash 工具（`simple_ai/tools/bash.rs`）是会话级一次性执行：
//! 命令在会话内同步跑完、输出直接回给 LLM，会话中断即 kill。
//! cap.bash 是宿主级能力：任务可后台运行、可查询日志、可等待、可强制终止，
//! 且不受会话生命周期约束——这正是「AI 会话结束后后台任务继续跑」的解耦点。
//!
//! # 实现策略
//!
//! 后台执行使用标准线程（std::thread）+ Condvar 等待，而非 tokio：
//! - 线程是宿主级资源，天然与会话解耦（任务不挂在某个会话对象上）
//! - Worker 线程：读双管道 → 按行入 log；Terminator 线程：超时 watchdog kill
//! - `wait`/同步 `run` 用 Condvar + timeout 语义阻塞等待
//! - `kill` 用 taskkill /T /F（Windows 杀进程树）
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `run`    `{ "action":"run", "command":"...", "workdir":"可选",
//!               "env":{k:v} 可选, "timeoutMs":可选毫秒, "async":bool 可选,
//!               "onSessionEnd":"keep|kill" 可选（默认 keep）}`
//!               → `{ "taskId":"t1", "pid":123, "status":"running|...", "logPath":"" }`
//! - `status` `{ "action":"status", "taskId":"t1" }`
//!               → `{ "taskId":"t1", "status":"...", "exitCode":可选, "startedAt":..., "finishedAt":可选 }`
//! - `log`    `{ "action":"log", "taskId":"t1", "offset":0, "limit":200 }`
//!               → `{ "taskId":"t1", "offset":0, "total":1024, "lines":["..."] }`
//! - `wait`   `{ "action":"wait", "taskId":"t1", "timeoutMs":30000 }`
//!               → `{ "taskId":"t1", "status":"...", "exitCode":可选, "finishedAt":可选 }`
//! - `kill`   `{ "action":"kill", "taskId":"t1" }` → `{ "taskId":"t1", "killed":true }`
//! - `list`   `{ "action":"list", "sessionId":"可选", "status":"可选" }`
//!               → `{ "tasks":[ { "taskId":"...", "status":"...", "command":"..." } ] }`
//!
//! # 会话关联
//!
//! 任务记录发起方来源字符串（`Source::Plugin{caller}` 的 caller，经 dispatch 注入）。
//! `sessionId` 过滤即按该来源字符串匹配；`onSessionEnd:"kill"` 的回收由调用方在会话
//! 结束时遍历归属会话的 running 任务并调用 `kill` 原语完成。默认 `keep`（会话解耦）。

use crate::contracts::{Capability, CapabilityId, Context, Source, Value};
use serde_json::json;
use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::process::Stdio;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CAP_ID: &str = "cap.bash";

/// 默认超时：10 分钟（与 SimpleAI bash 工具一致，防脚本死循环）
const DEFAULT_TIMEOUT_MS: u64 = 600_000;
/// 日志 ring buffer 最大行数（进程结束后仍可查尾部）
const MAX_LOG_LINES: usize = 500;
/// 单行最大字符数（超长截断，防内存滥用）
const MAX_LINE_CHARS: usize = 4096;
/// 日志最大总字节（防多任务累积占用）
const MAX_TOTAL_LOG_BYTES: usize = 4 * 1024 * 1024;

/// 任务状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Killed,
    Timeout,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Killed => "killed",
            TaskStatus::Timeout => "timeout",
        }
    }
}

/// 任务共享状态（status + terminated condvar）
struct TaskState {
    status: Mutex<TaskStatus>,
    terminated: Condvar,
}

/// 单个任务
struct Task {
    id: String,
    command: String,
    workdir: Option<String>,
    session_id: Option<String>,
    on_session_end: String,
    pid: AtomicU64,
    state: Arc<TaskState>,
    log: Mutex<VecDeque<String>>,
    log_bytes: AtomicU64,
    started_at_ms: u64,
    finished_at_ms: AtomicU64,
}

impl Task {
    fn status(&self) -> TaskStatus {
        *self.state.status.lock().unwrap()
    }

    fn mark_finished(&self, status: TaskStatus) {
        {
            let mut s = self.state.status.lock().unwrap();
            *s = status;
        }
        self.finished_at_ms.store(now_ms(), Ordering::SeqCst);
        self.state.terminated.notify_all();
        tracing::info!(
            "[cap.bash] task {} finished [{}, pid={}]",
            self.id,
            status.as_str(),
            self.pid.load(Ordering::Relaxed)
        );
    }

    fn append_log(&self, line: String) {
        if line.is_empty() {
            return;
        }
        let line = if line.len() > MAX_LINE_CHARS {
            format!("{}…[truncated]", &line[..MAX_LINE_CHARS])
        } else {
            line
        };
        let mut buf = self.log.lock().unwrap();
        let mut overflow = self.log_bytes.load(Ordering::Relaxed);
        while !buf.is_empty() && overflow + line.len() as u64 > MAX_TOTAL_LOG_BYTES as u64 {
            if let Some(old) = buf.pop_front() {
                overflow = overflow.saturating_sub(old.len() as u64);
            }
        }
        buf.push_back(line.clone());
        self.log_bytes.store(overflow + line.len() as u64, Ordering::Relaxed);
        while buf.len() > MAX_LOG_LINES {
            buf.pop_front();
        }
    }

    fn exit_code(&self) -> Option<i32> {
        self.log.lock().unwrap().iter().rev().find_map(|l| {
            let prefix = "[exit code: ";
            l.strip_prefix(prefix)
                .and_then(|r| r.trim_end_matches(']').parse::<i32>().ok())
        })
    }
}

/// 宿主级任务管理器（会话解耦：任务不挂在某个会话对象上）
struct TaskManager {
    tasks: Mutex<Vec<Arc<Task>>>,
    next_id: AtomicU64,
}

impl TaskManager {
    fn new() -> Arc<Self> {
        Arc::new(TaskManager {
            tasks: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
        })
    }

    fn next_task_id(&self) -> String {
        format!("t{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    fn get(&self, id: &str) -> Option<Arc<Task>> {
        self.tasks.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 检测可用 shell（与 SimpleAI bash.rs 同一策略，跨平台）
fn detect_shell() -> (&'static str, Option<String>) {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        static SHELL: OnceLock<(&'static str, Option<String>)> = OnceLock::new();
        SHELL.get_or_init(detect_shell_windows).clone()
    }
    #[cfg(not(windows))]
    {
        ("sh", None)
    }
}

#[cfg(windows)]
fn detect_shell_windows() -> (&'static str, Option<String>) {
    if let Ok(git_root) = std::env::var("GIT_INSTALL_ROOT") {
        let bash_path = std::path::Path::new(&git_root).join("usr/bin/bash.exe");
        if bash_path.exists() {
            return ("git_bash", Some(bash_path.to_string_lossy().to_string()));
        }
    }
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut where_cmd = std::process::Command::new("where");
    where_cmd.arg("bash");
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let bash_path = line.trim();
                if bash_path.is_empty() || !std::path::Path::new(bash_path).exists() {
                    continue;
                }
                if !is_wsl_bash(bash_path) {
                    return ("git_bash", Some(bash_path.to_string()));
                }
            }
        }
    }
    static GIT_BASH_FALLBACKS: &[&str] = &[
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
    ];
    for path in GIT_BASH_FALLBACKS {
        if std::path::Path::new(path).exists() {
            return ("git_bash", Some((*path).to_string()));
        }
    }
    let pwsh = std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if pwsh.exists() {
        return ("pwsh", Some(pwsh.to_string_lossy().to_string()));
    }
    ("cmd", None)
}

#[cfg(windows)]
fn is_wsl_bash(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("system32") || lower.contains("syswow64") || lower.contains("windowsapps")
}

/// 解码 Windows 进程输出（UTF-8 → GBK → lossy）
fn decode_windows_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (decoded, had_errors) = encoding_rs::GBK.decode_without_bom_handling(bytes);
            if !had_errors {
                decoded.into_owned()
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// 终止进程（Windows 杀进程树；非 Windows 直接 kill）
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").arg("-9").arg(pid.to_string()).output();
    }
}

/// cap.bash —— 宿主级 shell 命令执行能力（有状态：宿主级 TaskManager 单例）
pub struct BashCapability {
    manager: Arc<TaskManager>,
}

impl BashCapability {
    /// 全局宿主级 TaskManager（会话解耦核心：任务归属宿主，不随会话销毁）
    fn host_manager() -> &'static Arc<TaskManager> {
        static MANAGER: OnceLock<Arc<TaskManager>> = OnceLock::new();
        MANAGER.get_or_init(TaskManager::new)
    }

    pub fn new() -> Self {
        BashCapability {
            manager: Self::host_manager().clone(),
        }
    }

    /// 记录发起方来源：Session（Plugin{caller}）→ caller 字符串；Bootstrap → None
    fn caller_id(ctx: &dyn Context) -> Option<String> {
        match ctx.source() {
            Source::Plugin { caller } => Some(caller.0.clone()),
            Source::Bootstrap => None,
            Source::Remote { token } => Some(format!("remote:{token}")),
        }
    }

    fn action_run(&self, params: &Value, ctx: &dyn Context) -> Result<Value, String> {
        let command = params
            .get("command")
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .ok_or_else(|| "cap.bash run 需要 command 参数".to_string())?;
        let workdir = params
            .get("workdir")
            .and_then(|w| w.as_str())
            .map(String::from);
        let env = params
            .get("env")
            .and_then(|e| e.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| {
                        let v = v.as_str().unwrap_or_default().to_string();
                        (!k.is_empty() && !v.is_empty()).then(|| (k.clone(), v))
                    })
                    .collect::<Vec<(String, String)>>()
            })
            .unwrap_or_default();
        let timeout_ms = params
            .get("timeoutMs")
            .and_then(|t| t.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let async_run = params.get("async").and_then(|a| a.as_bool()).unwrap_or(false);
        let on_session_end = params
            .get("onSessionEnd")
            .and_then(|s| s.as_str())
            .unwrap_or("keep")
            .to_string();
        let session_id = Self::caller_id(ctx);

        let task_id = self.manager.next_task_id();
        let task = Arc::new(Task {
            id: task_id.clone(),
            command: command.to_string(),
            workdir,
            session_id,
            on_session_end,
            pid: AtomicU64::new(0),
            state: Arc::new(TaskState {
                status: Mutex::new(TaskStatus::Running),
                terminated: Condvar::new(),
            }),
            log: Mutex::new(VecDeque::new()),
            log_bytes: AtomicU64::new(0),
            started_at_ms: now_ms(),
            finished_at_ms: AtomicU64::new(0),
        });
        self.manager.tasks.lock().unwrap().push(task.clone());

        // 启动后台执行（独立线程，宿主级，与会话解耦）
        spawn_execution(self.manager.clone(), task.clone(), command.to_string(), timeout_ms, env);

        // 同步 run：等待完成或超时
        if !async_run {
            wait_task(&task, timeout_ms.max(1_000));
            return Ok(task_json(&task));
        }
        Ok(json!({
            "taskId": task_id,
            "pid": task.pid.load(Ordering::Relaxed),
            "status": task.status(),
            "logPath": "",
        }))
    }
}

/// 构建任务状态 JSON
fn task_json(task: &Arc<Task>) -> Value {
    json!({
        "taskId": task.id,
        "pid": task.pid.load(Ordering::Relaxed),
        "status": task.status(),
        "exitCode": (task.status() != TaskStatus::Running).then(|| task.exit_code().unwrap_or(-1)),
        "startedAt": task.started_at_ms,
        "finishedAt": (task.status() != TaskStatus::Running)
            .then(|| task.finished_at_ms.load(Ordering::Relaxed)),
    })
}

/// 同步等待任务结束（Condvar + timeout）
fn wait_task(task: &Arc<Task>, timeout_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut status = task.state.status.lock().unwrap();
    while *status == TaskStatus::Running {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let (guard, _t) = task
            .state
            .terminated
            .wait_timeout_while(status, deadline - now, |s| *s == TaskStatus::Running)
            .unwrap();
        status = guard;
    }
}

/// 后台执行：spawn 子进程，双线程读管道，watchdog 处理超时
fn spawn_execution(
    manager: Arc<TaskManager>,
    task: Arc<Task>,
    command: String,
    timeout_ms: u64,
    env: Vec<(String, String)>,
) {
    let (shell_name, shell_path) = detect_shell();
    let shell_exe = shell_path.unwrap_or_else(|| shell_name.to_string());
    let cwd = task
        .workdir
        .clone()
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".into())
        });

    let mut cmd = std::process::Command::new(&shell_exe);
    cmd.current_dir(&cwd);
    match shell_name {
        "git_bash" => {
            cmd.arg("-l").arg("-c").arg(&command);
        }
        "sh" => {
            cmd.arg("-c").arg(&command);
        }
        "pwsh" => {
            cmd.arg("-Command").arg(&command);
        }
        _ => {
            cmd.arg("/C").arg(&command);
        }
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use crate::utils::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            task.append_log(format!(
                "[spawn error] Failed to execute command with {shell_name}: {e}"
            ));
            task.mark_finished(TaskStatus::Failed);
            return;
        }
    };
    task.pid.store(child.id() as u64, Ordering::Relaxed);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Worker 线程：读双管道写日志
    let t2 = task.clone();
    std::thread::spawn(move || {
        if let Some(so) = stdout {
            read_lines_reader(so, &t2);
        }
    });
    let t3 = task.clone();
    std::thread::spawn(move || {
        if let Some(se) = stderr {
            read_lines_reader(se, &t3);
        }
    });

    let child_pid = child.id();

    // Watchdog 线程：超时则杀进程树并标记 timeout
    if timeout_ms > 0 {
        let tw = task.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout_ms));
            if tw.status() == TaskStatus::Running {
                kill_process_tree(child_pid);
                tw.append_log("[timed out]".into());
                tw.mark_finished(TaskStatus::Timeout);
            }
        });
    }

    // Waiter 线程：执行 child.wait()（阻塞），命令完成/被 kill 后返回并定性。
    // 关键：wait 不能占用 invoke 调用线程，否则 async/sync run 都会阻塞到命令结束。
    let t5 = task.clone();
    let t5_mgr = manager.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status
            .ok()
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        // 若 watchdog / kill 尚未定性（正常退出）→ 依退出码定性
        if t5.status() == TaskStatus::Running {
            t5.append_log(format!("[exit code: {code}]"));
            let st = if code == 0 {
                TaskStatus::Completed
            } else {
                TaskStatus::Failed
            };
            t5.mark_finished(st);
        }
        drop(t5_mgr);
    });
}

/// 从 OS 句柄逐行读入日志（字节流 → UTF-8/GBK 解码 → 按行切分）
fn read_lines_reader<R: Read + Send + 'static>(r: R, task: &Arc<Task>) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        let mut chunk = [0u8; 8192];
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                // 按行切分（保留残留跨 chunk 的尾部）
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                    let line = decode_windows_output(&line_bytes[..line_bytes.len().saturating_sub(1)]);
                    task.append_log(line.trim_end_matches('\r').to_string());
                }
            }
            Err(_) => break,
        }
    }
    // 尾部无换行的残留
    if !buf.is_empty() {
        let line = decode_windows_output(&buf);
        task.append_log(line.trim_end_matches('\r').to_string());
    }
}

impl Default for BashCapability {
    fn default() -> Self {
        Self::new()
    }
}

impl Capability for BashCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.bash 需要 action 参数（run/status/log/wait/kill/list）".to_string())?;

        match action {
            "run" => self.action_run(&params, ctx),
            "status" => {
                let id = params.get("taskId").and_then(|t| t.as_str())
                    .ok_or_else(|| "status 需要 taskId 参数".to_string())?;
                let task = self.manager.get(id)
                    .ok_or_else(|| format!("cap.bash 任务不存在: {id}"))?;
                Ok(task_json(&task))
            }
            "log" => {
                let id = params.get("taskId").and_then(|t| t.as_str())
                    .ok_or_else(|| "log 需要 taskId 参数".to_string())?;
                let offset = params.get("offset").and_then(|o| o.as_u64()).unwrap_or(0) as usize;
                let limit = params.get("limit").and_then(|l| l.as_u64()).unwrap_or(0) as usize;
                let task = self.manager.get(id)
                    .ok_or_else(|| format!("cap.bash 任务不存在: {id}"))?;
                let buf = task.log.lock().unwrap();
                let total = buf.len();
                let limit = if limit == 0 { total } else { limit.min(total - offset.min(total)) };
                let lines = buf.iter().skip(offset.min(total)).take(limit).cloned().collect::<Vec<_>>();
                Ok(json!({
                    "taskId": id,
                    "offset": offset.min(total),
                    "total": total,
                    "lines": lines,
                }))
            }
            "wait" => {
                let id = params.get("taskId").and_then(|t| t.as_str())
                    .ok_or_else(|| "wait 需要 taskId 参数".to_string())?;
                let timeout_ms = params.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(30_000);
                let task = self.manager.get(id)
                    .ok_or_else(|| format!("cap.bash 任务不存在: {id}"))?;
                wait_task(&task, timeout_ms);
                Ok(task_json(&task))
            }
            "kill" => {
                let id = params.get("taskId").and_then(|t| t.as_str())
                    .ok_or_else(|| "kill 需要 taskId 参数".to_string())?;
                let task = self.manager.get(id)
                    .ok_or_else(|| format!("cap.bash 任务不存在: {id}"))?;
                if task.status() == TaskStatus::Running {
                    let pid = task.pid.load(Ordering::Relaxed);
                    if pid != 0 {
                        kill_process_tree(pid as u32);
                    }
                    task.append_log("[killed]".into());
                    task.mark_finished(TaskStatus::Killed);
                    Ok(json!({ "taskId": id, "killed": true, "status": "killed" }))
                } else {
                    Ok(json!({ "taskId": id, "killed": false, "status": task.status() }))
                }
            }
            "list" => {
                let session_id = params.get("sessionId").and_then(|s| s.as_str());
                let status = params.get("status").and_then(|s| s.as_str());
                let tasks = self.manager.tasks.lock().unwrap();
                let mut out = Vec::new();
                for t in tasks.iter() {
                    if let Some(sid) = session_id {
                        if t.session_id.as_deref() != Some(sid) {
                            continue;
                        }
                    }
                    if let Some(sf) = status {
                        if t.status().as_str() != sf {
                            continue;
                        }
                    }
                    out.push(json!({
                        "taskId": t.id,
                        "status": t.status(),
                        "command": t.command,
                        "pid": t.pid.load(Ordering::Relaxed),
                        "sessionId": t.session_id,
                        "onSessionEnd": t.on_session_end,
                        "startedAt": t.started_at_ms,
                        "finishedAt": t.finished_at_ms.load(Ordering::Relaxed),
                        "logLines": t.log.lock().unwrap().len(),
                    }));
                }
                Ok(json!({ "tasks": out }))
            }
            other => Err(format!("cap.bash 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{PermissionRequest, PermissionVerdict, PluginId};

    struct NoopCtx(Source);
    impl Context for NoopCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(&self, _req: &PermissionRequest) -> Result<PermissionVerdict, String> {
            Ok(PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            &self.0
        }
        fn caller_id(&self) -> &PluginId {
            static PID: PluginId = PluginId(String::new());
            &PID
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(json!({}))
        }
    }

    fn plugin_ctx(caller: &str) -> NoopCtx {
        NoopCtx(Source::Plugin {
            caller: PluginId(caller.into()),
        })
    }

    #[test]
    fn run_echo_completes() {
        let cap = BashCapability::new();
        let ctx = plugin_ctx("sess-1");
        let r = cap.invoke(
            json!({ "action": "run", "command": "echo hello cap.bash", "async": false }),
            &ctx,
        );
        let v = r.unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["exitCode"], 0);
        let id = v["taskId"].as_str().unwrap().to_string();

        // log 里应含输出
        let log = cap
            .invoke(json!({ "action": "log", "taskId": id }), &ctx)
            .unwrap();
        let text = log["lines"].as_array().unwrap();
        let joined = text
            .iter()
            .filter_map(|l| l.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("hello cap.bash") || joined.contains("echo cap.bash"));
    }

    #[test]
    fn list_filters_by_status_and_session() {
        let cap = BashCapability::new();
        let ctx = plugin_ctx("sess-2");
        cap.invoke(
            json!({ "action": "run", "command": "echo a", "async": true }),
            &ctx,
        )
        .unwrap();
        // 等它结束
        std::thread::sleep(Duration::from_millis(300));
        let all = cap.invoke(json!({ "action": "list" }), &ctx).unwrap();
        let by_session = cap
            .invoke(json!({ "action": "list", "sessionId": "sess-2" }), &ctx)
            .unwrap();
        assert!(all["tasks"].as_array().unwrap().len() >= 1);
        assert!(by_session["tasks"].as_array().unwrap().len() >= 1);
        // 不存在的会话 → 空
        let other = cap
            .invoke(json!({ "action": "list", "sessionId": "nope" }), &ctx)
            .unwrap();
        assert_eq!(other["tasks"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn kill_running_task() {
        let cap = BashCapability::new();
        let ctx = plugin_ctx("sess-k");
        // 长命令放后台跑，立即 kill
        let cmd = if cfg!(windows) {
            "ping -n 30 127.0.0.1"
        } else {
            "sleep 30"
        };
        let r = cap
            .invoke(json!({ "action": "run", "command": cmd, "async": true, "timeoutMs": 60000 }), &ctx)
            .unwrap();
        let id = r["taskId"].as_str().unwrap().to_string();
        // 等 pid 就绪
        let mut tries = 0;
        while cap
            .invoke(json!({ "action": "status", "taskId": id }), &ctx)
            .and_then(|v| Ok(v["status"].as_str().unwrap().to_string()))
            .unwrap()
            == "running"
            && tries < 20
        {
            std::thread::sleep(Duration::from_millis(100));
            tries += 1;
        }
        let k = cap
            .invoke(json!({ "action": "kill", "taskId": id }), &ctx)
            .unwrap();
        assert_eq!(k["killed"], true);
        let st = cap
            .invoke(json!({ "action": "status", "taskId": id }), &ctx)
            .unwrap();
        assert_eq!(st["status"], "killed");
    }

    #[test]
    fn unknown_action_errors() {
        let cap = BashCapability::new();
        let ctx = plugin_ctx("s");
        let r = cap.invoke(json!({ "action": "wat" }), &ctx);
        assert!(r.is_err());
    }
}