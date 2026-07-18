/*! 应用状态定义
 *
 * 集中管理全局状态，包括配置存储、会话管理、集成管理器等
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

use crate::ai::EngineRegistry;
use crate::commands::context::ContextMemoryStore;
use crate::commands::terminal::TerminalManager;
use crate::integrations::IntegrationManager;
use crate::services::config_store::ConfigStore;
use crate::services::data_root::data_root;
use crate::services::file_watcher::FileWatcherManager;
use crate::services::lsp::LspManager;
use crate::services::lsp_config_repository::LspConfigRepository;
use crate::services::lsp_index::IndexService;
use crate::services::scheduler_daemon::SchedulerDaemon;
use crate::web::server::WebServerHandle;

/// 单个问题（同一个 MCP call 可包含 1-4 个）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    /// 完整问题文本（卡片正文）
    pub question: String,
    /// 短标签（≤12 字，类别 chip）
    pub header: String,
    /// 是否多选
    #[serde(default)]
    pub multi_select: bool,
    /// 选项列表
    pub options: Vec<QuestionOption>,
    /// 是否允许自定义输入
    #[serde(default = "default_allow_custom_input")]
    pub allow_custom_input: bool,
}

fn default_allow_custom_input() -> bool {
    true
}

/// 待回答问题信息（一条对应一个 MCP tool_call）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    /// 问题 ID（tool_call 的 callId）
    pub call_id: String,
    /// 会话 ID
    pub session_id: String,
    /// 同一个 call 包含的全部问题（1-4 个，与 MCP schema 对齐）
    pub questions: Vec<QuestionItem>,
    /// 问题状态
    pub status: QuestionStatus,
}

/// 问题选项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub value: String,
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 问题状态
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionStatus {
    Pending,
    Answered,
}

/// 插件交互卡片状态
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginCardStatus {
    Pending,
    Answered,
    Declined,
}

/// 待回答插件交互卡片
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPluginCard {
    pub interaction_id: String,
    pub session_id: String,
    pub call_id: Option<String>,
    pub plugin_id: String,
    pub card_id: String,
    pub tool_name: String,
    pub payload: serde_json::Value,
    pub status: PluginCardStatus,
}

/// 单条子答案
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAnswer {
    /// 选中的选项值（按 label 文本对齐）
    #[serde(default)]
    pub selected: Vec<String>,
    /// 自定义输入
    #[serde(default)]
    pub custom_input: Option<String>,
    /// 该题是否被单独跳过（部分跳过场景）
    #[serde(default)]
    pub declined: bool,
}

/// 一个 MCP call 的全部答案（与 PendingQuestion.questions 一一对齐）。
///
/// 反序列化时兼容旧版 `{ selected, customInput }` 单题形态：
/// 通过 #[serde(deny_unknown_fields = false)] 默认 + 自定义 deserializer。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    /// 每题答案（顺序对齐 questions）
    #[serde(default)]
    pub answers: Vec<SubAnswer>,
    /// 是否整体跳过（全部 decline）
    #[serde(default)]
    pub declined: bool,
}

// ============================================================================
// PlanMode 相关类型
// ============================================================================

/// 计划审批状态
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlanApprovalStatus {
    /// 等待审批
    Pending,
    /// 已批准
    Approved,
    /// 已拒绝
    Rejected,
}

/// 待审批计划
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPlan {
    /// 计划 ID
    pub plan_id: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划标题
    pub title: Option<String>,
    /// 计划描述
    pub description: Option<String>,
    /// 审批状态
    pub status: PlanApprovalStatus,
    /// 审批反馈（拒绝时可能有）
    pub feedback: Option<String>,
}

/// 派发任务记录（dispatch_task MCP 工具创建，前端执行并回报状态）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchedTask {
    /// 派发 ID（MCP 工具生成的 UUID）
    pub dispatch_id: String,
    /// 目标会话 ID（格式：dispatch-{depth}-{shortid}）
    pub session_id: String,
    /// 来源会话 ID（可能为空）
    pub source_session_id: String,
    /// 任务标题
    pub title: String,
    /// 任务提示词
    pub prompt: String,
    /// 目标工作目录（未指定则由前端继承来源会话）
    pub work_dir: Option<String>,
    /// 目标引擎（未指定则由前端继承来源会话）
    pub engine_id: Option<String>,
    /// 派发深度（1 = 普通会话派发，2 = 派发会话再派发；上限 2）
    pub depth: u32,
    /// 队员角色名（按预设派发时记录）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// 解析后的模型 Profile ID；"official" 哨兵 = 显式官方端点
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_profile_id: Option<String>,
    /// 解析后的模型名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 角色职责系统提示词（追加注入派发会话）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    /// 权限模式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// 状态：pending | running | completed | failed
    pub status: String,
    /// 完成摘要（前端回报，供 check_dispatched_task 返回给来源 AI）
    pub summary: Option<String>,
    /// 最新动作单行摘要（执行中由前端节流回报，check 工具可见）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<String>,
    /// 后端会话 ID（前端启动成功后回报，续派/恢复路径使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// 创建时间（Unix 秒）
    pub created_at: i64,
    /// 最后更新时间（Unix 秒）
    pub updated_at: i64,
}

/// 全局配置状态
pub struct AppState {
    /// 配置存储
    pub config_store: Arc<Mutex<ConfigStore>>,
    /// 保存会话 ID 到进程 PID 的映射（保留向后兼容）
    /// 使用 PID 而不是 Child，因为 Child 会在读取输出时被消费
    pub sessions: Arc<Mutex<HashMap<String, u32>>>,
    /// 上下文存储
    pub context_store: Arc<Mutex<ContextMemoryStore>>,
    /// 集成管理器 (使用 tokio::sync::Mutex 支持异步操作)
    pub integration_manager: AsyncMutex<IntegrationManager>,
    /// AI 引擎注册表（使用 tokio::sync::Mutex 支持异步操作和共享）
    pub engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    /// 终端管理器
    pub terminal_manager: Mutex<TerminalManager>,
    /// 文件监听管理器
    pub file_watcher_manager: Mutex<FileWatcherManager>,
    /// 待回答问题映射：callId -> PendingQuestion
    pub pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    /// AskUserQuestion 应答通道映射：callId -> AskAnswerEntry { sender, questions }
    /// 由 ask_listener 注册，由 answer_question 取出并 send 触发同回合回填
    pub ask_answer_senders:
        Arc<Mutex<HashMap<String, crate::services::ask_listener::AskAnswerEntry>>>,
    /// 待回答插件交互卡片映射：interactionId -> PendingPluginCard
    pub pending_plugin_cards: Arc<Mutex<HashMap<String, PendingPluginCard>>>,
    /// 插件交互卡片应答通道映射：interactionId -> PluginCardAnswerEntry
    pub plugin_card_answer_senders:
        Arc<Mutex<HashMap<String, crate::services::ask_listener::PluginCardAnswerEntry>>>,
    /// 派发任务注册表：dispatchId -> DispatchedTask
    /// 由 ask_listener 的 dispatch 帧创建，前端执行后通过 dispatch_report_status 回报状态
    pub dispatched_tasks: Arc<Mutex<HashMap<String, DispatchedTask>>>,
    /// AskUserQuestion 监听器端口 / token；启动时设置一次。
    /// 用 Arc 包裹 OnceLock 以便在 clone_for_web 后跨 AppState 共享同一份。
    pub ask_listener: Arc<OnceLock<crate::services::ask_listener::AskListenerHandle>>,
    /// 待审批计划映射：planId -> PendingPlan
    pub pending_plans: Arc<Mutex<HashMap<String, PendingPlan>>>,
    /// 调度器守护进程
    pub scheduler_daemon: AsyncMutex<Option<SchedulerDaemon>>,
    /// LSP 语言服务器管理器
    pub lsp_manager: Mutex<LspManager>,
    /// LSP 配置持久化
    pub lsp_config: Mutex<LspConfigRepository>,
    /// 轻量索引引擎（tree-sitter + SQLite，每 workspace 独立 DB）
    pub lsp_index_service: IndexService,
    /// WebSocket 事件广播通道（Web Access Layer）— 带 seq 与重放缓冲
    pub event_broadcast: crate::web::EventBroadcaster,
    /// Tauri AppHandle — set once during setup, used by Web API handlers
    /// to emit events back to the desktop webview (dual emission).
    #[cfg(feature = "tauri-app")]
    pub app_handle: OnceLock<tauri::AppHandle>,
    /// Application config directory — set once during setup from window.path().
    /// Shared by both Tauri commands and Web API handlers for consistent path resolution.
    pub app_config_dir: OnceLock<std::path::PathBuf>,
    /// Application resource directory — set once during setup from window.path().
    pub resource_dir: OnceLock<Option<std::path::PathBuf>>,
    /// Application start instant — used by health check to report uptime.
    pub start_time: Option<std::time::Instant>,
    /// Running web server handle — allows dynamic start/stop without app restart.
    pub web_server_handle: Arc<AsyncMutex<Option<WebServerHandle>>>,
    /// 内嵌代理管理器 — 管理 OpenAI Chat Completions 格式转换代理实例
    pub proxy_manager: crate::services::ProxyManager,
    /// 插件服务管理器 — 管理插件声明的后台服务
    pub plugin_service_manager: Arc<crate::services::plugin_service_manager::PluginServiceManager>,
}

/// 创建应用状态
pub fn create_app_state(
    config_store: ConfigStore,
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    integration_manager: IntegrationManager,
) -> AppState {
    let config_dir = data_root().config_dir();

    AppState {
        config_store: Arc::new(Mutex::new(config_store)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        context_store: Arc::new(Mutex::new(ContextMemoryStore::new())),
        integration_manager: AsyncMutex::new(integration_manager),
        engine_registry,
            terminal_manager: Mutex::new(TerminalManager::new()),
            file_watcher_manager: Mutex::new(FileWatcherManager::new()),
        pending_questions: Arc::new(Mutex::new(HashMap::new())),
        ask_answer_senders: Arc::new(Mutex::new(HashMap::new())),
        pending_plugin_cards: Arc::new(Mutex::new(HashMap::new())),
        plugin_card_answer_senders: Arc::new(Mutex::new(HashMap::new())),
        dispatched_tasks: Arc::new(Mutex::new(HashMap::new())),
        ask_listener: Arc::new(OnceLock::new()),
        pending_plans: Arc::new(Mutex::new(HashMap::new())),
        scheduler_daemon: AsyncMutex::new(None),
        lsp_manager: Mutex::new(LspManager::new()),
        lsp_config: Mutex::new(LspConfigRepository::new(&config_dir)),
        lsp_index_service: IndexService::new(),
        event_broadcast: crate::web::EventBroadcaster::new(256),
        #[cfg(feature = "tauri-app")]
        app_handle: OnceLock::new(),
        app_config_dir: OnceLock::new(),
        resource_dir: OnceLock::new(),
        start_time: Some(std::time::Instant::now()),
        web_server_handle: Arc::new(AsyncMutex::new(None)),
        proxy_manager: crate::services::ProxyManager::new(),
        plugin_service_manager: Arc::new(
            crate::services::plugin_service_manager::PluginServiceManager::new(),
        ),
    }
}

impl AppState {
    /// Clone the current config by briefly acquiring the config_store lock.
    /// Consolidates the lock-clone-drop pattern used in multiple web handlers.
    pub fn clone_config(&self) -> Result<crate::models::config::Config, String> {
        let store = self.config_store.lock()
            .map_err(|e| e.to_string())?;
        Ok(store.get().clone())
    }

    /// Clone shared Arc fields for the web server.
    ///
    /// Non-shared fields (integration_manager, terminal_manager, etc.) get fresh
    /// empty instances — the web server never accesses them.
    pub fn clone_for_web(&self) -> AppState {
        // Carry over app_config_dir if set, fallback to DataRoot
        let config_dir = self.app_config_dir.get()
            .cloned()
            .unwrap_or_else(|| data_root().config_dir());

        // Carry over app_handle if already set
        #[cfg(feature = "tauri-app")]
        let app_handle = {
            let lock = OnceLock::new();
            if let Some(handle) = self.app_handle.get() {
                let _ = lock.set(handle.clone());
            }
            lock
        };

        // Carry over resource_dir if set
        let resource_dir = OnceLock::new();
        if let Some(rd) = self.resource_dir.get() {
            let _ = resource_dir.set(rd.clone());
        }

        AppState {
            config_store: self.config_store.clone(),
            sessions: self.sessions.clone(),
            context_store: self.context_store.clone(),
            integration_manager: AsyncMutex::new(IntegrationManager::new()),
            engine_registry: self.engine_registry.clone(),
        terminal_manager: Mutex::new(TerminalManager::new()),
            file_watcher_manager: Mutex::new(FileWatcherManager::new()),
            pending_questions: self.pending_questions.clone(),
            ask_answer_senders: self.ask_answer_senders.clone(),
            pending_plugin_cards: self.pending_plugin_cards.clone(),
            plugin_card_answer_senders: self.plugin_card_answer_senders.clone(),
            dispatched_tasks: self.dispatched_tasks.clone(),
            ask_listener: self.ask_listener.clone(),
            pending_plans: self.pending_plans.clone(),
            scheduler_daemon: AsyncMutex::new(None),
            lsp_manager: Mutex::new(LspManager::new()),
            lsp_config: Mutex::new(LspConfigRepository::new(&config_dir)),
            lsp_index_service: self.lsp_index_service.clone(),
            event_broadcast: self.event_broadcast.clone(),
            #[cfg(feature = "tauri-app")]
            app_handle,
            app_config_dir: {
                let lock = OnceLock::new();
                let _ = lock.set(config_dir);
                lock
            },
            resource_dir,
            start_time: self.start_time,
            web_server_handle: self.web_server_handle.clone(),
            proxy_manager: crate::services::ProxyManager::new(),
            plugin_service_manager: self.plugin_service_manager.clone(),
        }
    }

    // ===== 派发任务注册表 =====

    /// 持久化文件路径（app_config_dir 未设置时返回 None，跳过持久化）
    fn dispatched_tasks_path(&self) -> Option<std::path::PathBuf> {
        self.app_config_dir
            .get()
            .map(|dir| dir.join("dispatch_tasks.json"))
    }

    /// 注册表持久化上限（按 updated_at 保留最近 N 条，活跃任务因时间戳新天然保留）
    const MAX_PERSISTED_DISPATCHED_TASKS: usize = 100;

    /// 将注册表落盘（写入失败仅告警，不影响主流程）。
    /// 同时对内存表做同规则裁剪，防止长期运行无限增长。
    pub fn persist_dispatched_tasks(&self) {
        let Some(path) = self.dispatched_tasks_path() else {
            return;
        };
        let tasks: Vec<DispatchedTask> = {
            let Ok(mut map) = self.dispatched_tasks.lock() else {
                return;
            };
            if map.len() > Self::MAX_PERSISTED_DISPATCHED_TASKS {
                let mut all: Vec<_> = map.values().cloned().collect();
                all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let keep: std::collections::HashSet<String> = all
                    .iter()
                    .take(Self::MAX_PERSISTED_DISPATCHED_TASKS)
                    .map(|t| t.dispatch_id.clone())
                    .collect();
                map.retain(|id, _| keep.contains(id));
            }
            let mut all: Vec<_> = map.values().cloned().collect();
            all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            all
        };

        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temp = path.with_extension("json.tmp");
            let content = serde_json::to_string_pretty(&tasks)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            std::fs::write(&temp, content)?;
            std::fs::rename(&temp, &path)?;
            Ok(())
        };
        if let Err(error) = write() {
            tracing::warn!("[Dispatch] 注册表落盘失败: {}", error);
        }
    }

    /// 启动时加载注册表。上一次运行中未结束的任务（pending/running）已随进程
    /// 退出而中断，标记为 failed 并注明原因。
    pub fn load_dispatched_tasks(&self) {
        let Some(path) = self.dispatched_tasks_path() else {
            return;
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!("[Dispatch] 注册表读取失败: {}", error);
                return;
            }
        };
        let tasks: Vec<DispatchedTask> = match serde_json::from_str(&content) {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::warn!("[Dispatch] 注册表解析失败，忽略历史记录: {}", error);
                return;
            }
        };

        let Ok(mut map) = self.dispatched_tasks.lock() else {
            return;
        };
        for mut task in tasks {
            if matches!(task.status.as_str(), "pending" | "running") {
                task.status = "failed".to_string();
                if task.summary.is_none() {
                    task.summary = Some("应用重启，任务已中断".to_string());
                }
                task.latest_activity = None;
            }
            map.entry(task.dispatch_id.clone()).or_insert(task);
        }
        tracing::info!("[Dispatch] 已加载 {} 条历史派发记录", map.len());
    }

    /// 插入新的派发任务记录
    pub fn insert_dispatched_task(&self, task: DispatchedTask) {
        if let Ok(mut tasks) = self.dispatched_tasks.lock() {
            tasks.insert(task.dispatch_id.clone(), task);
        }
        self.persist_dispatched_tasks();
    }

    /// 通用更新派发任务（返回 false 表示记录不存在）；自动刷新 updated_at
    pub fn update_dispatched_task<F: FnOnce(&mut DispatchedTask)>(
        &self,
        dispatch_id: &str,
        mutate: F,
    ) -> bool {
        let updated = {
            let Ok(mut tasks) = self.dispatched_tasks.lock() else {
                return false;
            };
            match tasks.get_mut(dispatch_id) {
                Some(task) => {
                    mutate(task);
                    task.updated_at = chrono::Utc::now().timestamp();
                    true
                }
                None => false,
            }
        };
        if updated {
            self.persist_dispatched_tasks();
        }
        updated
    }

    /// 删除派发任务记录（任务中心"删除记录"）
    pub fn delete_dispatched_task(&self, dispatch_id: &str) -> bool {
        let removed = self
            .dispatched_tasks
            .lock()
            .map(|mut tasks| tasks.remove(dispatch_id).is_some())
            .unwrap_or(false);
        if removed {
            self.persist_dispatched_tasks();
        }
        removed
    }

    /// 列出全部派发任务（按 updated_at 降序）
    pub fn list_dispatched_tasks(&self) -> Vec<DispatchedTask> {
        let mut tasks: Vec<DispatchedTask> = self
            .dispatched_tasks
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default();
        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        tasks
    }

    /// 更新派发任务状态（返回 false 表示记录不存在）
    pub fn update_dispatched_task_status(
        &self,
        dispatch_id: &str,
        status: &str,
        summary: Option<String>,
    ) -> bool {
        self.update_dispatched_task(dispatch_id, |task| {
            task.status = status.to_string();
            if summary.is_some() {
                task.summary = summary;
            }
        })
    }

    /// 查询派发任务记录
    pub fn get_dispatched_task(&self, dispatch_id: &str) -> Option<DispatchedTask> {
        self.dispatched_tasks
            .lock()
            .ok()
            .and_then(|tasks| tasks.get(dispatch_id).cloned())
    }

    /// 活跃（pending/running）派发任务数。忽略超过 30 分钟未更新的陈旧记录，
    /// 避免前端异常退出导致并发额度被永久占用。
    pub fn active_dispatched_task_count(&self) -> usize {
        const STALE_SECS: i64 = 30 * 60;
        let now = chrono::Utc::now().timestamp();
        self.dispatched_tasks
            .lock()
            .map(|tasks| {
                tasks
                    .values()
                    .filter(|t| {
                        matches!(t.status.as_str(), "pending" | "running")
                            && now - t.updated_at < STALE_SECS
                    })
                    .count()
            })
            .unwrap_or(0)
    }
}
