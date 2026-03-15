/**
 * 应用状态定义
 *
 * 集中管理全局状态，包括配置存储、会话管理、集成管理器等
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::ai::EngineRegistry;
use crate::commands::context::ContextMemoryStore;
use crate::integrations::IntegrationManager;
use crate::services::config_store::ConfigStore;
use crate::services::scheduler::{TaskStoreService, LogStoreService, SchedulerDispatcher};
use crate::utils::SchedulerLock;

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
    /// 定时任务存储
    pub scheduler_task_store: Arc<AsyncMutex<TaskStoreService>>,
    /// 定时任务日志存储
    pub scheduler_log_store: Arc<AsyncMutex<LogStoreService>>,
    /// 定时任务调度器
    pub scheduler_dispatcher: Arc<AsyncMutex<SchedulerDispatcher>>,
    /// 调度器单例锁（持有表示当前实例负责调度）
    pub scheduler_lock: AsyncMutex<Option<SchedulerLock>>,
}

/// 创建应用状态
pub fn create_app_state(
    config_store: ConfigStore,
    engine_registry: Arc<AsyncMutex<EngineRegistry>>,
    integration_manager: IntegrationManager,
) -> AppState {
    // 初始化定时任务服务
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
    );

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
        scheduler_dispatcher: Arc::new(AsyncMutex::new(dispatcher)),
        scheduler_lock: AsyncMutex::new(None),
    }
}
