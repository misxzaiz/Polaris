/**
 * Monitor Visualization Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeMonitor,
  resetRuntimeMonitor,
} from '../monitor/index';
import {
  DashboardAggregator,
  ChartDataFormatter,
  TimelineGenerator,
  DataExporter,
  formatNumberShort,
  formatDuration,
  formatRelativeTime,
  formatCost,
  getStatusColor,
  getStatusColorClass,
} from '../monitor/visualization';
import type { VisualizationConfig } from '../monitor/visualization-types';

describe('Visualization Utilities', () => {
  describe('formatNumberShort', () => {
    it('should format small numbers', () => {
      expect(formatNumberShort(0)).toBe('0');
      expect(formatNumberShort(100)).toBe('100');
      expect(formatNumberShort(999)).toBe('999');
    });

    it('should format thousands', () => {
      expect(formatNumberShort(1000)).toBe('1.0K');
      expect(formatNumberShort(1500)).toBe('1.5K');
      expect(formatNumberShort(999999)).toBe('1000.0K');
    });

    it('should format millions', () => {
      expect(formatNumberShort(1000000)).toBe('1.0M');
      expect(formatNumberShort(2500000)).toBe('2.5M');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(10)).toBe('10ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(5000)).toBe('5.0s');
      expect(formatDuration(59999)).toBe('60.0s');
    });

    it('should format minutes', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(3000000)).toBe('50m 0s');
    });

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('1h 0m');
      expect(formatDuration(3660000)).toBe('1h 1m');
      expect(formatDuration(7200000)).toBe('2h 0m');
    });
  });

  describe('formatRelativeTime', () => {
    it('should format just now', () => {
      const now = Date.now();
      expect(formatRelativeTime(now, now)).toBe('just now');
      expect(formatRelativeTime(now - 500, now)).toBe('just now');
    });

    it('should format seconds ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 1000, now)).toBe('1s ago');
      expect(formatRelativeTime(now - 30000, now)).toBe('30s ago');
    });

    it('should format minutes ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 60000, now)).toBe('1m ago');
      expect(formatRelativeTime(now - 1800000, now)).toBe('30m ago');
    });

    it('should format hours ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 3600000, now)).toBe('1h ago');
      expect(formatRelativeTime(now - 7200000, now)).toBe('2h ago');
    });

    it('should format days ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 86400000, now)).toBe('1d ago');
      expect(formatRelativeTime(now - 172800000, now)).toBe('2d ago');
    });
  });

  describe('formatCost', () => {
    it('should format small costs', () => {
      expect(formatCost(0.0001)).toBe('$0.0001');
      expect(formatCost(0.005)).toBe('$0.0050');
    });

    it('should format medium costs', () => {
      expect(formatCost(0.01)).toBe('$0.010');
      expect(formatCost(0.5)).toBe('$0.500');
    });

    it('should format large costs', () => {
      expect(formatCost(1)).toBe('$1.00');
      expect(formatCost(10.5)).toBe('$10.50');
      expect(formatCost(100)).toBe('$100.00');
    });

    it('should use custom currency symbol', () => {
      expect(formatCost(1, '¥')).toBe('¥1.00');
      expect(formatCost(10, '€')).toBe('€10.00');
    });
  });

  describe('getStatusColor', () => {
    it('should return correct colors', () => {
      expect(getStatusColor('running')).toBe('#3b82f6');
      expect(getStatusColor('completed')).toBe('#22c55e');
      expect(getStatusColor('failed')).toBe('#ef4444');
      expect(getStatusColor('paused')).toBe('#f59e0b');
    });

    it('should return default color for unknown status', () => {
      expect(getStatusColor('unknown')).toBe('#6b7280');
    });
  });

  describe('getStatusColorClass', () => {
    it('should return Tailwind classes', () => {
      expect(getStatusColorClass('running')).toBe('bg-blue-500');
      expect(getStatusColorClass('completed')).toBe('bg-green-500');
      expect(getStatusColorClass('failed')).toBe('bg-red-500');
    });
  });
});

describe('DashboardAggregator', () => {
  let monitor: RuntimeMonitor;
  let aggregator: DashboardAggregator;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
    aggregator = new DashboardAggregator(monitor);
  });

  describe('getOverview', () => {
    it('should return null for non-existent workflow', () => {
      expect(aggregator.getOverview('non-existent')).toBeNull();
    });

    it('should return dashboard overview for registered workflow', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');
      monitor.registerNode('node-3', 'Node 3', 'wf-1');
      monitor.startWorkflow('wf-1', 3);

      const overview = aggregator.getOverview('wf-1');

      expect(overview).not.toBeNull();
      expect(overview?.workflowId).toBe('wf-1');
      expect(overview?.workflowName).toBe('Test Workflow');
      expect(overview?.status).toBe('running');
      expect(overview?.progress.total).toBe(3);
      expect(overview?.progress.percentage).toBe(0);
    });

    it('should calculate progress correctly', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');
      monitor.registerNode('node-3', 'Node 3', 'wf-1');

      monitor.startWorkflow('wf-1', 3);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1');
      monitor.startNode('wf-1', 'node-2');
      monitor.failNode('wf-1', 'node-2', 'Error');

      const overview = aggregator.getOverview('wf-1');

      expect(overview?.progress.completed).toBe(1);
      expect(overview?.progress.failed).toBe(1);
      expect(overview?.progress.running).toBe(0);
      // node-3 is still idle, not pending
      expect(overview?.progress.pending).toBe(0);
      expect(overview?.progress.percentage).toBe(33);
    });

    it('should calculate token summary', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.startWorkflow('wf-1', 1);

      monitor.updateTokenUsage('wf-1', 'node-1', { input: 1000, output: 500 });

      const overview = aggregator.getOverview('wf-1');

      expect(overview?.tokenSummary.input).toBe(1000);
      expect(overview?.tokenSummary.output).toBe(500);
      expect(overview?.tokenSummary.total).toBe(1500);
      expect(overview?.tokenSummary.formatted.input).toBe('1.0K');
      expect(overview?.tokenSummary.formatted.output).toBe('500');
    });

    it('should calculate cost summary', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.startWorkflow('wf-1', 1);

      monitor.updateTokenUsage('wf-1', 'node-1', { input: 1000000, output: 500000 });

      const overview = aggregator.getOverview('wf-1');

      // Default pricing: $3/1M input, $15/1M output
      expect(overview?.costSummary.inputCost).toBe(3);
      expect(overview?.costSummary.outputCost).toBe(7.5);
      expect(overview?.costSummary.totalCost).toBe(10.5);
    });

    it('should calculate error stats', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');
      monitor.registerNode('node-3', 'Node 3', 'wf-1');

      monitor.startWorkflow('wf-1', 3);
      monitor.startNode('wf-1', 'node-2');
      monitor.failNode('wf-1', 'node-2', 'Test error');

      const overview = aggregator.getOverview('wf-1');

      expect(overview?.errorStats.total).toBe(1);
      expect(overview?.errorStats.rate).toBe(33);
      expect(overview?.errorStats.recent).toHaveLength(1);
      expect(overview?.errorStats.recent[0].message).toBe('Test error');
    });
  });

  describe('getStatusCards', () => {
    it('should return status cards', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.startWorkflow('wf-1', 5);

      const cards = aggregator.getStatusCards('wf-1');

      expect(cards.length).toBeGreaterThan(0);
      expect(cards.find(c => c.title === 'Status')?.value).toBe('running');
      expect(cards.find(c => c.title === 'Nodes')?.value).toBe('0/5');
    });
  });

  describe('getNodeStatusCards', () => {
    it('should return node status cards', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');

      monitor.startWorkflow('wf-1', 2);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1', 'Success output');

      const cards = aggregator.getNodeStatusCards('wf-1');

      expect(cards).toHaveLength(2);
      expect(cards.find(c => c.nodeId === 'node-1')?.status).toBe('completed');
      expect(cards.find(c => c.nodeId === 'node-1')?.output).toBe('Success output');
    });
  });
});

describe('ChartDataFormatter', () => {
  let monitor: RuntimeMonitor;
  let formatter: ChartDataFormatter;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
    formatter = new ChartDataFormatter(monitor);
  });

  describe('getExecutionTimeChartData', () => {
    it('should return null for non-existent workflow', () => {
      expect(formatter.getExecutionTimeChartData('non-existent')).toBeNull();
    });

    it('should return execution time data', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');

      monitor.startWorkflow('wf-1', 2);

      // Simulate node execution with different durations
      vi.useFakeTimers();
      const now = Date.now();

      vi.setSystemTime(now);
      monitor.startNode('wf-1', 'node-1');
      vi.setSystemTime(now + 1000);
      monitor.completeNode('wf-1', 'node-1');

      vi.setSystemTime(now + 2000);
      monitor.startNode('wf-1', 'node-2');
      vi.setSystemTime(now + 5000); // 3 seconds duration
      monitor.completeNode('wf-1', 'node-2');

      vi.useRealTimers();

      const data = formatter.getExecutionTimeChartData('wf-1');

      expect(data).not.toBeNull();
      expect(data?.byNode).toHaveLength(2);
      expect(data?.byNode[0].durationMs).toBe(3000); // node-2 should be first (longest)
      expect(data?.byNode[1].durationMs).toBe(1000);
      expect(data?.maxMs).toBe(3000);
      expect(data?.minMs).toBe(1000);
    });
  });

  describe('getNodeStatusChartData', () => {
    it('should return null for empty workflow', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.startWorkflow('wf-1', 0);

      expect(formatter.getNodeStatusChartData('wf-1')).toBeNull();
    });

    it('should return node status distribution', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');
      monitor.registerNode('node-3', 'Node 3', 'wf-1');
      monitor.registerNode('node-4', 'Node 4', 'wf-1');

      monitor.startWorkflow('wf-1', 4);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1');
      monitor.startNode('wf-1', 'node-2');
      monitor.failNode('wf-1', 'node-2', 'Error');

      const data = formatter.getNodeStatusChartData('wf-1');

      expect(data).not.toBeNull();
      expect(data?.total).toBe(4);
      expect(data?.data.find(d => d.status === 'completed')?.count).toBe(1);
      expect(data?.data.find(d => d.status === 'failed')?.count).toBe(1);
      expect(data?.data.find(d => d.status === 'idle')?.count).toBe(2);
    });
  });
});

describe('TimelineGenerator', () => {
  let monitor: RuntimeMonitor;
  let generator: TimelineGenerator;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
    generator = new TimelineGenerator(monitor);
  });

  describe('generate', () => {
    it('should return null for non-existent workflow', () => {
      expect(generator.generate('non-existent')).toBeNull();
    });

    it('should generate timeline data', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');

      monitor.startWorkflow('wf-1', 1);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1');
      monitor.completeWorkflow('wf-1');

      const timeline = generator.generate('wf-1');

      expect(timeline).not.toBeNull();
      expect(timeline?.workflowId).toBe('wf-1');
      expect(timeline?.events.length).toBeGreaterThan(0);
      // Events are in chronological order, workflow_start should be one of the event types
      const eventTypes = timeline?.events.map(e => e.type) || [];
      expect(eventTypes).toContain('workflow_start');
    });

    it('should calculate relative time correctly', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.startWorkflow('wf-1', 1);

      vi.setSystemTime(now + 5000);
      monitor.startNode('wf-1', 'node-1');

      vi.setSystemTime(now + 10000);
      monitor.completeNode('wf-1', 'node-1');

      vi.useRealTimers();

      const timeline = generator.generate('wf-1');
      const nodeStart = timeline?.events.find(e => e.type === 'node_start');

      expect(nodeStart?.relativeTime).toBe(5000);
      expect(nodeStart?.formattedTime).toBe('5.0s');
    });
  });

  describe('generateNodeRanges', () => {
    it('should return null for non-existent workflow', () => {
      expect(generator.generateNodeRanges('non-existent')).toBeNull();
    });

    it('should generate node ranges for gantt chart', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.registerNode('node-2', 'Node 2', 'wf-1');

      monitor.startWorkflow('wf-1', 2);

      vi.setSystemTime(now + 0);
      monitor.startNode('wf-1', 'node-1');

      vi.setSystemTime(now + 1000);
      monitor.completeNode('wf-1', 'node-1');

      vi.setSystemTime(now + 2000);
      monitor.startNode('wf-1', 'node-2');

      vi.setSystemTime(now + 5000);
      monitor.completeNode('wf-1', 'node-2');

      vi.setSystemTime(now + 6000);
      monitor.completeWorkflow('wf-1');

      vi.useRealTimers();

      const ranges = generator.generateNodeRanges('wf-1');

      expect(ranges).not.toBeNull();
      expect(ranges).toHaveLength(2);
      expect(ranges?.[0].nodeId).toBe('node-1');
      expect(ranges?.[0].duration).toBe(1000);
      expect(ranges?.[1].duration).toBe(3000);
    });
  });
});

describe('DataExporter', () => {
  let monitor: RuntimeMonitor;
  let exporter: DataExporter;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
    exporter = new DataExporter(monitor);
  });

  describe('exportJSON', () => {
    it('should return null for non-existent workflow', () => {
      expect(exporter.exportJSON('non-existent')).toBeNull();
    });

    it('should export complete workflow data', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');

      monitor.startWorkflow('wf-1', 1);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1');
      monitor.updateTokenUsage('wf-1', 'node-1', { input: 1000, output: 500 });
      monitor.completeWorkflow('wf-1');

      const data = exporter.exportJSON('wf-1');

      expect(data).not.toBeNull();
      expect(data?.workflow.id).toBe('wf-1');
      expect(data?.workflow.name).toBe('Test Workflow');
      expect(data?.workflow.status).toBe('completed');
      expect(data?.dashboard).toBeDefined();
      expect(data?.timeline).toBeDefined();
      expect(data?.charts).toBeDefined();
      expect(data?.logs).toBeDefined();
      expect(data?.exportedAt).toBeDefined();
    });
  });

  describe('exportCSV', () => {
    it('should return null for empty workflow', () => {
      expect(exporter.exportCSV('non-existent')).toBeNull();
    });

    it('should export logs as CSV', () => {
      monitor.registerWorkflow('wf-1', 'Test Workflow');
      monitor.registerNode('node-1', 'Node 1', 'wf-1');
      monitor.startWorkflow('wf-1', 1);
      monitor.startNode('wf-1', 'node-1');
      monitor.completeNode('wf-1', 'node-1');

      const csv = exporter.exportCSV('wf-1');

      expect(csv).not.toBeNull();
      expect(csv).toContain('timestamp,type,nodeId,title,content,level');
      // Check for node-1 in the CSV (it appears in the node events)
      expect(csv).toMatch(/node-1/);
    });
  });
});

describe('Visualization with custom config', () => {
  it('should use custom token pricing', () => {
    resetRuntimeMonitor();
    const monitor = new RuntimeMonitor();
    const config: Partial<VisualizationConfig> = {
      tokenPricing: { input: 5.0, output: 20.0 },
      currencySymbol: '¥',
    };
    const aggregator = new DashboardAggregator(monitor, config);

    monitor.registerWorkflow('wf-1', 'Test Workflow');
    monitor.startWorkflow('wf-1', 1);
    monitor.updateTokenUsage('wf-1', 'node-1', { input: 1000000, output: 500000 });

    const overview = aggregator.getOverview('wf-1');

    // Custom pricing: ¥5/1M input, ¥20/1M output
    expect(overview?.costSummary.inputCost).toBe(5);
    expect(overview?.costSummary.outputCost).toBe(10);
    expect(overview?.costSummary.totalCost).toBe(15);
    expect(overview?.costSummary.formatted.totalCost).toBe('¥15.00');
  });
});
