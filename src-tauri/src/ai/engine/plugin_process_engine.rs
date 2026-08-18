/*! 通用插件引擎适配器运行器
 *
 * 通过 stdin/stdout JSONRPC 与插件适配器进程通信，适配器进程负责与底层引擎 CLI 交互。
 *
 * 加新 AI 引擎只需写一个插件包（包含适配器进程），无需修改 Polaris 核心。
 * 适配器进程声明在插件的 `contributes.engines[].adapter` 字段中。
 *
 * ## 协议（engine-v1）
 *
 * 所有通信通过 stdin/stdout 进行，每行一个完整 JSON（JSONL）。
 *
 * ### Polaris → 适配器（请求）
 * ```
 * {"id":1,"method":"start_session","params":{...}}
 * {"id":1,"method":"continue_session","params":{...}}
 * {"id":1,"method":"interrupt","params":{}}
 * ```
 *
 * ### 适配器 → Polaris（事件帧）
 * ```
 * {"event":"ai_event","type":"assistant_message","session_id":"s1","content":"hi","is_delta":true}
 * {"event":"ai_event","type":"tool_call_start","session_id":"s1","tool":"bash","args":{"cmd":"ls"},"call_id":"c1"}
 * {"event":"ai_event","type":"tool_call_end","session_id":"s1","tool":"bash","success":true,"result":"output","call_id":"c1"}
 * {"event":"ai_event","type":"usage","session_id":"s1","input_tokens":100,"output_tokens":50}
 * {"event":"ai_event","type":"error","session_id":"s1","error":"engine failed"}
 * {"event":"ai_event","type":"session_end","session_id":"s1"}
 * ```
 *
 * ### 适配器 → Polaris（响应帧）
 * ```
 * {"id":1,"result":{"session_id":"s1","resume_token":"/path/to/file.jsonl"}}
 * {"id":1,"error":{"code":-1,"message":"engine not found"}}
 * ```
 *
 * ## 解析规则
 * 1. 解析每行 JSON
 * 2. 若 `event == "ai_event"` → 事件帧，构造 AIEvent 推给 event_callback
 * 3. 若 `id` 存在且 `result` → 请求成功响应
 * 4. 若 `id` 存在且 `error` → 请求失败
 *
 * ## 生命周期（模型 A）
 * 每轮对话 spawn 一个适配器进程，适配器内部 spawn 引擎 CLI，结束后一起退出。
 * 与 PluginEngineRunner 语义对齐，风险最低。
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::ai::session::SessionManager;
use crate::ai::traits::{
    AIEngine, EngineId, EngineMetadata, EngineDistribution, EngineCapabilities,
    EnvKeyMapping, PluginEngineConfig, PluginEngineAdapterDecl, SessionOptions,
};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use crate::models::ai_event::{ToolCallStartEvent, ToolCallEndEvent, UsageEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 启动帧类型（请求 method）
#[allow(dead_code)]
const METHOD_START_SESSION: &str = "start_session";
#[allow(dead_code)]
const METHOD_CONTINUE_SESSION: &str = "continue_session";
#[allow(dead_code)]
const METHOD_INTERRUPT: &str = "interrupt";

/// 通用插件引擎适配器运行器
pub struct PluginProcessEngine {
    /// 引擎配置
    config: PluginEngineConfig,
    /// 适配器声明
    adapter: PluginEngineAdapterDecl,
    /// 会话管理器
    sessions: SessionManager,
    /// 泄漏到 &'static str 的名称
    leaked_name: &'static str,
    /// 泄漏到 &'static str 的描述
    leaked_description: &'static str,
    /// 持久 resume_token 映射（polaris session_id → resume_token）
    resume_tokens: std::sync::Mutex<HashMap<String, String>>,
    /// 持久化文件路径
    resume_tokens_file: Option<PathBuf>,
}

impl PluginProcessEngine {
    /// 创建新的适配器引擎运行器
    pub fn new(config: PluginEngineConfig) -> Result<Self> {
        let adapter = config.adapter.clone()
            .ok_or_else(|| AppError::ConfigError("PluginProcessEngine 需要 adapter 声明".to_string()))?;
        let leaked_name: &'static str = Box::leak(config.name.clone().into_boxed_str());
        let leaked_description: &'static str = Box::leak(config.description.clone().into_boxed_str());

        // 加载持久化 resume_tokens
        let resume_tokens_file = Self::resume_tokens_file_path(&config.id);
        let resume_tokens = if let Some(path) = &resume_tokens_file {
            fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

        Ok(Self {
            config,
            adapter,
            sessions: SessionManager::new(),
            leaked_name,
            leaked_description,
            resume_tokens: std::sync::Mutex::new(resume_tokens),
            resume_tokens_file,
        })
    }

    /// resume_tokens 持久化文件路径
    fn resume_tokens_file_path(engine_id: &str) -> Option<PathBuf> {
        let dir = crate::services::data_root::data_root().root()
            .join("plugin-sessions").join(engine_id);
        Some(dir.join("resume_tokens.json"))
    }

    /// 持久化 resume_tokens 到磁盘
    #[allow(dead_code)]
    fn save_resume_tokens(&self) {
        if let Some(path) = &self.resume_tokens_file {
            if let Ok(map) = self.resume_tokens.lock() {
                if let Ok(s) = serde_json::to_string_pretty(&*map) {
                    let _ = fs::write(path, s);
                }
            }
        }
    }

    /// 构建适配器进程命令
    fn build_adapter_command(&self) -> Result<Command> {
        // 适配器入口相对插件安装目录（install_path）
        let base_dir = self.config.install_path.as_deref()
            .map(Path::new)
            .unwrap_or_else(|| Path::new(&self.config.cli.command));
        let adapter_entry = base_dir.join(&self.adapter.entry);

        let mut cmd = match &self.adapter.runtime {
            Some(runtime) => {
                let mut c = Command::new(runtime);
                c.arg(&adapter_entry);
                c
            }
            None => Command::new(&adapter_entry),
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        Ok(cmd)
    }

    /// 发送 JSONRPC 请求到适配器 stdin
    #[allow(dead_code)]
    fn send_request(
        stdin_writer: &mut impl Write,
        id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<()> {
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)
            .map_err(|e| AppError::ProcessError(format!("序列化请求失败: {}", e)))?;
        line.push('\n');
        stdin_writer.write_all(line.as_bytes())
            .and_then(|_| stdin_writer.flush())
            .map_err(|e| AppError::ProcessError(format!("发送请求失败: {}", e)))
    }

    /// 解析适配器事件帧 → AIEvent
    ///
    /// 适配器发送的事件帧格式：
    /// `{"event":"ai_event","type":"<event_type>",...event_fields...}`
    ///
    /// 对 struct-variant 事件（assistant_message/error/thinking/session_end/context_compacted），
    /// 直接 serde_json::from_value 反序列化。
    /// 对 tuple-variant 事件（tool_call_start/end/usage），手动构造。
    fn parse_event_frame(frame: &serde_json::Value) -> Option<AIEvent> {
        let obj = frame.as_object()?;
        let type_tag = obj.get("type")?.as_str()?;
        match type_tag {
            // struct-variant：直接反序列化
            "assistant_message" | "error" | "session_end" | "thinking" | "context_compacted" => {
                serde_json::from_value(frame.clone()).ok()
            }
            // tuple-variant：手动构造
            "tool_call_start" => {
                let session_id = obj.get("session_id")?.as_str()?.to_string();
                let tool = obj.get("tool")?.as_str()?.to_string();
                let args = obj.get("args")
                    .and_then(|a| a.as_object())
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default();
                let call_id = obj.get("call_id").and_then(|c| c.as_str()).map(String::from);
                let mut ev = ToolCallStartEvent::new(session_id, tool, args);
                if let Some(cid) = call_id {
                    ev = ev.with_call_id(cid);
                }
                Some(AIEvent::ToolCallStart(ev))
            }
            "tool_call_end" => {
                let session_id = obj.get("session_id")?.as_str()?.to_string();
                let tool = obj.get("tool")?.as_str()?.to_string();
                let success = obj.get("success").and_then(|s| s.as_bool()).unwrap_or(true);
                let result = obj.get("result").cloned();
                let call_id = obj.get("call_id").and_then(|c| c.as_str()).map(String::from);
                let mut ev = ToolCallEndEvent::new(session_id, tool, success);
                if let Some(cid) = call_id {
                    ev = ev.with_call_id(cid);
                }
                if let Some(r) = result {
                    if !r.is_null() {
                        ev = ev.with_result(r);
                    }
                }
                Some(AIEvent::ToolCallEnd(ev))
            }
            "usage" => {
                let session_id = obj.get("session_id")?.as_str()?.to_string();
                let input = obj.get("input_tokens").and_then(|v| v.as_u64())?;
                let output = obj.get("output_tokens").and_then(|v| v.as_u64())?;
                let cache_creation = obj.get("cache_creation_input_tokens").and_then(|v| v.as_u64());
                let cache_read = obj.get("cache_read_input_tokens").and_then(|v| v.as_u64());
                let reasoning = obj.get("reasoning_output_tokens").and_then(|v| v.as_u64());
                let context_window = obj.get("context_window").and_then(|v| v.as_u64());
                let cost = obj.get("total_cost_usd").and_then(|v| v.as_f64());
                let model = obj.get("actual_model").and_then(|v| v.as_str()).map(String::from);
                let mut ev = UsageEvent::new(session_id, input, cache_creation, cache_read, output, reasoning, context_window);
                if let Some(c) = cost {
                    ev = ev.with_total_cost_usd(Some(c));
                }
                if let Some(m) = model {
                    ev = ev.with_actual_model(Some(m));
                }
                Some(AIEvent::Usage(ev))
            }
            _ => None,
        }
    }

    /// 启动后台线程读取适配器 stdout 事件
    fn spawn_event_reader(
        &self,
        mut child: Child,
        session_id: String,
        _pid: u32,
        options: SessionOptions,
        initial_prompt: Option<String>,
    ) -> std::sync::mpsc::Sender<String> {
        let sessions = self.sessions.shared();
        let event_callback = options.event_callback.clone();
        let on_complete = options.on_complete.clone();
        let on_error = options.on_error.clone();
        let current_session_id = session_id.clone();
        let engine_id = self.config.id.clone();
        let resume_tokens = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let resume_tokens_file = self.resume_tokens_file.clone();

        let (input_sender, input_receiver) = std::sync::mpsc::channel::<String>();
        let input_sender_for_return = input_sender.clone();

        std::thread::spawn(move || {
            let (stdout, stdin) = match (child.stdout.take(), child.stdin.take()) {
                (Some(s), Some(i)) => (s, i),
                _ => {
                    if let Some(ref cb) = on_error {
                        cb("无法获取适配器进程输入/输出流".to_string());
                    }
                    event_callback(AIEvent::session_end(&current_session_id));
                    if let Some(ref cb) = on_complete { cb(0); }
                    return;
                }
            };
            let stderr = match child.stderr.take() {
                Some(s) => s,
                None => {
                    event_callback(AIEvent::session_end(&current_session_id));
                    if let Some(ref cb) = on_complete { cb(0); }
                    return;
                }
            };

            // stderr 读取线程（日志）
            let engine_id_err = engine_id.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|r| r.ok()) {
                    tracing::warn!("[PluginProcess:{}] stderr: {}", engine_id_err, line);
                }
            });

            // 发初始 start_session 请求（通过 stdin 转发线程）
            let start_params = serde_json::json!({
                "session_id": current_session_id,
                "message": initial_prompt.unwrap_or_default(),
            });
            let mut init_req = serde_json::to_string(&serde_json::json!({
                "id": 1u64,
                "method": METHOD_START_SESSION,
                "params": start_params,
            })).unwrap_or_default();
            init_req.push('\n');

            // stdin 转发线程（先发初始请求，再转发后续命令）
            let engine_id_stdin = engine_id.clone();
            let _ = input_sender.send(init_req);
            std::thread::spawn(move || {
                let mut stdin_writer = std::io::BufWriter::new(stdin);
                // 初始请求已通过 input_sender 发送，这里循环转发后续命令
                while let Ok(input) = input_receiver.recv() {
                    if let Err(e) = stdin_writer.write_all(input.as_bytes()) {
                        tracing::warn!("[PluginProcess:{}] stdin 转发失败: {}", engine_id_stdin, e);
                        break;
                    }
                    if let Err(e) = stdin_writer.flush() {
                        tracing::warn!("[PluginProcess:{}] stdin flush 失败: {}", engine_id_stdin, e);
                        break;
                    }
                }
            });

            // 读取 stdout 事件
            let mut reader = BufReader::new(stdout);
            let mut line_buf = String::new();
            let mut line_count: usize = 0;
            let mut _message_event_count: usize = 0;
            let mut session_ended = false;

            'reader: loop {
                line_buf.clear();
                match reader.read_line(&mut line_buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let trimmed = line_buf.trim();
                if trimmed.is_empty() { continue; }
                line_count += 1;

                let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                    tracing::warn!("[PluginProcess:{}] 无法解析适配器输出行: {}", engine_id, trimmed.chars().take(200).collect::<String>());
                    continue;
                };

                // 判断帧类型
                if val.get("event").and_then(|e| e.as_str()) == Some("ai_event") {
                    // 事件帧：解析为 AIEvent
                    if let Some(ev) = Self::parse_event_frame(&val) {
                        if matches!(&ev, AIEvent::AssistantMessage(_) | AIEvent::ToolCallStart(_) | AIEvent::ToolCallEnd(_)) {
                            _message_event_count += 1;
                        }
                        // 检查是否 session_end
                        if matches!(&ev, AIEvent::SessionEnd(_)) {
                            session_ended = true;
                        }
                        event_callback(ev);
                    } else {
                        tracing::warn!("[PluginProcess:{}] 无法解析事件帧: type={:?}", engine_id, val.get("type"));
                    }
                } else if val.get("id").is_some() {
                    // 响应帧
                    if val.get("result").is_some() {
                        // 提取 resume_token
                        if let Some(rt) = val.pointer("/result/resume_token").and_then(|v| v.as_str()) {
                            if let Ok(mut map) = resume_tokens.lock() {
                                map.insert(current_session_id.clone(), rt.to_string());
                                // 持久化
                                if let Some(path) = &resume_tokens_file {
                                    if let Ok(s) = serde_json::to_string_pretty(&*map) {
                                        let _ = fs::write(path, s);
                                    }
                                }
                            }
                        }
                    } else if val.get("error").is_some() {
                        let msg = val.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("适配器响应错误");
                        tracing::warn!("[PluginProcess:{}] 适配器响应错误: {}", engine_id, msg);
                        event_callback(AIEvent::error(&current_session_id, msg));
                    }
                } else {
                    tracing::debug!("[PluginProcess:{}] 未识别的适配器输出行: {}", engine_id, trimmed.chars().take(100).collect::<String>());
                }

                if session_ended {
                    break 'reader;
                }
            }

            // 收尾
            if !session_ended && line_count > 0 {
                tracing::warn!("[PluginProcess:{}] reader 循环退出但未收到 session_end，session={}", engine_id, current_session_id);
            }
            if line_count == 0 {
                tracing::warn!("[PluginProcess:{}] 适配器未产生任何 stdout 输出", engine_id);
                event_callback(AIEvent::error(&current_session_id, format!("{} 适配器未产生任何输出", engine_id)));
            }

            // 清理进程
            let mut child = child;
            if let Ok(mut s) = sessions.lock() {
                s.remove(&current_session_id);
            }
            let max_wait = std::time::Duration::from_secs(5);
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() >= max_wait {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }

            if !session_ended {
                event_callback(AIEvent::session_end(&current_session_id));
            }
            if let Some(cb) = on_complete {
                cb(0);
            }
        });

        input_sender_for_return
    }
}

impl AIEngine for PluginProcessEngine {
    fn id(&self) -> EngineId {
        EngineId::Custom(self.config.id.clone())
    }

    fn name(&self) -> &'static str {
        self.leaked_name
    }

    fn description(&self) -> &'static str {
        self.leaked_description
    }

    fn metadata(&self) -> EngineMetadata {
        EngineMetadata {
            id: self.id(),
            name: self.config.name.clone(),
            description: Some(self.config.description.clone()),
            distribution: EngineDistribution::CustomPath {
                path: self.config.cli.command.clone(),
                available: self.is_available(),
            },
            capabilities: EngineCapabilities {
                tools: self.config.capabilities.tools,
                image_input: false,
                streaming: self.config.capabilities.streaming,
                interrupt: self.config.capabilities.interrupt,
                resume: self.config.capabilities.resume,
                stdin_input: true,
                fork_session: false,
            },
            env_keys: EnvKeyMapping::default(),
            supports_model_provider: false,
            install_guide: self.config.cli.install_guide.clone(),
            npm_package: self.config.npm_package.clone(),
            install_url: self.config.install_url.clone(),
        }
    }

    fn is_available(&self) -> bool {
        // 检查 runtime 是否可用
        let base_dir = self.config.install_path.as_deref()
            .map(Path::new)
            .unwrap_or_else(|| Path::new(&self.config.cli.command));
        let adapter_entry = base_dir.join(&self.adapter.entry);
        if !adapter_entry.exists() {
            return false;
        }
        if let Some(runtime) = &self.adapter.runtime {
            let which_cmd = if cfg!(windows) { "where" } else { "which" };
            let mut check = Command::new(which_cmd);
            check.arg(runtime);
            #[cfg(windows)]
            check.creation_flags(CREATE_NO_WINDOW);
            check.output().map(|o| o.status.success()).unwrap_or(false)
        } else {
            true
        }
    }

    fn unavailable_reason(&self) -> Option<String> {
        let base_dir = self.config.install_path.as_deref()
            .map(Path::new)
            .unwrap_or_else(|| Path::new(&self.config.cli.command));
        let adapter_entry = base_dir.join(&self.adapter.entry);
        if !adapter_entry.exists() {
            return Some(format!("适配器入口不存在: {}", adapter_entry.display()));
        }
        if let Some(runtime) = &self.adapter.runtime {
            let which_cmd = if cfg!(windows) { "where" } else { "which" };
            let mut check = Command::new(which_cmd);
            check.arg(runtime);
            #[cfg(windows)]
            check.creation_flags(CREATE_NO_WINDOW);
            if !check.output().map(|o| o.status.success()).unwrap_or(false) {
                return Some(format!("适配器需要 runtime '{}'，但未在 PATH 中找到", runtime));
            }
        }
        let guide = self.config.cli.install_guide.as_deref().unwrap_or("请安装插件");
        Some(format!("{} 未安装。{}", self.config.cli.command, guide))
    }

    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String> {
        let engine_id = &self.config.id;
        tracing::info!("[PluginProcess:{}] 启动会话，消息长度: {}", engine_id, message.len());

        if !self.is_available() {
            let reason = self.unavailable_reason().unwrap_or_default();
            return Err(AppError::ProcessError(reason));
        }

        let mut cmd = self.build_adapter_command()?;
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动适配器进程失败: {}", e)))?;
        let pid = child.id();
        let temp_id = uuid::Uuid::new_v4().to_string();

        tracing::info!("[PluginProcess:{}] 适配器进程启动，PID: {}", engine_id, pid);

        let input_sender = self.spawn_event_reader(
            child, temp_id.clone(), pid, options, Some(message.to_string()),
        );
        self.sessions.register_with_sender(
            temp_id.clone(), pid, engine_id.clone(), Some(input_sender),
        )?;

        Ok(temp_id)
    }

    fn continue_session(&mut self, session_id: &str, message: &str, options: SessionOptions) -> Result<()> {
        let engine_id = &self.config.id;
        tracing::info!("[PluginProcess:{}] 继续会话: {}", engine_id, session_id);

        if !self.is_available() {
            return Err(AppError::ProcessError("适配器不可用".to_string()));
        }

        // Kill 旧进程
        if self.sessions.get(session_id).is_some() {
            let _ = self.sessions.kill_process(session_id);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // 从 resume_tokens 取续聊令牌
        let resume_token = self.resume_tokens.lock().ok()
            .and_then(|m| m.get(session_id).cloned());

        let mut cmd = self.build_adapter_command()?;
        let child = cmd.spawn()
            .map_err(|e| AppError::ProcessError(format!("启动适配器进程失败: {}", e)))?;
        let pid = child.id();

        let options_with_resume = SessionOptions {
            // 将 resume_token 和 message 传给适配器，由适配器在 params 中获取
            // 这里通过注入 session_id 和 resume_token 到 env_overrides 传给适配器
            env_overrides: {
                let mut env = options.env_overrides.clone();
                if let Some(ref token) = resume_token {
                    env.insert("POLARIS_RESUME_TOKEN".to_string(), token.clone());
                }
                env.insert("POLARIS_SESSION_ID".to_string(), session_id.to_string());
                env.insert("POLARIS_MESSAGE".to_string(), message.to_string());
                env
            },
            ..options
        };

        let input_sender = self.spawn_event_reader(
            child, session_id.to_string(), pid, options_with_resume, Some(message.to_string()),
        );
        self.sessions.register_with_sender(
            session_id.to_string(), pid, engine_id.clone(), Some(input_sender),
        )?;

        Ok(())
    }

    fn interrupt(&mut self, session_id: &str) -> Result<()> {
        let engine_id = &self.config.id;
        tracing::info!("[PluginProcess:{}] 中断会话: {}", engine_id, session_id);

        // 发 interrupt 请求（通过 stdin 发送）
        let abort = "{\"id\":0,\"method\":\"interrupt\",\"params\":{}}\n";
        if let Ok(true) = self.sessions.send_input(session_id, abort) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        match self.sessions.kill_process(session_id) {
            Ok(true) => {
                tracing::info!("[PluginProcess:{}] 会话已中断: {}", engine_id, session_id);
                Ok(())
            }
            Ok(false) => {
                Err(AppError::ProcessError(format!("会话不存在或中断失败: {}", session_id)))
            }
            Err(e) => Err(e),
        }
    }

    fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        self.sessions.send_input(session_id, input)
    }

    fn active_session_count(&self) -> usize {
        self.sessions.count()
    }

    fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.get(session_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// engine-v1 适配器事件帧解析：覆盖协议注释里列出的全部事件类型，
    /// 保证「插件适配器 ↔ PluginProcessEngine」契约在生产级回归时不漂移。
    ///
    /// 受 [[rust-lib-test-env-limit]] 约束，本机仅编译不运行，逻辑由 CI 执行。

    #[test]
    fn parse_assistant_message_struct_variant() {
        let frame = json!({
            "event": "ai_event",
            "type": "assistant_message",
            "session_id": "s1",
            "content": "hello",
            "is_delta": true
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame)
            .expect("assistant_message 应解析为 AIEvent");
        match ev {
            AIEvent::AssistantMessage(m) => {
                assert_eq!(m.session_id, "s1");
                assert_eq!(m.content, "hello");
                assert!(m.is_delta);
            }
            other => panic!("期望 AssistantMessage，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_session_end_struct_variant() {
        let frame = json!({ "event": "ai_event", "type": "session_end", "session_id": "s1" });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("session_end 应解析为 AIEvent");
        assert!(matches!(ev, AIEvent::SessionEnd(_)));
    }

    #[test]
    fn parse_tool_call_start_tuple_variant() {
        let frame = json!({
            "event": "ai_event",
            "type": "tool_call_start",
            "session_id": "s1",
            "tool": "bash",
            "args": { "cmd": "ls -la" },
            "call_id": "c1"
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("tool_call_start 应解析为 AIEvent");
        match ev {
            AIEvent::ToolCallStart(e) => {
                assert_eq!(e.session_id, "s1");
                assert_eq!(e.tool, "bash");
                assert_eq!(e.args.get("cmd").and_then(|v| v.as_str()), Some("ls -la"));
                assert_eq!(e.call_id.as_deref(), Some("c1"));
            }
            other => panic!("期望 ToolCallStart，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_tool_call_start_missing_args_defaults_empty() {
        // 无 args / 无 call_id → 默认空 map / None，不 panic。
        let frame = json!({
            "event": "ai_event", "type": "tool_call_start",
            "session_id": "s1", "tool": "bash"
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("缺 args 也应解析");
        match ev {
            AIEvent::ToolCallStart(e) => {
                assert!(e.args.is_empty());
                assert!(e.call_id.is_none());
            }
            other => panic!("期望 ToolCallStart，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_tool_call_end_tuple_variant() {
        let frame = json!({
            "event": "ai_event",
            "type": "tool_call_end",
            "session_id": "s1",
            "tool": "bash",
            "success": true,
            "result": "some output",
            "call_id": "c1"
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("tool_call_end 应解析为 AIEvent");
        match ev {
            AIEvent::ToolCallEnd(e) => {
                assert_eq!(e.session_id, "s1");
                assert_eq!(e.tool, "bash");
                assert!(e.success);
                assert_eq!(e.result.as_ref().and_then(|r| r.as_str()), Some("some output"));
                assert_eq!(e.call_id.as_deref(), Some("c1"));
            }
            other => panic!("期望 ToolCallEnd，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_tool_call_end_null_result_ignored() {
        // result: null → 视为无结果，不作为 Some(null) 存储。
        let frame = json!({
            "event": "ai_event", "type": "tool_call_end",
            "session_id": "s1", "tool": "bash", "success": false, "result": null
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("null result 也应解析");
        match ev {
            AIEvent::ToolCallEnd(e) => {
                assert!(!e.success);
                assert!(e.result.is_none(), "null result 应被忽略");
            }
            other => panic!("期望 ToolCallEnd，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_usage_tuple_variant() {
        let frame = json!({
            "event": "ai_event", "type": "usage",
            "session_id": "s1",
            "input_tokens": 100, "output_tokens": 50,
            "cache_creation_input_tokens": 10, "cache_read_input_tokens": 20,
            "reasoning_output_tokens": 5, "context_window": 128000,
            "total_cost_usd": 0.0123, "actual_model": "deepseek-v3"
        });
        let ev = PluginProcessEngine::parse_event_frame(&frame).expect("usage 应解析为 AIEvent");
        match ev {
            AIEvent::Usage(u) => {
                assert_eq!(u.session_id, "s1");
                assert_eq!(u.input_tokens, 100);
                assert_eq!(u.output_tokens, 50);
                assert_eq!(u.context_window, Some(128000));
                assert_eq!(u.actual_model.as_deref(), Some("deepseek-v3"));
            }
            other => panic!("期望 Usage，得到 {:?}", other),
        }
    }

    #[test]
    fn parse_unknown_event_type_returns_none() {
        let frame = json!({ "event": "ai_event", "type": "no_such_event", "session_id": "s1" });
        assert!(PluginProcessEngine::parse_event_frame(&frame).is_none());
    }

    #[test]
    fn parse_malformed_frame_returns_none() {
        // 非对象 / 缺 type → None，不 panic。
        assert!(PluginProcessEngine::parse_event_frame(&json!([1, 2, 3])).is_none());
        assert!(PluginProcessEngine::parse_event_frame(&json!({ "event": "ai_event" })).is_none());
        assert!(PluginProcessEngine::parse_event_frame(&serde_json::Value::Null).is_none());
    }
}