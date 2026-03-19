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
