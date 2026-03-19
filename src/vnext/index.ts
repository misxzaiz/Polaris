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
