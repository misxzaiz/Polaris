/*! 应用状态定义
 *
 * 集中管理全局状态，包括配置存储、会话管理、集成管理器等
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::ai::EngineRegistry;
use crate::commands::context::ContextMemoryStore;
use crate::commands::terminal::TerminalManager;
use crate::integrations::IntegrationManager;
use crate::services::config_store::ConfigStore;
use crate::services::scheduler::{TaskStoreService, LogStoreService, SchedulerDispatcher, UnifiedStorageService};
use crate::utils::SchedulerLock;

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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    pub config_store: Mutex<ConfigStore>,
    /// 保存会话 ID 到进程 PID 的映射（保留向后兼容）
    /// 使用 PID 而不是 Child，因为 Child 会在读取输出时被消费
    pub sessions: Arc<Mutex<HashMap<String, u32>>>,
    /// OpenAIProxy 任务的取消控制
    pub openai_tasks: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// 上下文存储
    pub context_store: Arc<Mutex<ContextMemoryStore>>,
    /// 集成管理器 (使用 tokio::sync::Mutex 支持异步操作)
    pub integration_manager: AsyncMutex<IntegrationManager>,
    /// AI 引擎注册表（使用 tokio::sync::Mutex 支持异步操作和共享）
    pub engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    /// 定时任务存储（旧版 JSON 存储，保留向后兼容）
    pub scheduler_task_store: Arc<AsyncMutex<TaskStoreService>>,
    /// 定时任务日志存储（旧版 JSON 存储，保留向后兼容）
    pub scheduler_log_store: Arc<AsyncMutex<LogStoreService>>,
    /// 统一存储服务（新版 SQLite 存储）
    /// 支持自动迁移 JSON 数据到 SQLite
    pub unified_storage: Arc<AsyncMutex<UnifiedStorageService>>,
    /// 定时任务调度器
    pub scheduler_dispatcher: Arc<AsyncMutex<SchedulerDispatcher>>,
    /// 调度器单例锁（持有表示当前实例负责调度）
    pub scheduler_lock: AsyncMutex<Option<SchedulerLock>>,
    /// 终端管理器
    pub terminal_manager: Mutex<TerminalManager>,
    /// 待回答问题映射：callId -> PendingQuestion
    pub pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
    /// 待审批计划映射：planId -> PendingPlan
    pub pending_plans: Arc<Mutex<HashMap<String, PendingPlan>>>,
}

/// 创建应用状态
pub fn create_app_state(
    config_store: ConfigStore,
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    integration_manager: IntegrationManager,
) -> AppState {
    // 初始化统一存储服务（SQLite）
    let unified_storage = match UnifiedStorageService::new() {
        Ok(service) => {
            tracing::info!(
                "[AppState] 统一存储服务初始化成功，后端类型: {:?}",
                service.backend_type()
            );
            Arc::new(AsyncMutex::new(service))
        }
        Err(e) => {
            tracing::error!("[AppState] 统一存储服务初始化失败: {:?}", e);
            panic!("无法初始化统一存储服务: {:?}", e);
        }
    };

    // 初始化定时任务服务（保留向后兼容）
    let task_store = Arc::new(AsyncMutex::new(
        TaskStoreService::new().expect("无法初始化任务存储")
    ));
    let log_store = Arc::new(AsyncMutex::new(
        LogStoreService::new().expect("无法初始化日志存储")
    ));

    let dispatcher = SchedulerDispatcher::new(
        task_store.clone(),
        log_store.clone(),
        engine_registry.clone(),
    ).with_unified_storage(unified_storage.clone());

    // 注意：调度器启动需要在 Tauri 运行时中进行，在 lib.rs 的 setup hook 中启动

    AppState {
        config_store: Mutex::new(config_store),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        openai_tasks: Arc::new(Mutex::new(HashMap::new())),
        context_store: Arc::new(Mutex::new(ContextMemoryStore::new())),
        integration_manager: AsyncMutex::new(integration_manager),
        engine_registry,
        scheduler_task_store: task_store,
        scheduler_log_store: log_store,
        unified_storage,
        scheduler_dispatcher: Arc::new(AsyncMutex::new(dispatcher)),
        scheduler_lock: AsyncMutex::new(None),
        terminal_manager: Mutex::new(TerminalManager::new()),
        pending_questions: Arc::new(Mutex::new(HashMap::new())),
        pending_plans: Arc::new(Mutex::new(HashMap::new())),
    }
}
