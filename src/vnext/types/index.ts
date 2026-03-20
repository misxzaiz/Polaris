/**
 * Scheduler vNext - Workflow Engine Types
 *
 * Event Driven Multi-Agent Workflow Engine
 * 核心数据模型定义
 */

// ============================================================================
// Workflow 状态枚举
// ============================================================================

/**
 * Workflow 生命周期状态
 */
export type WorkflowStatus =
  | 'CREATED'      // 已创建，等待启动
  | 'PLANNING'     // 规划阶段
  | 'RUNNING'      // 正在执行
  | 'WAITING_EVENT' // 等待事件触发
  | 'BLOCKED'      // 被阻塞
  | 'COMPACTING_MEMORY' // 内存压缩中
  | 'FAILED'       // 执行失败
  | 'COMPLETED'    // 已完成
  | 'EVOLVING';    // 进化模式（自动优化）

/**
 * Workflow 执行模式
 */
export type WorkflowMode =
  | 'continuous'   // 连续执行模式（无等待）
  | 'scheduled'    // 定时触发模式
  | 'event';       // 事件驱动模式

// ============================================================================
// Workflow Node 状态枚举
// ============================================================================

/**
 * Node 节点状态
 */
export type NodeState =
  | 'IDLE'          // 空闲，等待触发
  | 'READY'         // 就绪，可以执行
  | 'RUNNING'       // 正在执行
  | 'WAITING_INPUT' // 等待用户输入
  | 'WAITING_EVENT' // 等待事件
  | 'DONE'          // 已完成
  | 'FAILED'        // 执行失败
  | 'SKIPPED';      // 已跳过

/**
 * Node 触发类型
 */
export type NodeTriggerType =
  | 'start'         // 工作流启动时触发
  | 'event'         // 事件触发
  | 'dependency';   // 依赖完成后触发

/**
 * Agent 执行策略
 */
export type ExecutionStrategy =
  | 'PLAN_FIRST'    // 先规划后执行
  | 'CODE_FIRST'    // 直接编码
  | 'TEST_DRIVEN'   // 测试驱动开发
  | 'EXPLORE';      // 探索模式

// ============================================================================
// Workflow 数据模型
// ============================================================================

/**
 * Workflow（工作流）
 *
 * 代表一个完整的多 Agent 协同工作流
 */
export interface Workflow {
  /** 唯一标识符 */
  id: string;

  /** 工作流名称 */
  name: string;

  /** 描述 */
  description?: string;

  /** 使用的模板 ID */
  templateId?: string;

  /** 当前状态 */
  status: WorkflowStatus;

  /** 执行模式 */
  mode: WorkflowMode;

  /** 优先级 (1-100, 越高越优先) */
  priority: number;

  /** 是否启用连续执行模式 */
  continuousMode?: boolean;

  /** 创建时间戳 */
  createdAt: number;

  /** 更新时间戳 */
  updatedAt: number;

  /** 当前执行的节点 ID */
  currentNodeId?: string;

  /** Memory 存储根路径 */
  memoryRoot?: string;

  /** 工作目录 */
  workDir?: string;

  /** 最大执行轮次 */
  maxRounds?: number;

  /** 当前已执行轮次 */
  currentRounds?: number;

  /** 标签 */
  tags?: string[];

  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 创建 Workflow 参数
 */
export interface CreateWorkflowParams {
  name: string;
  templateId: string;
  mode?: WorkflowMode;
  priority?: number;
  continuousMode?: boolean;
  workDir?: string;
  maxRounds?: number;
  tags?: string[];
}

// ============================================================================
// WorkflowNode 数据模型
// ============================================================================

/**
 * WorkflowNode（工作流节点）
 *
 * 代表工作流中的一个 Agent 执行节点
 */
export interface WorkflowNode {
  /** 节点唯一标识符 */
  id: string;

  /** 所属工作流 ID */
  workflowId: string;

  /** 节点名称 */
  name: string;

  /** Agent 角色 (product/dev/test/research等) */
  role: string;

  /** 使用的 Agent 模板 ID */
  agentProfileId?: string;

  /** 当前状态 */
  state: NodeState;

  /** 触发类型 */
  triggerType: NodeTriggerType;

  /** 订阅的事件类型列表 */
  subscribeEvents: string[];

  /** 执行完成后发布的事件类型列表 */
  emitEvents: string[];

  /** 下游节点 ID 列表 */
  nextNodes: string[];

  /** 依赖节点 ID 列表（需等待这些节点完成） */
  dependencies: string[];

  /** 最大执行轮次 */
  maxRounds: number;

  /** 当前已执行轮次 */
  currentRounds?: number;

  /** 执行顺序 */
  order?: number;

  /** 是否启用 */
  enabled: boolean;

  /** 创建时间 */
  createdAt?: number;

  /** 更新时间 */
  updatedAt?: number;

  /** 超时时间（毫秒） */
  timeoutMs?: number;

  /** 重试次数 */
  retryCount?: number;

  /** 最大重试次数 */
  maxRetries?: number;

  /** 自定义配置 */
  config?: Record<string, unknown>;
}

/**
 * 创建 WorkflowNode 参数
 */
export interface CreateNodeParams {
  workflowId: string;
  name: string;
  role: string;
  agentProfileId: string;
  triggerType?: NodeTriggerType;
  subscribeEvents?: string[];
  emitEvents?: string[];
  nextNodes?: string[];
  dependencies?: string[];
  maxRounds?: number;
  order?: number;
  enabled?: boolean;
}

// ============================================================================
// AgentProfile 数据模型
// ============================================================================

/**
 * AgentProfile（Agent 配置模板）
 *
 * 定义 Agent 的行为规范、执行策略和约束
 */
export interface AgentProfile {
  /** 模板唯一标识符 */
  id: string;

  /** 模板名称 */
  name: string;

  /** Agent 角色 */
  role: string;

  /** 角色描述 */
  description?: string;

  /** 系统提示词策略 */
  systemPolicy: string;

  /** 执行策略 */
  executionStrategy: ExecutionStrategy;

  /** 评分规则描述 */
  scoringRule: string;

  /** 是否允许自进化 */
  selfEvolve: boolean;

  /** 每轮最大输出长度 */
  maxOutputLength?: number;

  /** 超时时间（分钟） */
  timeoutMinutes?: number;

  /** 创建时间 */
  createdAt: number;

  /** 更新时间 */
  updatedAt: number;
}

// ============================================================================
// Event 数据模型
// ============================================================================

/**
 * AgentEvent（Agent 事件）
 *
 * 用于 Agent 间通信的事件
 */
export interface AgentEvent {
  /** 事件唯一标识符 */
  id: string;

  /** 事件类型 */
  type: string;

  /** 事件负载数据 */
  payload: unknown;

  /** 所属工作流 ID */
  workflowId: string;

  /** 来源节点 ID */
  sourceNodeId?: string;

  /** 目标节点 ID（点对点事件） */
  targetNodeId?: string;

  /** 创建时间戳 */
  createdAt: number;

  /** 是否已被消费 */
  consumed: boolean;

  /** 优先级 (1-100) */
  priority?: number;
}

/**
 * 内置事件类型
 */
export const EventTypes = {
  /** 工作流启动 */
  WORKFLOW_START: 'workflow:start',
  /** 工作流完成 */
  WORKFLOW_COMPLETE: 'workflow:complete',
  /** 工作流失败 */
  WORKFLOW_FAILED: 'workflow:failed',

  /** 节点就绪 */
  NODE_READY: 'node:ready',
  /** 节点开始执行 */
  NODE_START: 'node:start',
  /** 节点完成 */
  NODE_COMPLETE: 'node:complete',
  /** 节点失败 */
  NODE_FAILED: 'node:failed',

  /** 需求就绪 */
  REQUIREMENT_READY: 'requirement:ready',
  /** 代码就绪 */
  CODE_READY: 'code:ready',
  /** 测试完成 */
  TEST_DONE: 'test:done',
  /** 部署完成 */
  DEPLOY_DONE: 'deploy:done',

  /** 用户输入 */
  USER_INPUT: 'user:input',
  /** 用户中断 */
  USER_INTERRUPT: 'user:interrupt',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// ============================================================================
// Execution Record 数据模型
// ============================================================================

/**
 * ExecutionRecord（执行记录）
 *
 * 记录节点的执行历史
 */
export interface ExecutionRecord {
  /** 记录唯一标识符 */
  id: string;

  /** 节点 ID */
  nodeId: string;

  /** 工作流 ID */
  workflowId: string;

  /** 执行轮次 */
  round: number;

  /** 执行状态 */
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'TIMEOUT';

  /** 开始时间 */
  startTime: number;

  /** 结束时间 */
  endTime?: number;

  /** 执行耗时（毫秒） */
  durationMs?: number;

  /** AI 会话 ID */
  sessionId?: string;

  /** 执行摘要路径 */
  summaryPath?: string;

  /** 错误信息 */
  error?: string;

  /** 输出内容摘要 */
  outputSummary?: string;

  /** Token 消耗 */
  tokenCount?: number;

  /** 工具调用次数 */
  toolCallCount?: number;
}

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 工作流执行上下文
 */
export interface WorkflowContext {
  workflow: Workflow;
  nodes: WorkflowNode[];
  currentNode?: WorkflowNode;
  events: AgentEvent[];
  executionRecords: ExecutionRecord[];
}

/**
 * 节点执行上下文
 */
export interface NodeExecutionContext {
  node: WorkflowNode;
  workflow: Workflow;
  profile: AgentProfile;
  memoryRoot: string;
  round: number;
}

/**
 * 事件处理器
 */
export type EventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * 节点状态转换
 */
export interface NodeStateTransition {
  from: NodeState;
  to: NodeState;
  event?: AgentEvent;
  timestamp: number;
}
