/**
 * Scheduler vNext - Workflow State Machine
 *
 * Workflow 和 Node 的状态机逻辑
 */

import type {
  Workflow,
  WorkflowStatus,
  WorkflowNode,
  NodeState,
  AgentEvent,
  NodeStateTransition,
} from '../types';

// ============================================================================
// Workflow 状态机
// ============================================================================

/**
 * Workflow 状态转换规则
 */
const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  CREATED: ['PLANNING', 'RUNNING', 'FAILED'],
  PLANNING: ['RUNNING', 'FAILED', 'COMPLETED', 'CREATED'],
  RUNNING: ['WAITING_EVENT', 'BLOCKED', 'COMPACTING_MEMORY', 'FAILED', 'COMPLETED', 'EVOLVING', 'CREATED'],
  WAITING_EVENT: ['RUNNING', 'BLOCKED', 'FAILED', 'COMPLETED', 'CREATED'],
  BLOCKED: ['RUNNING', 'FAILED', 'COMPLETED', 'CREATED'],
  COMPACTING_MEMORY: ['RUNNING', 'FAILED'],
  FAILED: ['RUNNING', 'CREATED'], // 允许重试
  COMPLETED: ['EVOLVING', 'CREATED'], // 允许重新启动
  EVOLVING: ['RUNNING', 'COMPLETED', 'FAILED', 'CREATED'],
};

/**
 * 检查 Workflow 状态转换是否合法
 */
export function canTransitionWorkflow(
  currentStatus: WorkflowStatus,
  targetStatus: WorkflowStatus
): boolean {
  return WORKFLOW_TRANSITIONS[currentStatus]?.includes(targetStatus) ?? false;
}

/**
 * 获取 Workflow 可转换的状态列表
 */
export function getValidWorkflowTransitions(status: WorkflowStatus): WorkflowStatus[] {
  return WORKFLOW_TRANSITIONS[status] ?? [];
}

/**
 * Workflow 状态机
 */
export class WorkflowStateMachine {
  private workflow: Workflow;
  private transitions: NodeStateTransition[] = [];

  constructor(workflow: Workflow) {
    this.workflow = workflow;
  }

  /**
   * 尝试转换状态
   */
  transition(targetStatus: WorkflowStatus, event?: AgentEvent): boolean {
    if (!canTransitionWorkflow(this.workflow.status, targetStatus)) {
      return false;
    }

    const previousStatus = this.workflow.status;
    this.workflow.status = targetStatus;
    this.workflow.updatedAt = Date.now();

    // 记录转换（可选）
    if (event) {
      this.transitions.push({
        from: previousStatus as NodeState,
        to: targetStatus as NodeState,
        event,
        timestamp: Date.now(),
      });
    }

    return true;
  }

  /**
   * 启动工作流
   */
  start(): boolean {
    if (this.workflow.status === 'CREATED' || this.workflow.status === 'FAILED') {
      return this.transition('RUNNING');
    }
    if (this.workflow.status === 'PLANNING') {
      return this.transition('RUNNING');
    }
    return false;
  }

  /**
   * 暂停工作流（进入等待事件状态）
   */
  pause(): boolean {
    return this.transition('WAITING_EVENT');
  }

  /**
   * 恢复工作流
   */
  resume(): boolean {
    if (this.workflow.status === 'WAITING_EVENT' || this.workflow.status === 'BLOCKED') {
      return this.transition('RUNNING');
    }
    return false;
  }

  /**
   * 标记完成
   */
  complete(): boolean {
    return this.transition('COMPLETED');
  }

  /**
   * 标记失败
   */
  fail(): boolean {
    return this.transition('FAILED');
  }

  /**
   * 进入进化模式
   */
  evolve(): boolean {
    return this.transition('EVOLVING');
  }

  /**
   * 重置工作流
   */
  reset(): boolean {
    this.workflow.currentRounds = 0;
    this.workflow.currentNodeId = undefined;
    return this.transition('CREATED');
  }

  /**
   * 获取当前工作流
   */
  getWorkflow(): Workflow {
    return this.workflow;
  }
}

// ============================================================================
// Node 状态机
// ============================================================================

/**
 * Node 状态转换规则
 */
const NODE_TRANSITIONS: Record<NodeState, NodeState[]> = {
  IDLE: ['READY', 'RUNNING', 'SKIPPED'],
  READY: ['RUNNING', 'IDLE', 'SKIPPED'],
  RUNNING: ['WAITING_INPUT', 'WAITING_EVENT', 'DONE', 'FAILED'],
  WAITING_INPUT: ['RUNNING', 'DONE', 'FAILED'],
  WAITING_EVENT: ['RUNNING', 'DONE', 'FAILED'],
  DONE: ['IDLE', 'READY'], // 连续模式下可以重新激活
  FAILED: ['IDLE', 'READY'], // 允许重试
  SKIPPED: [],
};

/**
 * 检查 Node 状态转换是否合法
 */
export function canTransitionNode(
  currentState: NodeState,
  targetState: NodeState
): boolean {
  return NODE_TRANSITIONS[currentState]?.includes(targetState) ?? false;
}

/**
 * 获取 Node 可转换的状态列表
 */
export function getValidNodeTransitions(state: NodeState): NodeState[] {
  return NODE_TRANSITIONS[state] ?? [];
}

/**
 * Node 状态机
 */
export class NodeStateMachine {
  private node: WorkflowNode;
  private transitions: NodeStateTransition[] = [];

  constructor(node: WorkflowNode) {
    this.node = node;
  }

  /**
   * 尝试转换状态
   */
  transition(targetState: NodeState, event?: AgentEvent): boolean {
    if (!canTransitionNode(this.node.state, targetState)) {
      return false;
    }

    const previousState = this.node.state;
    this.node.state = targetState;
    this.transitions.push({
      from: previousState,
      to: targetState,
      event,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * 激活节点（进入就绪状态）
   */
  activate(): boolean {
    if (this.node.state === 'IDLE' || this.node.state === 'DONE' || this.node.state === 'FAILED') {
      return this.transition('READY');
    }
    return false;
  }

  /**
   * 开始执行
   */
  start(): boolean {
    if (this.node.state === 'READY' || this.node.state === 'IDLE') {
      return this.transition('RUNNING');
    }
    return false;
  }

  /**
   * 等待输入
   */
  waitForInput(): boolean {
    return this.transition('WAITING_INPUT');
  }

  /**
   * 等待事件
   */
  waitForEvent(): boolean {
    return this.transition('WAITING_EVENT');
  }

  /**
   * 标记完成
   */
  complete(): boolean {
    if (this.node.state === 'RUNNING' ||
        this.node.state === 'WAITING_INPUT' ||
        this.node.state === 'WAITING_EVENT') {
      this.node.currentRounds = (this.node.currentRounds ?? 0) + 1;
      return this.transition('DONE');
    }
    return false;
  }

  /**
   * 标记失败
   */
  fail(): boolean {
    return this.transition('FAILED');
  }

  /**
   * 重置节点（用于连续模式）
   */
  reset(): boolean {
    return this.transition('IDLE');
  }

  /**
   * 检查是否可以执行
   */
  canExecute(): boolean {
    return this.node.state === 'READY' && this.node.enabled;
  }

  /**
   * 检查是否已完成最大轮次
   */
  isMaxRoundsReached(): boolean {
    return (this.node.currentRounds ?? 0) >= this.node.maxRounds;
  }

  /**
   * 获取当前节点
   */
  getNode(): WorkflowNode {
    return this.node;
  }

  /**
   * 获取状态转换历史
   */
  getTransitions(): NodeStateTransition[] {
    return [...this.transitions];
  }
}

// ============================================================================
// Node READY 判定逻辑
// ============================================================================

/**
 * 判定节点是否可以进入 READY 状态
 */
export function canNodeBeReady(
  node: WorkflowNode,
  allNodes: WorkflowNode[],
  pendingEvents: AgentEvent[]
): boolean {
  // 已启用且状态为 IDLE
  if (!node.enabled || node.state !== 'IDLE') {
    return false;
  }

  // 检查是否达到最大轮次
  if ((node.currentRounds ?? 0) >= node.maxRounds) {
    return false;
  }

  // 根据触发类型判断
  switch (node.triggerType) {
    case 'start':
      // 启动触发：总是可以就绪
      return true;

    case 'dependency':
      // 依赖触发：检查所有依赖节点是否完成
      return node.dependencies.every(depId => {
        const depNode = allNodes.find(n => n.id === depId);
        return depNode?.state === 'DONE';
      });

    case 'event':
      // 事件触发：检查是否有所需事件
      return node.subscribeEvents.some(eventType =>
        pendingEvents.some(e => e.type === eventType && !e.consumed)
      );

    default:
      return false;
  }
}

/**
 * 获取所有可就绪的节点
 */
export function getReadyNodes(
  nodes: WorkflowNode[],
  pendingEvents: AgentEvent[]
): WorkflowNode[] {
  return nodes.filter(node =>
    canNodeBeReady(node, nodes, pendingEvents)
  );
}

// ============================================================================
// 状态查询工具
// ============================================================================

/**
 * 检查工作流是否处于活跃状态
 */
export function isWorkflowActive(workflow: Workflow): boolean {
  return ['RUNNING', 'PLANNING', 'WAITING_EVENT', 'EVOLVING'].includes(workflow.status);
}

/**
 * 检查工作流是否可以启动
 */
export function canStartWorkflow(workflow: Workflow): boolean {
  return ['CREATED', 'FAILED', 'COMPLETED'].includes(workflow.status);
}

/**
 * 检查节点是否处于活跃状态
 */
export function isNodeActive(node: WorkflowNode): boolean {
  return ['READY', 'RUNNING', 'WAITING_INPUT', 'WAITING_EVENT'].includes(node.state);
}

/**
 * 检查节点是否处于可执行状态
 */
export function isNodeExecutable(node: WorkflowNode): boolean {
  return node.state === 'READY' && node.enabled;
}

/**
 * 获取工作流进度
 */
export function getWorkflowProgress(
  workflow: Workflow,
  nodes: WorkflowNode[]
): {
  totalNodes: number;
  completedNodes: number;
  runningNodes: number;
  progress: number;
} {
  const totalNodes = nodes.length;
  const completedNodes = nodes.filter(n => n.state === 'DONE').length;
  const runningNodes = nodes.filter(n => n.state === 'RUNNING').length;
  const progress = totalNodes > 0 ? (completedNodes / totalNodes) * 100 : 0;

  return {
    totalNodes,
    completedNodes,
    runningNodes,
    progress,
  };
}
