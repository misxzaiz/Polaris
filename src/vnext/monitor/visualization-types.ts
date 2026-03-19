/**
 * Monitor Visualization Types
 * 监控可视化数据接口
 */

import type { TokenUsage, ExecutionLogEntry } from './index';

// ============================================================================
// Dashboard Data Types
// ============================================================================

/**
 * 仪表板概览数据
 */
export interface DashboardOverview {
  /** 工作流 ID */
  workflowId: string;
  /** 工作流名称 */
  workflowName: string;
  /** 当前状态 */
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  /** 运行时间 (格式化字符串) */
  duration: string;
  /** 运行时间 (毫秒) */
  durationMs: number;
  /** 节点进度 */
  progress: ProgressData;
  /** Token 摘要 */
  tokenSummary: TokenSummary;
  /** 成本摘要 */
  costSummary: CostSummary;
  /** 错误统计 */
  errorStats: ErrorStats;
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 进度数据
 */
export interface ProgressData {
  /** 总节点数 */
  total: number;
  /** 已完成 */
  completed: number;
  /** 运行中 */
  running: number;
  /** 等待中 */
  pending: number;
  /** 失败 */
  failed: number;
  /** 跳过 */
  skipped: number;
  /** 完成百分比 (0-100) */
  percentage: number;
  /** 进度条数据 */
  bar: ProgressBarData;
}

/**
 * 进度条数据
 */
export interface ProgressBarData {
  /** 各状态占比 */
  segments: ProgressSegment[];
  /** 总宽度百分比 */
  totalWidth: number;
}

/**
 * 进度条段
 */
export interface ProgressSegment {
  /** 状态 */
  status: 'completed' | 'running' | 'pending' | 'failed' | 'skipped';
  /** 数量 */
  count: number;
  /** 百分比 (0-100) */
  percentage: number;
  /** 颜色类名 */
  colorClass: string;
}

/**
 * Token 摘要
 */
export interface TokenSummary {
  /** 输入 Token */
  input: number;
  /** 输出 Token */
  output: number;
  /** 总计 */
  total: number;
  /** 格式化显示 */
  formatted: {
    input: string;
    output: string;
    total: string;
  };
}

/**
 * 成本摘要
 */
export interface CostSummary {
  /** 输入成本 */
  inputCost: number;
  /** 输出成本 */
  outputCost: number;
  /** 总成本 */
  totalCost: number;
  /** 格式化显示 */
  formatted: {
    inputCost: string;
    outputCost: string;
    totalCost: string;
  };
}

/**
 * 错误统计
 */
export interface ErrorStats {
  /** 总错误数 */
  total: number;
  /** 错误率 (0-100) */
  rate: number;
  /** 最近错误 */
  recent: ErrorItem[];
}

/**
 * 错误项
 */
export interface ErrorItem {
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 错误消息 */
  message: string;
  /** 时间 */
  timestamp: string;
}

// ============================================================================
// Chart Data Types
// ============================================================================

/**
 * 图表数据点
 */
export interface ChartDataPoint {
  /** 时间戳 */
  timestamp: number;
  /** 时间标签 */
  label: string;
  /** 值 */
  value: number;
}

/**
 * Token 使用图表数据
 */
export interface TokenChartData {
  /** 输入 Token 数据点 */
  input: ChartDataPoint[];
  /** 输出 Token 数据点 */
  output: ChartDataPoint[];
  /** 总计数据点 */
  total: ChartDataPoint[];
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 聚合间隔 (毫秒) */
  interval: number;
}

/**
 * 成本图表数据
 */
export interface CostChartData {
  /** 累计成本数据点 */
  cumulative: ChartDataPoint[];
  /** 增量成本数据点 */
  incremental: ChartDataPoint[];
  /** 时间范围 */
  timeRange: {
    start: number;
    end: number;
  };
  /** 聚合间隔 (毫秒) */
  interval: number;
}

/**
 * 执行时间图表数据
 */
export interface ExecutionTimeChartData {
  /** 按节点分组 */
  byNode: NodeExecutionTime[];
  /** 平均执行时间 */
  averageMs: number;
  /** 最大执行时间 */
  maxMs: number;
  /** 最小执行时间 */
  minMs: number;
}

/**
 * 节点执行时间
 */
export interface NodeExecutionTime {
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 执行时间 (毫秒) */
  durationMs: number;
  /** 执行次数 */
  executionCount: number;
  /** 平均时间 */
  avgMs: number;
}

/**
 * 节点状态分布图数据
 */
export interface NodeStatusChartData {
  /** 各状态数量 */
  data: NodeStatusData[];
  /** 总节点数 */
  total: number;
}

/**
 * 节点状态数据
 */
export interface NodeStatusData {
  /** 状态 */
  status: string;
  /** 数量 */
  count: number;
  /** 百分比 */
  percentage: number;
  /** 颜色 */
  color: string;
}

// ============================================================================
// Timeline Types
// ============================================================================

/**
 * 时间线数据
 */
export interface TimelineData {
  /** 工作流 ID */
  workflowId: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 时间线事件 */
  events: TimelineEvent[];
  /** 缩放级别 */
  zoomLevel: 'ms' | 's' | 'm' | 'h';
}

/**
 * 时间线事件
 */
export interface TimelineEvent {
  /** 事件 ID */
  id: string;
  /** 事件类型 */
  type: TimelineEventType;
  /** 时间戳 */
  timestamp: number;
  /** 相对时间 (毫秒) */
  relativeTime: number;
  /** 格式化时间 */
  formattedTime: string;
  /** 节点 ID */
  nodeId?: string;
  /** 节点名称 */
  nodeName?: string;
  /** 标题 */
  title: string;
  /** 描述 */
  description?: string;
  /** 持续时间 (毫秒) */
  duration?: number;
  /** 格式化持续时间 */
  formattedDuration?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 时间线事件类型
 */
export type TimelineEventType =
  | 'workflow_start'
  | 'workflow_pause'
  | 'workflow_resume'
  | 'workflow_stop'
  | 'workflow_complete'
  | 'workflow_fail'
  | 'node_start'
  | 'node_complete'
  | 'node_fail'
  | 'tool_call'
  | 'decision'
  | 'error'
  | 'checkpoint'
  | 'user_input';

/**
 * 时间线节点范围
 */
export interface TimelineNodeRange {
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 持续时间 */
  duration?: number;
  /** 状态 */
  status: 'running' | 'completed' | 'failed';
  /** 左偏移百分比 */
  leftPercent: number;
  /** 宽度百分比 */
  widthPercent: number;
}

// ============================================================================
// Status Card Types
// ============================================================================

/**
 * 状态卡片数据
 */
export interface StatusCardData {
  /** 标题 */
  title: string;
  /** 值 */
  value: string | number;
  /** 副标题 */
  subtitle?: string;
  /** 趋势 */
  trend?: 'up' | 'down' | 'stable';
  /** 趋势值 */
  trendValue?: string;
  /** 图标 */
  icon?: string;
  /** 颜色 */
  color?: string;
}

/**
 * 节点状态卡片
 */
export interface NodeStatusCard {
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeName: string;
  /** 状态 */
  status: string;
  /** 状态颜色 */
  statusColor: string;
  /** 执行时间 */
  duration?: string;
  /** Token 使用 */
  tokens?: string;
  /** 输出摘要 */
  output?: string;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Export Data Types
// ============================================================================

/**
 * 导出数据格式
 */
export interface ExportData {
  /** 导出时间 */
  exportedAt: string;
  /** 工作流信息 */
  workflow: {
    id: string;
    name: string;
    status: string;
  };
  /** 仪表板数据 */
  dashboard: DashboardOverview;
  /** 时间线数据 */
  timeline: TimelineData;
  /** 图表数据 */
  charts: {
    tokens: TokenChartData;
    cost: CostChartData;
    executionTime: ExecutionTimeChartData;
  };
  /** 日志 */
  logs: ExecutionLogEntry[];
}

/**
 * 可视化配置
 */
export interface VisualizationConfig {
  /** 时间格式 */
  timeFormat: 'relative' | 'absolute' | 'both';
  /** 时区 */
  timezone?: string;
  /** 数字格式 */
  numberFormat: 'short' | 'long';
  /** 货币符号 */
  currencySymbol: string;
  /** Token 价格配置 */
  tokenPricing: {
    input: number;
    output: number;
  };
  /** 图表聚合间隔 (毫秒) */
  chartAggregationInterval: number;
  /** 是否显示趋势 */
  showTrends: boolean;
}

/**
 * 默认可视化配置
 */
export const DEFAULT_VISUALIZATION_CONFIG: VisualizationConfig = {
  timeFormat: 'relative',
  numberFormat: 'short',
  currencySymbol: '$',
  tokenPricing: {
    input: 3.0,
    output: 15.0,
  },
  chartAggregationInterval: 1000, // 1 second
  showTrends: true,
};
