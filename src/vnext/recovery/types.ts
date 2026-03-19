/**
 * Error Recovery Types
 * 错误恢复机制
 */

/**
 * 错误类型
 */
export enum ErrorType {
  /** 网络错误 */
  NETWORK = 'network',
  /** 超时错误 */
  TIMEOUT = 'timeout',
  /** 资源错误 (内存、磁盘等) */
  RESOURCE = 'resource',
  /** API 错误 (限流、认证等) */
  API = 'api',
  /** 执行错误 */
  EXECUTION = 'execution',
  /** 验证错误 */
  VALIDATION = 'validation',
  /** 依赖错误 */
  DEPENDENCY = 'dependency',
  /** 配置错误 */
  CONFIGURATION = 'configuration',
  /** 内部错误 */
  INTERNAL = 'internal',
  /** 未知错误 */
  UNKNOWN = 'unknown',
}

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
  /** 低 - 可忽略 */
  LOW = 'low',
  /** 中 - 需要处理但可继续 */
  MEDIUM = 'medium',
  /** 高 - 需要立即处理 */
  HIGH = 'high',
  /** 严重 - 需要停止执行 */
  CRITICAL = 'critical',
  /** 致命 - 无法恢复 */
  FATAL = 'fatal',
}

/**
 * 恢复策略
 */
export enum RecoveryStrategy {
  /** 立即重试 */
  RETRY_IMMEDIATE = 'retry_immediate',
  /** 延迟重试 */
  RETRY_DELAYED = 'retry_delayed',
  /** 指数退避重试 */
  RETRY_EXPONENTIAL = 'retry_exponential',
  /** 跳过当前节点 */
  SKIP_NODE = 'skip_node',
  /** 回滚到上一个快照 */
  ROLLBACK = 'rollback',
  /** 切换到备用节点 */
  FAILOVER = 'failover',
  /** 请求用户干预 */
  USER_INTERVENTION = 'user_intervention',
  /** 终止工作流 */
  TERMINATE = 'terminate',
  /** 忽略错误 */
  IGNORE = 'ignore',
}

/**
 * 错误记录
 */
export interface ErrorRecord {
  /** 唯一标识 */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId?: string;
  /** 错误类型 */
  type: ErrorType;
  /** 严重程度 */
  severity: ErrorSeverity;
  /** 错误代码 */
  code?: string;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: string;
  /** 堆栈跟踪 */
  stack?: string;
  /** 发生时间 */
  timestamp: number;
  /** 重试次数 */
  retryCount: number;
  /** 恢复状态 */
  recoveryStatus: RecoveryStatus;
  /** 应用的恢复策略 */
  appliedStrategy?: RecoveryStrategy;
  /** 恢复结果 */
  recoveryResult?: RecoveryResult;
  /** 上下文数据 */
  context?: Record<string, unknown>;
}

/**
 * 恢复状态
 */
export enum RecoveryStatus {
  /** 待处理 */
  PENDING = 'pending',
  /** 恢复中 */
  IN_PROGRESS = 'in_progress',
  /** 已恢复 */
  RECOVERED = 'recovered',
  /** 恢复失败 */
  FAILED = 'failed',
  /** 已跳过 */
  SKIPPED = 'skipped',
  /** 等待用户 */
  AWAITING_USER = 'awaiting_user',
}

/**
 * 恢复结果
 */
export interface RecoveryResult {
  /** 是否成功 */
  success: boolean;
  /** 使用的策略 */
  strategy: RecoveryStrategy;
  /** 尝试次数 */
  attempts: number;
  /** 总耗时 (毫秒) */
  durationMs: number;
  /** 结果消息 */
  message?: string;
  /** 恢复后的数据 */
  recoveredData?: unknown;
}

/**
 * 恢复策略配置
 */
export interface RecoveryStrategyConfig {
  /** 策略类型 */
  strategy: RecoveryStrategy;
  /** 最大尝试次数 */
  maxAttempts: number;
  /** 初始延迟 (毫秒) */
  initialDelayMs: number;
  /** 最大延迟 (毫秒) */
  maxDelayMs: number;
  /** 退避乘数 */
  backoffMultiplier: number;
  /** 是否需要用户确认 */
  requiresUserConfirmation: boolean;
  /** 适用错误类型 */
  applicableErrorTypes: ErrorType[];
  /** 适用严重程度 */
  applicableSeverities: ErrorSeverity[];
  /** 自定义恢复函数 */
  customRecoveryFn?: (error: ErrorRecord) => Promise<boolean>;
}

/**
 * 错误恢复配置
 */
export interface ErrorRecoveryConfig {
  /** 是否启用自动恢复 */
  enableAutoRecovery: boolean;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 默认重试延迟 (毫秒) */
  defaultRetryDelayMs: number;
  /** 最大恢复时间 (毫秒) */
  maxRecoveryTimeMs: number;
  /** 是否在恢复失败时通知 */
  notifyOnRecoveryFailure: boolean;
  /** 错误历史保留时间 (毫秒) */
  errorHistoryRetentionMs: number;
  /** 最大错误历史条数 */
  maxErrorHistory: number;
  /** 默认恢复策略配置 */
  defaultStrategies: RecoveryStrategyConfig[];
}

/**
 * 恢复事件
 */
export interface RecoveryEvent {
  /** 事件类型 */
  type: 'error_occurred' | 'recovery_started' | 'recovery_attempt' | 'recovery_success' | 'recovery_failed' | 'user_intervention_required';
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 错误记录 */
  error?: ErrorRecord;
  /** 恢复结果 */
  result?: RecoveryResult;
  /** 消息 */
  message?: string;
}

/**
 * 恢复监听器
 */
export type RecoveryListener = (event: RecoveryEvent) => void;

/**
 * 默认错误恢复配置
 */
export const DEFAULT_ERROR_RECOVERY_CONFIG: ErrorRecoveryConfig = {
  enableAutoRecovery: true,
  defaultMaxRetries: 3,
  defaultRetryDelayMs: 1000,
  maxRecoveryTimeMs: 300000, // 5 minutes
  notifyOnRecoveryFailure: true,
  errorHistoryRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
  maxErrorHistory: 1000,
  defaultStrategies: [
    {
      strategy: RecoveryStrategy.RETRY_IMMEDIATE,
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      requiresUserConfirmation: false,
      applicableErrorTypes: [ErrorType.NETWORK, ErrorType.TIMEOUT],
      applicableSeverities: [ErrorSeverity.LOW, ErrorSeverity.MEDIUM],
    },
    {
      strategy: RecoveryStrategy.RETRY_EXPONENTIAL,
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      backoffMultiplier: 2,
      requiresUserConfirmation: false,
      applicableErrorTypes: [ErrorType.API, ErrorType.RESOURCE],
      applicableSeverities: [ErrorSeverity.MEDIUM, ErrorSeverity.HIGH],
    },
    {
      strategy: RecoveryStrategy.ROLLBACK,
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      requiresUserConfirmation: true,
      applicableErrorTypes: [ErrorType.EXECUTION, ErrorType.INTERNAL],
      applicableSeverities: [ErrorSeverity.HIGH, ErrorSeverity.CRITICAL],
    },
    {
      strategy: RecoveryStrategy.SKIP_NODE,
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      requiresUserConfirmation: false,
      applicableErrorTypes: [ErrorType.VALIDATION, ErrorType.DEPENDENCY],
      applicableSeverities: [ErrorSeverity.LOW, ErrorSeverity.MEDIUM],
    },
    {
      strategy: RecoveryStrategy.TERMINATE,
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      requiresUserConfirmation: true,
      applicableErrorTypes: [ErrorType.INTERNAL, ErrorType.UNKNOWN],
      applicableSeverities: [ErrorSeverity.CRITICAL, ErrorSeverity.FATAL],
    },
  ],
};

/**
 * 创建错误记录
 */
export function createErrorRecord(
  workflowId: string,
  type: ErrorType,
  message: string,
  options?: {
    nodeId?: string;
    severity?: ErrorSeverity;
    code?: string;
    details?: string;
    stack?: string;
    context?: Record<string, unknown>;
  }
): ErrorRecord {
  return {
    id: `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    workflowId,
    nodeId: options?.nodeId,
    type,
    severity: options?.severity ?? ErrorSeverity.MEDIUM,
    code: options?.code,
    message,
    details: options?.details,
    stack: options?.stack,
    timestamp: Date.now(),
    retryCount: 0,
    recoveryStatus: RecoveryStatus.PENDING,
    context: options?.context,
  };
}

/**
 * 判断错误是否可恢复
 */
export function isRecoverable(error: ErrorRecord): boolean {
  return error.severity !== ErrorSeverity.FATAL &&
         error.recoveryStatus !== RecoveryStatus.FAILED;
}

/**
 * 获取推荐的恢复策略
 */
export function getRecommendedStrategy(
  error: ErrorRecord,
  strategies: RecoveryStrategyConfig[]
): RecoveryStrategyConfig | undefined {
  for (const config of strategies) {
    if (config.applicableErrorTypes.includes(error.type) &&
        config.applicableSeverities.includes(error.severity)) {
      return config;
    }
  }
  return undefined;
}
