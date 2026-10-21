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
use crate::services::mcp_config_service::ResolvedExternalMcpServer;

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
    /// 未知事件类型（前向兼容兜底，R4-1）
    ///
    /// opencode 新版本新增的事件 type（如 reasoning/image/compaction）不应整行
    /// 静默丢弃——那是「协议无运行时 schema 校验」缺口的实例。用 `#[serde(other)]`
    /// 保住「这一行是有效事件、只是我们不认识」的信息，解析处 debug 日志 +
    /// unknown 计数进入 EOF 诊断摘要，版本漂移可排查。
    #[serde(other)]
    Unknown,
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

/// opencode error 事件文案 → 用户可读的中文提示
///
/// 根因（进程树实测，见 plans/opencode-integration-optimization.md）：
/// opencode run 是连接共享后台服务（`serve --service`）的客户端，其 error 事件
/// 常携带 Bun 内部 fetch 报错原文，例如
/// "Transport: The socket connection was closed unexpectedly. For more
/// information, pass `verbose: true` in the second argument to fetch()"。
/// 用户无法据此判断是引擎故障还是网络问题。此类传输错误多为瞬态，重试即可恢复。
/// 映射策略：已知传输/认证模式 → 友好文案 + 附加压缩为一行的原始错误（供排障）；
/// 未知文案原样透传，保证 opencode 新版本错误仍可见、不吞错。
fn friendly_error_message(raw: &str) -> String {
    const PATTERNS: &[(&str, &str)] = &[
        (
            "The socket connection was closed unexpectedly",
            "opencode 连接中断（本地服务或网络波动），可重试发送",
        ),
        ("ConnectionRefused", "opencode 无法连接目标服务，请确认服务运行后重试"),
        ("Unable to connect", "opencode 无法连接目标服务，请确认服务运行后重试"),
        (
            "ENOTFOUND",
            "opencode 域名解析失败，请检查网络或代理设置",
        ),
        (
            "Missing Authentication header",
            "opencode provider 缺少认证信息，请在 `opencode auth login` 配置凭据",
        ),
        (
            "Missing API key",
            "opencode provider 缺少 API key，请在 `opencode auth login` 配置凭据",
        ),
        (
            "Invalid API key",
            "opencode provider API key 无效，请在 `opencode auth login` 重新配置",
        ),
    ];
    let Some(friendly) = PATTERNS
        .iter()
        .find_map(|(needle, text)| raw.contains(needle).then_some(*text))
    else {
        return raw.to_string();
    };
    // 压缩原始错误为单行并截断：Bun 报错可能带多行堆栈，直接透出会淹没友好文案
    let mut condensed: String = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if condensed.chars().count() > 200 {
        condensed = condensed.chars().take(200).collect();
        condensed.push_str("……");
    }
    format!("{}\n（原始错误：{}）", friendly, condensed)
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

/// 会话期注入文件（R-MCP 桥接 + R4-2 长消息共用）
///
/// 会话结束（EOF 线程收尾）时统一清理，恢复工作区/临时目录原状。
/// Polaris 崩溃场景可能残留（无法执行收尾）；`Delete` 残留仅为会话新建的
/// 注入文件，无破坏性（详见 write_mcp_bridge_config 注释）。
enum SessionFileCleanup {
    /// 删除本次会话新建的文件
    Delete(std::path::PathBuf),
}

impl SessionFileCleanup {
    fn apply(&self) {
        let Self::Delete(path) = self;
        if let Err(e) = std::fs::remove_file(path) {
            tracing::debug!(
                "[OpencodeEngine] 会话注入文件清理失败 ({}): {}",
                path.display(),
                e
            );
        } else {
            tracing::debug!(
                "[OpencodeEngine] 会话注入文件已清理: {}",
                path.display()
            );
        }
    }
}

/// 把 Polaris 解析的 MCP server 列表转换为 opencode 项目配置的 `mcp` 段（R-MCP）
///
/// 形状（实测 v2.0.30 可用）：`{"mcp": {"<name>": {"type": "local",
/// "command": ["<cmd>", "<args...>"], "enabled": true}}}`。
fn build_opencode_mcp_config(servers: &[ResolvedExternalMcpServer]) -> serde_json::Value {
    let mut mcp = serde_json::Map::new();
    for srv in servers {
        let mut command = vec![srv.command.clone()];
        command.extend(srv.args.iter().cloned());
        mcp.insert(
            srv.server_name.clone(),
            serde_json::json!({
                "type": "local",
                "command": command,
                "enabled": true,
            }),
        );
    }
    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": mcp,
    })
}

/// opencode CLI 引擎
pub struct OpencodeEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// 子进程退出信号表: 会话初始 ID（temp 或 real）-> 退出信号
    exit_signals: std::sync::Arc<std::sync::Mutex<HashMap<String, std::sync::Arc<ExitSignal>>>>,
    /// CLI 可用性缓存（R4-3，需求 6）：None=未探测，Some=已探测结果。
    ///
    /// `where`/`which` 每次调用都会 spawn 子进程，前端引擎列表/会话入口会
    /// 反复调用 `is_available`，不能每次都查。探测一次缓存结果；包装命中
    /// 失败的锁（poisoned）也继续读，保证不 panic（与 AGENTS「不把环境受限
    /// 写成通过」无冲突——锁毒化仅影响缓存读写，行为退化为每次重查）。
    cli_available: std::sync::Mutex<Option<bool>>,
}

impl OpencodeEngine {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            exit_signals: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            cli_available: std::sync::Mutex::new(None),
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
        via_file: Option<&std::path::Path>,
        resume_session: Option<&str>,
        model: Option<&str>,
    ) -> Result<Command> {
        let cli_path = self.get_cli_path()?;
        let mut cmd = Command::new(&cli_path);
        cmd.arg("run");

        match via_file {
            None => {
                // 消息作为位置参数（opencode run <message>）
                cmd.arg(message);
            }
            Some(file) => {
                // R4-2：超长消息经临时文件挂载（`--file <path>`）。
                // 实测（Rev4 证据 1）：位置参数必须存在（空串报 "You must
                // provide a message"），用 "." 占位即可，文件内容完整送达
                // 模型（回复 OK 验证）。位置参数不给真实短消息是避免消息
                // 语义分叉——长文本全量在附件里。
                cmd.arg(".");
                cmd.args(["--file", &file.to_string_lossy()]);
            }
        }

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

    /// R4-2：消息走命令行参数的字节上限，超出即写临时文件走 `--file` 挂载。
    ///
    /// Windows CreateProcess 命令行约 32767 UTF-16 字符上限；Rust std 对
    /// `.cmd` 需要 cmd.exe 批处理包装（单行 ~8191 字符限制），加上引号/转义
    /// 膨胀与 cli 路径/flags 占位，取 6000 字节留足余量（粘贴大段代码/
    /// 大 diff 的常态长度远超此值，前置校验显式分流而非靠事后 OS error 206）。
    const MESSAGE_ARG_MAX_BYTES: usize = 6_000;

    /// 把超长消息写入临时文件供 `--file` 挂载（R4-2）
    ///
    /// 文件生命周期由调用方管理：spawn 失败立即删除；成功则由 EOF 读取线程
    /// 收尾删除。清理失败仅 debug（系统临时目录有 OS 级回收兜底）。
    fn write_message_file(message: &str) -> Result<std::path::PathBuf> {
        let name = format!("polaris-opencode-msg-{}.txt", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, message).map_err(|e| {
            AppError::ProcessError(format!("写入临时消息文件失败 ({}): {}", path.display(), e))
        })?;
        Ok(path)
    }

    /// 在工作区写入项目级 opencode.json 注入 MCP 桥接（R-MCP）
    ///
    /// 实测（Rev4/Rev5 证据）：opencode 按工作目录（cwd）读取项目级
    /// `opencode.json` 的 `mcp` 段；`OPENCODE_CONFIG` env 不被 v2.0.30 认可，
    /// 全局配置则跨项目生效且无法承载每会话动态参数（ask/dispatch 的
    /// --polaris-port/--polaris-token）——因此注入走 cwd 项目级文件。
    ///
    /// v1 安全策略：**工作区已有 opencode.json 时跳过注入**（不合并/覆盖
    /// 用户自有 opencode 配置，合并存在 JSONC 解析失败与崩溃残留覆盖语义
    /// 风险；跳过时引擎按无 MCP 工具运行，warn 可观测）。
    ///
    /// 文件生命周期：会话 EOF 删除（工作区恢复原状）。Polaris 崩溃可能残留；
    /// 残留无破坏性——只对 cwd 内使用 opencode 的用户多暴露 Polaris 内置
    /// MCP 工具，删除文件即恢复。
    ///
    /// 返回 None 表示未注入（无 server / 已有配置 / 写入失败），调用方照常启动。
    fn write_mcp_bridge_config(
        workspace_dir: &str,
        servers: &[ResolvedExternalMcpServer],
    ) -> Option<SessionFileCleanup> {
        if servers.is_empty() {
            return None;
        }
        let path = std::path::Path::new(workspace_dir).join("opencode.json");
        if path.exists() {
            tracing::warn!(
                "[OpencodeEngine] 工作区已有 opencode.json，跳过 Polaris MCP 注入 ({})",
                path.display()
            );
            return None;
        }
        let content = build_opencode_mcp_config(servers);
        let rendered = match serde_json::to_string_pretty(&content) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("[OpencodeEngine] MCP 桥接配置序列化失败: {}", e);
                return None;
            }
        };
        if let Err(e) = std::fs::write(&path, rendered) {
            tracing::warn!("[OpencodeEngine] 写入 MCP 桥接配置失败 ({}): {}", path.display(), e);
            return None;
        }
        tracing::info!(
            "[OpencodeEngine] 已注入 Polaris MCP 桥接: {} 个 server → {}",
            servers.len(),
            path.display()
        );
        Some(SessionFileCleanup::Delete(path))
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
        // R4-2 / R-MCP：会话期注入文件（长消息临时文件、MCP 桥接配置），
        // EOF 收尾统一删除，恢复工作区/临时目录原状
        cleanup_files: Vec<SessionFileCleanup>,
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
                    // R4-5: stderr 每行降为 debug。正常启动（node 子进程等）
                    // 也会输出噪音，warn 会高频落盘；内容仍进 stderr_buf，
                    // 异常退出时 fallback 摘要使用，不丢失排障信息。
                    tracing::debug!("[OpencodeEngine] stderr: {}", line);
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
            // R4-1：无法识别的事件 type 计数，进入 EOF 诊断摘要（版本漂移排查）
            let mut unknown_count: usize = 0;
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
                // R4-5：stdout 数据流日志降为 debug。此前为定位「应用内偶发无回复」
                // 临时开的逐行 info，问题已定位（共享服务连坐，Rev3），生产数据流
                // 不应逐行 info 落盘（AGENTS 日志约定：debug 高频诊断，生产不落盘）。
                tracing::debug!(
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
                        tracing::debug!(
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
                            tracing::debug!(
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
                        tracing::debug!(
                            "[OpencodeEngine] 事件 tool_use, tool={}, status={}",
                            part.tool,
                            part.state.status
                        );
                        Self::emit_tool_events(&part, &current_session_id, &event_callback);
                    }
                    OpencodeEvent::StepFinish { part, .. } => {
                        received_finish = true;
                        tracing::debug!(
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
                        // 原始 Bun fetch 报错对用户不可读（如 socket closed），映射为友好文案
                        let friendly = friendly_error_message(&error.message);
                        tracing::warn!(
                            "[OpencodeEngine] 事件 error, message={} → friendly={}",
                            error.message,
                            friendly
                        );
                        event_callback(AIEvent::Error(ErrorEvent::new(
                            &current_session_id,
                            friendly,
                        )));
                    }
                    OpencodeEvent::Unknown => {
                        unknown_count += 1;
                        // serde 无法在 other 变体捕获 tag 值，type 名从原始行提取
                        let type_name = serde_json::from_str::<serde_json::Value>(trimmed)
                            .ok()
                            .and_then(|v| v.get("type").and_then(|t| t.as_str().map(String::from)))
                            .unwrap_or_else(|| "<no-type-field>".to_string());
                        tracing::debug!(
                            "[OpencodeEngine] 未知事件 type={} (行 #{}), 原文: {}",
                            type_name,
                            line_count,
                            preview
                        );
                    }
                }
            }

            // stdout EOF 处理
            tracing::info!(
                "[OpencodeEngine] stdout EOF, 共 {} 行, unknown={}, flags: finish={} text={} error={}",
                line_count,
                unknown_count,
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
            // R4-2 / R-MCP：进程已退出，会话注入文件统一清理
            for cleanup in &cleanup_files {
                cleanup.apply();
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
        // R4-3（需求 6）：缓存 get_cli_path 结果。此前恒 true，前端引擎列表
        // 对 opencode 永远「可用」，未安装时只能等 spawn 失败才发现。
        // 首查真实探测，结果缓存供后续调用（含 false——前端据此展示
        // install_guide 引导）。缓存副作用：会话期间安装 opencode 需重启
        // 应用刷新，属可接受取舍（引擎实例随应用生命周期重建）。
        if let Ok(cached) = self.cli_available.lock() {
            if let Some(v) = *cached {
                return v;
            }
        }
        let ok = self.get_cli_path().is_ok();
        if let Ok(mut cache) = self.cli_available.lock() {
            *cache = Some(ok);
        }
        tracing::info!("[OpencodeEngine] is_available 探测结果: {}", ok);
        ok
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        tracing::info!("[OpencodeEngine] 启动会话，消息长度: {}", message.len());
        tracing::info!("[OpencodeEngine] 工作目录: {:?}", options.work_dir);
        tracing::info!("[OpencodeEngine] 模型: {:?}", options.model);

        // 构建命令（start_session 不带 --session，新建会话）
        // R4-2 前置校验：超长消息分流到临时文件走 --file，不靠事后 OS error 206
        let msg_file = if message.len() > Self::MESSAGE_ARG_MAX_BYTES {
            Some(Self::write_message_file(message)?)
        } else {
            None
        };
        // R-MCP：注入桥接配置（仅当工作区无 opencode.json 时创建新文件，
        // EOF 线程统一删除恢复工作区原状；已有配置则跳过注入）
        let bridge_work_dir = options.work_dir.clone().or_else(|| {
            self.config
                .work_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        });
        let mcp_bridge = bridge_work_dir
            .as_deref()
            .and_then(|wd| Self::write_mcp_bridge_config(wd, &options.mcp_servers));
        let mut cmd = match self.build_command(
            message,
            msg_file.as_deref(),
            None,
            options.model.as_deref(),
        ) {
            Ok(c) => c,
            Err(e) => {
                // 构建失败同样无人消费注入文件，立即清理
                if let Some(b) = &mcp_bridge {
                    b.apply();
                }
                if let Some(f) = &msg_file {
                    let _ = std::fs::remove_file(f);
                }
                return Err(e);
            }
        };
        self.configure_command(&mut cmd, options.work_dir.as_deref(), &options.env_overrides);

        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[OpencodeEngine] 执行命令: {}", cmd_str);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // spawn 失败时注入文件无人消费，立即清理防泄漏
                if let Some(b) = &mcp_bridge {
                    b.apply();
                }
                if let Some(f) = &msg_file {
                    let _ = std::fs::remove_file(f);
                }
                return Err(Self::map_spawn_error(
                    e,
                    message.len(),
                    "启动 opencode 进程失败",
                ));
            }
        };

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

        // R4-2 / R-MCP：注入文件统一移交 EOF 线程收尾（msg_file 与
        // build_command 的借用已结束，此处可安全 move）
        let mut cleanup_files: Vec<SessionFileCleanup> = Vec::new();
        if let Some(b) = mcp_bridge {
            cleanup_files.push(b);
        }
        if let Some(f) = msg_file {
            cleanup_files.push(SessionFileCleanup::Delete(f));
        }
        let input_sender = self.spawn_event_reader(
            child,
            temp_id.clone(),
            pid,
            options,
            exit_signal,
            cleanup_files,
        );

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
        // R4-2 前置校验：续接消息同样可能很长（追加代码/说明），与 start 同规则分流
        let msg_file = if message.len() > Self::MESSAGE_ARG_MAX_BYTES {
            Some(Self::write_message_file(message)?)
        } else {
            None
        };
        // R-MCP：与 start_session 同规则注入桥接配置（续接是新进程，同样
        // 需要读到 cwd 项目级 opencode.json 才能挂上 Polaris MCP server）
        let mcp_bridge = work_dir
            .as_deref()
            .and_then(|wd| Self::write_mcp_bridge_config(wd, &options.mcp_servers));
        let mut cmd = match self.build_command(
            message,
            msg_file.as_deref(),
            Some(&real_session_id),
            options.model.as_deref(),
        ) {
            Ok(c) => c,
            Err(e) => {
                // 构建失败同样无人消费注入文件，立即清理
                if let Some(b) = &mcp_bridge {
                    b.apply();
                }
                if let Some(f) = &msg_file {
                    let _ = std::fs::remove_file(f);
                }
                return Err(e);
            }
        };
        self.configure_command(&mut cmd, work_dir.as_deref(), &options.env_overrides);

        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[OpencodeEngine] 执行命令: {}", cmd_str);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if let Some(b) = &mcp_bridge {
                    b.apply();
                }
                if let Some(f) = &msg_file {
                    let _ = std::fs::remove_file(f);
                }
                return Err(Self::map_spawn_error(
                    e,
                    message.len(),
                    "继续 opencode 会话失败",
                ));
            }
        };

        let pid = child.id();
        tracing::info!("[OpencodeEngine] 进程启动，PID: {}", pid);

        // T1：中断标记清理——续接是新的一轮对话，不复用旧标记
        self.sessions.clear_interrupted(&real_session_id);
        // T2：注册新退出信号（在 spawn_event_reader 之前，键 = 本次 spawn 的初始 ID）
        let exit_signal = std::sync::Arc::new(ExitSignal::new());
        if let Ok(mut signals) = self.exit_signals.lock() {
            signals.insert(real_session_id.clone(), std::sync::Arc::clone(&exit_signal));
        }

        // R4-2 / R-MCP：注入文件统一移交 EOF 线程收尾
        let mut cleanup_files: Vec<SessionFileCleanup> = Vec::new();
        if let Some(b) = mcp_bridge {
            cleanup_files.push(b);
        }
        if let Some(f) = msg_file {
            cleanup_files.push(SessionFileCleanup::Delete(f));
        }
        let input_sender = self.spawn_event_reader(
            child,
            real_session_id.clone(),
            pid,
            options,
            exit_signal,
            cleanup_files,
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

    #[test]
    fn parse_unknown_type_falls_back_to_unknown_variant() {
        // R4-1：未知 type 是有效 JSONL 事件，不应丢弃（serde other 兜底）
        let line = r#"{"type":"compaction","sessionID":"ses_x","part":{"type":"compaction"}}"#;
        let event = OpencodeEvent::parse_line(line).expect("未知 type 应兜底为 Unknown 而非丢行");
        assert!(matches!(event, OpencodeEvent::Unknown));
    }

    #[test]
    fn message_threshold_splits_arg_and_file_routes() {
        // R4-2：短消息走命令行参数（阈值以下），粘贴代码/大 diff（阈值以上）走 --file
        assert!(1_000 < OpencodeEngine::MESSAGE_ARG_MAX_BYTES);
        assert!(OpencodeEngine::MESSAGE_ARG_MAX_BYTES < 10_000);
    }

    #[test]
    fn friendly_error_maps_socket_closed() {
        // Bun fetch 真实报错原文（2026-10-17 分析记录）
        let raw = "Transport: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
        let out = friendly_error_message(raw);
        assert!(out.contains("连接中断"), "应包含友好文案，实际: {}", out);
        assert!(out.contains("原始错误"), "应附带原始错误，实际: {}", out);
    }

    #[test]
    fn friendly_error_maps_multi_line_stack_condensed() {
        let raw = "AI.Error: ConnectionRefused: Unable to connect. Is the computer able to access the url?\n    at <anonymous> (B:/~BUN/root/chunk-sh3q3pe9.js:6:26193)\n    at <anonymous> (B:/~BUN/root/chunk-jjyjbx8w.js:2:43639)";
        let out = friendly_error_message(raw);
        assert!(out.contains("无法连接"));
        assert!(!out.contains('\n'), "原始错误应压缩为单行: {}", out);
    }

    #[test]
    fn friendly_error_maps_missing_api_key() {
        let out = friendly_error_message("Missing API key");
        assert!(out.contains("缺少 API key"));
        assert!(out.contains("opencode auth login"));
    }

    #[test]
    fn friendly_error_passthrough_unknown() {
        assert_eq!(
            friendly_error_message("some unknown failure"),
            "some unknown failure"
        );
    }

    fn sample_server(name: &str) -> ResolvedExternalMcpServer {
        ResolvedExternalMcpServer {
            plugin_id: "builtin".to_string(),
            server_name: name.to_string(),
            command: "C:\\polaris\\polaris-mcp.exe".to_string(),
            args: vec![
                "requirements".to_string(),
                "C:\\config".to_string(),
                "C:\\ws".to_string(),
            ],
            builtin: true,
        }
    }

    #[test]
    fn build_opencode_mcp_config_maps_command_and_args() {
        // R-MCP：server 列表 → opencode.json 的 mcp 段（command 数组 = [cmd, ...args]）
        let servers = vec![sample_server("polaris-requirements")];
        let config = build_opencode_mcp_config(&servers);
        assert_eq!(config["$schema"], "https://opencode.ai/config.json");
        let srv = &config["mcp"]["polaris-requirements"];
        assert_eq!(srv["type"], "local");
        assert_eq!(srv["enabled"], true);
        let cmd = srv["command"].as_array().expect("command 应为数组");
        assert_eq!(cmd.len(), 4, "command+3 个 args");
        assert_eq!(cmd[0], "C:\\polaris\\polaris-mcp.exe");
        assert_eq!(cmd[3], "C:\\ws");
    }

    #[test]
    fn build_opencode_mcp_config_empty_servers_yields_empty_mcp() {
        let config = build_opencode_mcp_config(&[]);
        assert!(config["mcp"].as_object().unwrap().is_empty());
    }

    #[test]
    fn write_mcp_bridge_config_creates_and_cleans_up() {
        // R-MCP：无 opencode.json 时写入 + EOF 删除恢复原状
        let dir = std::env::temp_dir().join(format!("polaris-oc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wd = dir.to_string_lossy().to_string();
        let server = sample_server("polaris-ask");
        let cleanup = OpencodeEngine::write_mcp_bridge_config(&wd, std::slice::from_ref(&server))
            .expect("工作区干净时应注入");
        let cfg_path = dir.join("opencode.json");
        assert!(cfg_path.exists(), "注入文件应存在");
        let raw = std::fs::read_to_string(&cfg_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            parsed["mcp"]["polaris-ask"]["enabled"],
            serde_json::Value::Bool(true)
        );
        cleanup.apply();
        assert!(!cfg_path.exists(), "apply 后注入文件应删除");
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_mcp_bridge_config_skips_existing_config() {
        // R-MCP v1 安全策略：用户已有 opencode.json → 跳过注入，不动用户文件
        let dir =
            std::env::temp_dir().join(format!("polaris-oc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_path = dir.join("opencode.json");
        std::fs::write(&cfg_path, "{\n  \"mcp\": {},\n  // jsonc 用户注释\n}").unwrap();
        let wd = dir.to_string_lossy().to_string();
        let server = sample_server("polaris-ask");
        let before = std::fs::read_to_string(&cfg_path).unwrap();
        assert!(
            OpencodeEngine::write_mcp_bridge_config(&wd, std::slice::from_ref(&server)).is_none(),
            "已有配置应返回 None"
        );
        assert_eq!(
            std::fs::read_to_string(&cfg_path).unwrap(),
            before,
            "用户文件内容不应被修改"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_mcp_bridge_config_no_servers_is_none() {
        let dir =
            std::env::temp_dir().join(format!("polaris-oc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            OpencodeEngine::write_mcp_bridge_config(&dir.to_string_lossy(), &[]).is_none(),
            "无 server 不应注入"
        );
        assert!(
            !dir.join("opencode.json").exists(),
            "无 server 不应写任何文件"
        );
        let _ = std::fs::remove_dir(&dir);
    }
}
