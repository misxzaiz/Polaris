/**
 * Scheduler vNext - WorkflowNode Data Models
 *
 * WorkflowNode 类型定义
 */

// ============================================================================
// Node State
// ============================================================================

/**
 * 节点状态
 */
export type NodeState =
  | 'IDLE'           // 空闲，未激活
  | 'READY'          // 就绪，等待执行
  | 'RUNNING'        // 正在执行
  | 'WAITING_INPUT'  // 等待用户输入
  | 'WAITING_EVENT'  // 等待事件
  | 'DONE'           // 完成
  | 'FAILED'         // 失败
  | 'SKIPPED';       // 跳过

// ============================================================================
// Node Trigger Types
// ============================================================================

/**
 * 节点触发类型
 */
export type NodeTriggerType =
  | 'start'       // 工作流启动时触发
  | 'dependency'  // 依赖节点完成时触发
  | 'event';      // 事件触发

/**
 * 节点执行策略
 */
export type ExecutionStrategy =
  | 'sequential'   // 顺序执行
  | 'parallel'     // 并行执行
  | 'conditional'  // 条件执行
  | 'PLAN_FIRST'   // 先规划
  | 'EXPLORE'      // 探索模式
  | 'TEST_DRIVEN'; // 测试驱动

// ============================================================================
// WorkflowNode
// ============================================================================

/**
 * 工作流节点
 */
export interface WorkflowNode {
  /** 节点 ID */
  id: string;

  /** 节点名称 */
  name: string;

  /** 节点角色描述 */
  role: string;

  /** 所属工作流 ID */
  workflowId: string;

  /** 关联的 Agent Profile ID */
  templateId?: string;

  /** 当前状态 */
  state: NodeState;

  /** 触发类型 */
  triggerType: NodeTriggerType;

  /** 订阅的事件类型列表 */
  subscribeEvents: string[];

  /** 发射的事件类型列表 */
  emitEvents: string[];

  /** 依赖的节点 ID 列表 */
  dependencies: string[];

  /** 依赖的节点 ID 列表 (alias for dependencies) */
  dependsOn?: string[];

  /** 下一个节点 ID 列表 */
  nextNodes?: string[];

  /** 是否启用 */
  enabled: boolean;

  /** 最大执行轮次 */
  maxRounds: number;

  /** 当前已执行轮次 */
  currentRounds?: number;

  /** 当前轮次 (alias for currentRounds) */
  currentRound?: number;

  /** 任务提示词 */
  taskPrompt?: string;

  /** 节点顺序 */
  order?: number;

  /** 执行超时 (ms) */
  timeoutMs?: number;

  /** 最大重试次数 */
  maxRetries?: number;

  /** 当前重试次数 */
  retries?: number;

  /** 当前重试次数 (alias for retries) */
  retryCount?: number;

  /** 创建时间 */
  createdAt: number;

  /** 更新时间 */
  updatedAt: number;

  /** 额外配置 */
  config?: Record<string, unknown>;
}

// ============================================================================
// Create/Update Params
// ============================================================================

/**
 * 创建节点参数
 */
export interface CreateNodeParams {
  /** 节点 ID */
  id: string;

  /** 节点名称 */
  name: string;

  /** 节点角色 */
  role: string;

  /** 工作流 ID */
  workflowId: string;

  /** Agent Profile ID */
  templateId?: string;

  /** 触发类型 */
  triggerType?: NodeTriggerType;

  /** 订阅事件 */
  subscribeEvents?: string[];

  /** 发射事件 */
  emitEvents?: string[];

  /** 依赖节点 */
  dependencies?: string[];

  /** 是否启用 */
  enabled?: boolean;

  /** 最大轮次 */
  maxRounds?: number;

  /** 任务提示词 */
  taskPrompt?: string;
}

/**
 * 更新节点参数
 */
export interface UpdateNodeParams {
  name?: string;
  role?: string;
  agentProfileId?: string;
  triggerType?: NodeTriggerType;
  subscribeEvents?: string[];
  emitEvents?: string[];
  nextNodes?: string[];
  dependencies?: string[];
  maxRounds?: number;
  order?: number;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  config?: Record<string, unknown>;
}

// ============================================================================
// Node Ready Check
// ============================================================================

/**
 * 节点就绪检查结果
 */
export interface NodeReadyCheck {
  nodeId: string;
  isReady: boolean;
  blockedBy: string[];
  reason: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 检查是否为终止状态
 */
export function isTerminalState(state: NodeState): boolean {
  return state === 'DONE' || state === 'FAILED' || state === 'SKIPPED';
}

/**
 * 检查状态转换是否合法
 */
export function isValidTransition(
  from: NodeState,
  to: NodeState
): boolean {
  const validTransitions: Record<NodeState, NodeState[]> = {
    'IDLE': ['READY', 'SKIPPED'],
    'READY': ['RUNNING', 'SKIPPED'],
    'RUNNING': ['DONE', 'FAILED', 'WAITING_INPUT', 'WAITING_EVENT'],
    'WAITING_INPUT': ['RUNNING', 'FAILED'],
    'WAITING_EVENT': ['RUNNING', 'FAILED', 'DONE'],
    'DONE': ['READY'],
    'FAILED': ['READY'],
    'SKIPPED': [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}
