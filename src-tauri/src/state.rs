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
use crate::services::data_root::DataRoot;
use crate::services::file_watcher::FileWatcherManager;
use crate::services::lsp::LspManager;
use crate::services::lsp_config_repository::LspConfigRepository;
use crate::services::scheduler_daemon::SchedulerDaemon;
use crate::web::server::WebServerHandle;

/// 待回答问题信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    /// 问题 ID（tool_call 的 callId）
    pub call_id: String,
    /// 会话 ID
    pub session_id: String,
    /// 问题标题
    pub header: String,
    /// 是否多选
    pub multi_select: bool,
    /// 选项列表
    pub options: Vec<QuestionOption>,
    /// 是否允许自定义输入
    pub allow_custom_input: bool,
    /// 问题状态
    pub status: QuestionStatus,
}

/// 问题选项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub value: String,
    pub label: Option<String>,
}

/// 问题状态
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionStatus {
    Pending,
    Answered,
}

/// 问题答案
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    /// 选中的选项值
    pub selected: Vec<String>,
    /// 自定义输入
    pub custom_input: Option<String>,
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
    /// 待审批计划映射：planId -> PendingPlan
    pub pending_plans: Arc<Mutex<HashMap<String, PendingPlan>>>,
    /// 调度器守护进程
    pub scheduler_daemon: AsyncMutex<Option<SchedulerDaemon>>,
    /// LSP 语言服务器管理器
    pub lsp_manager: Mutex<LspManager>,
    /// LSP 配置持久化
    pub lsp_config: Mutex<LspConfigRepository>,
    /// WebSocket 事件广播通道（Web Access Layer）— 带 seq 与重放缓冲
    pub event_broadcast: crate::web::EventBroadcaster,
    /// Tauri AppHandle — set once during setup, used by Web API handlers
    /// to emit events back to the desktop webview (dual emission).
    #[cfg(feature = "tauri-app")]
    pub app_handle: OnceLock<tauri::AppHandle>,
    /// Application config directory — set once during setup from window.path().
    /// Shared by both Tauri commands and Web API handlers for consistent path resolution.
    ///
    /// **Deprecation note**: 新代码应改用 `data_root.config_dir()`，该字段保留是为了
    /// 不一次性破坏所有调用方；启动时会被同步设置为 `data_root.config_dir()`。
    pub app_config_dir: OnceLock<std::path::PathBuf>,
    /// 应用数据根目录抽象 — 所有落盘服务/命令的统一路径来源。
    /// 由启动流程一次性解析（基于 `Config.data_root` 或系统默认）。
    /// 使用 Mutex 支持迁移后热切换。
    pub data_root: Mutex<Arc<DataRoot>>,
    /// Application resource directory — set once during setup from window.path().
    pub resource_dir: OnceLock<Option<std::path::PathBuf>>,
    /// Application start instant — used by health check to report uptime.
    pub start_time: Option<std::time::Instant>,
    /// Running web server handle — allows dynamic start/stop without app restart.
    pub web_server_handle: Arc<AsyncMutex<Option<WebServerHandle>>>,
    /// 内嵌代理管理器 — 管理 OpenAI Chat Completions 格式转换代理实例
    pub proxy_manager: crate::services::ProxyManager,
}

/// 创建应用状态
pub fn create_app_state(
    config_store: ConfigStore,
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    integration_manager: IntegrationManager,
) -> AppState {
    // 解析 DataRoot：优先使用 Config.data_root，否则系统默认（含 LEGACY 命名兼容）
    let custom_root = {
        let cfg = config_store.get();
        cfg.data_root.clone()
    };
    let data_root = Mutex::new(DataRoot::resolve(custom_root).shared());
    let config_dir = { let r = data_root.lock().unwrap(); r.config_dir() };

    AppState {
        config_store: Arc::new(Mutex::new(config_store)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        context_store: Arc::new(Mutex::new(ContextMemoryStore::new())),
        integration_manager: AsyncMutex::new(integration_manager),
        engine_registry,
        terminal_manager: Mutex::new(TerminalManager::new()),
        file_watcher_manager: Mutex::new(FileWatcherManager::new()),
        pending_questions: Arc::new(Mutex::new(HashMap::new())),
        pending_plans: Arc::new(Mutex::new(HashMap::new())),
        scheduler_daemon: AsyncMutex::new(None),
        lsp_manager: Mutex::new(LspManager::new()),
        lsp_config: Mutex::new(LspConfigRepository::new(&config_dir)),
        event_broadcast: crate::web::EventBroadcaster::new(256),
        #[cfg(feature = "tauri-app")]
        app_handle: OnceLock::new(),
        app_config_dir: {
            // 同步初始化为 data_root.config_dir() 以兼容旧调用方
            let lock = OnceLock::new();
            let _ = lock.set(config_dir.clone());
            lock
        },
        data_root,
        resource_dir: OnceLock::new(),
        start_time: Some(std::time::Instant::now()),
        web_server_handle: Arc::new(AsyncMutex::new(None)),
        proxy_manager: crate::services::ProxyManager::new(),
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
        // DataRoot 在 Mutex 中，克隆 Arc 值并共享给 Web 模式
        let data_root = Mutex::new(self.data_root.lock().unwrap().clone());
        let config_dir = { let r = data_root.lock().unwrap(); r.config_dir() };

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
            pending_plans: self.pending_plans.clone(),
            scheduler_daemon: AsyncMutex::new(None),
            lsp_manager: Mutex::new(LspManager::new()),
            lsp_config: Mutex::new(LspConfigRepository::new(&config_dir)),
            event_broadcast: self.event_broadcast.clone(),
            #[cfg(feature = "tauri-app")]
            app_handle,
            app_config_dir: {
                let lock = OnceLock::new();
                let _ = lock.set(config_dir);
                lock
            },
            data_root,
            resource_dir,
            start_time: self.start_time,
            web_server_handle: self.web_server_handle.clone(),
            proxy_manager: crate::services::ProxyManager::new(),
        }
    }
}
