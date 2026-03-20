/**
 * Scheduler vNext - Workflow Data Models
 *
 * Workflow 类型定义
 */

// ============================================================================
// Workflow Status
// ============================================================================

/**
 * 工作流状态
 */
export type WorkflowStatus =
  | 'CREATED'            // 已创建
  | 'PLANNING'           // 规划中
  | 'RUNNING'            // 运行中
  | 'WAITING_EVENT'      // 等待事件
  | 'BLOCKED'            // 阻塞
  | 'COMPACTING_MEMORY'  // 压缩内存
  | 'FAILED'             // 失败
  | 'COMPLETED'          // 完成
  | 'EVOLVING';          // 进化中

/**
 * 工作流模式
 */
export type WorkflowMode =
  | 'single'     // 单次执行
  | 'continuous' // 连续执行
  | 'scheduled'; // 定时执行

// ============================================================================
// Workflow
// ============================================================================

/**
 * 工作流定义
 */
export interface Workflow {
  /** 工作流 ID */
  id: string;

  /** 工作流名称 */
  name: string;

  /** 描述 */
  description?: string;

  /** 模板 ID */
  templateId?: string;

  /** 当前状态 */
  status: WorkflowStatus;

  /** 执行模式 */
  mode: WorkflowMode;

  /** 优先级 */
  priority: number;

  /** 是否连续模式 */
  continuousMode?: boolean;

  /** 创建时间 */
  createdAt: number;

  /** 更新时间 */
  updatedAt: number;

  /** 当前执行节点 ID */
  currentNodeId?: string;

  /** 内存根目录 */
  memoryRoot?: string;

  /** 工作目录 */
  workDir?: string;

  /** 最大轮次 */
  maxRounds?: number;

  /** 当前轮次 */
  currentRound?: number;

  /** 已执行轮次 */
  currentRounds?: number;

  /** 总轮次 */
  totalRounds?: number;

  /** 标签 */
  tags?: string[];

  /** 元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Create/Update Params
// ============================================================================

/**
 * 创建工作流参数
 */
export interface CreateWorkflowParams {
  /** 工作流 ID */
  id: string;

  /** 工作流名称 */
  name: string;

  /** 描述 */
  description?: string;

  /** 模板 ID */
  templateId?: string;

  /** 执行模式 */
  mode?: WorkflowMode;

  /** 优先级 */
  priority?: number;

  /** 是否连续模式 */
  continuousMode?: boolean;

  /** 工作目录 */
  workDir?: string;

  /** 最大轮次 */
  maxRounds?: number;

  /** 标签 */
  tags?: string[];

  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 更新 Workflow 参数
 */
export interface UpdateWorkflowParams {
  name?: string;
  description?: string;
  priority?: number;
  continuousMode?: boolean;
  workDir?: string;
  maxRounds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Extended Types
// ============================================================================

/**
 * 扩展 Workflow 类型（包含额外字段，用于兼容性）
 */
export interface WorkflowWithNodes {
  id: string;
  name: string;
  description?: string;
  templateId?: string;
  status: WorkflowStatus;
  mode: WorkflowMode;
  priority: number;
  continuousMode?: boolean;
  createdAt: number;
  updatedAt: number;
  currentNodeId?: string;
  memoryRoot?: string;
  workDir?: string;
  maxRounds?: number;
  currentRounds?: number;
  totalRounds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
