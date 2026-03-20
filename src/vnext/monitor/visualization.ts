/**
 * Monitor Visualization
 * 监控数据可视化工具
 *
 * 功能:
 * - 仪表板数据聚合
 * - 图表数据格式化
 * - 进度可视化
 * - 时间线生成
 * - 数据导出
 */

import type { RuntimeMonitor } from './index';
import type {
  NodeRuntimeStatus,
  ExecutionLogEntry,
  MonitorEventType,
} from './index';

import type {
  DashboardOverview,
  ProgressData,
  ProgressBarData,
  TokenSummary,
  CostSummary,
  ErrorStats,
  ChartDataPoint,
  TokenChartData,
  CostChartData,
  ExecutionTimeChartData,
  NodeExecutionTime,
  NodeStatusChartData,
  NodeStatusData,
  TimelineData,
  TimelineEvent,
  TimelineEventType,
  TimelineNodeRange,
  StatusCardData,
  NodeStatusCard,
  ExportData,
  VisualizationConfig,
} from './visualization-types';

import { DEFAULT_VISUALIZATION_CONFIG } from './visualization-types';

// ============================================================================
// Utilities
// ============================================================================

/**
 * 格式化数字 (短格式)
 */
export function formatNumberShort(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

/**
 * 格式化时间 (毫秒 -> 可读格式)
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 1000) {
    return 'just now';
  }
  if (diff < 60000) {
    return `${Math.round(diff / 1000)}s ago`;
  }
  if (diff < 3600000) {
    return `${Math.round(diff / 60000)}m ago`;
  }
  if (diff < 86400000) {
    return `${Math.round(diff / 3600000)}h ago`;
  }
  return `${Math.round(diff / 86400000)}d ago`;
}

/**
 * 格式化成本
 */
export function formatCost(cost: number, currency: string = '$'): string {
  if (cost < 0.01) {
    return `${currency}${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `${currency}${cost.toFixed(3)}`;
  }
  return `${currency}${cost.toFixed(2)}`;
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(timestamp: number, format: 'relative' | 'absolute' | 'both' = 'relative'): string {
  const date = new Date(timestamp);
  const absolute = date.toLocaleTimeString();

  if (format === 'absolute') {
    return absolute;
  }
  if (format === 'both') {
    return `${absolute} (${formatRelativeTime(timestamp)})`;
  }
  return formatRelativeTime(timestamp);
}

/**
 * 获取状态颜色
 */
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    idle: '#gray',
    running: '#3b82f6', // blue
    paused: '#f59e0b', // amber
    stopped: '#6b7280', // gray
    completed: '#22c55e', // green
    failed: '#ef4444', // red
    pending: '#9ca3af', // gray
    skipped: '#a855f7', // purple
  };
  return colors[status] || '#6b7280';
}

/**
 * 获取状态颜色类名
 */
export function getStatusColorClass(status: string): string {
  const classes: Record<string, string> = {
    idle: 'bg-gray-400',
    running: 'bg-blue-500',
    paused: 'bg-amber-500',
    stopped: 'bg-gray-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    pending: 'bg-gray-300',
    skipped: 'bg-purple-500',
  };
  return classes[status] || 'bg-gray-400';
}

// ============================================================================
// Dashboard Aggregator
// ============================================================================

/**
 * 仪表板数据聚合器
 */
export class DashboardAggregator {
  private monitor: RuntimeMonitor;
  private config: VisualizationConfig;

  constructor(monitor: RuntimeMonitor, config: Partial<VisualizationConfig> = {}) {
    this.monitor = monitor;
    this.config = { ...DEFAULT_VISUALIZATION_CONFIG, ...config };
  }

  /**
   * 获取仪表板概览
   */
  getOverview(workflowId: string): DashboardOverview | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const nodes = this.monitor.getWorkflowNodes(workflowId);
    const progress = this.calculateProgress(nodes);
    const tokenSummary = this.calculateTokenSummary(workflowStatus.tokenUsage);
    const costSummary = this.calculateCostSummary(workflowStatus.tokenUsage);
    const errorStats = this.calculateErrorStats(nodes);

    return {
      workflowId: workflowStatus.workflowId,
      workflowName: workflowStatus.workflowName,
      status: workflowStatus.status,
      duration: workflowStatus.duration ? formatDuration(workflowStatus.duration) : '-',
      durationMs: workflowStatus.duration || 0,
      progress,
      tokenSummary,
      costSummary,
      errorStats,
      lastUpdated: formatTimestamp(workflowStatus.lastUpdatedAt, this.config.timeFormat),
    };
  }

  /**
   * 获取状态卡片数据
   */
  getStatusCards(workflowId: string): StatusCardData[] {
    const status = this.monitor.getWorkflowStatus(workflowId);
    const metrics = this.monitor.getRealtimeMetrics();
    const resourceStats = this.monitor.getResourceUsageStats(workflowId);

    const cards: StatusCardData[] = [
      {
        title: 'Status',
        value: status?.status || 'idle',
        color: getStatusColor(status?.status || 'idle'),
      },
      {
        title: 'Nodes',
        value: status ? `${status.completedNodes}/${status.totalNodes}` : '0/0',
        subtitle: `${status?.completedNodes || 0} completed`,
      },
      {
        title: 'Tokens',
        value: formatNumberShort(status?.tokenUsage.total || 0),
        subtitle: `${formatNumberShort(status?.tokenUsage.input || 0)} in / ${formatNumberShort(status?.tokenUsage.output || 0)} out`,
      },
      {
        title: 'Cost',
        value: formatCost(status?.estimatedCost || 0, this.config.currencySymbol),
        subtitle: resourceStats ? `Avg ${formatCost(resourceStats.avgTokensPerExecution.total * 0.001, this.config.currencySymbol)}/node` : undefined,
      },
    ];

    if (this.config.showTrends) {
      cards.push({
        title: 'Token Rate',
        value: `${metrics.tokenRate}/min`,
        trend: metrics.tokenRate > 1000 ? 'up' : metrics.tokenRate > 100 ? 'stable' : 'down',
      });
    }

    return cards;
  }

  /**
   * 获取节点状态卡片
   */
  getNodeStatusCards(workflowId: string): NodeStatusCard[] {
    const nodes = this.monitor.getWorkflowNodes(workflowId);

    return nodes.map((node) => ({
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      status: node.status,
      statusColor: getStatusColor(node.status),
      duration: node.duration ? formatDuration(node.duration) : undefined,
      tokens: node.tokenUsage.total > 0 ? formatNumberShort(node.tokenUsage.total) : undefined,
      output: node.outputSummary?.substring(0, 100),
      error: node.lastError,
    }));
  }

  private calculateProgress(nodes: NodeRuntimeStatus[]): ProgressData {
    const counts = {
      completed: 0,
      running: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
    };

    for (const node of nodes) {
      if (node.status in counts) {
        counts[node.status as keyof typeof counts]++;
      }
    }

    const total = nodes.length;
    const percentage = total > 0 ? Math.round((counts.completed / total) * 100) : 0;

    return {
      total,
      ...counts,
      percentage,
      bar: this.calculateProgressBar(counts, total),
    };
  }

  private calculateProgressBar(
    counts: { completed: number; running: number; pending: number; failed: number; skipped: number },
    total: number
  ): ProgressBarData {
    const segments: ProgressBarData['segments'] = [];

    const addSegment = (status: keyof typeof counts, colorClass: string) => {
      if (counts[status] > 0) {
        segments.push({
          status,
          count: counts[status],
          percentage: total > 0 ? Math.round((counts[status] / total) * 100) : 0,
          colorClass,
        });
      }
    };

    addSegment('completed', 'bg-green-500');
    addSegment('running', 'bg-blue-500');
    addSegment('failed', 'bg-red-500');
    addSegment('skipped', 'bg-purple-500');
    addSegment('pending', 'bg-gray-300');

    return {
      segments,
      totalWidth: 100,
    };
  }

  private calculateTokenSummary(usage: { input: number; output: number; total: number }): TokenSummary {
    return {
      input: usage.input,
      output: usage.output,
      total: usage.total,
      formatted: {
        input: formatNumberShort(usage.input),
        output: formatNumberShort(usage.output),
        total: formatNumberShort(usage.total),
      },
    };
  }

  private calculateCostSummary(usage: { input: number; output: number; total: number }): CostSummary {
    const inputCost = (usage.input / 1_000_000) * this.config.tokenPricing.input;
    const outputCost = (usage.output / 1_000_000) * this.config.tokenPricing.output;
    const totalCost = inputCost + outputCost;

    return {
      inputCost,
      outputCost,
      totalCost,
      formatted: {
        inputCost: formatCost(inputCost, this.config.currencySymbol),
        outputCost: formatCost(outputCost, this.config.currencySymbol),
        totalCost: formatCost(totalCost, this.config.currencySymbol),
      },
    };
  }

  private calculateErrorStats(nodes: NodeRuntimeStatus[]): ErrorStats {
    const failedNodes = nodes.filter((n) => n.status === 'failed');
    const total = nodes.length;
    const errorCount = failedNodes.length;

    return {
      total: errorCount,
      rate: total > 0 ? Math.round((errorCount / total) * 100) : 0,
      recent: failedNodes.slice(0, 5).map((node) => ({
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        message: node.lastError || 'Unknown error',
        timestamp: formatTimestamp(node.lastUpdatedAt, this.config.timeFormat),
      })),
    };
  }
}

// ============================================================================
// Chart Data Formatter
// ============================================================================

/**
 * 图表数据格式化器
 */
export class ChartDataFormatter {
  private monitor: RuntimeMonitor;
  private config: VisualizationConfig;

  constructor(monitor: RuntimeMonitor, config: Partial<VisualizationConfig> = {}) {
    this.monitor = monitor;
    this.config = { ...DEFAULT_VISUALIZATION_CONFIG, ...config };
  }

  /**
   * 获取 Token 使用图表数据
   */
  getTokenChartData(workflowId: string, intervalMs?: number): TokenChartData | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const logs = this.monitor.getLogs(workflowId, {
      types: ['TOKEN_USAGE_UPDATE' as MonitorEventType],
    });

    const interval = intervalMs || this.config.chartAggregationInterval;
    const startTime = workflowStatus.startedAt || Date.now();
    const endTime = Date.now();

    // 聚合数据点
    const inputPoints: ChartDataPoint[] = [];
    const outputPoints: ChartDataPoint[] = [];
    const totalPoints: ChartDataPoint[] = [];

    let cumulativeInput = 0;
    let cumulativeOutput = 0;

    for (let t = startTime; t <= endTime; t += interval) {
      const label = this.formatChartLabel(t, startTime);
      const pointLogs = logs.filter((log) => {
        const logTime = log.timestamp;
        return logTime >= t && logTime < t + interval;
      });

      const input = pointLogs.reduce((sum, log) => {
        const delta = (log.metadata?.delta as { input?: number })?.input || 0;
        return sum + delta;
      }, 0);
      const output = pointLogs.reduce((sum, log) => {
        const delta = (log.metadata?.delta as { output?: number })?.output || 0;
        return sum + delta;
      }, 0);

      cumulativeInput += input;
      cumulativeOutput += output;

      inputPoints.push({ timestamp: t, label, value: cumulativeInput });
      outputPoints.push({ timestamp: t, label, value: cumulativeOutput });
      totalPoints.push({ timestamp: t, label, value: cumulativeInput + cumulativeOutput });
    }

    return {
      input: inputPoints,
      output: outputPoints,
      total: totalPoints,
      timeRange: { start: startTime, end: endTime },
      interval,
    };
  }

  /**
   * 获取成本图表数据
   */
  getCostChartData(workflowId: string, intervalMs?: number): CostChartData | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const tokenData = this.getTokenChartData(workflowId, intervalMs);
    if (!tokenData) return null;

    const cumulative: ChartDataPoint[] = [];
    const incremental: ChartDataPoint[] = [];

    let prevCost = 0;

    for (let i = 0; i < tokenData.total.length; i++) {
      const point = tokenData.total[i];
      const inputPoint = tokenData.input[i];
      const outputPoint = tokenData.output[i];

      const cost =
        ((inputPoint?.value || 0) / 1_000_000) * this.config.tokenPricing.input +
        ((outputPoint?.value || 0) / 1_000_000) * this.config.tokenPricing.output;

      cumulative.push({
        timestamp: point.timestamp,
        label: point.label,
        value: cost,
      });

      incremental.push({
        timestamp: point.timestamp,
        label: point.label,
        value: cost - prevCost,
      });

      prevCost = cost;
    }

    return {
      cumulative,
      incremental,
      timeRange: tokenData.timeRange,
      interval: tokenData.interval,
    };
  }

  /**
   * 获取执行时间图表数据
   */
  getExecutionTimeChartData(workflowId: string): ExecutionTimeChartData | null {
    const nodes = this.monitor.getWorkflowNodes(workflowId);
    if (nodes.length === 0) return null;

    const byNode: NodeExecutionTime[] = [];
    let totalDuration = 0;
    let maxDuration = 0;
    let minDuration = Infinity;
    let nodeCount = 0;

    for (const node of nodes) {
      if (node.duration !== undefined) {
        byNode.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          durationMs: node.duration,
          executionCount: node.executionCount,
          avgMs: node.executionCount > 0 ? Math.round(node.duration / node.executionCount) : node.duration,
        });

        totalDuration += node.duration;
        maxDuration = Math.max(maxDuration, node.duration);
        minDuration = Math.min(minDuration, node.duration);
        nodeCount++;
      }
    }

    return {
      byNode: byNode.sort((a, b) => b.durationMs - a.durationMs),
      averageMs: nodeCount > 0 ? Math.round(totalDuration / nodeCount) : 0,
      maxMs: maxDuration === 0 ? 0 : maxDuration,
      minMs: minDuration === Infinity ? 0 : minDuration,
    };
  }

  /**
   * 获取节点状态分布图数据
   */
  getNodeStatusChartData(workflowId: string): NodeStatusChartData | null {
    const nodes = this.monitor.getWorkflowNodes(workflowId);
    if (nodes.length === 0) return null;

    const counts: Record<string, number> = {};

    for (const node of nodes) {
      counts[node.status] = (counts[node.status] || 0) + 1;
    }

    const total = nodes.length;
    const data: NodeStatusData[] = Object.entries(counts).map(([status, count]) => ({
      status,
      count,
      percentage: Math.round((count / total) * 100),
      color: getStatusColor(status),
    }));

    return { data, total };
  }

  private formatChartLabel(timestamp: number, startTime: number): string {
    const elapsed = timestamp - startTime;
    if (elapsed < 60000) {
      return `${Math.round(elapsed / 1000)}s`;
    }
    if (elapsed < 3600000) {
      return `${Math.round(elapsed / 60000)}m`;
    }
    return `${Math.round(elapsed / 3600000)}h`;
  }
}

// ============================================================================
// Timeline Generator
// ============================================================================

/**
 * 时间线生成器
 */
export class TimelineGenerator {
  private monitor: RuntimeMonitor;
  private config: VisualizationConfig;

  constructor(monitor: RuntimeMonitor, config: Partial<VisualizationConfig> = {}) {
    this.monitor = monitor;
    this.config = { ...DEFAULT_VISUALIZATION_CONFIG, ...config };
    // config is stored for future use
  }

  /**
   * 生成时间线数据
   */
  generate(workflowId: string): TimelineData | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const logs = this.monitor.getLogs(workflowId);
    const startTime = workflowStatus.startedAt || Date.now();

    const events = this.convertLogsToEvents(logs, startTime);

    // 确定缩放级别
    const duration = (workflowStatus.duration || 0);
    let zoomLevel: TimelineData['zoomLevel'] = 'ms';
    if (duration >= 3600000) zoomLevel = 'h';
    else if (duration >= 60000) zoomLevel = 'm';
    else if (duration >= 1000) zoomLevel = 's';

    return {
      workflowId,
      startTime,
      endTime: workflowStatus.startedAt ? startTime + duration : undefined,
      events,
      zoomLevel,
    };
  }

  /**
   * 生成节点范围数据 (用于甘特图样式展示)
   */
  generateNodeRanges(workflowId: string): TimelineNodeRange[] | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const nodes = this.monitor.getWorkflowNodes(workflowId);
    const startTime = workflowStatus.startedAt || Date.now();
    const totalDuration = workflowStatus.duration || 1;

    const ranges: TimelineNodeRange[] = [];

    for (const node of nodes) {
      if (node.startedAt) {
        const leftPercent = ((node.startedAt - startTime) / totalDuration) * 100;
        const widthPercent = node.duration ? (node.duration / totalDuration) * 100 : 0;

        ranges.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          startTime: node.startedAt,
          endTime: node.finishedAt,
          duration: node.duration,
          status: node.status === 'completed' ? 'completed' : node.status === 'failed' ? 'failed' : 'running',
          leftPercent: Math.max(0, Math.min(100, leftPercent)),
          widthPercent: Math.max(0, Math.min(100 - leftPercent, widthPercent)),
        });
      }
    }

    return ranges.sort((a, b) => a.startTime - b.startTime);
  }

  private convertLogsToEvents(logs: ExecutionLogEntry[], startTime: number): TimelineEvent[] {
    return logs.map((log) => {
      const type = this.mapLogTypeToTimelineType(log.type);
      const relativeTime = log.timestamp - startTime;

      return {
        id: log.id,
        type,
        timestamp: log.timestamp,
        relativeTime,
        formattedTime: formatDuration(relativeTime),
        nodeId: log.nodeId,
        nodeName: log.metadata?.nodeName as string | undefined,
        title: log.title,
        description: log.content,
        duration: log.duration,
        formattedDuration: log.duration ? formatDuration(log.duration) : undefined,
        metadata: log.metadata,
      };
    });
  }

  private mapLogTypeToTimelineType(logType: MonitorEventType): TimelineEventType {
    const mapping: Record<string, TimelineEventType> = {
      'workflow_started': 'workflow_start',
      'workflow_paused': 'workflow_pause',
      'workflow_resumed': 'workflow_resume',
      'workflow_stopped': 'workflow_stop',
      'workflow_completed': 'workflow_complete',
      'workflow_failed': 'workflow_fail',
      'node_started': 'node_start',
      'node_completed': 'node_complete',
      'node_failed': 'node_fail',
      'execution_tool_call': 'tool_call',
      'execution_decision': 'decision',
      'execution_error': 'error',
    };

    return mapping[logType] || 'checkpoint';
  }
}

// ============================================================================
// Data Exporter
// ============================================================================

/**
 * 数据导出器
 */
export class DataExporter {
  private monitor: RuntimeMonitor;
  private config: VisualizationConfig;

  constructor(monitor: RuntimeMonitor, config: Partial<VisualizationConfig> = {}) {
    this.monitor = monitor;
    this.config = { ...DEFAULT_VISUALIZATION_CONFIG, ...config };
  }

  /**
   * 导出为 JSON
   */
  exportJSON(workflowId: string): ExportData | null {
    const workflowStatus = this.monitor.getWorkflowStatus(workflowId);
    if (!workflowStatus) return null;

    const aggregator = new DashboardAggregator(this.monitor, this.config);
    const chartFormatter = new ChartDataFormatter(this.monitor, this.config);
    const timelineGenerator = new TimelineGenerator(this.monitor, this.config);

    const dashboard = aggregator.getOverview(workflowId);
    const timeline = timelineGenerator.generate(workflowId);
    const logs = this.monitor.getLogs(workflowId);

    if (!dashboard || !timeline) return null;

    return {
      exportedAt: new Date().toISOString(),
      workflow: {
        id: workflowStatus.workflowId,
        name: workflowStatus.workflowName,
        status: workflowStatus.status,
      },
      dashboard,
      timeline,
      charts: {
        tokens: chartFormatter.getTokenChartData(workflowId) || {
          input: [],
          output: [],
          total: [],
          timeRange: { start: 0, end: 0 },
          interval: 0,
        },
        cost: chartFormatter.getCostChartData(workflowId) || {
          cumulative: [],
          incremental: [],
          timeRange: { start: 0, end: 0 },
          interval: 0,
        },
        executionTime: chartFormatter.getExecutionTimeChartData(workflowId) || {
          byNode: [],
          averageMs: 0,
          maxMs: 0,
          minMs: 0,
        },
      },
      logs,
    };
  }

  /**
   * 导出为 CSV (简化版)
   */
  exportCSV(workflowId: string): string | null {
    const logs = this.monitor.getLogs(workflowId);
    if (logs.length === 0) return null;

    const headers = ['timestamp', 'type', 'nodeId', 'title', 'content', 'level'];
    const rows = logs.map((log) => [
      new Date(log.timestamp).toISOString(),
      log.type,
      log.nodeId || '',
      `"${log.title.replace(/"/g, '""')}"`,
      `"${log.content.replace(/"/g, '""')}"`,
      log.level,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  DashboardOverview,
  ProgressData,
  TokenSummary,
  CostSummary,
  ErrorStats,
  ChartDataPoint,
  TokenChartData,
  CostChartData,
  ExecutionTimeChartData,
  TimelineData,
  TimelineEvent,
  VisualizationConfig,
};

export { DEFAULT_VISUALIZATION_CONFIG } from './visualization-types';
