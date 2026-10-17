/*! opencode CLI 引擎实现
 *
 * 接入 opencode（开源 AI 编程 CLI）作为第三个内置引擎。
 * 与 ClaudeEngine 同构，但协议层不同：
 * - 消息走命令行参数（opencode run "<msg>"），非 stdin stream-json
 * - 输出为 JSONL（--format json），非 Claude stream-json
 * - 续接用 --session <id>，非 --resume
 * - 权限用 --auto，非 --permission-mode bypassPermissions
 * - 模型用 --model <provider>/<model>（如 opencode/glm-5.3-flash-free）
 *
 * 事件流（实测 v2.0.30，`opencode run --format json`）：
 *   step_start ×N → text/tool_use → … → stdout EOF
 *   error（可选，provider 鉴权失败等）
 *
 * **没有 step_finish / session_end 事件，完成信号 = stdout EOF**；
 * StepFinish 解析分支与 tokens 提取保留作为前向兼容（有单测覆盖），
 * 但 EOF 判定不依赖它。
 */

use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineCapabilities, EngineDistribution, EngineId, EngineMetadata, EnvKeyMapping,
    SessionOptions,
};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    AssistantMessageEvent, ErrorEvent, ResultEvent, SessionEndEvent, SessionEndReason,
    ToolCallEndEvent, ToolCallStartEvent, UsageEvent, AIEvent,
};
use crate::models::config::Config;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// opencode JSONL 事件（逐行 stdout 反序列化）
///
/// 实测格式（字段名按 opencode v2.0.30）：
/// ```json
/// {"type":"step_start","sessionID":"ses_xxx","part":{"type":"step-start",...}}
/// {"type":"text","sessionID":"ses_xxx","part":{"type":"text","text":"...",...}}
/// {"type":"tool_use","sessionID":"ses_xxx","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{...},"output":"..."},...}}
/// {"type":"step_finish","sessionID":"ses_xxx","part":{"type":"step-finish","reason":"...","tokens":{"input":101,"output":54,...}}}
/// {"type":"error","sessionID":"ses_xxx","error":{"type":"provider.auth","message":"...","status":401}}
/// ```
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OpencodeEvent {
    /// 步骤开始 —— 首行即携带真实 sessionID
    StepStart {
        #[serde(rename = "sessionID")]
        session_id: String,
        #[serde(default, rename = "part")]
        part: serde_json::Value,
    },
    /// 文本增量
    Text {
        #[serde(rename = "sessionID", default)]
        session_id: Option<String>,
        #[serde(rename = "part")]
        part: TextPart,
    },
    /// 工具调用（含状态机：pending/running/completed/error）
    ToolUse {
        #[serde(rename = "sessionID", default)]
        session_id: Option<String>,
        #[serde(rename = "part")]
        part: ToolPart,
    },
    /// 步骤结束 —— 携带 tokens 用量
    StepFinish {
        #[serde(rename = "sessionID", default)]
        session_id: Option<String>,
        #[serde(rename = "part")]
        part: StepFinishPart,
    },
    /// 错误事件
    Error {
        #[serde(rename = "sessionID", default)]
        session_id: Option<String>,
        error: OpencodeError,
    },
}

#[derive(Debug, serde::Deserialize)]
struct TextPart {
    #[serde(default)]
    text: String,
}

#[derive(Debug, serde::Deserialize)]
struct ToolPart {
    /// 工具名（read/write/bash/edit 等）
    #[serde(default)]
    tool: String,
    /// 工具调用 ID
    #[serde(default, rename = "id")]
    call_id: Option<String>,
    /// 状态机
    #[serde(default)]
    state: ToolState,
}

#[derive(Debug, Default, serde::Deserialize)]
struct ToolState {
    /// pending / running / completed / error
    #[serde(default)]
    status: String,
    /// 输入参数
    #[serde(default)]
    input: serde_json::Value,
    /// 输出结果
    #[serde(default)]
    output: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct StepFinishPart {
    /// 结束原因（tool-calls / end-turn / ...）
    #[serde(default)]
    reason: Option<String>,
    /// token 用量
    #[serde(default)]
    tokens: Option<TokensInfo>,
    /// 成本
    #[serde(default)]
    cost: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
struct TokensInfo {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    reasoning: u64,
    #[serde(default)]
    cache: Option<CacheTokens>,
}

#[derive(Debug, serde::Deserialize)]
struct CacheTokens {
    #[serde(default)]
    read: u64,
    #[serde(default, rename = "write")]
    write: u64,
}

#[derive(Debug, serde::Deserialize)]
struct OpencodeError {
    #[serde(default)]
    message: String,
}

impl OpencodeEvent {
    /// 解析单行 JSONL
    fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}

/// 子进程退出信号（T2：去 sleep 的确定性退出等待）
///
/// `Child` 所有权在 EOF 读取线程内（`spawn_event_reader` 拿走），
/// `SessionManager` 只持有 PID，无法 `Child::wait`。EOF 线程在收尾时收割
/// child 并置位本信号；`continue_session` 收到信号（进程已真实退出）后才
/// spawn 续接进程，替代原 `kill → sleep(100ms) → spawn` 的超时掩盖方案。
///
/// 顺序约定：`signal()` 必须在 `child.wait()` **返回之后**调用，
/// 保证「信号已置位 ⇒ 进程已退出」的顺序成立。
struct ExitSignal {
    finished: std::sync::Mutex<bool>,
    cond: std::sync::Condvar,
}

impl ExitSignal {
    fn new() -> Self {
        Self {
            finished: std::sync::Mutex::new(false),
            cond: std::sync::Condvar::new(),
        }
    }

    /// 置位完成信号并广播
    fn signal(&self) {
        if let Ok(mut f) = self.finished.lock() {
            *f = true;
            self.cond.notify_all();
        }
    }

    /// bounded 等待完成信号。
    /// 返回 true = 进程已真实退出；false = 超时或锁失败（调用方应明确报错，
    /// 不得继续 spawn —— 否则新旧两个 opencode 实例写同一 opencode session）。
    fn wait(&self, timeout: std::time::Duration) -> bool {
        let guard = match self.finished.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match self.cond.wait_timeout_while(guard, timeout, |f: &mut bool| !*f) {
            Ok((g, _)) => *g,
            Err(_) => false,
        }
    }
}

/// opencode CLI 引擎
pub struct OpencodeEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// 子进程退出信号表: 会话初始 ID（temp 或 real）-> 退出信号
    exit_signals: std::sync::Arc<std::sync::Mutex<HashMap<String, std::sync::Arc<ExitSignal>>>>,
}

impl OpencodeEngine {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            exit_signals: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// 查找 opencode 可执行文件路径
    ///
    /// opencode 通过 npm 全局安装（`npm i -g opencode`），在 Windows 上为
    /// `%APPDATA%\npm\opencode.cmd`，已在 PATH 中。直接走 PATH 查找。
    fn get_cli_path(&self) -> Result<String> {
        #[cfg(windows)]
        {
            // Windows：npm 全局安装生成 opencode（shell 脚本）+ opencode.cmd（批处理）。
            // Rust Command::new 执行无扩展名文件会失败，必须用 .cmd 版本。
            Self::find_in_path("opencode.cmd")
        }
        #[cfg(not(windows))]
        {
            Self::find_in_path("opencode")
        }
    }

    /// 在 PATH 中查找命令
    #[cfg(windows)]
    fn find_in_path(cmd: &str) -> Result<String> {
        let output = Command::new("where")
            .arg(cmd)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| AppError::ProcessError(format!("查找 {} 失败: {}", cmd, e)))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string());
            if let Some(p) = path {
                if !p.is_empty() {
                    return Ok(p);
                }
            }
        }
        Err(AppError::ProcessError(format!(
            "未在 PATH 中找到 {}。请通过 npm 全局安装: npm install -g opencode",
            cmd
        )))
    }

    #[cfg(not(windows))]
    fn find_in_path(cmd: &str) -> Result<String> {
        let output = Command::new("which")
            .arg(cmd)
            .output()
            .map_err(|e| AppError::ProcessError(format!("查找 {} 失败: {}", cmd, e)))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string());
            if let Some(p) = path {
                if !p.is_empty() {
                    return Ok(p);
                }
            }
        }
        Err(AppError::ProcessError(format!(
            "未在 PATH 中找到 {}。请通过 npm 全局安装: npm install -g opencode",
            cmd
        )))
    }

    /// 构建命令
    ///
    /// `opencode run "<message>" --format json --model <m> [--session <id>] --auto`
    ///
    /// 注意：opencode run 默认即为非交互模式（不像 claude 需要 --print），
    /// --format json 指定 JSONL 逐行输出。
    fn build_command(
        &self,
        message: &str,
        resume_session: Option<&str>,
        model: Option<&str>,
    ) -> Result<Command> {
        let cli_path = self.get_cli_path()?;
        let mut cmd = Command::new(&cli_path);
        cmd.arg("run");

        // 消息作为位置参数（opencode run <message>）
        cmd.arg(message);

        // 输出格式：JSON 逐行
        cmd.args(["--format", "json"]);

        // 模型选择
        // opencode 默认会走 reflection provider（reflection/beam-*），未配置 auth 会 401。
        // Polaris 侧如果没显式指定模型，兜底到免费档 GLM（实测可用）。
        let effective_model = match model {
            Some(m) if !m.is_empty() => m,
            _ => "opencode/glm-5.3-flash-free",
        };
        cmd.args(["--model", effective_model]);

        // 续接会话
        if let Some(sid) = resume_session {
            cmd.args(["--session", sid]);
        }

        // 自动批准权限（非交互场景必需）
        cmd.arg("--auto");

        // 独立服务模式（plans §5.1 实测确认可用）：opencode 默认可能拉起后台
        // server 进程，kill 时留下孤儿进程；--standalone 让本次 run 用私有
        // server 随 run 进程生命周期结束，中断/续接的进程树语义才完整。
        cmd.arg("--standalone");

        Ok(cmd)
    }

    /// 配置命令（管道 + 工作目录 + 环境变量）
    ///
    /// stdin 用 null：opencode run 是非交互模式，检测到 stdin 为 pipe 且未 EOF
    /// 会进入交互模式等待输入（实测：进程不退出、stdout 不吐 JSONL）。
    /// 改用 Stdio::null() 让子进程立即看到 stdin EOF，走非交互路径处理命令行 message。
    fn configure_command(
        &self,
        cmd: &mut Command,
        work_dir: Option<&str>,
        env_overrides: &HashMap<String, String>,
    ) {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // 工作目录
        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }

        // 注入模型 Profile 环境变量覆盖
        for (key, value) in env_overrides {
            cmd.env(key, value);
        }
    }

    /// 把 spawn 失败转换为 AppError（含 Windows 32767 字符限制友好提示）
    fn map_spawn_error(e: std::io::Error, message_len: usize, prefix: &str) -> AppError {
        if e.raw_os_error() == Some(206) {
            AppError::ProcessError(format!(
                "{}: 命令行总长度超过 Windows 限制 (32767 字符)。\
                 当前 message 长度 {} 字符（走命令行参数）。\
                 请缩短消息内容或改用文件挂载。原始错误: {}",
                prefix, message_len, e
            ))
        } else {
            AppError::ProcessError(format!("{}: {}", prefix, e))
        }
    }

    /// 格式化命令为可复制的字符串（用于日志）
    #[cfg(windows)]
    fn format_command_for_log(cmd: &Command) -> String {
        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| {
                let s = a.to_string_lossy();
                if s.contains(' ') || s.contains('"') {
                    format!("\"{}\"", s.replace('"', "\\\""))
                } else {
                    s.to_string()
                }
            })
            .collect();
        format!("{} {}", program, args.join(" "))
    }

    #[cfg(not(windows))]
    fn format_command_for_log(cmd: &Command) -> String {
        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        format!("{} {}", program, args.join(" "))
    }

    /// 启动 stdout/stderr 读取线程，逐行解析 JSONL → AIEvent
    ///
    /// 返回值仍为 mpsc::Sender<String> 以满足 SessionManager::register_with_sender
    /// 签名（send_input 通道），但因 stdin 已用 Stdio::null()，发送到该 channel
    /// 的数据无处可写——opencode run 不支持运行时 stdin 交互。初版 send_input
    /// 走"kill + continue_session"替代路径。
    fn spawn_event_reader(
        &self,
        child: Child,
        temp_id: String,
        pid: u32,
        options: SessionOptions,
        exit_signal: std::sync::Arc<ExitSignal>,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        // T1：中断标记集合的本地句柄（kill_process 成功后会 remove 会话条目，
        // 标记须独立于 SessionInfo 存活才能在 EOF 时被查到）
        let interrupted_set = self.sessions.shared_interrupted();
        // T2：退出信号表句柄（置位后清理自身表项，避免信号表随会话累积）
        let exit_signals = std::sync::Arc::clone(&self.exit_signals);
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let mut current_session_id = temp_id.clone();

        // stdin 通道保留（满足 register_with_sender 签名），但 stdin=null 后无实际写入
        let (input_sender, _input_receiver) = std::sync::mpsc::channel::<String>();
        let input_sender_for_return = input_sender.clone();

        std::thread::spawn(move || {
            // 收割子进程需要可变绑定（T2：EOF 后 child.wait()）
            // stdout/stderr 用 take() 取出，避免部分移动 child 导致后续 wait() 不可用
            let mut child = child;
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程输出流".to_string());
                    }
                    return;
                }
            };

            let stderr = match child.stderr.take() {
                Some(s) => s,
                None => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取进程错误流".to_string());
                    }
                    return;
                }
            };

            // stderr 共享缓冲（供 EOF fallback 构造错误摘要）
            let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let stderr_buf_for_thread = stderr_buf.clone();

            // stderr 读取线程
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[OpencodeEngine] stderr: {}", line);
                    if let Ok(mut buf) = stderr_buf_for_thread.lock() {
                        buf.push(line);
                        if buf.len() > 50 {
                            buf.remove(0);
                        }
                    }
                }
            });

            // stdout 逐行读取 → OpencodeEvent → AIEvent
            //
            // 诊断日志：opencode 在应用内偶发"无回复"，手动 CLI 正常。
            // 逐行打 info 级日志以定位：进程是否产出 / 解析是否成功 / EOF 时序。
            let reader = std::io::BufReader::new(stdout);
            let mut received_finish = false;
            let mut received_error = false;
            let mut received_text = false;
            let mut line_count: usize = 0;
            let sender_for_update = input_sender.clone();

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::warn!(
                            "[OpencodeEngine] stdout 读取错误，退出循环: {}",
                            e
                        );
                        break;
                    }
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                line_count += 1;
                // 截断超长行避免日志爆炸（text 事件可能很长）。
                // 注意 UTF-8 多字节字符：按字节切片会 panic，必须回退到 char boundary。
                let preview = if trimmed.len() > 300 {
                    let mut end = 300;
                    while !trimmed.is_char_boundary(end) && end > 0 {
                        end -= 1;
                    }
                    format!("{}...(总 {} 字节)", &trimmed[..end], trimmed.len())
                } else {
                    trimmed.to_string()
                };
                tracing::info!(
                    "[OpencodeEngine] stdout #{}: {}",
                    line_count,
                    preview
                );

                let raw_event = match OpencodeEvent::parse_line(trimmed) {
                    Some(e) => e,
                    None => {
                        tracing::warn!(
                            "[OpencodeEngine] 无法解析为 OpencodeEvent: {}",
                            preview
                        );
                        continue;
                    }
                };

                match raw_event {
                    OpencodeEvent::StepStart { session_id, .. } => {
                        tracing::info!(
                            "[OpencodeEngine] 事件 step_start, sessionID={}",
                            session_id
                        );
                        // 首个 step_start 携带真实 opencode sessionID
                        if !session_id.is_empty() && session_id != current_session_id {
                            current_session_id = session_id.clone();
                            SessionManager::update_session_id_shared(
                                &sessions,
                                &temp_id,
                                &session_id,
                                pid,
                                "opencode",
                                Some(sender_for_update.clone()),
                            );
                            if let Some(ref cb) = on_session_id_update {
                                cb(session_id.clone());
                            }
                        }
                    }
                    OpencodeEvent::Text { part, .. } => {
                        if !part.text.is_empty() {
                            received_text = true;
                            tracing::info!(
                                "[OpencodeEngine] 事件 text, delta 长度 {} 字符",
                                part.text.len()
                            );
                            event_callback(AIEvent::AssistantMessage(
                                AssistantMessageEvent::new(
                                    &current_session_id,
                                    part.text,
                                    true, // is_delta
                                ),
                            ));
                        }
                    }
                    OpencodeEvent::ToolUse { part, .. } => {
                        tracing::info!(
                            "[OpencodeEngine] 事件 tool_use, tool={}, status={}",
                            part.tool,
                            part.state.status
                        );
                        Self::emit_tool_events(&part, &current_session_id, &event_callback);
                    }
                    OpencodeEvent::StepFinish { part, .. } => {
                        received_finish = true;
                        tracing::info!(
                            "[OpencodeEngine] 事件 step_finish, reason={:?}",
                            part.reason
                        );
                        // 发送 Usage 事件
                        if let Some(tokens) = part.tokens {
                            let cache_read = tokens.cache.as_ref().map(|c| c.read);
                            let cache_write = tokens.cache.as_ref().map(|c| c.write);
                            event_callback(AIEvent::Usage(UsageEvent::new(
                                &current_session_id,
                                tokens.input,
                                cache_write,        // cache_creation_input_tokens
                                cache_read,         // cache_read_input_tokens
                                tokens.output,
                                if tokens.reasoning > 0 {
                                    Some(tokens.reasoning)
                                } else {
                                    None
                                },
                                None, // context_window
                            )));
                        }
                        // 发送 Result 事件（opencode 无独立 result，step_finish 即本轮结束）
                        event_callback(AIEvent::Result(ResultEvent::new(
                            &current_session_id,
                            serde_json::Value::String(
                                part.reason.unwrap_or_else(|| "completed".to_string()),
                            ),
                        )));
                    }
                    OpencodeEvent::Error { error, .. } => {
                        received_error = true;
                        tracing::warn!(
                            "[OpencodeEngine] 事件 error, message={}",
                            error.message
                        );
                        event_callback(AIEvent::Error(ErrorEvent::new(
                            &current_session_id,
                            error.message,
                        )));
                    }
                }
            }

            // stdout EOF 处理
            tracing::info!(
                "[OpencodeEngine] stdout EOF, 共 {} 行, flags: finish={} text={} error={}",
                line_count,
                received_finish,
                received_text,
                received_error
            );
            //
            // 关键事实（实测 opencode v2.0.30 `opencode run --format json`）：
            // - 事件类型只有 step_start / text / tool_use / error 四类
            // - **没有 step_finish / session_end 事件**，即使有 token 用量也不会推
            // - 错误事件（如 provider.auth 401）通过 stdout 走，type=error
            // - 完成信号就是 stdout EOF
            //
            // 因此：
            //   - 收到 error 事件 → SessionEnd(Error)（error 事件本身已推送）
            //   - 否则只要收到过 text 或 finish → SessionEnd(Completed)
            //   - 完全无产出 → fallback error + SessionEnd(Error)
            //
            // 参考 ai_chat_core 的 SessionEndReason 语义：Completed 用于正常结束，
            // 前端据此关闭生成态。Error 触发前端错误态提示。
            //
            // T1 中断语义（spec 见 plans/opencode-integration-optimization.md §六）：
            //   判定顺序 1. interrupted（最优先：用户主动中断不是引擎故障）
            //              → 只补 SessionEnd(Aborted)，不发 fallback error / Completed
            //            2. 收到 error 事件 → SessionEnd(Error)
            //            3. 收到过 text 或 finish → SessionEnd(Completed)
            //            4. 完全无产出 → fallback error + SessionEnd(Error)
            let was_interrupted = {
                let set = interrupted_set.lock().ok();
                set.map(|s| s.contains(&current_session_id) || s.contains(&temp_id))
                    .unwrap_or(false)
            };
            // 消费标记：无论走哪个分支都清掉，防止跨轮次脏残留
            if let Ok(mut set) = interrupted_set.lock() {
                set.remove(&current_session_id);
                set.remove(&temp_id);
            }
            if was_interrupted {
                tracing::info!(
                    "[OpencodeEngine] 会话被用户中断 ({}), EOF 补发 SessionEnd(Aborted)",
                    current_session_id
                );
                event_callback(AIEvent::SessionEnd(
                    SessionEndEvent::new(&current_session_id)
                        .with_reason(SessionEndReason::Aborted),
                ));
            } else if received_error {
                // error 事件已在上面通过 event_callback 推送，这里只补 SessionEnd
                tracing::warn!(
                    "[OpencodeEngine] 收到 error 事件后 EOF，发送 SessionEnd(Error)"
                );
                event_callback(AIEvent::SessionEnd(
                    SessionEndEvent::new(&current_session_id)
                        .with_reason(SessionEndReason::Error),
                ));
            } else if received_finish || received_text {
                // 正常完成：opencode 无 step_finish/session_end，EOF 即完成信号
                event_callback(AIEvent::SessionEnd(
                    SessionEndEvent::new(&current_session_id)
                        .with_reason(SessionEndReason::Completed),
                ));
            } else {
                // 完全无产出 —— 构造 fallback error
                let stderr_summary = stderr_buf
                    .lock()
                    .map(|buf| {
                        let start = buf.len().saturating_sub(8);
                        buf[start..].join("\n")
                    })
                    .unwrap_or_default();
                let msg = if stderr_summary.trim().is_empty() {
                    "opencode CLI 异常退出，未产生任何输出".to_string()
                } else {
                    format!("opencode CLI 异常退出:\n{}", stderr_summary)
                };
                tracing::warn!("[OpencodeEngine] 未收到任何事件，发送 fallback error: {}", msg);
                event_callback(AIEvent::error(&current_session_id, msg));
                event_callback(AIEvent::SessionEnd(
                    SessionEndEvent::new(&current_session_id)
                        .with_reason(SessionEndReason::Error),
                ));
            }

            // T2：收割子进程真实退出状态并置位退出信号。
            // signal() 在 wait() 返回之后调用，保证「信号已置位 ⇒ 进程已退出」。
            match child.wait() {
                Ok(status) => {
                    tracing::info!(
                        "[OpencodeEngine] 子进程退出, code={:?}, was_interrupted={}",
                        status.code(),
                        was_interrupted
                    );
                }
                Err(e) => {
                    tracing::warn!("[OpencodeEngine] 子进程 wait 失败: {}", e);
                }
            }
            // 直接对本进程的信号置位（不查表）。查表会与 continue_session 的
            // “取走信号”发生竞态：若 continue 先移除表项，这里查不到就不置位，
            // 续接方的 bounded wait 必然超时误报。EOF 线程持有自身 Arc 即可解耦。
            exit_signal.signal();
            // 置位后清理本进程表项，避免信号表随会话累积。
            // 清理是安全的：能走到这里说明进程已 wait 退出；若 continue_session
            // 稍后查不到表项，说明旧进程确已死亡，放行续接即可（不会双写）。
            if let Ok(mut signals) = exit_signals.lock() {
                signals.remove(&temp_id);
            }

            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }

    /// 从 tool_use 事件发射 ToolCallStart / ToolCallEnd
    ///
    /// opencode 的 tool_use 事件是**完整快照**（含 input/output + status），
    /// 而非 Claude 的 start/end 两阶段。这里按 status 映射：
    /// - pending/running → ToolCallStart
    /// - completed → ToolCallStart + ToolCallEnd（让前端有完整生命周期）
    /// - error → ToolCallStart + ToolCallEnd(success=false)
    fn emit_tool_events(
        part: &ToolPart,
        session_id: &str,
        callback: &std::sync::Arc<dyn Fn(AIEvent) + Send + Sync>,
    ) {
        if part.tool.is_empty() {
            return;
        }
        let status = part.state.status.as_str();
        // 提取 input 为 args HashMap
        let args: HashMap<String, serde_json::Value> = if let Some(obj) = part.state.input.as_object()
        {
            obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        } else {
            HashMap::new()
        };

        // pending / running / completed / error 都先发 Start
        let mut start = ToolCallStartEvent::new(session_id, part.tool.clone(), args);
        if let Some(ref id) = part.call_id {
            start = start.with_call_id(id.clone());
        }
        callback(AIEvent::ToolCallStart(start));

        // completed / error 再发 End
        if status == "completed" || status == "error" {
            let success = status == "completed";
            let mut end = ToolCallEndEvent::new(session_id, part.tool.clone(), success);
            if let Some(ref id) = part.call_id {
                end = end.with_call_id(id.clone());
            }
            if let Some(ref output) = part.state.output {
                end = end.with_result(output.clone());
            }
            callback(AIEvent::ToolCallEnd(end));
        }
    }

    /// bounded 等待旧会话子进程真实退出（T2）
    ///
    /// 退出信号按 spawn 时传入的初始 ID（temp 或 real）索引，
    /// 会话参数 / 信息真实 ID / 别名都可能是该键，逐个尝试。
    /// - 找到信号：信号已置位 → 进程已确认退出，放行；
    ///   超时未置位 → 明确报错（调用方不得继续 spawn）。
    /// - 未找到信号：进程大概率早已结束（或引擎重启残留），warn 后放行。
    fn wait_session_exit(&self, candidate_ids: &[String]) -> Result<()> {
        let consumed_signal = {
            let mut map = self
                .exit_signals
                .lock()
                .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
            let found = candidate_ids.iter().find_map(|k| map.get(k).cloned());
            // 消费：无论超时与否都移除候选键，防止信号表残留
            for k in candidate_ids {
                map.remove(k);
            }
            found
        };

        let Some(signal) = consumed_signal else {
            tracing::warn!(
                "[OpencodeEngine] 未找到会话退出信号 (ids={:?})，跳过退出等待",
                candidate_ids
            );
            return Ok(());
        };

        if !signal.wait(std::time::Duration::from_secs(2)) {
            return Err(AppError::ProcessError(format!(
                "旧 opencode 进程未在 2s 内退出，中止续接以免新旧实例双写同一 opencode session (ids={:?})",
                candidate_ids
            )));
        }
        tracing::info!("[OpencodeEngine] 旧进程已确认退出 (ids={:?})", candidate_ids);
        Ok(())
    }
}

impl AIEngine for OpencodeEngine {
    fn id(&self) -> EngineId {
        EngineId::OpenCode
    }

    fn name(&self) -> &'static str {
        "OpenCode"
    }

    fn description(&self) -> &'static str {
        "开源 AI 编程 CLI（多 provider，支持免费模型）"
    }

    fn metadata(&self) -> EngineMetadata {
        EngineMetadata {
            id: EngineId::OpenCode,
            name: "OpenCode".into(),
            description: Some(
                "开源 AI 编程 CLI — 支持多 provider、免费模型（GLM/DeepSeek 等）、\
                 工具调用、流式输出与会话续接"
                    .into(),
            ),
            distribution: EngineDistribution::PackageRunner {
                package: "opencode".into(),
                cmd: "opencode".into(),
                args: vec![],
                runtime_min_version: Some("18.0.0".into()),
            },
            capabilities: EngineCapabilities {
                tools: true,
                image_input: false, // opencode 图片输入能力待验证
                streaming: true,
                interrupt: true,
                resume: true,
                stdin_input: false, // --print 模式不支持 stdin 交互
                fork_session: false,
            },
            env_keys: EnvKeyMapping {
                base_url: "OPENAI_BASE_URL",
                api_key: "OPENAI_API_KEY",
                model: "OPENAI_MODEL",
            },
            supports_model_provider: true,
            install_guide: Some("npm install -g opencode".into()),
            npm_package: Some("opencode".into()),
            install_url: None,
            stable: false,
        }
    }

    fn is_available(&self) -> bool {
        // 实际可用性检查在 start_session 入口完成
        true
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        tracing::info!("[OpencodeEngine] 启动会话，消息长度: {}", message.len());
        tracing::info!("[OpencodeEngine] 工作目录: {:?}", options.work_dir);
        tracing::info!("[OpencodeEngine] 模型: {:?}", options.model);

        // 构建命令（start_session 不带 --session，新建会话）
        let mut cmd = self.build_command(message, None, options.model.as_deref())?;
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[OpencodeEngine] 执行命令: {}", cmd_str);

        let child = cmd
            .spawn()
            .map_err(|e| Self::map_spawn_error(e, message.len(), "启动 opencode 进程失败"))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();
        tracing::info!(
            "[OpencodeEngine] 进程启动，PID: {}, 临时 ID: {}",
            pid,
            temp_id
        );

        // T2：注册退出信号（在 spawn_event_reader 之前，EOF 线程持有同一 Arc 置位）
        let exit_signal = std::sync::Arc::new(ExitSignal::new());
        if let Ok(mut signals) = self.exit_signals.lock() {
            signals.insert(temp_id.clone(), std::sync::Arc::clone(&exit_signal));
        }

        let input_sender =
            self.spawn_event_reader(child, temp_id.clone(), pid, options, exit_signal);

        self.sessions.register_with_sender(
            temp_id.clone(),
            pid,
            "opencode".to_string(),
            Some(input_sender),
        )?;

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!(
            "[OpencodeEngine] 继续会话: {}, 消息长度: {}",
            session_id,
            message.len()
        );

        // 获取真实 session_id 并终止旧进程
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!(
                "[OpencodeEngine] 找到会话，真实 ID: {}, PID: {}",
                info.id,
                info.pid
            );
            let _ = self.sessions.kill_process(session_id);
            // T2：等待旧进程真实退出（bounded），替代原 sleep(100ms) 的超时掩盖。
            // 信号未置位则明确报错、不 spawn —— 旧实例未死时新旧两个 opencode
            // 进程会写同一 opencode session（双写竞态，AGENTS 禁止）。
            let mut wait_ids = vec![session_id.to_string(), info.id.clone()];
            wait_ids.extend(info.aliases.iter().cloned());
            self.wait_session_exit(&wait_ids)?;
            info.id.clone()
        } else {
            tracing::warn!("[OpencodeEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        let work_dir = options.work_dir.clone().or_else(|| {
            self.config
                .work_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        });

        // 构建命令（带 --session 续接）
        let mut cmd = self.build_command(
            message,
            Some(&real_session_id),
            options.model.as_deref(),
        )?;
        self.configure_command(&mut cmd, work_dir.as_deref(), &options.env_overrides);

        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[OpencodeEngine] 执行命令: {}", cmd_str);

        let child = cmd
            .spawn()
            .map_err(|e| Self::map_spawn_error(e, message.len(), "继续 opencode 会话失败"))?;

        let pid = child.id();
        tracing::info!("[OpencodeEngine] 进程启动，PID: {}", pid);

        // T1：中断标记清理——续接是新的一轮对话，不复用旧标记
        self.sessions.clear_interrupted(&real_session_id);
        // T2：注册新退出信号（在 spawn_event_reader 之前，键 = 本次 spawn 的初始 ID）
        let exit_signal = std::sync::Arc::new(ExitSignal::new());
        if let Ok(mut signals) = self.exit_signals.lock() {
            signals.insert(real_session_id.clone(), std::sync::Arc::clone(&exit_signal));
        }

        let input_sender = self.spawn_event_reader(
            child,
            real_session_id.clone(),
            pid,
            options,
            exit_signal,
        );

        self.sessions.register_with_sender(
            real_session_id.clone(),
            pid,
            "opencode".to_string(),
            Some(input_sender),
        )?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[OpencodeEngine] 中断会话: {}", session_id);
        // 先标记后杀（明确顺序，T1）：mark_interrupted → kill_process。
        // EOF 线程读到标记后回发 SessionEnd(Aborted)（用户中断），
        // 而非走「无产出 fallback error + SessionEnd(Error)」把主动中断当引擎故障。
        self.sessions.mark_interrupted(session_id);
        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[OpencodeEngine] 会话已中断: {}", session_id);
                Ok(())
            }
            Ok(false) => Err(AppError::ProcessError(format!(
                "会话不存在或 kill 失败: {}",
                session_id
            ))),
            Err(e) => Err(e),
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        tracing::info!(
            "[OpencodeEngine] 向会话 {} 发送输入: {} bytes",
            session_id,
            input.len()
        );
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }

    fn update_config(&mut self, new_config: Config) {
        tracing::info!("[OpencodeEngine] 应用新配置");
        self.config = new_config;
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_step_start_extracts_session_id() {
        let line = r#"{"type":"step_start","sessionID":"ses_abc123","part":{"type":"step-start"}}"#;
        let event = OpencodeEvent::parse_line(line).expect("应解析成功");
        match event {
            OpencodeEvent::StepStart { session_id, .. } => {
                assert_eq!(session_id, "ses_abc123");
            }
            _ => panic!("应为 StepStart"),
        }
    }

    #[test]
    fn parse_text_event() {
        let line = r#"{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"hello"}}"#;
        let event = OpencodeEvent::parse_line(line).expect("应解析成功");
        match event {
            OpencodeEvent::Text { part, .. } => {
                assert_eq!(part.text, "hello");
            }
            _ => panic!("应为 Text"),
        }
    }

    #[test]
    fn parse_tool_use_completed() {
        let line = r#"{"type":"tool_use","sessionID":"ses_x","part":{"type":"tool","tool":"read","id":"call_1","state":{"status":"completed","input":{"path":"a.txt"},"output":"content"}}}"#;
        let event = OpencodeEvent::parse_line(line).expect("应解析成功");
        match event {
            OpencodeEvent::ToolUse { part, .. } => {
                assert_eq!(part.tool, "read");
                assert_eq!(part.state.status, "completed");
                assert!(part.state.output.is_some());
            }
            _ => panic!("应为 ToolUse"),
        }
    }

    #[test]
    fn parse_step_finish_with_tokens() {
        let line = r#"{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"end-turn","tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":200,"write":0}}}}"#;
        let event = OpencodeEvent::parse_line(line).expect("应解析成功");
        match event {
            OpencodeEvent::StepFinish { part, .. } => {
                assert_eq!(part.reason.as_deref(), Some("end-turn"));
                let tokens = part.tokens.expect("应有 tokens");
                assert_eq!(tokens.input, 100);
                assert_eq!(tokens.output, 50);
                let cache = tokens.cache.expect("应有 cache");
                assert_eq!(cache.read, 200);
            }
            _ => panic!("应为 StepFinish"),
        }
    }

    #[test]
    fn parse_error_event() {
        let line = r#"{"type":"error","sessionID":"ses_x","error":{"type":"provider.auth","message":"Missing API key"}}"#;
        let event = OpencodeEvent::parse_line(line).expect("应解析成功");
        match event {
            OpencodeEvent::Error { error, .. } => {
                assert_eq!(error.message, "Missing API key");
            }
            _ => panic!("应为 Error"),
        }
    }

    #[test]
    fn parse_empty_line_returns_none() {
        assert!(OpencodeEvent::parse_line("").is_none());
        assert!(OpencodeEvent::parse_line("   ").is_none());
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(OpencodeEvent::parse_line("not json").is_none());
        assert!(OpencodeEvent::parse_line("{broken").is_none());
    }
}
