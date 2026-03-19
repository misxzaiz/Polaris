/**
 * vNext Visualization Components - Types
 * React 组件属性类型定义
 */

import type {
  Workflow,
  WorkflowNode,
  NodeState,
} from '../types';
import type {
  DashboardOverview,
  ProgressData,
  TokenSummary,
  CostSummary,
  TimelineData,
  TimelineEvent,
} from '../monitor/visualization-types';

// ============================================================================
// Workflow Diagram Types
// ============================================================================

/**
 * 工作流图形化展示属性
 */
export interface WorkflowDiagramProps {
  /** 工作流数据 */
  workflow: Workflow;
  /** 节点列表 */
  nodes: WorkflowNode[];
  /** 当前选中的节点 ID */
  selectedNodeId?: string;
  /** 节点点击回调 */
  onNodeClick?: (nodeId: string) => void;
  /** 是否显示依赖连线 */
  showDependencies?: boolean;
  /** 是否显示事件连线 */
  showEventConnections?: boolean;
  /** 布局方向 */
  direction?: 'horizontal' | 'vertical';
  /** 缩放级别 */
  zoom?: number;
  /** 自定义类名 */
  className?: string;
}

/**
 * 节点图形位置
 */
export interface NodePosition {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 连线数据
 */
export interface ConnectionLine {
  fromNodeId: string;
  toNodeId: string;
  type: 'dependency' | 'event' | 'next';
  label?: string;
}

// ============================================================================
// Node Status Card Types
// ============================================================================

/**
 * 节点状态卡片属性
 */
export interface NodeStatusCardProps {
  /** 节点数据 */
  node: WorkflowNode;
  /** 执行时间 (毫秒) */
  duration?: number;
  /** Token 使用量 */
  tokenUsage?: {
    input: number;
    output: number;
  };
  /** 输出摘要 */
  outputSummary?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 是否选中 */
  selected?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 节点状态配置
 */
export interface NodeStatusConfig {
  color: string;
  bgColor: string;
  borderColor: string;
  icon: string;
  label: string;
}

/**
 * 获取节点状态配置
 */
export function getNodeStatusConfig(state: NodeState): NodeStatusConfig {
  const configs: Record<NodeState, NodeStatusConfig> = {
    IDLE: {
      color: 'text-gray-500',
      bgColor: 'bg-gray-100',
      borderColor: 'border-gray-300',
      icon: '○',
      label: '空闲',
    },
    READY: {
      color: 'text-blue-500',
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-300',
      icon: '◐',
      label: '就绪',
    },
    RUNNING: {
      color: 'text-amber-500',
      bgColor: 'bg-amber-50',
      borderColor: 'border-amber-300',
      icon: '◉',
      label: '运行中',
    },
    WAITING_INPUT: {
      color: 'text-purple-500',
      bgColor: 'bg-purple-50',
      borderColor: 'border-purple-300',
      icon: '◎',
      label: '等待输入',
    },
    DONE: {
      color: 'text-green-500',
      bgColor: 'bg-green-50',
      borderColor: 'border-green-300',
      icon: '●',
      label: '完成',
    },
    FAILED: {
      color: 'text-red-500',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-300',
      icon: '✕',
      label: '失败',
    },
    SKIPPED: {
      color: 'text-gray-400',
      bgColor: 'bg-gray-50',
      borderColor: 'border-gray-200',
      icon: '—',
      label: '跳过',
    },
  };

  return configs[state] || configs.IDLE;
}

// ============================================================================
// Dashboard Overview Types
// ============================================================================

/**
 * 仪表板概览属性
 */
export interface DashboardOverviewProps {
  /** 仪表板数据 */
  data: DashboardOverview;
  /** 是否显示成本信息 */
  showCost?: boolean;
  /** 是否显示 Token 信息 */
  showTokens?: boolean;
  /** 是否显示错误统计 */
  showErrors?: boolean;
  /** 刷新回调 */
  onRefresh?: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 进度条属性
 */
export interface ProgressBarProps {
  /** 进度数据 */
  progress: ProgressData;
  /** 高度 */
  height?: 'sm' | 'md' | 'lg';
  /** 是否显示标签 */
  showLabels?: boolean;
  /** 是否显示百分比 */
  showPercentage?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * Token 摘要卡片属性
 */
export interface TokenSummaryCardProps {
  /** Token 摘要数据 */
  summary: TokenSummary;
  /** 是否显示详情 */
  showDetails?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * 成本摘要卡片属性
 */
export interface CostSummaryCardProps {
  /** 成本摘要数据 */
  summary: CostSummary;
  /** 货币符号 */
  currencySymbol?: string;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// Timeline Types
// ============================================================================

/**
 * 时间线视图属性
 */
export interface TimelineViewProps {
  /** 时间线数据 */
  data: TimelineData;
  /** 是否自动滚动到最新 */
  autoScroll?: boolean;
  /** 最大显示事件数 */
  maxEvents?: number;
  /** 事件点击回调 */
  onEventClick?: (event: TimelineEvent) => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 时间线事件项属性
 */
export interface TimelineEventItemProps {
  /** 事件数据 */
  event: TimelineEvent;
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 时间线事件类型配置
 */
export interface TimelineEventTypeConfig {
  color: string;
  bgColor: string;
  icon: string;
  label: string;
}

/**
 * 获取时间线事件类型配置
 */
export function getTimelineEventTypeConfig(
  type: TimelineEvent['type']
): TimelineEventTypeConfig {
  const configs: Record<TimelineEvent['type'], TimelineEventTypeConfig> = {
    workflow_start: {
      color: 'text-blue-500',
      bgColor: 'bg-blue-100',
      icon: '▶',
      label: '工作流开始',
    },
    workflow_pause: {
      color: 'text-amber-500',
      bgColor: 'bg-amber-100',
      icon: '⏸',
      label: '工作流暂停',
    },
    workflow_resume: {
      color: 'text-blue-500',
      bgColor: 'bg-blue-100',
      icon: '▶',
      label: '工作流恢复',
    },
    workflow_stop: {
      color: 'text-gray-500',
      bgColor: 'bg-gray-100',
      icon: '⏹',
      label: '工作流停止',
    },
    workflow_complete: {
      color: 'text-green-500',
      bgColor: 'bg-green-100',
      icon: '✓',
      label: '工作流完成',
    },
    workflow_fail: {
      color: 'text-red-500',
      bgColor: 'bg-red-100',
      icon: '✕',
      label: '工作流失败',
    },
    node_start: {
      color: 'text-blue-500',
      bgColor: 'bg-blue-100',
      icon: '◐',
      label: '节点开始',
    },
    node_complete: {
      color: 'text-green-500',
      bgColor: 'bg-green-100',
      icon: '●',
      label: '节点完成',
    },
    node_fail: {
      color: 'text-red-500',
      bgColor: 'bg-red-100',
      icon: '✕',
      label: '节点失败',
    },
    tool_call: {
      color: 'text-purple-500',
      bgColor: 'bg-purple-100',
      icon: '⚙',
      label: '工具调用',
    },
    decision: {
      color: 'text-amber-500',
      bgColor: 'bg-amber-100',
      icon: '⚡',
      label: '决策',
    },
    error: {
      color: 'text-red-500',
      bgColor: 'bg-red-100',
      icon: '!',
      label: '错误',
    },
    checkpoint: {
      color: 'text-cyan-500',
      bgColor: 'bg-cyan-100',
      icon: '⚑',
      label: '检查点',
    },
    user_input: {
      color: 'text-indigo-500',
      bgColor: 'bg-indigo-100',
      icon: '✎',
      label: '用户输入',
    },
  };

  return configs[type] || configs.workflow_start;
}

// ============================================================================
// Workflow List Types
// ============================================================================

/**
 * 工作流列表属性
 */
export interface WorkflowListProps {
  /** 工作流列表 */
  workflows: Workflow[];
  /** 当前选中的工作流 ID */
  selectedId?: string;
  /** 选择回调 */
  onSelect?: (workflowId: string) => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * 工作流列表项属性
 */
export interface WorkflowListItemProps {
  /** 工作流数据 */
  workflow: Workflow;
  /** 是否选中 */
  selected?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}
