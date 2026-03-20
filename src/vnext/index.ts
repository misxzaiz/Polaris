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
} from './session';

// TokenUsage from session (alias to avoid conflict with monitor)
export type { TokenUsage as SessionTokenUsage } from './session';

// 上下文构建器
export {
  // 构建器实现
  ContextBuilder,
  getContextBuilder,
  resetContextBuilder,

  // 类型
  type IContextBuilder,
  type PromptContext,
  type ContextBuildOptions,
  type UserInput,
  type DependencyStatus,
  type ContextInfo,
} from './context';

// NodeExecutionContext from context (alias to avoid conflict with runtime)
export type { NodeExecutionContext as ContextNodeExecutionContext, UserInputType as ContextUserInputType } from './context';

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
  type InterruptRequest,
  type UserInputEntry,
  type InterruptConfig,
  type InterruptInboxState,
  type InterruptEvent,
  type InterruptListener,
  type InterruptFilter,
} from './interrupt';

// UserInputType from interrupt (the main one)
export { UserInputType } from './interrupt';

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
  type ExecutionLogEntry,
  type ResourceUsageStats,
  type RealtimeMetrics,
  type MonitorConfig,
  type MonitorEvent,
  type MonitorListener,
} from './monitor';

// TokenUsage from monitor (the main one)
export type { TokenUsage } from './monitor';

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
  type NodeExecutionResult,
  type WorkflowRegistration,
} from './runtime';

// NodeExecutionContext from runtime (alias to avoid conflict with context)
export type { NodeExecutionContext as RuntimeNodeExecutionContext } from './runtime';

// Plugin System
export {
  // Plugin Manager
  PluginManager,

  // Built-in Plugins
  loggingPlugin,
  metricsPlugin,
  rateLimitPlugin,
  cachingPlugin,
  getBuiltinPlugins,

  // Types
  BUILTIN_PLUGINS,
  type Plugin,
  type PluginMeta,
  type PluginHooks,
  type PluginHook,
  type PluginContext,
  type PluginLogger,
  type PluginPriority,
  type PluginState,
  type PluginStatus,
  type HookResult,
  type PluginManagerConfig,
  type PluginConfigSchema,
  type ConfigField,

  // Hook Payloads
  type BeforeWorkflowStartPayload,
  type AfterWorkflowCompletePayload,
  type BeforeNodeExecutePayload,
  type AfterNodeExecutePayload,
  type WorkflowErrorPayload,
  type NodeErrorPayload,
  type EventEmitPayload,
  type EventReceivePayload,
  type MemorySavePayload,
  type MemoryLoadPayload,
  type PersistPayload,
  type RestorePayload,

  // Metrics Types
  type MetricsData,
  type RateLimitConfig,
  type CacheEntry,
} from './plugin';

// Benchmark
export {
  // Benchmark runners
  runBenchmark,
  runAllBenchmarks,
  BenchmarkSuite,
  createStateMachineBenchmarkSuite,
  createEventBusBenchmarkSuite,
  createNodeSelectionBenchmarkSuite,
  createExecutionStoreBenchmarkSuite,
  createMemoryBenchmarkSuite,

  // Helpers
  createBenchmarkWorkflow,
  createBenchmarkNodes,
  formatBenchmarkResult,
  formatSuiteResult,

  // Types
  type BenchmarkResult,
  type BenchmarkSuiteResult,
  type BenchmarkConfig,
} from './benchmark';

// React Components
export {
  // Types
  getNodeStatusConfig,
  getTimelineEventTypeConfig,

  // Progress Components
  ProgressBar,
  SimpleProgressBar,
  CircularProgress,

  // Node Status Components
  NodeStatusCard,
  NodeStatusMiniCard,
  NodeStatusGrid,
  NodeStatusList,

  // Workflow Diagram
  WorkflowDiagram,
  SimpleWorkflowDiagram,

  // Dashboard
  DashboardOverview,
  TokenSummaryCard,
  CostSummaryCard,
  StatsCardGroup,
  QuickStatsBar,

  // Timeline
  TimelineView,
  SimpleTimeline,
  NodeGanttChart,

  // Component Types
  type WorkflowDiagramProps,
  type NodeStatusCardProps,
  type DashboardOverviewProps,
  type ProgressBarProps,
  type TokenSummaryCardProps,
  type CostSummaryCardProps,
  type TimelineViewProps,
  type TimelineEventItemProps,
  type WorkflowListProps,
  type WorkflowListItemProps,
  type NodePosition,
  type ConnectionLine,
  type NodeStatusConfig,
  type TimelineEventTypeConfig,
} from './components';

// CLI Tool
export {
  // CLI Tool
  CLITool,
  createCLITool,

  // Formatters
  formatTable,
  formatJSON,
  formatYAML,
  formatStatusBadge,
  formatDuration,
  formatRelativeTime,

  // Types
  DEFAULT_CLI_CONFIG,
  BUILTIN_TEMPLATES,
  type CLICommand,
  type CLIOptions,
  type CLIResult,
  type CLIContext,
  type CLIConfig,
  type CLICommandDefinition,
  type WorkflowTemplate as CLIWorkflowTemplate,
  type MonitorData,
  type TableColumn,
  type TableOptions,
} from './cli';

// Engine Adapter
export {
  // Adapter
  AIEngineAdapter,
  createAIEngineSession,

  // Types
  type EngineAdapterConfig,
  type EngineAdapterState,
  type EngineAdapterInfo,
  type EngineAdapterEvent,
} from './engine-adapter';
