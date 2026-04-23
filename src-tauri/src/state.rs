/*! 应用状态定义
 *
 * 集中管理全局状态，包括配置存储、会话管理、集成管理器等
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, broadcast};

use crate::ai::EngineRegistry;
use crate::commands::context::ContextMemoryStore;
use crate::commands::terminal::TerminalManager;
use crate::integrations::IntegrationManager;
use crate::services::config_store::ConfigStore;
use crate::services::file_watcher::FileWatcherManager;
use crate::services::lsp::LspManager;
use crate::services::lsp_config_repository::LspConfigRepository;
use crate::services::scheduler_daemon::SchedulerDaemon;

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
    /// WebSocket 事件广播通道（Web Access Layer）
    pub event_broadcast: broadcast::Sender<String>,
}

/// 创建应用状态
pub fn create_app_state(
    config_store: ConfigStore,
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    integration_manager: IntegrationManager,
) -> AppState {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("claude-code-pro");

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
        event_broadcast: broadcast::channel(256).0,
    }
}

impl AppState {
    /// Clone shared Arc fields for the web server.
    ///
    /// Non-shared fields (integration_manager, terminal_manager, etc.) get fresh
    /// empty instances — the web server never accesses them.
    pub fn clone_for_web(&self) -> AppState {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("claude-code-pro");

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
        }
    }
}
