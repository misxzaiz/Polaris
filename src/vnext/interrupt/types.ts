/**
 * Interrupt Inbox Types
 * 中断与补充需求机制
 */

/**
 * 中断类型
 */
export enum InterruptType {
  /** 用户请求暂停 */
  USER_PAUSE = 'user_pause',
  /** 用户请求补充 */
  USER_SUPPLEMENT = 'user_supplement',
  /** 用户请求修正 */
  USER_CORRECTION = 'user_correction',
  /** 系统错误中断 */
  SYSTEM_ERROR = 'system_error',
  /** 依赖阻塞 */
  DEPENDENCY_BLOCKED = 'dependency_blocked',
  /** 资源限制 */
  RESOURCE_LIMIT = 'resource_limit',
  /** 审批等待 */
  AWAITING_APPROVAL = 'awaiting_approval',
}

/**
 * 中断优先级
 */
export enum InterruptPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  URGENT = 3,
}

/**
 * 中断状态
 */
export enum InterruptStatus {
  /** 待处理 */
  PENDING = 'pending',
  /** 已读取 */
  ACKNOWLEDGED = 'acknowledged',
  /** 处理中 */
  PROCESSING = 'processing',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 已忽略 */
  DISMISSED = 'dismissed',
  /** 已过期 */
  EXPIRED = 'expired',
}

/**
 * 用户输入类型
 */
export enum UserInputType {
  /** 补充说明 */
  SUPPLEMENT = 'supplement',
  /** 需求修正 */
  CORRECTION = 'correction',
  /** 问题反馈 */
  FEEDBACK = 'feedback',
  /** 审批决策 */
  APPROVAL = 'approval',
  /** 紧急停止 */
  EMERGENCY_STOP = 'emergency_stop',
  /** 方向调整 */
  DIRECTION_CHANGE = 'direction_change',
}

/**
 * 中断请求
 */
export interface InterruptRequest {
  /** 唯一标识 */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID (可选) */
  nodeId?: string;
  /** 中断类型 */
  type: InterruptType;
  /** 优先级 */
  priority: InterruptPriority;
  /** 状态 */
  status: InterruptStatus;
  /** 标题 */
  title: string;
  /** 详细内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间 (可选) */
  expiresAt?: number;
  /** 处理时间 */
  processedAt?: number;
  /** 处理结果 */
  result?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 标签 */
  tags?: string[];
}

/**
 * 用户输入项
 */
export interface UserInputEntry {
  /** 唯一标识 */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 输入类型 */
  type: UserInputType;
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
  /** 是否已处理 */
  processed: boolean;
  /** 处理时间 */
  processedAt?: number;
  /** 处理节点 ID */
  processedByNode?: string;
  /** 优先级 */
  priority: InterruptPriority;
  /** 关联的中断请求 ID */
  interruptId?: string;
  /** 附件 (文件路径等) */
  attachments?: string[];
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 中断配置
 */
export interface InterruptConfig {
  /** 最大待处理中断数 */
  maxPendingInterrupts: number;
  /** 默认过期时间 (毫秒) */
  defaultExpiryMs: number;
  /** 是否自动确认低优先级中断 */
  autoAcknowledgeLowPriority: boolean;
  /** 最大用户输入历史 */
  maxUserInputHistory: number;
  /** 是否启用过期清理 */
  enableExpiryCleanup: boolean;
  /** 清理间隔 (毫秒) */
  cleanupIntervalMs: number;
}

/**
 * 中断收件箱状态
 */
export interface InterruptInboxState {
  /** 工作流 ID */
  workflowId: string;
  /** 待处理中断 */
  pendingInterrupts: InterruptRequest[];
  /** 待处理用户输入 */
  pendingUserInputs: UserInputEntry[];
  /** 已处理用户输入历史 */
  processedUserInputs: UserInputEntry[];
  /** 最后更新时间 */
  lastUpdatedAt: number;
  /** 是否有紧急中断 */
  hasUrgentInterrupt: boolean;
}

/**
 * 中断事件
 */
export interface InterruptEvent {
  /** 事件类型 */
  type: 'interrupt_added' | 'interrupt_processed' | 'interrupt_dismissed' |
        'user_input_added' | 'user_input_processed' | 'inbox_cleared';
  /** 工作流 ID */
  workflowId: string;
  /** 相关数据 */
  data?: InterruptRequest | UserInputEntry | { count: number };
  /** 时间戳 */
  timestamp: number;
}

/**
 * 中断监听器
 */
export type InterruptListener = (event: InterruptEvent) => void;

/**
 * 中断过滤器
 */
export interface InterruptFilter {
  /** 按类型过滤 */
  type?: InterruptType | InterruptType[];
  /** 按状态过滤 */
  status?: InterruptStatus | InterruptStatus[];
  /** 按优先级过滤 */
  priority?: InterruptPriority | InterruptPriority[];
  /** 按节点过滤 */
  nodeId?: string;
  /** 按标签过滤 */
  tags?: string[];
  /** 时间范围 */
  timeRange?: {
    start: number;
    end: number;
  };
}

/**
 * 默认中断配置
 */
export const DEFAULT_INTERRUPT_CONFIG: InterruptConfig = {
  maxPendingInterrupts: 100,
  defaultExpiryMs: 24 * 60 * 60 * 1000, // 24 hours
  autoAcknowledgeLowPriority: false,
  maxUserInputHistory: 50,
  enableExpiryCleanup: true,
  cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
};

/**
 * 创建中断请求
 */
export function createInterruptRequest(
  workflowId: string,
  type: InterruptType,
  title: string,
  content: string,
  options?: {
    nodeId?: string;
    priority?: InterruptPriority;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }
): InterruptRequest {
  return {
    id: `interrupt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    workflowId,
    nodeId: options?.nodeId,
    type,
    priority: options?.priority ?? InterruptPriority.NORMAL,
    status: InterruptStatus.PENDING,
    title,
    content,
    createdAt: Date.now(),
    expiresAt: options?.expiresAt,
    metadata: options?.metadata,
    tags: options?.tags,
  };
}

/**
 * 创建用户输入项
 */
export function createUserInputEntry(
  workflowId: string,
  type: UserInputType,
  title: string,
  content: string,
  options?: {
    priority?: InterruptPriority;
    interruptId?: string;
    attachments?: string[];
    metadata?: Record<string, unknown>;
  }
): UserInputEntry {
  return {
    id: `user-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    workflowId,
    type,
    title,
    content,
    createdAt: Date.now(),
    processed: false,
    priority: options?.priority ?? InterruptPriority.NORMAL,
    interruptId: options?.interruptId,
    attachments: options?.attachments,
    metadata: options?.metadata,
  };
}
