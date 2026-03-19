/**
 * Scheduler vNext - Event Driven Multi-Agent Workflow Engine
 *
 * 主入口模块
 */

// 类型定义
export * from './types';

// 状态机
export {
  // Workflow 状态机
  canTransitionWorkflow,
  getValidWorkflowTransitions,
  WorkflowStateMachine,

  // Node 状态机
  canTransitionNode,
  getValidNodeTransitions,
  NodeStateMachine,

  // Node READY 判定
  canNodeBeReady,
  getReadyNodes,

  // 状态查询工具
  isWorkflowActive,
  canStartWorkflow,
  isNodeActive,
  isNodeExecutable,
  getWorkflowProgress,
} from './state-machine';

// 事件总线
export {
  EventBus,
  getEventBus,
  resetEventBus,
  type EventBusConfig,
} from './event-bus';

// 执行器
export {
  // 执行器实现
  ContinuousExecutor,
  DefaultNodeSelector,

  // 类型
  type ExecutorState,
  type ExecutionContext,
  type ExecutionResult,
  type ExecutorRunResult,
  type IExecutor,
  type ContinuousExecutorConfig,
  type INodeSelector,
  type NodeSelectionStrategy,
} from './executor';

// 调度器
export {
  // 调度器实现
  PriorityDispatcher,
  DefaultWorkflowSelector,

  // 类型
  type DispatcherState,
  type WorkflowEntry,
  type DispatchStrategy,
  type IWorkflowSelector,
  type IDispatcher,
  type PriorityDispatcherConfig,
  type DispatchResult,
  type DispatcherRunResult,
} from './dispatcher';

// 事件控制器
export {
  // 控制器实现
  NodeEventController,
  getNodeEventController,
  resetNodeEventController,

  // 类型
  type NodeSubscriptionRecord,
  type EventMatchResult,
  type NodeEventControllerConfig,
  type EmitEventOptions,
  type NodeCompletionResult,
} from './event-controller';

// Pipeline 推进
export {
  // Pipeline 实现
  PipelineOrchestrator,

  // 类型
  type PipelineState,
  type NodeExecutionState,
  type PipelineAdvanceResult,
  type PipelineConfig,
  type PipelineProgress,
} from './pipeline';

// 执行记录存储
export {
  // 存储实现
  ExecutionStore,
  getExecutionStore,
  resetExecutionStore,

  // 类型
  type ExecutionStoreConfig,
  type ExecutionStats,
  type CreateExecutionParams,
  type CompleteExecutionParams,
} from './execution-store';

// AI Session Manager
export {
  // 会话管理器
  SessionManager,
  MockSession,
  getSessionManager,
  resetSessionManager,

  // 类型
  type ISession,
  type ISessionManager,
  type SessionFactory,
  type SessionState,
  type SessionConfig,
  type SessionInfo,
  type SessionResult,
  type Message,
  type ExecutionEvent,
  type SessionEventCallbacks,
  type ToolCallRecord,
  type TokenUsage,
} from './session';

// 上下文构建器
export {
  // 构建器实现
  ContextBuilder,
  getContextBuilder,
  resetContextBuilder,

  // 类型
  type IContextBuilder,
  type NodeExecutionContext,
  type PromptContext,
  type ContextBuildOptions,
  type UserInput,
  type UserInputType,
  type DependencyStatus,
  type ContextInfo,
} from './context';

// 模板系统
export {
  // 模板引擎
  TemplateEngine,
  getTemplateEngine,
  resetTemplateEngine,

  // 类型
  type ITemplateEngine,
  type TemplateType,
  type ProfileTemplate,
  type PromptTemplate,
  type WorkflowTemplate,
  type NodeTemplate,
  type TemplateVariable,
  type TemplateRenderContext,
  type TemplateRenderResult,
} from './template';

// Memory 管理
export {
  // Memory 管理器
  MemoryManager,
  InMemoryStore,
  DefaultMemoryCompactor,
  SemanticIndexStub,
  getMemoryManager,
  resetMemoryManager,

  // 类型
  type IMemoryManager,
  type IMemoryStore,
  type IMemoryCompactor,
  type ISemanticIndex,
  type MemoryManagerConfig,
  type MemoryEventListener,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryQueryFilter,
  type CompactionResult,
  type MemoryWorkflowState,
  type MemoryLayerInfo,
} from './memory-manager';

// Interrupt Inbox
export {
  // 中断收件箱
  InterruptInbox,
  getInterruptInbox,
  resetInterruptInbox,

  // 类型
  InterruptType,
  InterruptPriority,
  InterruptStatus,
  UserInputType,
  type InterruptRequest,
  type UserInputEntry,
  type InterruptConfig,
  type InterruptInboxState,
  type InterruptEvent,
  type InterruptListener,
  type InterruptFilter,
} from './interrupt';

// Runtime Monitor
export {
  // 运行时监控器
  RuntimeMonitor,
  getRuntimeMonitor,
  resetRuntimeMonitor,

  // 类型
  MonitorEventType,
  type WorkflowRuntimeStatus,
  type NodeRuntimeStatus,
  type TokenUsage,
  type ExecutionLogEntry,
  type ResourceUsageStats,
  type RealtimeMetrics,
  type MonitorConfig,
  type MonitorEvent,
  type MonitorListener,
} from './monitor';

// Workflow Persistence
export {
  // 持久化管理器
  WorkflowPersistence,
  MemoryStorage,
  getWorkflowPersistence,
  resetWorkflowPersistence,

  // 类型
  StorageType,
  SnapshotType,
  type PersistenceSnapshot,
  type PersistenceConfig,
  type PersistenceState,
  type PersistenceEvent,
  type PersistenceListener,
  type IStorage,
  type ExportFormat,
} from './persistence';

// Error Recovery
export {
  // 错误恢复管理器
  ErrorRecovery,
  getErrorRecovery,
  resetErrorRecovery,

  // 类型
  ErrorType,
  ErrorSeverity,
  RecoveryStrategy,
  RecoveryStatus,
  type ErrorRecord,
  type ErrorRecoveryConfig,
  type RecoveryStrategyConfig,
  type RecoveryEvent,
  type RecoveryListener,
  type RecoveryResult,
} from './recovery';

// Workflow Runtime
export {
  // 运行时实现
  WorkflowRuntime,
  getWorkflowRuntime,
  resetWorkflowRuntime,

  // 类型
  DEFAULT_RUNTIME_CONFIG,
  type WorkflowRuntimeConfig,
  type RuntimeState,
  type WorkflowRunStatus,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeEventType,
  type WorkflowRunResult,
  type NodeExecutorFn,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type WorkflowRegistration,
} from './runtime';
