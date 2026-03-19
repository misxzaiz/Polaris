/*! IFlow 引擎实现
 *
 * 封装 IFlow CLI 的调用逻辑。
 * IFlow 通过监控 JSONL 文件来获取事件。
 */

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crate::ai::event_parser::EventParser;
use crate::ai::session::SessionManager;
use crate::ai::traits::{AIEngine, EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::config::Config;
use crate::models::events::StreamEvent;
use crate::models::iflow_events::IFlowJsonlEvent;
use crate::models::AIEvent;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// IFlow 引擎
pub struct IFlowEngine {
    /// 配置
    config: Config,
    /// 会话管理器
    sessions: SessionManager,
    /// CLI 路径缓存
    cli_path: Option<String>,
}

impl IFlowEngine {
    /// 创建新的 IFlow 引擎
    pub fn new(config: Config) -> Self {
        Self {
            config,
            sessions: SessionManager::new(),
            cli_path: None,
        }
    }

    /// 获取 IFlow CLI 路径
    fn get_cli_path(&mut self) -> Result<&str> {
        if self.cli_path.is_none() {
            self.cli_path = if let Some(ref path) = self.config.iflow.cli_path {
                Some(path.clone())
            } else if let Some(path) = crate::services::config_store::ConfigStore::find_iflow_path() {
                Some(path)
            } else {
                return Err(AppError::ConfigError("未找到 IFlow CLI".to_string()));
            };
        }
        Ok(self.cli_path.as_ref().unwrap())
    }

    /// 检查 CLI 是否可用
    fn check_cli_available(&mut self) -> bool {
        self.get_cli_path().is_ok()
    }

    /// 构建 IFlow 命令
    fn build_command(&self, message: &str, session_id: Option<&str>) -> Result<(Command, Option<PathBuf>)> {
        let cli_path = self.cli_path.as_ref()
            .ok_or_else(|| AppError::ProcessError("CLI 路径未初始化".to_string()))?;

        // 打印 CLI 路径信息
        tracing::info!("[IFlowEngine] CLI 路径: {}", cli_path);

        // 返回值：(Command, 临时文件路径)
        // 临时文件路径用于后续清理，Some 表示使用了临时文件
        let mut temp_file_path: Option<PathBuf> = None;

        // Windows 上如果是批处理文件，需要使用临时文件传递消息
        // 因为环境变量无法正确处理包含换行符、反引号等特殊字符的长消息
        #[cfg(windows)]
        {
            let is_batch = Self::is_batch_file(cli_path);
            tracing::info!("[IFlowEngine] 是否批处理文件: {}", is_batch);

            if is_batch {
                // 创建临时文件存储消息
                let temp_dir = std::env::temp_dir();
                let temp_file_name = format!("iflow_msg_{}.txt", uuid::Uuid::new_v4());
                let temp_file = temp_dir.join(&temp_file_name);

                // 写入消息到临时文件
                std::fs::write(&temp_file, message)
                    .map_err(|e| AppError::ProcessError(format!("创建临时消息文件失败: {}", e)))?;

                temp_file_path = Some(temp_file.clone());

                tracing::info!("[IFlowEngine] 消息已写入临时文件: {:?}", temp_file);
                tracing::info!("[IFlowEngine] 消息长度: {} 字符", message.len());

                let mut cmd = Command::new("cmd");
                cmd.arg("/S").arg("/C");

                let mut cmd_parts = vec![cli_path.to_string(), "--yolo".to_string()];

                if let Some(sid) = session_id {
                    cmd_parts.push("--resume".to_string());
                    cmd_parts.push(sid.to_string());
                }

                // 使用 type 命令读取临时文件内容作为 prompt
                // 注意：这里使用 for /f 来读取文件内容
                let prompt_arg = format!("$(type \"{}\")", temp_file.display());
                cmd_parts.push("--prompt".to_string());
                cmd_parts.push(prompt_arg.clone());

                // 打印完整命令
                let full_cmd = format!("cmd /S /C \"{}\"", cmd_parts.join(" "));
                tracing::info!("[IFlowEngine] 完整命令: {}", full_cmd);

                // 实际执行时，使用更可靠的方式：直接传递文件路径让 IFlow 读取
                // 但 IFlow 不支持 --prompt-file，所以我们需要另一种方式
                // 方案：使用 set /p 读取文件第一行，但这不支持多行
                // 最终方案：直接用 node 执行 iflow（绕过批处理文件）
                // 或者：用 PowerShell 传递参数

                // 最简单的方案：找到 iflow.cmd 实际调用的 node 脚本，直接调用 node
                // 但这需要解析 cmd 文件

                // 临时方案：对于批处理文件，尝试使用 node 直接执行
                // 大多数 npm 安装的 CLI 都是通过 node 执行的
                let node_path = Self::find_node_path();
                if let Some(node) = node_path {
                    // 尝试找到 iflow 的 JS 入口
                    if let Some(js_entry) = Self::find_npm_cli_js_entry(cli_path) {
                        tracing::info!("[IFlowEngine] 使用 node 直接执行: {} {}", node, js_entry);

                        let mut cmd = Command::new(&node);
                        cmd.arg(&js_entry);
                        cmd.arg("--yolo");

                        if let Some(sid) = session_id {
                            cmd.arg("--resume").arg(sid);
                        }

                        cmd.arg("--prompt").arg(message);

                        let args: Vec<String> = cmd.get_args().map(|s| s.to_string_lossy().to_string()).collect();
                        tracing::info!("[IFlowEngine] 实际命令: {} {}", node, args.join(" "));
                        // 不需要临时文件了
                        temp_file_path = None;

                        return Ok((cmd, temp_file_path));
                    }
                }

                // 如果无法找到 node 或 JS 入口，回退到环境变量方案（短消息可能有效）
                cmd_parts.pop(); // 移除 prompt_arg
                cmd_parts.pop(); // 移除 --prompt

                cmd_parts.push("--prompt".to_string());
                cmd_parts.push("%IFLOW_MSG%".to_string());

                cmd.env("IFLOW_MSG", message);
                cmd.arg(cmd_parts.join(" "));

                let full_cmd = format!("cmd /S /C \"{}\"", cmd_parts.join(" "));
                tracing::info!("[IFlowEngine] 回退到环境变量方案: {}", full_cmd);

                return Ok((cmd, temp_file_path));
            }
        }

        // 非 Windows 或非批处理文件，使用直接执行方式
        let mut cmd = Command::new(cli_path);
        cmd.arg("--yolo");

        if let Some(sid) = session_id {
            cmd.arg("--resume").arg(sid);
        }

        cmd.arg("--prompt").arg(message);

        // 打印完整命令
        let args: Vec<String> = cmd.get_args().map(|s| s.to_string_lossy().to_string()).collect();
        tracing::info!("[IFlowEngine] 完整命令: {} {}", cli_path, args.join(" "));
        // 安全地截取前200字符（避免切到多字节字符中间）
        let preview: String = message.chars().take(200).collect();
        tracing::info!("[IFlowEngine] 消息内容预览(前200字符): {}", preview);

        Ok((cmd, temp_file_path))
    }

    /// 查找 node 可执行文件路径
    #[cfg(windows)]
    fn find_node_path() -> Option<String> {
        // 尝试从 PATH 环境变量中查找 node
        if let Ok(path_env) = std::env::var("PATH") {
            for path in path_env.split(';') {
                let node_path = PathBuf::from(path).join("node.exe");
                if node_path.exists() {
                    tracing::info!("[IFlowEngine] 找到 node: {:?}", node_path);
                    return Some(node_path.to_string_lossy().to_string());
                }
            }
        }
        None
    }

    /// 解析 npm cmd 文件，找到实际的 JS 入口
    #[cfg(windows)]
    fn find_npm_cli_js_entry(cmd_path: &str) -> Option<String> {
        // npm 安装的 cmd 文件通常格式：
        // 格式1: node "%~dp0\..\包名\bin\cli.js"
        // 格式2: "%_prog%" "%dp0%\node_modules\包名\bundle\entry.js"
        // 格式3: node "${basedir}/../包名/bin/cli.js"

        if let Ok(content) = std::fs::read_to_string(cmd_path) {
            tracing::debug!("[IFlowEngine] cmd 文件内容:\n{}", content);

            // 获取 cmd 文件所在目录
            let cmd_dir = PathBuf::from(cmd_path).parent()?.to_string_lossy().to_string();
            let cmd_dir_normalized = cmd_dir.replace('\\', "/");

            // 查找 .js 文件路径
            for line in content.lines() {
                let line = line.trim();

                // 查找包含 .js 的行
                if line.contains(".js") {
                    tracing::debug!("[IFlowEngine] 检查行: {}", line);

                    // 尝试匹配 "%dp0%\xxx" 模式 (npm 新格式)
                    // 例如: "%dp0%\node_modules\@iflow-ai\iflow-cli\bundle\entry.js"
                    if let Some(start) = line.find("\"%dp0%") {
                        let rest = &line[start + 6..]; // 跳过 "%dp0%
                        if let Some(end) = rest.find("\"") {
                            let relative_path = &rest[..end];
                            let js_path = format!("{}{}", cmd_dir_normalized, relative_path.replace('\\', "/"));
                            tracing::info!("[IFlowEngine] 解析到 JS 入口 (%dp0%): {}", js_path);
                            return Some(js_path);
                        }
                    }

                    // 尝试匹配 "%~dp0\xxx" 模式 (传统格式)
                    if let Some(start) = line.find("\"%~dp0") {
                        let rest = &line[start + 6..]; // 跳过 "%~dp0
                        if let Some(end) = rest.find("\"") {
                            let relative_path = &rest[..end];
                            let js_path = format!("{}{}", cmd_dir_normalized, relative_path.replace('\\', "/"));
                            tracing::info!("[IFlowEngine] 解析到 JS 入口 (%~dp0): {}", js_path);
                            return Some(js_path);
                        }
                    }

                    // 尝试匹配 "${basedir}" 模式
                    if let Some(start) = line.find("${basedir}") {
                        let rest = &line[start + 11..]; // 跳过 ${basedir}
                        if let Some(end) = rest.find("\"") {
                            let relative_path = &rest[..end];
                            let js_path = format!("{}{}", cmd_dir_normalized, relative_path.replace('\\', "/"));
                            tracing::info!("[IFlowEngine] 解析到 JS 入口 ($basedir): {}", js_path);
                            return Some(js_path);
                        }
                    }
                }
            }

            tracing::warn!("[IFlowEngine] 无法从 cmd 文件解析 JS 入口");
        }
        None
    }

    /// 检查是否是批处理文件
    #[cfg(windows)]
    fn is_batch_file(path: &str) -> bool {
        let lower = path.to_lowercase();
        lower.ends_with(".bat") || lower.ends_with(".cmd")
    }

    /// 配置命令
    fn configure_command(&self, cmd: &mut Command, work_dir: Option<&str>) {
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Some(dir) = work_dir {
            cmd.current_dir(dir);
        } else if let Some(ref work_dir) = self.config.work_dir {
            cmd.current_dir(work_dir);
        }
    }

    /// 编码项目路径为 IFlow 格式
    fn encode_project_path(path: &str) -> String {
        let normalized = path.replace(":", "").replace("\\", "-").replace("/", "-");
        format!("-{}", normalized)
    }

    /// 获取项目会话目录
    fn get_project_session_dir(&self, work_dir: &str) -> Result<PathBuf> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| AppError::ConfigError("无法获取用户目录".to_string()))?;

        let config_dir = PathBuf::from(home).join(".iflow");

        if !config_dir.exists() {
            return Err(AppError::ConfigError("IFlow 配置目录不存在".to_string()));
        }

        let encoded_path = Self::encode_project_path(work_dir);
        Ok(config_dir.join("projects").join(&encoded_path))
    }

    /// 查找最新的会话文件
    fn find_latest_session_file(&self, work_dir: &str) -> Result<PathBuf> {
        let session_dir = self.get_project_session_dir(work_dir)?;

        if !session_dir.exists() {
            return Err(AppError::ProcessError("会话目录不存在".to_string()));
        }

        let entries = std::fs::read_dir(&session_dir)
            .map_err(|e| AppError::ProcessError(format!("读取会话目录失败: {}", e)))?;

        let mut latest_file: Option<PathBuf> = None;
        let mut latest_time: u64 = 0;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                if let Ok(meta) = std::fs::metadata(&path) {
                    if let Ok(modified) = meta.modified() {
                        let modified_secs = modified
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        if modified_secs > latest_time {
                            latest_time = modified_secs;
                            latest_file = Some(path);
                        }
                    }
                }
            }
        }

        latest_file.ok_or_else(|| AppError::ProcessError("未找到会话文件".to_string()))
    }

    /// 查找指定会话 ID 的 JSONL 文件
    fn find_session_jsonl(&self, work_dir: &str, session_id: &str) -> Result<PathBuf> {
        let session_dir = self.get_project_session_dir(work_dir)?;

        if !session_dir.exists() {
            return Err(AppError::ProcessError("会话目录不存在".to_string()));
        }

        let entries = std::fs::read_dir(&session_dir)
            .map_err(|e| AppError::ProcessError(format!("读取会话目录失败: {}", e)))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
                if filename.starts_with("session-") && filename.ends_with(".jsonl") {
                    if let Ok(file) = File::open(&path) {
                        let reader = BufReader::new(file);
                        for line in reader.lines().take(10).flatten() {
                            if let Some(event) = IFlowJsonlEvent::parse_line(&line) {
                                if event.session_id == session_id {
                                    return Ok(path);
                                }
                            }
                        }
                    }
                }
            }
        }

        Err(AppError::ProcessError(format!("未找到会话文件: {}", session_id)))
    }

    /// 获取 JSONL 文件当前行数
    fn get_jsonl_line_count(path: &Path) -> usize {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return 0,
        };

        BufReader::new(file)
            .lines()
            .filter_map(|r| r.ok())
            .filter(|l| !l.trim().is_empty())
            .count()
    }

    /// 检查进程是否还在运行
    #[cfg(windows)]
    fn is_process_running(pid: u32) -> bool {
        use std::process::Command;

        // 使用 tasklist 命令检查进程是否存在
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();

        match output {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 如果找到了进程，输出会包含进程 ID
                stdout.contains(&pid.to_string())
            }
            Err(e) => {
                tracing::warn!("[IFlowEngine] 检查进程状态失败: {}", e);
                false
            }
        }
    }

    /// 检查进程是否还在运行 (非 Windows)
    #[cfg(not(windows))]
    fn is_process_running(pid: u32) -> bool {
        // Unix: 检查 /proc/{pid} 目录是否存在
        let path = format!("/proc/{}", pid);
        std::path::Path::new(&path).exists()
    }

    /// 监控 JSONL 文件
    fn monitor_jsonl_file(
        path: PathBuf,
        session_id: String,
        start_line: usize,
        cli_pid: u32,
        event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
        on_complete: Option<Arc<dyn Fn(i32) + Send + Sync>>,
    ) {
        std::thread::spawn(move || {
            tracing::info!(
                "[IFlowEngine] 开始监控文件: {:?}, session_id: {}, CLI PID: {}, 从第 {} 行开始",
                path, session_id, cli_pid, start_line
            );

            // 创建事件解析器
            let mut parser = EventParser::new(&session_id);

            // 等待文件创建
            let mut wait_count = 0;
            while !path.exists() && wait_count < 50 {
                tracing::debug!(
                    "[IFlowEngine] 等待文件创建... ({}/50), 路径: {:?}",
                    wait_count + 1, path
                );
                std::thread::sleep(Duration::from_millis(100));
                wait_count += 1;
            }

            if !path.exists() {
                tracing::error!(
                    "[IFlowEngine] 文件未创建: {:?}, 等待了 {} 次检查 ({}ms)",
                    path, wait_count, wait_count * 100
                );
                event_callback(AIEvent::error("会话文件未创建"));
                return;
            }

            tracing::info!("[IFlowEngine] 文件已存在: {:?}", path);

            // 读取文件当前内容，帮助调试
            if let Ok(file) = File::open(&path) {
                let reader = BufReader::new(file);
                let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).take(5).collect();
                tracing::info!(
                    "[IFlowEngine] 文件当前有 {} 行（显示前5行）: {:?}",
                    lines.len(),
                    lines.iter().map(|l| if l.len() > 100 { &l[..100] } else { l.as_str() }).collect::<Vec<_>>()
                );
            }

            // 持续监控文件
            let mut line_count = start_line;
            let mut sleep_count = 0;
            let mut total_checks = 0usize;
            let mut last_process_check = 0usize;
            const MAX_SLEEPS: usize = 600;

            loop {
                total_checks += 1;
                let file = match File::open(&path) {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::warn!(
                            "[IFlowEngine] 打开文件失败: {:?}, 错误: {}, 重试中...",
                            path, e
                        );
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                };

                let reader = BufReader::new(file);
                let mut current_file_lines = 0;
                let mut has_new_content = false;
                let mut new_events_count = 0usize;

                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(e) => {
                            tracing::warn!("[IFlowEngine] 读取行失败: {}", e);
                            break;
                        }
                    };

                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    current_file_lines += 1;

                    // 跳过已处理的行
                    if current_file_lines <= line_count {
                        continue;
                    }

                    has_new_content = true;
                    line_count = current_file_lines;
                    sleep_count = 0;

                    // 解析事件
                    if let Some(iflow_event) = IFlowJsonlEvent::parse_line(trimmed) {
                        new_events_count += 1;
                        tracing::debug!(
                            "[IFlowEngine] 解析到事件类型: {:?}, 行号: {}",
                            iflow_event.event_type, current_file_lines
                        );

                        let stream_events = iflow_event.to_stream_events();
                        for stream_event in stream_events {
                            let is_session_end = matches!(stream_event, StreamEvent::SessionEnd);

                            // 使用 EventParser 转换为 AIEvent
                            for ai_event in parser.parse(stream_event) {
                                event_callback(ai_event);
                            }

                            if is_session_end {
                                tracing::info!(
                                    "[IFlowEngine] 检测到会话结束, 总检查次数: {}, 总行数: {}",
                                    total_checks, line_count
                                );
                                if let Some(cb) = on_complete {
                                    cb(0);
                                }
                                return;
                            }
                        }
                    } else {
                        tracing::warn!(
                            "[IFlowEngine] 无法解析行 {} 内容: {}",
                            current_file_lines,
                            if trimmed.len() > 100 { &trimmed[..100] } else { trimmed }
                        );
                    }
                }

                if has_new_content {
                    tracing::debug!(
                        "[IFlowEngine] 本轮读取完成: 新行数={}, 新事件数={}, 当前行数={}",
                        line_count - start_line, new_events_count, line_count
                    );
                } else {
                    sleep_count += 1;

                    // 每 50 次检查 (5秒) 检查一次进程状态
                    if sleep_count >= last_process_check + 50 {
                        last_process_check = sleep_count;
                        let process_running = Self::is_process_running(cli_pid);
                        tracing::info!(
                            "[IFlowEngine] 进程状态检查: PID={}, 运行中={}, sleep_count={}/{}, 当前行数={}",
                            cli_pid, process_running, sleep_count, MAX_SLEEPS, line_count
                        );

                        // 如果进程已退出但没有 SessionEnd 事件，也应该结束监控
                        if !process_running {
                            tracing::warn!(
                                "[IFlowEngine] IFlow CLI 进程 (PID: {}) 已退出，但未收到 SessionEnd 事件，结束监控",
                                cli_pid
                            );
                            // 等待一下看是否还有最后的输出
                            std::thread::sleep(Duration::from_millis(500));
                            break;
                        }
                    }

                    if sleep_count % 100 == 0 {
                        // 每 10 秒打印一次状态 (100 * 100ms = 10s)
                        tracing::info!(
                            "[IFlowEngine] 等待新内容中... sleep_count={}/{}, 当前行数={}, 总检查次数={}",
                            sleep_count, MAX_SLEEPS, line_count, total_checks
                        );
                    }

                    if sleep_count >= MAX_SLEEPS {
                        let process_running = Self::is_process_running(cli_pid);
                        tracing::error!(
                            "[IFlowEngine] ====== 等待超时! ======\n\
                             - sleep_count: {}\n\
                             - MAX_SLEEPS: {}\n\
                             - 当前行数: {}\n\
                             - 总检查次数: {}\n\
                             - 路径: {:?}\n\
                             - CLI PID: {}\n\
                             - CLI 进程运行中: {}",
                            sleep_count, MAX_SLEEPS, line_count, total_checks, path, cli_pid, process_running
                        );

                        if !process_running {
                            tracing::error!(
                                "[IFlowEngine] IFlow CLI 进程已退出但未发送 SessionEnd 事件，可能是异常终止"
                            );
                        } else {
                            tracing::error!(
                                "[IFlowEngine] IFlow CLI 进程仍在运行但无输出，可能是卡住了"
                            );
                        }

                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }

            tracing::info!(
                "[IFlowEngine] 监控结束: session_id={}, 最终行数={}, 总检查次数={}",
                session_id, line_count, total_checks
            );

            if let Some(cb) = on_complete {
                cb(0);
            }
        });
    }

    /// 读取 stderr 获取 session_id
    #[allow(dead_code)]
    fn read_stderr_for_session_id(
        child: &mut Child,
        sessions: Arc<std::sync::Mutex<HashMap<String, crate::ai::session::SessionInfo>>>,
        temp_id: String,
    ) -> Option<String> {
        let stderr = child.stderr.take()?;
        let reader = BufReader::new(stderr);

        for line in reader.lines().filter_map(|r| r.ok()) {
            tracing::debug!("[iflow stderr] {}", line);

            // 从 stderr 提取 session_id
            if let Some(id) = Self::extract_session_id_from_line(&line) {
                if let Ok(mut s) = sessions.lock() {
                    if let Some(info) = s.remove(&temp_id) {
                        s.insert(id.clone(), info);
                    }
                }
                return Some(id);
            }
        }

        None
    }

    /// 从 stderr 行中提取 session_id
    fn extract_session_id_from_line(line: &str) -> Option<String> {
        // IFlow stderr 格式: JSON 中的 "session-id": "session-xxx"
        // 尝试 JSON 解析
        if line.contains("session-id") || line.contains("session_id") {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                // 优先检查 session-id（IFlow 格式）
                if let Some(id) = json.get("session-id").and_then(|v| v.as_str()) {
                    return Some(id.to_string());
                }
                // 兼容 session_id 格式
                if let Some(id) = json.get("session_id").and_then(|v| v.as_str()) {
                    return Some(id.to_string());
                }
            }
        }
        None
    }
}

impl AIEngine for IFlowEngine {
    fn id(&self) -> EngineId {
        EngineId::IFlow
    }

    fn name(&self) -> &'static str {
        "IFlow"
    }

    fn description(&self) -> &'static str {
        "支持多种 AI 模型的智能编程助手"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        tracing::info!("[IFlowEngine] 启动会话，消息长度: {}", message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("IFlow CLI 不可用".to_string()));
        }

        let work_dir = options.work_dir.clone()
            .or_else(|| self.config.work_dir.as_ref().map(|p| p.to_string_lossy().to_string()))
            .unwrap_or_else(|| ".".to_string());

        tracing::info!("[IFlowEngine] start_session work_dir: {}", work_dir);

        // 构建命令
        let (mut cmd, _temp_file) = self.build_command(message, None)?;
        self.configure_command(&mut cmd, Some(&work_dir));

        // 启动进程
        let mut child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动 IFlow 进程失败: {}", e)))?;

        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[IFlowEngine] 进程启动，PID: {}, 临时 ID: {}", pid, temp_id);

        // 获取会话管理器的共享引用和回调（用于 stderr 线程）
        let sessions_shared = self.sessions.shared();
        let on_session_id_update = options.on_session_id_update.clone();

        // 读取 stderr 以防止缓冲区满，并捕获错误信息
        // 同时解析真实的 session-id
        let stderr = child.stderr.take();
        let temp_id_for_stderr = temp_id.clone();
        let sessions_for_stderr = sessions_shared.clone();
        let on_session_id_update_for_stderr = on_session_id_update.clone();
        let pid_for_stderr = pid;
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().filter_map(|r| r.ok()) {
                    tracing::info!("[IFlowEngine] CLI stderr: {}", line);

                    // 尝试从 stderr 解析 session-id
                    if let Some(real_id) = Self::extract_session_id_from_line(&line) {
                        tracing::info!(
                            "[IFlowEngine] 从 stderr 解析到真实 session_id: {} -> {}",
                            temp_id_for_stderr, real_id
                        );

                        // 更新 session_id 映射
                        SessionManager::update_session_id_shared(
                            &sessions_for_stderr,
                            &temp_id_for_stderr,
                            &real_id,
                            pid_for_stderr,
                            "iflow"
                        );

                        // 通知外部 session_id 已更新
                        if let Some(ref cb) = on_session_id_update_for_stderr {
                            cb(real_id);
                        }
                    }
                }
            });
        }

        // 读取 stdout 以防止缓冲区满
        let stdout = child.stdout.take();
        if let Some(stdout) = stdout {
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().filter_map(|r| r.ok()) {
                    tracing::debug!("[IFlowEngine] CLI stdout: {}", line);
                }
            });
        }

        // 注册会话
        self.sessions.register(temp_id.clone(), pid, "iflow".to_string())?;

        // 后台线程监控
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_session_id_update_for_monitor = options.on_session_id_update.clone();
        let sessions_for_monitor = self.sessions.shared();
        let work_dir_owned = work_dir;
        let temp_id_for_monitor = temp_id.clone();
        let cli_pid = pid;

        std::thread::spawn(move || {
            tracing::info!(
                "[IFlowEngine] 后台监控线程启动, work_dir: {}, temp_id: {}",
                work_dir_owned, temp_id_for_monitor
            );

            // 记录进程启动时间（毫秒级精度），用于判断文件是否是新创建的
            let start_time_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            tracing::info!("[IFlowEngine] 会话启动时间戳(ms): {}", start_time_ms);

            // 等待会话文件创建
            std::thread::sleep(Duration::from_millis(500));

            // 检查进程是否还在运行
            let process_running = Self::is_process_running(cli_pid);
            tracing::info!(
                "[IFlowEngine] 500ms 后检查进程状态: PID={}, 运行中={}",
                cli_pid, process_running
            );

            tracing::debug!("[IFlowEngine] 初始等待 500ms 完成");

            // 尝试找到新的会话文件
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();

            let config_dir = PathBuf::from(home).join(".iflow");
            let encoded_path = Self::encode_project_path(&work_dir_owned);
            let session_dir = config_dir.join("projects").join(&encoded_path);

            tracing::info!(
                "[IFlowEngine] 查找会话目录: {:?}, 编码路径: {}",
                session_dir, encoded_path
            );

            // 等待新文件出现（修改时间 >= 启动时间）
            // 修复：使用毫秒级时间戳，并且当有多个"新文件"时选择最新的
            let mut wait_count = 0;
            let jsonl_path = loop {
                if let Ok(entries) = std::fs::read_dir(&session_dir) {
                    let mut _newest: Option<PathBuf> = None;
                    let mut newest_time_ms: u64 = 0;
                    let mut newest_new_file: Option<PathBuf> = None;
                    let mut newest_new_file_time_ms: u64 = 0;
                    let mut _jsonl_count = 0;

                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                            _jsonl_count += 1;
                            if let Ok(meta) = std::fs::metadata(&path) {
                                if let Ok(modified) = meta.modified() {
                                    // 使用毫秒级时间戳提高精度
                                    let modified_ms = modified
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64;
                                    tracing::debug!(
                                        "[IFlowEngine] 发现 jsonl 文件: {:?}, 修改时间戳(ms): {}",
                                        path, modified_ms
                                    );
                                    // 跟踪最新文件
                                    if modified_ms > newest_time_ms {
                                        newest_time_ms = modified_ms;
                                        _newest = Some(path.clone());
                                    }
                                    // 检查是否是新创建的文件（修改时间 >= 启动时间，允许 1 秒误差）
                                    // 修复：当有多个新文件时，选择时间戳最大的那个
                                    if modified_ms >= start_time_ms.saturating_sub(1000) {
                                        tracing::info!(
                                            "[IFlowEngine] 发现新创建的会话文件: {:?}, 时间戳(ms): {}, 启动时间(ms): {}",
                                            path, modified_ms, start_time_ms
                                        );
                                        if modified_ms > newest_new_file_time_ms {
                                            newest_new_file_time_ms = modified_ms;
                                            newest_new_file = Some(path);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // tracing::info!(
                    //     "[IFlowEngine] 目录中有 {} 个 jsonl 文件，最新时间戳(ms): {}, 启动时间戳(ms): {}",
                    //     jsonl_count, newest_time_ms, start_time_ms
                    // );

                    // 优先使用新创建的文件（选择时间戳最大的）
                    if let Some(p) = newest_new_file {
                        tracing::info!("[IFlowEngine] 使用新创建的会话文件: {:?}", p);
                        break p;
                    }

                    // 修复：如果没有新文件，继续等待而不是使用旧文件
                    // 这避免了读取到错误的会话内容
                } else {
                    tracing::warn!(
                        "[IFlowEngine] 无法读取目录: {:?}, 等待中...",
                        session_dir
                    );
                }

                wait_count += 1;
                if wait_count > 10000 {
                    // 超时后检查进程状态
                    let process_running = Self::is_process_running(cli_pid);
                    tracing::error!(
                        "[IFlowEngine] 超时未找到会话文件! 目录: {:?}, 等待了 {} 次, 进程运行中: {}",
                        session_dir, wait_count, process_running
                    );

                    if process_running {
                        // 进程还在运行，继续等待（最多再等 50 次 = 5 秒）
                        // 这处理了 IFlow CLI 启动慢或响应慢的情况
                        tracing::info!("[IFlowEngine] 进程仍在运行，继续等待文件创建...");
                        if wait_count > 150 {
                            // 真正的超时，进程运行但长时间未创建文件
                            tracing::error!(
                                "[IFlowEngine] 进程运行但长时间未创建会话文件，可能是异常"
                            );
                            event_callback(AIEvent::error("IFlow 长时间未响应，请检查网络连接"));
                            return;
                        }
                        // 继续循环等待
                    } else {
                        // 进程已退出但没有创建文件，可能是启动失败或配置问题
                        tracing::error!(
                            "[IFlowEngine] IFlow 进程已退出但未创建会话文件，可能是启动失败"
                        );
                        event_callback(AIEvent::error("IFlow 启动失败，请检查配置"));
                        return;
                    }
                }
                // if wait_count % 10 == 0 {
                //     tracing::info!(
                //         "[IFlowEngine] 等待会话文件... ({}/{}), 目录: {:?}",
                //         wait_count, 10000, session_dir
                //     );
                // }
                std::thread::sleep(Duration::from_millis(100));
            };

            // ===== 关键修复：从文件名提取真实 session_id =====
            // IFlow 文件名格式: session-{uuid}.jsonl
            let real_session_id = jsonl_path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| temp_id_for_monitor.clone());

            tracing::info!(
                "[IFlowEngine] 从文件名提取 session_id: {} -> {}",
                temp_id_for_monitor, real_session_id
            );

            // 如果成功提取到真实 session_id，更新映射并通知前端
            if real_session_id != temp_id_for_monitor {
                // 更新 SessionManager 映射
                SessionManager::update_session_id_shared(
                    &sessions_for_monitor,
                    &temp_id_for_monitor,
                    &real_session_id,
                    cli_pid,
                    "iflow"
                );

                // 通知前端 session_id 已更新
                if let Some(ref cb) = on_session_id_update_for_monitor {
                    tracing::info!(
                        "[IFlowEngine] 通知前端 session_id 更新: {}",
                        real_session_id
                    );
                    cb(real_session_id.clone());
                }
            }

            // 监控文件（使用真实 session_id）
            Self::monitor_jsonl_file(
                jsonl_path,
                real_session_id,
                0,
                cli_pid,
                event_callback,
                on_complete,
            );
        });

        Ok(temp_id)
    }

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        tracing::info!("[IFlowEngine] 继续会话: {}, 消息长度: {}", session_id, message.len());

        if !self.check_cli_available() {
            return Err(AppError::ProcessError("IFlow CLI 不可用".to_string()));
        }

        let work_dir = options.work_dir.clone()
            .or_else(|| self.config.work_dir.as_ref().map(|p| p.to_string_lossy().to_string()))
            .unwrap_or_else(|| ".".to_string());

        // 获取会话信息，找到真实的 session_id
        let real_session_id = if let Some(info) = self.sessions.get(session_id) {
            tracing::info!("[IFlowEngine] 找到会话，真实 ID: {}, PID: {}", info.id, info.pid);
            // 终止旧进程
            tracing::info!("[IFlowEngine] 终止旧进程 PID: {}", info.pid);
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
            info.id.clone() // 使用真实 ID
        } else {
            tracing::warn!("[IFlowEngine] 未找到会话信息，使用传入的 session_id");
            session_id.to_string()
        };

        tracing::info!("[IFlowEngine] 使用 --resume 参数，session_id: {}", real_session_id);

        // 构建命令（带 --resume，使用真实 session_id）
        let (mut cmd, _temp_file) = self.build_command(message, Some(&real_session_id))?;
        self.configure_command(&mut cmd, Some(&work_dir));

        // 启动进程
        let mut child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("继续 IFlow 会话失败: {}", e)))?;

        let pid = child.id();

        tracing::info!("[IFlowEngine] 进程启动，PID: {}", pid);

        // 读取 stderr 以防止缓冲区满，并捕获错误信息
        // 同时解析可能的 session-id（IFlow 可能创建新会话）
        let stderr = child.stderr.take();
        let temp_id_for_stderr = real_session_id.clone();
        let sessions_for_stderr = self.sessions.shared();
        let on_session_id_update_for_stderr = options.on_session_id_update.clone();
        let pid_for_stderr = pid;
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().filter_map(|r| r.ok()) {
                    tracing::info!("[IFlowEngine] CLI stderr ({}): {}", temp_id_for_stderr, line);

                    // 尝试从 stderr 解析 session-id
                    if let Some(new_real_id) = Self::extract_session_id_from_line(&line) {
                        if new_real_id != temp_id_for_stderr {
                            tracing::info!(
                                "[IFlowEngine] 从 stderr 解析到新的 session_id: {} -> {}",
                                temp_id_for_stderr, new_real_id
                            );

                            // 更新 session_id 映射
                            SessionManager::update_session_id_shared(
                                &sessions_for_stderr,
                                &temp_id_for_stderr,
                                &new_real_id,
                                pid_for_stderr,
                                "iflow"
                            );

                            // 通知外部 session_id 已更新
                            if let Some(ref cb) = on_session_id_update_for_stderr {
                                cb(new_real_id);
                            }
                        }
                    }
                }
            });
        }

        // 读取 stdout 以防止缓冲区满
        let stdout = child.stdout.take();
        if let Some(stdout) = stdout {
            let sid = real_session_id.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().filter_map(|r| r.ok()) {
                    tracing::debug!("[IFlowEngine] CLI stdout ({}): {}", sid, line);
                }
            });
        }

        // 更新会话 PID（使用真实 session_id）
        self.sessions.register(real_session_id.clone(), pid, "iflow".to_string())?;

        // 查找会话文件
        let jsonl_path = self.find_session_jsonl(&work_dir, &real_session_id)?;
        let start_line = Self::get_jsonl_line_count(&jsonl_path);

        // 启动监控
        Self::monitor_jsonl_file(
            jsonl_path,
            real_session_id.clone(),
            start_line,
            pid,
            options.event_callback.clone(),
            options.on_complete.clone(),
        );

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        tracing::info!("[IFlowEngine] 中断会话: {}", session_id);

        if self.sessions.kill_process(session_id)? {
            tracing::info!("[IFlowEngine] 会话已中断: {}", session_id);
            Ok(())
        } else {
            // 找不到会话，返回错误让调用者尝试其他引擎
            Err(AppError::ProcessError(format!("会话不存在: {}", session_id)))
        }
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }
}
