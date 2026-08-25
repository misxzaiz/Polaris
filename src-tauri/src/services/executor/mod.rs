//! 通用执行器抽象（ExecutorRegistry）
//!
//! Polaris 核心提供统一的执行器注册表，任何插件可声明任务执行器而不启动额外进程。
//!
//! # 设计目标
//!
//! - 通用：执行器类型不限于 AI 对话，支持 CLI 命令、HTTP 请求、插件自定义等
//! - 零进程：执行器运行在核心进程内，不启动额外进程
//! - 插件可扩展：插件 manifest 声明 `executors`，自动注册
//! - 向后兼容：旧 `prompt`+`engineId` 字段自动映射到 `executor_type=chat`

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

use crate::error::Result;

// ============================================================================
// 执行上下文
// ============================================================================

/// 执行上下文 — 执行器可用的 Polaris 核心能力
///
/// 替代 AppState，避免生命周期和 Arc 问题。
/// 包含执行器所需的最小能力集。
#[derive(Clone)]
pub struct ExecutorContext {
    /// WebSocket 事件广播
    pub event_broadcast: crate::web::EventBroadcaster,
    /// 应用配置目录
    pub config_dir: std::path::PathBuf,
    /// 资源目录
    pub resource_dir: Option<std::path::PathBuf>,
    /// 完整的 AppState（ChatExecutor 需要）
    pub app_state: Option<std::sync::Arc<crate::AppState>>,
}

impl ExecutorContext {
    /// 从 AppState 创建
    pub fn from_app_state(state: &std::sync::Arc<crate::AppState>) -> Self {
        Self {
            event_broadcast: state.event_broadcast.clone(),
            config_dir: state
                .app_config_dir
                .get()
                .cloned()
                .unwrap_or_else(|| crate::services::data_root::data_root().config_dir()),
            resource_dir: state.resource_dir.get().and_then(|p| p.clone()),
            app_state: Some(state.clone()),
        }
    }

    /// 从 AppState 引用创建（ChatExecutor 可用，通过 clone_for_web 共享核心能力）
    pub fn from_ref(state: &crate::AppState) -> Self {
        Self {
            event_broadcast: state.event_broadcast.clone(),
            config_dir: state
                .app_config_dir
                .get()
                .cloned()
                .unwrap_or_else(|| crate::services::data_root::data_root().config_dir()),
            resource_dir: state.resource_dir.get().and_then(|p| p.clone()),
            // 共享核心能力（engine_registry/config_store/ask_listener/event_broadcast），
            // 使 ChatExecutor 可以在无 Arc<AppState> 的入口（IPC / Web-only）中正常工作。
            app_state: Some(std::sync::Arc::new(state.clone_for_web())),
        }
    }

    /// 创建轻量上下文（无 AppState，仅用于 command/http 执行器）
    pub fn lightweight() -> Self {
        Self {
            event_broadcast: crate::web::EventBroadcaster::new(64),
            config_dir: crate::services::data_root::data_root().config_dir(),
            resource_dir: None,
            app_state: None,
        }
    }
}

// ============================================================================
// 执行器类型（内置 + 插件自定义）
// ============================================================================

/// 执行器类型标识
///
/// 内置类型使用固定字符串，插件自定义使用 `plugin:<plugin_id>:<executor_id>` 格式。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ExecutorType {
    /// AI 对话执行器（内置，默认）
    Chat,
    /// CLI 命令执行器（内置）
    Command,
    /// HTTP 请求执行器（内置）
    Http,
    /// 插件自定义执行器
    Plugin { plugin_id: String, executor_id: String },
}

impl ExecutorType {
    /// 从字符串解析执行器类型
    pub fn parse(s: &str) -> Self {
        match s {
            "chat" => ExecutorType::Chat,
            "command" | "cli" => ExecutorType::Command,
            "http" | "webhook" => ExecutorType::Http,
            _ => {
                if let Some(rest) = s.strip_prefix("plugin:") {
                    let parts: Vec<&str> = rest.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        ExecutorType::Plugin {
                            plugin_id: parts[0].to_string(),
                            executor_id: parts[1].to_string(),
                        }
                    } else {
                        ExecutorType::Chat // 默认回退
                    }
                } else {
                    ExecutorType::Chat // 默认回退
                }
            }
        }
    }

    /// 序列化为字符串
    pub fn as_str(&self) -> String {
        match self {
            ExecutorType::Chat => "chat".to_string(),
            ExecutorType::Command => "command".to_string(),
            ExecutorType::Http => "http".to_string(),
            ExecutorType::Plugin { plugin_id, executor_id } => {
                format!("plugin:{}:{}", plugin_id, executor_id)
            }
        }
    }
}

// ============================================================================
// 执行参数
// ============================================================================

/// 执行器参数（不同执行器类型使用不同字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorParams {
    /// 执行器类型
    #[serde(rename = "executorType", default = "default_executor_type")]
    pub executor_type: String,

    // ── Chat 执行器参数 ──
    /// AI 对话提示词（chat 执行器使用）
    #[serde(default)]
    pub prompt: Option<String>,
    /// 引擎 ID（chat 执行器使用）
    #[serde(default)]
    pub engine_id: Option<String>,

    // ── Command 执行器参数 ──
    /// CLI 命令（command 执行器使用）
    #[serde(default)]
    pub command: Option<String>,
    /// 命令参数列表
    #[serde(default)]
    pub command_args: Option<Vec<String>>,
    /// 命令工作目录
    #[serde(default)]
    pub cwd: Option<String>,

    // ── HTTP 执行器参数 ──
    /// HTTP URL（http 执行器使用）
    #[serde(default)]
    pub url: Option<String>,
    /// HTTP 方法
    #[serde(default)]
    pub method: Option<String>,
    /// HTTP 请求体
    #[serde(default)]
    pub body: Option<Value>,

    // ── 通用执行参数 ──
    /// 工作目录（所有执行器通用）
    #[serde(default)]
    pub work_dir: Option<String>,
    /// 上下文 ID（用于事件路由）
    #[serde(default)]
    pub context_id: Option<String>,
    /// 超时秒数
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// 自定义参数（插件自定义执行器使用）
    #[serde(default)]
    pub custom_params: Option<Value>,
}

fn default_executor_type() -> String {
    "chat".to_string()
}

impl ExecutorParams {
    /// 从旧版 ScheduledTask 构建（向后兼容）
    pub fn from_legacy(prompt: &str, engine_id: &str, work_dir: Option<&str>) -> Self {
        Self {
            executor_type: "chat".to_string(),
            prompt: Some(prompt.to_string()),
            engine_id: Some(if engine_id.is_empty() {
                "claude-code".to_string()
            } else {
                engine_id.to_string()
            }),
            work_dir: work_dir.map(|s| s.to_string()),
            command: None,
            command_args: None,
            cwd: None,
            url: None,
            method: None,
            body: None,
            context_id: None,
            timeout_secs: None,
            custom_params: None,
        }
    }
}

// ============================================================================
// 执行结果
// ============================================================================

/// 执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorResult {
    /// 是否成功
    pub success: bool,
    /// 会话 ID（chat 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 退出码（command 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// 标准输出（command 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    /// 标准错误（command 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    /// HTTP 状态码（http 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// HTTP 响应体（http 执行器返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_body: Option<Value>,
    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 原始数据（插件自定义执行器使用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

impl ExecutorResult {
    pub fn success() -> Self {
        Self {
            success: true,
            session_id: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            http_status: None,
            http_body: None,
            error: None,
            raw: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(msg.into()),
            ..Self::success()
        }
    }
}

// ============================================================================
// TaskExecutor Trait
// ============================================================================

/// 任务执行器 trait
///
/// 所有执行器（内置 + 插件自定义）必须实现此 trait。
/// 执行器在核心进程内运行，不启动额外进程。
#[async_trait::async_trait]
pub trait TaskExecutor: Send + Sync {
    /// 执行器类型标识
    fn executor_type(&self) -> ExecutorType;

    /// 执行器名称（展示用）
    fn name(&self) -> &str;

    /// 执行器描述
    fn description(&self) -> &str;

    /// 执行任务
    ///
    /// # 参数
    /// * `params` - 执行参数
    /// * `ctx` - 执行上下文（事件广播、配置路径等）
    ///
    /// # 返回
    /// 执行结果
    async fn execute(
        &self,
        params: ExecutorParams,
        ctx: ExecutorContext,
    ) -> ExecutorResult;
}

// ============================================================================
// ExecutorRegistry
// ============================================================================

/// 执行器注册表
///
/// 管理所有已注册的执行器（内置 + 插件自定义），
/// 提供按类型查找和执行的能力。
#[derive(Clone)]
pub struct ExecutorRegistry {
    executors: HashMap<String, Arc<dyn TaskExecutor>>,
}

impl ExecutorRegistry {
    pub fn new() -> Self {
        Self {
            executors: HashMap::new(),
        }
    }

    /// 注册执行器
    pub fn register(&mut self, executor: Arc<dyn TaskExecutor>) {
        let key = executor.executor_type().as_str();
        tracing::info!(
            "[ExecutorRegistry] 注册执行器: {} (type={})",
            executor.name(),
            key
        );
        self.executors.insert(key, executor);
    }

    /// 按类型获取执行器
    pub fn get(&self, executor_type: &ExecutorType) -> Option<&Arc<dyn TaskExecutor>> {
        self.executors.get(&executor_type.as_str())
    }

    /// 按字符串获取执行器
    pub fn get_by_str(&self, type_str: &str) -> Option<&Arc<dyn TaskExecutor>> {
        self.executors.get(type_str)
    }

    /// 获取所有执行器列表
    pub fn list(&self) -> Vec<(String, String, String)> {
        self.executors
            .values()
            .map(|e| {
                let t = e.executor_type();
                (t.as_str(), e.name().to_string(), e.description().to_string())
            })
            .collect()
    }

    /// 执行任务
    ///
    /// 根据 params.executor_type 查找对应的执行器并执行。
    /// 如果找不到，回退到 chat 执行器。
    pub async fn execute(
        &self,
        params: ExecutorParams,
        ctx: ExecutorContext,
    ) -> ExecutorResult {
        let executor = self
            .get_by_str(&params.executor_type)
            .or_else(|| {
                tracing::warn!(
                    "[ExecutorRegistry] 未找到执行器 '{}'，回退到 chat",
                    params.executor_type
                );
                self.get(&ExecutorType::Chat)
            });

        match executor {
            Some(executor) => executor.execute(params, ctx).await,
            None => ExecutorResult::error(format!(
                "未找到执行器 '{}' 且无默认回退",
                params.executor_type
            )),
        }
    }
}

// ============================================================================
// 内置 ChatExecutor
// ============================================================================

/// AI 对话执行器（内置）
///
/// 调用 Polaris 的 start_chat_inner 创建 AI 会话并立即返回。
/// 事件通过 WebSocket 正常推送。
pub struct ChatExecutor;

#[async_trait::async_trait]
impl TaskExecutor for ChatExecutor {
    fn executor_type(&self) -> ExecutorType {
        ExecutorType::Chat
    }

    fn name(&self) -> &str {
        "AI 对话"
    }

    fn description(&self) -> &str {
        "通过 AI 引擎执行对话任务"
    }

    async fn execute(
        &self,
        params: ExecutorParams,
        ctx: ExecutorContext,
    ) -> ExecutorResult {
        let prompt = match params.prompt {
            Some(ref p) if !p.trim().is_empty() => p.trim().to_string(),
            _ => return ExecutorResult::error("提示词不能为空"),
        };

        let engine_id = params
            .engine_id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "claude-code".to_string());

        let context_id = params
            .context_id
            .clone()
            .or_else(|| Some(format!("exec-{}", uuid::Uuid::new_v4())));

        let options = crate::commands::chat::ChatRequestOptions {
            work_dir: params.work_dir.clone(),
            engine_id: Some(engine_id),
            context_id,
            enable_mcp_tools: Some(true),
            ..Default::default()
        };

        let app_paths = crate::commands::chat::AppPaths {
            config_dir: ctx.config_dir.clone(),
            resource_dir: ctx.resource_dir.clone(),
        };

        let event_broadcast = ctx.event_broadcast.clone();
        let emit_event = Arc::new(move |json: serde_json::Value| {
            let ws_msg = serde_json::json!({
                "event": "chat-event",
                "payload": json,
            });
            if let Err(e) = event_broadcast.send(ws_msg.to_string()) {
                tracing::warn!("[ChatExecutor] 事件发送失败: {}", e);
            }
        });

        let callbacks = crate::commands::chat::ChatCallbacks {
            emit_event,
            notify_complete: Arc::new(|| {}),
        };

        // 如果有 AppState，用它执行；否则使用轻量上下文
        match ctx.app_state {
            Some(ref state) => {
                match crate::commands::chat::start_chat_inner(prompt, options, state, callbacks, &app_paths).await {
                    Ok(session_id) => {
                        tracing::info!("[ChatExecutor] 任务已执行: session_id={}", session_id);
                        ExecutorResult {
                            success: true,
                            session_id: Some(session_id),
                            ..ExecutorResult::success()
                        }
                    }
                    Err(e) => {
                        tracing::error!("[ChatExecutor] 执行失败: {}", e);
                        ExecutorResult::error(format!("AI 执行失败: {}", e))
                    }
                }
            }
            None => {
                ExecutorResult::error("ChatExecutor 需要有效的 AppState 引用")
            }
        }
    }
}

// ============================================================================
// 内置 CommandExecutor
// ============================================================================

/// CLI 命令执行器（内置）
///
/// 在后台执行 CLI 命令，返回 stdout/stderr。
pub struct CommandExecutor;

#[async_trait::async_trait]
impl TaskExecutor for CommandExecutor {
    fn executor_type(&self) -> ExecutorType {
        ExecutorType::Command
    }

    fn name(&self) -> &str {
        "CLI 命令"
    }

    fn description(&self) -> &str {
        "执行 CLI 命令并返回输出"
    }

    async fn execute(
        &self,
        params: ExecutorParams,
        _ctx: ExecutorContext,
    ) -> ExecutorResult {
        let command = match params.command {
            Some(ref c) if !c.trim().is_empty() => c.trim().to_string(),
            _ => return ExecutorResult::error("命令不能为空"),
        };

        let cwd = params
            .cwd
            .clone()
            .or_else(|| params.work_dir.clone())
            .unwrap_or_else(|| std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()));

        tracing::info!("[CommandExecutor] 执行命令: {} (cwd={})", command, cwd);

        // 使用 tokio::process::Command 执行
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", &command]);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", &command]);
            c
        };

        cmd.current_dir(&cwd);

        if let Some(args) = &params.command_args {
            cmd.args(args);
        }

        let timeout = std::time::Duration::from_secs(params.timeout_secs.unwrap_or(300));

        match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();

                if output.status.success() {
                    tracing::info!("[CommandExecutor] 命令执行成功");
                    ExecutorResult {
                        success: true,
                        exit_code: output.status.code(),
                        stdout: Some(stdout),
                        stderr: Some(stderr),
                        ..ExecutorResult::success()
                    }
                } else {
                    tracing::warn!("[CommandExecutor] 命令执行失败: exit={:?}", output.status.code());
                    ExecutorResult {
                        success: false,
                        exit_code: output.status.code(),
                        stdout: Some(stdout),
                        stderr: Some(stderr),
                        error: Some(format!("命令退出码: {:?}", output.status.code())),
                        ..ExecutorResult::success()
                    }
                }
            }
            Ok(Err(e)) => {
                tracing::error!("[CommandExecutor] 命令执行出错: {}", e);
                ExecutorResult::error(format!("命令执行失败: {}", e))
            }
            Err(_) => {
                tracing::error!("[CommandExecutor] 命令超时");
                ExecutorResult::error("命令执行超时")
            }
        }
    }
}

// ============================================================================
// 内置 HttpExecutor
// ============================================================================

/// HTTP 请求执行器（内置）
///
/// 发送 HTTP 请求并返回响应。
pub struct HttpExecutor;

#[async_trait::async_trait]
impl TaskExecutor for HttpExecutor {
    fn executor_type(&self) -> ExecutorType {
        ExecutorType::Http
    }

    fn name(&self) -> &str {
        "HTTP 请求"
    }

    fn description(&self) -> &str {
        "发送 HTTP 请求并返回响应"
    }

    async fn execute(
        &self,
        params: ExecutorParams,
        _ctx: ExecutorContext,
    ) -> ExecutorResult {
        let url = match params.url {
            Some(ref u) if !u.trim().is_empty() => u.trim().to_string(),
            _ => return ExecutorResult::error("URL 不能为空"),
        };

        let method = params
            .method
            .clone()
            .unwrap_or_else(|| "GET".to_string())
            .to_uppercase();

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(params.timeout_secs.unwrap_or(60)))
            .build() {
            Ok(c) => c,
            Err(e) => return ExecutorResult::error(format!("创建 HTTP 客户端失败: {}", e)),
        };

        let req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => {
                let mut req = client.post(&url);
                if let Some(ref body) = params.body {
                    req = req.json(body);
                }
                req
            }
            "PUT" => {
                let mut req = client.put(&url);
                if let Some(ref body) = params.body {
                    req = req.json(body);
                }
                req
            }
            "DELETE" => client.delete(&url),
            "PATCH" => {
                let mut req = client.patch(&url);
                if let Some(ref body) = params.body {
                    req = req.json(body);
                }
                req
            }
            _ => return ExecutorResult::error(format!("不支持的 HTTP 方法: {}", method)),
        };

        match req.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or(Value::Null);

                ExecutorResult {
                    success: status < 500,
                    http_status: Some(status),
                    http_body: Some(body),
                    ..ExecutorResult::success()
                }
            }
            Err(e) => {
                ExecutorResult::error(format!("HTTP 请求失败: {}", e))
            }
        }
    }
}

// ============================================================================
// 初始化
// ============================================================================

/// 创建内置执行器注册表并注册所有内置执行器
pub fn create_builtin_registry() -> ExecutorRegistry {
    let mut registry = ExecutorRegistry::new();

    registry.register(Arc::new(ChatExecutor));
    registry.register(Arc::new(CommandExecutor));
    registry.register(Arc::new(HttpExecutor));

    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_executor_type_parse() {
        assert_eq!(ExecutorType::parse("chat"), ExecutorType::Chat);
        assert_eq!(ExecutorType::parse("command"), ExecutorType::Command);
        assert_eq!(ExecutorType::parse("http"), ExecutorType::Http);
        assert_eq!(
            ExecutorType::parse("plugin:polaris.scheduler:my-exec"),
            ExecutorType::Plugin {
                plugin_id: "polaris.scheduler".to_string(),
                executor_id: "my-exec".to_string(),
            }
        );
    }

    #[test]
    fn test_executor_type_as_str() {
        assert_eq!(ExecutorType::Chat.as_str(), "chat");
        assert_eq!(ExecutorType::Command.as_str(), "command");
        assert_eq!(ExecutorType::Http.as_str(), "http");
        assert_eq!(
            ExecutorType::Plugin {
                plugin_id: "test".to_string(),
                executor_id: "exec".to_string(),
            }
            .as_str(),
            "plugin:test:exec"
        );
    }

    #[test]
    fn test_executor_params_from_legacy() {
        let params = ExecutorParams::from_legacy("hello", "claude-code", Some("/workspace"));
        assert_eq!(params.executor_type, "chat");
        assert_eq!(params.prompt, Some("hello".to_string()));
        assert_eq!(params.engine_id, Some("claude-code".to_string()));
        assert_eq!(params.work_dir, Some("/workspace".to_string()));
    }
}