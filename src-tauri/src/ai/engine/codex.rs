use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use super::codex_parser::{
    codex_event_to_ai_events, extract_event_type, parse_codex_line, CodexEvent,
};
use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::AIEvent;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

const CODEX_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

fn codex_generated_images_dir(thread_id: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex").join("generated_images").join(thread_id))
}

fn is_safe_codex_artifact_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !value.contains("..")
}

fn list_codex_generated_image_names(thread_id: &str) -> BTreeSet<String> {
    if !is_safe_codex_artifact_segment(thread_id) {
        return BTreeSet::new();
    }

    let Some(dir) = codex_generated_images_dir(thread_id) else {
        return BTreeSet::new();
    };

    let Ok(entries) = std::fs::read_dir(dir) else {
        return BTreeSet::new();
    };

    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }

            let ext = path
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| v.to_ascii_lowercase())?;

            if !CODEX_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                return None;
            }

            path.file_name()
                .and_then(|v| v.to_str())
                .filter(|name| is_safe_codex_artifact_segment(name))
                .map(|v| v.to_string())
        })
        .collect()
}

fn build_codex_generated_images_markdown(
    thread_id: &str,
    initial_images: &BTreeSet<String>,
) -> Option<String> {
    let current_images = list_codex_generated_image_names(thread_id);
    build_codex_generated_images_markdown_for_names(thread_id, initial_images, current_images)
}

fn build_codex_generated_images_markdown_for_names(
    thread_id: &str,
    initial_images: &BTreeSet<String>,
    current_images: BTreeSet<String>,
) -> Option<String> {
    let new_images: Vec<&String> = current_images.difference(initial_images).collect();

    if new_images.is_empty() {
        return None;
    }

    let lines = new_images
        .into_iter()
        .map(|file_name| {
            format!(
                "![Codex 生成图片](/api/artifacts/codex-images/{}/{})",
                thread_id, file_name
            )
        })
        .collect::<Vec<_>>();

    Some(lines.join("\n\n"))
}

fn decode_process_output_line(bytes: &[u8]) -> (String, Option<&'static str>) {
    match std::str::from_utf8(bytes) {
        Ok(line) => (line.to_string(), None),
        Err(_) => {
            #[cfg(windows)]
            {
                // Windows CLI wrappers and child tools can occasionally leak
                // CP936/GBK bytes into otherwise JSONL stdout. Keep reading the
                // stream instead of tearing down Codex's stdout pipe.
                let (decoded, had_errors) = encoding_rs::GBK.decode_without_bom_handling(bytes);
                if !had_errors {
                    return (decoded.into_owned(), Some("gbk"));
                }
            }

            (
                String::from_utf8_lossy(bytes).into_owned(),
                Some("utf8-lossy"),
            )
        }
    }
}

fn hex_preview(bytes: &[u8], max_len: usize) -> String {
    bytes
        .iter()
        .take(max_len)
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join(" ")
}

/// OpenAI Codex CLI 引擎
pub struct CodexEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
}

impl CodexEngine {
    /// 创建新的 Codex 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
        }
    }

    /// 获取 Codex CLI 路径
    ///
    /// 查找顺序：
    /// 1. 配置文件中的 codex_code.cli_path
    /// 2. CODEX_PATH 环境变量
    /// 3. Windows: %APPDATA%\npm\codex.cmd（npm 全局安装）
    /// 4. Windows: where codex（PATH 查找）
    /// 5. 默认 "codex"
    fn get_cli_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.cli_path {
            return Ok(path.clone());
        }

        // 1. 配置文件中的路径（用户可自定义）
        let config_path = self.config.get_codex_cmd();
        if config_path != "codex" && !config_path.is_empty() {
            // 用户自定义了路径，直接使用
            tracing::info!("[CodexEngine] 使用配置路径: {}", config_path);
            self.cli_path = Some(config_path.clone());
            return Ok(config_path);
        }

        // 2. 环境变量
        if let Ok(path) = std::env::var("CODEX_PATH") {
            if !path.is_empty() {
                tracing::info!("[CodexEngine] 使用 CODEX_PATH 环境变量: {}", path);
                self.cli_path = Some(path.clone());
                return Ok(path);
            }
        }

        // 3. Windows: 探测 npm 全局安装路径
        #[cfg(windows)]
        {
            // %APPDATA%\npm\codex.cmd
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_codex = PathBuf::from(&appdata).join("npm").join("codex.cmd");
                if npm_codex.exists() {
                    let path_str = npm_codex.to_string_lossy().to_string();
                    tracing::info!("[CodexEngine] 在 APPDATA\\npm 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            // %PNPM_HOME%\codex.cmd
            if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
                let pnpm_codex = PathBuf::from(&pnpm_home).join("codex.cmd");
                if pnpm_codex.exists() {
                    let path_str = pnpm_codex.to_string_lossy().to_string();
                    tracing::info!("[CodexEngine] 在 PNPM_HOME 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            // %LOCALAPPDATA%\pnpm\codex.cmd
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                let pnpm_codex = PathBuf::from(&localappdata).join("pnpm").join("codex.cmd");
                if pnpm_codex.exists() {
                    let path_str = pnpm_codex.to_string_lossy().to_string();
                    tracing::info!("[CodexEngine] 在 LOCALAPPDATA\\pnpm 找到: {}", path_str);
                    self.cli_path = Some(path_str.clone());
                    return Ok(path_str);
                }
            }

            // 4. where codex（PATH 查找）
            if let Ok(output) = Command::new("where")
                .arg("codex")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first_line) = stdout.lines().next() {
                        let path_str = first_line.trim().to_string();
                        if !path_str.is_empty() && Path::new(&path_str).exists() {
                            tracing::info!("[CodexEngine] 通过 where 找到: {}", path_str);
                            self.cli_path = Some(path_str.clone());
                            return Ok(path_str);
                        }
                    }
                }
            }
        }

        // 5. 默认使用 PATH 中的 codex
        tracing::warn!("[CodexEngine] 未找到 codex CLI，将使用默认 'codex'（依赖 PATH）");
        let default_path = "codex".to_string();
        self.cli_path = Some(default_path.clone());
        Ok(default_path)
    }

    /// 检查 Codex CLI 是否可用
    fn check_available(&mut self) -> bool {
        let cli_path = match self.get_cli_path() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("[CodexEngine] 获取 CLI 路径失败: {}", e);
                return false;
            }
        };

        // 检查路径是否存在（如果是绝对路径）
        if Path::new(&cli_path).exists() {
            tracing::info!("[CodexEngine] CLI 路径存在: {}", cli_path);
            return true;
        }

        // 尝试运行 codex --version
        #[cfg(windows)]
        let mut cmd = {
            if cli_path.ends_with(".cmd") || cli_path.ends_with(".bat") {
                let mut c = Command::new("cmd");
                c.arg("/c").arg(&cli_path);
                c
            } else {
                Command::new(&cli_path)
            }
        };
        #[cfg(not(windows))]
        let mut cmd = Command::new(&cli_path);

        cmd.arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.status() {
            Ok(status) => {
                tracing::info!("[CodexEngine] codex --version 状态: {}", status);
                status.success()
            }
            Err(e) => {
                tracing::error!("[CodexEngine] 检查 codex 可用性失败: {}", e);
                false
            }
        }
    }

    /// 构建命令
    ///
    /// codex exec（新会话）和 codex exec resume（续接）的参数不同：
    /// - exec 支持 -C 指定工作目录
    /// - exec resume 不支持 -C，工作目录通过 cmd.current_dir() 设置
    /// - exec resume 参数顺序: exec resume [OPTIONS] SESSION_ID PROMPT
    fn build_command(
        &self,
        message: &str,
        session_id: Option<&str>,
        work_dir: Option<&str>,
        model: Option<&str>,
        additional_dirs: &[String],
        permission_mode: Option<&str>,
        codex_config_args: &[String],
    ) -> Result<Command> {
        let cli_path = self
            .cli_path
            .as_ref()
            .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

        let is_resume = session_id.is_some();

        // Windows .cmd 需要用 cmd /c 执行
        #[cfg(windows)]
        let mut cmd = {
            if cli_path.ends_with(".cmd") || cli_path.ends_with(".bat") {
                let mut c = Command::new("cmd");
                c.arg("/c").arg(cli_path);
                c
            } else if cli_path.ends_with(".js") {
                let mut c = Command::new("node");
                c.arg(cli_path);
                c
            } else {
                Command::new(cli_path)
            }
        };

        #[cfg(not(windows))]
        let mut cmd = Command::new(cli_path);

        // === 子命令 + 选项 ===
        // 注意: exec resume 不支持 -C，选项必须在 SESSION_ID 之前
        cmd.arg("exec");

        if is_resume {
            cmd.arg("resume");
        }

        // JSON 输出模式
        cmd.arg("--json");

        // 跳过 git 仓库检查（允许在非 git 目录中使用）
        cmd.arg("--skip-git-repo-check");

        // 权限模式。Codex CLI 的 resume 子命令目前不支持 --sandbox，仅支持 --full-auto / bypass。
        add_codex_permission_args(&mut cmd, permission_mode, is_resume);

        for arg in codex_config_args {
            if !arg.is_empty() {
                cmd.arg(arg);
            }
        }

        // 工作目录（仅 exec 支持 -C；resume 通过 cmd.current_dir() 设置）
        if !is_resume {
            if let Some(dir) = work_dir {
                if !dir.is_empty() {
                    cmd.arg("-C").arg(dir);
                }
            } else if let Some(ref work_dir) = self.config.work_dir {
                cmd.arg("-C").arg(work_dir);
            }

            for dir in additional_dirs {
                if !dir.is_empty() {
                    cmd.arg("--add-dir").arg(dir);
                }
            }
        }

        // 模型选择（清理 ANSI 转义码）
        if let Some(m) = model {
            let cleaned = strip_ansi_codes(m);
            if !cleaned.is_empty() {
                cmd.arg("--model").arg(&cleaned);
            }
        }

        // === 位置参数（必须在选项之后）===
        if let Some(sid) = session_id {
            cmd.arg(sid);
        }

        // 消息作为最后一个参数
        cmd.arg(message);

        Ok(cmd)
    }

    /// 配置命令的通用选项
    fn configure_command(
        &self,
        cmd: &mut Command,
        work_dir: Option<&str>,
        env_overrides: &std::collections::HashMap<String, String>,
    ) {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // 设置工作目录（current_dir 用于进程 cwd，-C 用于 codex 内部）
        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }

        // 设置 UTF-8 环境
        cmd.env("LANG", "zh_CN.UTF-8");
        cmd.env("LC_ALL", "zh_CN.UTF-8");

        #[cfg(windows)]
        {
            cmd.env("CHCP", "65001");
        }

        for (key, value) in env_overrides {
            cmd.env(key, value);
        }
    }

    /// 格式化命令为可复制的字符串（用于日志输出）
    fn format_command_for_log(cmd: &Command) -> String {
        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| {
                let s = a.to_string_lossy();
                if s.contains(' ') || s.contains('"') || s.contains('\\') {
                    format!("\"{}\"", s.replace('\\', "\\\\"))
                } else {
                    s.to_string()
                }
            })
            .collect();
        format!("{} {}", program, args.join(" "))
    }

    /// 启动后台线程读取 Codex JSONL 事件
    fn spawn_event_reader(&self, child: Child, temp_id: String, pid: u32, options: SessionOptions) {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let on_session_id_update = options.on_session_id_update.clone();
        let current_session_id = temp_id.clone();

        std::thread::spawn(move || {
            // 解构 child，显式关闭 stdin 以避免 codex 等待输入
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

            // 关闭 stdin，让 codex 知道没有更多输入
            child.stdin.take();
            drop(child);

            // 读取 stderr（用于错误诊断和 session ID 发现）
            let stderr_sessions = sessions.clone();
            let stderr_temp_id = temp_id.clone();
            let stderr_pid = pid;
            let _stderr_on_error = on_error.clone();
            let stderr_on_session_id_update = on_session_id_update.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[CodexEngine] stderr: {}", line);

                    // 尝试从 stderr 中提取 session ID（某些版本的 codex 会在 stderr 输出）
                    if let Some(captures) = extract_session_id_from_stderr(&line) {
                        tracing::info!("[CodexEngine] 从 stderr 发现 session_id: {}", captures);
                        SessionManager::update_session_id_shared(
                            &stderr_sessions,
                            &stderr_temp_id,
                            &captures,
                            stderr_pid,
                            "codex",
                            None,
                        );
                        if let Some(ref cb) = stderr_on_session_id_update {
                            cb(captures);
                        }
                    }
                }
            });

            // 读取 stdout JSONL
            let mut reader = BufReader::new(stdout);
            let mut received_session_end = false;
            let mut real_session_id = current_session_id.clone();
            let mut initial_codex_images = list_codex_generated_image_names(&current_session_id);
            let mut line_count: u32 = 0;
            let mut known_event_count: u32 = 0;
            let mut unknown_event_count: u32 = 0;
            let mut parse_fail_count: u32 = 0;
            let mut non_json_line_count: u32 = 0;
            let mut decode_recovery_count: u32 = 0;
            let mut line_bytes = Vec::new();

            loop {
                line_bytes.clear();
                let bytes_read = match reader.read_until(b'\n', &mut line_bytes) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => {
                        tracing::warn!("[CodexEngine] stdout 读取错误: {}", e);
                        break;
                    }
                };

                if bytes_read == 0 {
                    break;
                }

                let (line, decoded_with) = decode_process_output_line(&line_bytes);
                if let Some(encoding) = decoded_with {
                    decode_recovery_count += 1;
                    tracing::warn!(
                        "[CodexEngine] stdout 包含非 UTF-8 字节，已按 {} 容错解码后继续读取。hex={}",
                        encoding,
                        hex_preview(&line_bytes, 80)
                    );
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                line_count += 1;
                let preview: String = trimmed.chars().take(500).collect();
                tracing::info!("[CodexEngine] stdout[{}]: {}", line_count, preview);

                // 解析 Codex JSONL 事件
                if let Some(codex_event) = parse_codex_line(trimmed) {
                    // 检查是否为未知事件类型
                    if matches!(codex_event, CodexEvent::Unknown) {
                        unknown_event_count += 1;
                        if let Some(evt_type) = extract_event_type(trimmed) {
                            tracing::warn!(
                                "[CodexEngine] 未知事件类型 [{}]: {}",
                                evt_type,
                                preview
                            );
                        } else {
                            tracing::warn!("[CodexEngine] 无法提取事件类型: {}", preview);
                        }
                        continue;
                    }

                    known_event_count += 1;

                    // 处理 thread.started — 更新 session ID 映射
                    if let CodexEvent::ThreadStarted { ref thread_id } = codex_event {
                        real_session_id = thread_id.clone();
                        initial_codex_images = list_codex_generated_image_names(thread_id);
                        SessionManager::update_session_id_shared(
                            &sessions, &temp_id, thread_id, pid, "codex", None,
                        );
                        tracing::info!(
                            "[CodexEngine] session_id 更新: {} -> {}",
                            temp_id,
                            thread_id
                        );

                        // 通知外部 session_id 已更新
                        if let Some(ref cb) = on_session_id_update {
                            cb(thread_id.clone());
                        }

                        // 发送 session_start 事件（携带真实 session ID）
                        event_callback(AIEvent::session_start(thread_id));
                    }

                    // 检查会话结束
                    if matches!(
                        codex_event,
                        CodexEvent::TurnCompleted { .. } | CodexEvent::TurnFailed { .. }
                    ) {
                        received_session_end = true;
                    }

                    // 转换为 AIEvent 并回调
                    let sid = if real_session_id != current_session_id {
                        &real_session_id
                    } else {
                        &current_session_id
                    };

                    // Codex image_generation events are persisted in Codex session files but are
                    // not currently emitted on `codex exec --json` stdout. Detect images written
                    // for this thread and surface them as markdown before session_end.
                    if matches!(codex_event, CodexEvent::TurnCompleted { .. }) {
                        if let Some(markdown) =
                            build_codex_generated_images_markdown(sid, &initial_codex_images)
                        {
                            event_callback(AIEvent::assistant_message(sid, markdown, false));
                        }
                    }

                    for ai_event in codex_event_to_ai_events(codex_event, sid) {
                        event_callback(ai_event);
                    }
                } else if trimmed.starts_with('{') {
                    parse_fail_count += 1;
                    tracing::warn!(
                        "[CodexEngine] JSON 解析失败 [{}/{}]: {}",
                        parse_fail_count,
                        line_count,
                        preview
                    );
                } else {
                    non_json_line_count += 1;
                    tracing::info!(
                        "[CodexEngine] 跳过非 JSON stdout 行 [{}/{}]: {}",
                        non_json_line_count,
                        line_count,
                        preview
                    );
                }
            }

            tracing::info!(
                "[CodexEngine] stdout 读取完成: {} 行, {} 已知事件, {} 未知事件, {} 非 JSON 行, {} 解析失败, {} 行容错解码",
                line_count,
                known_event_count,
                unknown_event_count,
                non_json_line_count,
                parse_fail_count,
                decode_recovery_count
            );

            // 如果没有收到 turn 结束事件，发送 fallback
            if !received_session_end {
                if line_count == 0 {
                    // CLI 未产生任何 stdout 输出 — 可能启动失败或立即退出
                    tracing::warn!("[CodexEngine] CLI 未产生任何 stdout 输出");
                    event_callback(AIEvent::error(
                        &current_session_id,
                        "Codex CLI 未产生任何输出，请检查 CLI 是否正确安装 (npm install -g @openai/codex)".to_string(),
                    ));
                } else if known_event_count == 0 {
                    // 有 stdout 输出但无已知事件 — 格式不兼容或解析错误
                    tracing::warn!(
                        "[CodexEngine] CLI 产生了 {} 行输出但无已知事件 ({} 解析失败, {} 未知类型)",
                        line_count,
                        parse_fail_count,
                        unknown_event_count
                    );
                    event_callback(AIEvent::error(
                        &current_session_id,
                        format!(
                            "Codex CLI 输出无法解析 ({} 行, {} 解析失败, {} 未知事件类型)。请检查 Codex CLI 版本兼容性",
                            line_count, parse_fail_count, unknown_event_count
                        ),
                    ));
                }
                tracing::info!("[CodexEngine] 发送 fallback session_end");
                event_callback(AIEvent::session_end(&current_session_id));
            }

            // 完成回调
            if let Some(cb) = on_complete {
                cb(0);
            }
        });
    }
}

/// 从 stderr 中提取 session ID
fn extract_session_id_from_stderr(line: &str) -> Option<String> {
    // 匹配格式: "session[-_]id[:\s]+<uuid>"
    let re = regex::Regex::new(r"(?i)session[-_]?id[:\s]+([a-zA-Z0-9-]+)").ok()?;
    re.captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// 清理字符串中的 ANSI 转义序列
fn strip_ansi_codes(s: &str) -> String {
    // 匹配 ANSI CSI 序列: ESC[ ... final_byte
    let re = regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap();
    re.replace_all(s, "").to_string()
}

fn add_codex_permission_args(cmd: &mut Command, permission_mode: Option<&str>, is_resume: bool) {
    match permission_mode.unwrap_or("").trim() {
        "bypassPermissions" => {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        "auto" | "acceptEdits" => {
            cmd.arg("--full-auto");
        }
        "dontAsk" | "plan" => {
            if !is_resume {
                cmd.arg("--sandbox").arg("read-only");
            }
        }
        // Default Codex behavior: preserve configured user approval/sandbox settings.
        _ => {}
    }
}

impl AIEngine for CodexEngine {
    fn id(&self) -> EngineId {
        EngineId::Codex
    }

    fn name(&self) -> &'static str {
        "OpenAI Codex"
    }

    fn description(&self) -> &'static str {
        "OpenAI Codex CLI - 全部操作权限"
    }

    fn is_available(&self) -> bool {
        true // 实际检查在 start_session 时进行
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        tracing::info!("[CodexEngine] 启动会话，消息长度: {}", message.len());
        tracing::info!("[CodexEngine] 工作目录: {:?}", options.work_dir);

        // 检查 CLI 可用性
        if !self.check_available() {
            return Err(AppError::ProcessError(
                "Codex CLI 不可用。请确保已安装: npm install -g @openai/codex".to_string(),
            ));
        }

        let work_dir = options.work_dir.clone().or_else(|| {
            self.config
                .work_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        });

        // 构建命令
        let mut cmd = self.build_command(
            message,
            None, // 新会话无 session_id
            work_dir.as_deref(),
            options.model.as_deref(),
            &options.additional_dirs,
            options.permission_mode.as_deref(),
            &options.codex_config_args,
        )?;
        self.configure_command(&mut cmd, work_dir.as_deref(), &options.env_overrides);

        // 打印命令（调试用）
        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[CodexEngine] 执行命令: {}", cmd_str);
        eprintln!("\n[CodexEngine] 执行命令:\n{}\n", cmd_str);

        // 启动进程
        let child = cmd
            .spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 Codex 进程失败: {}", e)))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[CodexEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        // 启动事件读取
        self.spawn_event_reader(child, temp_id.clone(), pid, options);

        // 注册会话
        self.sessions
            .register(temp_id.clone(), pid, "codex".to_string())?;

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!(
            "[CodexEngine] 继续会话: {}, 消息长度: {}",
            session_id,
            message.len()
        );

        // 检查 CLI 可用性
        if !self.check_available() {
            return Err(AppError::ProcessError("Codex CLI 不可用".to_string()));
        }

        // 获取会话信息，找到真实的 session_id
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!(
                "[CodexEngine] 找到会话，真实 ID: {}, PID: {}",
                info.id,
                info.pid
            );
            // 终止旧进程
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone()
        } else {
            tracing::warn!("[CodexEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        let work_dir = options.work_dir.clone().or_else(|| {
            self.config
                .work_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        });

        // 构建命令（带 resume）
        let mut cmd = self.build_command(
            message,
            Some(&real_session_id),
            work_dir.as_deref(),
            options.model.as_deref(),
            &options.additional_dirs,
            options.permission_mode.as_deref(),
            &options.codex_config_args,
        )?;
        self.configure_command(&mut cmd, work_dir.as_deref(), &options.env_overrides);

        let cmd_str = Self::format_command_for_log(&cmd);
        tracing::info!("[CodexEngine] 执行命令: {}", cmd_str);
        eprintln!("\n[CodexEngine] 执行命令:\n{}\n", cmd_str);

        // 启动进程
        let child = cmd
            .spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 Codex 会话失败: {}", e)))?;

        let pid = child.id();
        tracing::info!("[CodexEngine] 进程启动，PID: {}", pid);

        // 启动事件读取
        self.spawn_event_reader(child, real_session_id.clone(), pid, options);

        // 更新会话
        self.sessions
            .register(real_session_id, pid, "codex".to_string())?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[CodexEngine] 中断会话: {}", session_id);

        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[CodexEngine] 会话已中断: {}", session_id);
                Ok(())
            }
            Ok(false) => {
                tracing::warn!(
                    "[CodexEngine] kill_process 返回 false (session 不在本引擎或 kill 失败): {}",
                    session_id
                );
                Err(AppError::ProcessError(format!(
                    "会话不存在或 kill 失败: {}",
                    session_id
                )))
            }
            Err(e) => {
                tracing::warn!(
                    "[CodexEngine] kill_process 返回 Err: {} ({})",
                    e,
                    session_id
                );
                Err(e)
            }
        }
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn update_config(&mut self, new_config: Config) {
        tracing::info!("[CodexEngine] 应用新配置,失效 CLI 路径缓存");
        self.config = new_config;
        self.cli_path = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_codex_artifact_segments_reject_path_traversal() {
        assert!(is_safe_codex_artifact_segment(
            "019ddbda-c6e1-7d33-83cf-15140b579b4e"
        ));
        assert!(is_safe_codex_artifact_segment("ig_abc123.png"));
        assert!(!is_safe_codex_artifact_segment(""));
        assert!(!is_safe_codex_artifact_segment("../secret.png"));
        assert!(!is_safe_codex_artifact_segment("a/b.png"));
        assert!(!is_safe_codex_artifact_segment("a\\b.png"));
    }

    #[test]
    fn builds_markdown_for_new_codex_images() {
        let initial = BTreeSet::from(["old.png".to_string()]);
        let markdown = build_codex_generated_images_markdown_for_names(
            "thread-1",
            &initial,
            BTreeSet::from(["old.png".to_string(), "ig_new.png".to_string()]),
        )
        .unwrap();

        assert_eq!(
            markdown,
            "![Codex 生成图片](/api/artifacts/codex-images/thread-1/ig_new.png)"
        );
    }

    #[test]
    fn decodes_utf8_process_output_line_without_recovery() {
        let (line, decoded_with) = decode_process_output_line(b"{\"type\":\"turn.completed\"}\n");

        assert_eq!(line, "{\"type\":\"turn.completed\"}\n");
        assert!(decoded_with.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn decodes_gbk_jsonl_line_after_utf8_failure() {
        let mut bytes =
            b"{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\""
                .to_vec();
        // "中文" encoded as Windows CP936/GBK.
        bytes.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]);
        bytes.extend_from_slice(b"\"}}\n");

        let (line, decoded_with) = decode_process_output_line(&bytes);

        assert_eq!(decoded_with, Some("gbk"));
        assert!(line.contains("\"text\":\"中文\""));
        assert!(parse_codex_line(line.trim()).is_some());
    }

    #[test]
    fn build_command_includes_codex_config_args_before_positionals() {
        let mut engine = CodexEngine::new(Config::default());
        engine.cli_path = Some("codex".to_string());

        let config_args = vec![
            "-c".to_string(),
            "mcp_servers.polaris-todo.command=\"todo\"".to_string(),
            "-c".to_string(),
            "mcp_servers.polaris-todo.args=[\"config\",\"workspace\"]".to_string(),
        ];

        let cmd = engine
            .build_command(
                "hello",
                Some("session-1"),
                Some("D:\\workspace"),
                None,
                &[],
                None,
                &config_args,
            )
            .unwrap();

        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        let first_config_index = args.iter().position(|arg| arg == "-c").unwrap();
        let session_index = args.iter().position(|arg| arg == "session-1").unwrap();
        let message_index = args.iter().position(|arg| arg == "hello").unwrap();

        assert!(first_config_index < session_index);
        assert!(session_index < message_index);
        assert!(args.contains(&"mcp_servers.polaris-todo.command=\"todo\"".to_string()));
        assert!(
            args.contains(&"mcp_servers.polaris-todo.args=[\"config\",\"workspace\"]".to_string())
        );
    }
}
