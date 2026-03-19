/**
 * vNext Components Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Import types and helpers
import {
  getNodeStatusConfig,
  getTimelineEventTypeConfig,
  type NodeState,
} from '../components/types';

// Import components
import {
  ProgressBar,
  SimpleProgressBar,
  CircularProgress,
  NodeStatusCard,
  NodeStatusMiniCard,
  NodeStatusGrid,
  DashboardOverview,
  TokenSummaryCard,
  CostSummaryCard,
  SimpleTimeline,
} from '../components';

// ============================================================================
// Type and Helper Tests
// ============================================================================

describe('getNodeStatusConfig', () => {
  const states: NodeState[] = [
    'IDLE', 'READY', 'RUNNING', 'WAITING_INPUT', 'DONE', 'FAILED', 'SKIPPED'
  ];

  states.forEach((state) => {
    it(`should return config for ${state}`, () => {
      const config = getNodeStatusConfig(state);
      expect(config).toBeDefined();
      expect(config.color).toBeDefined();
      expect(config.bgColor).toBeDefined();
      expect(config.borderColor).toBeDefined();
      expect(config.icon).toBeDefined();
      expect(config.label).toBeDefined();
    });
  });
});

describe('getTimelineEventTypeConfig', () => {
  const eventTypes = [
    'workflow_start', 'workflow_pause', 'workflow_resume', 'workflow_stop',
    'workflow_complete', 'workflow_fail', 'node_start', 'node_complete',
    'node_fail', 'tool_call', 'decision', 'error', 'checkpoint', 'user_input'
  ];

  eventTypes.forEach((type) => {
    it(`should return config for ${type}`, () => {
      const config = getTimelineEventTypeConfig(type);
      expect(config).toBeDefined();
      expect(config.color).toBeDefined();
      expect(config.bgColor).toBeDefined();
      expect(config.icon).toBeDefined();
      expect(config.label).toBeDefined();
    });
  });
});

// ============================================================================
// ProgressBar Tests
// ============================================================================

describe('ProgressBar', () => {
  const mockProgress = {
    total: 10,
    completed: 5,
    running: 2,
    pending: 2,
    failed: 1,
    skipped: 0,
    percentage: 50,
    bar: {
      segments: [
        { status: 'completed' as const, count: 5, percentage: 50, colorClass: '' },
        { status: 'running' as const, count: 2, percentage: 20, colorClass: '' },
        { status: 'pending' as const, count: 2, percentage: 20, colorClass: '' },
        { status: 'failed' as const, count: 1, percentage: 10, colorClass: '' },
      ],
      totalWidth: 100,
    },
  };

  it('should render progress bar', () => {
    render(<ProgressBar progress={mockProgress} />);

    // Check for progress bar role
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeInTheDocument();
  });

  it('should show labels when showLabels is true', () => {
    render(<ProgressBar progress={mockProgress} showLabels />);

    // Should show status badges
    expect(screen.getByText(/完成/)).toBeInTheDocument();
    expect(screen.getByText(/运行/)).toBeInTheDocument();
  });

  it('should show percentage when showPercentage is true', () => {
    render(<ProgressBar progress={mockProgress} showPercentage />);

    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('should apply different heights', () => {
    const { container: sm } = render(<ProgressBar progress={mockProgress} height="sm" />);
    const { container: md } = render(<ProgressBar progress={mockProgress} height="md" />);
    const { container: lg } = render(<ProgressBar progress={mockProgress} height="lg" />);

    // All should render without error
    expect(sm.firstChild).toBeInTheDocument();
    expect(md.firstChild).toBeInTheDocument();
    expect(lg.firstChild).toBeInTheDocument();
  });
});

describe('SimpleProgressBar', () => {
  it('should render with percentage', () => {
    const { container } = render(<SimpleProgressBar percentage={75} />);

    // SimpleProgressBar doesn't have progressbar role, check for structure
    const progressContainer = container.querySelector('.w-full.rounded-full');
    expect(progressContainer).toBeInTheDocument();
  });

  it('should clamp percentage to 0-100', () => {
    const { container, rerender } = render(<SimpleProgressBar percentage={150} />);

    // Should still render with clamped value (100%)
    const progressBar = container.querySelector('.h-full.rounded-full') as HTMLElement;
    expect(progressBar).toBeTruthy();
    expect(progressBar?.style.width).toBe('100%');

    rerender(<SimpleProgressBar percentage={-50} />);
    // Should render with 0%
    const progressBarAfter = container.querySelector('.h-full.rounded-full') as HTMLElement;
    expect(progressBarAfter?.style.width).toBe('0%');
  });
});

describe('CircularProgress', () => {
  it('should render circular progress', () => {
    const { container } = render(<CircularProgress percentage={60} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('should show label by default', () => {
    const { container } = render(<CircularProgress percentage={60} />);

    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('should hide label when showLabel is false', () => {
    const { container } = render(<CircularProgress percentage={60} showLabel={false} />);

    expect(screen.queryByText('60%')).not.toBeInTheDocument();
  });
});

// ============================================================================
// NodeStatusCard Tests
// ============================================================================

describe('NodeStatusCard', () => {
  const mockNode = {
    id: 'node-1',
    workflowId: 'wf-1',
    name: 'Test Node',
    role: 'developer',
    enabled: true,
    state: 'RUNNING' as NodeState,
    triggerType: 'start' as const,
    subscribeEvents: [],
    emitEvents: [],
    dependencies: [],
    nextNodes: [],
    maxRounds: 10,
    currentRound: 5,
    timeoutMs: 60000,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('should render node information', () => {
    render(<NodeStatusCard node={mockNode} />);

    expect(screen.getByText('Test Node')).toBeInTheDocument();
    expect(screen.getByText('developer')).toBeInTheDocument();
  });

  it('should show status badge', () => {
    render(<NodeStatusCard node={mockNode} />);

    // Should show "运行中" for RUNNING state
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('should show duration when provided', () => {
    render(<NodeStatusCard node={mockNode} duration={5000} />);

    // Duration should be formatted
    expect(screen.getByText('5.0s')).toBeInTheDocument();
  });

  it('should show error message when provided', () => {
    render(<NodeStatusCard node={{ ...mockNode, state: 'FAILED' }} errorMessage="Something went wrong" />);

    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
  });

  it('should handle click events', () => {
    const handleClick = vi.fn();
    render(<NodeStatusCard node={mockNode} onClick={handleClick} />);

    const card = screen.getByRole('button');
    card.click();

    expect(handleClick).toHaveBeenCalled();
  });

  it('should show selected state', () => {
    const { container } = render(<NodeStatusCard node={mockNode} selected />);

    expect(container.querySelector('.ring-2')).toBeInTheDocument();
  });
});

describe('NodeStatusMiniCard', () => {
  const mockNode = {
    id: 'node-1',
    name: 'Mini Node',
    state: 'DONE',
    role: 'tester',
  };

  it('should render mini card', () => {
    render(<NodeStatusMiniCard node={mockNode} />);

    expect(screen.getByText('Mini Node')).toBeInTheDocument();
  });
});

describe('NodeStatusGrid', () => {
  const mockNodes = [
    { id: 'n1', name: 'Node 1', state: 'DONE', role: 'dev' },
    { id: 'n2', name: 'Node 2', state: 'RUNNING', role: 'test' },
    { id: 'n3', name: 'Node 3', state: 'IDLE', role: 'dev' },
  ];

  it('should render all nodes', () => {
    render(<NodeStatusGrid nodes={mockNodes} />);

    expect(screen.getByText('Node 1')).toBeInTheDocument();
    expect(screen.getByText('Node 2')).toBeInTheDocument();
    expect(screen.getByText('Node 3')).toBeInTheDocument();
  });

  it('should handle node selection', () => {
    const handleSelect = vi.fn();
    render(<NodeStatusGrid nodes={mockNodes} onNodeClick={handleSelect} />);

    screen.getByText('Node 1').click();
    expect(handleSelect).toHaveBeenCalledWith('n1');
  });
});

// ============================================================================
// DashboardOverview Tests
// ============================================================================

describe('DashboardOverview', () => {
  const mockData = {
    workflowId: 'wf-1',
    workflowName: 'Test Workflow',
    status: 'running' as const,
    duration: '5m 30s',
    durationMs: 330000,
    progress: {
      total: 10,
      completed: 6,
      running: 2,
      pending: 2,
      failed: 0,
      skipped: 0,
      percentage: 60,
      bar: {
        segments: [
          { status: 'completed' as const, count: 6, percentage: 60, colorClass: '' },
          { status: 'running' as const, count: 2, percentage: 20, colorClass: '' },
          { status: 'pending' as const, count: 2, percentage: 20, colorClass: '' },
        ],
        totalWidth: 100,
      },
    },
    tokenSummary: {
      input: 1000,
      output: 500,
      total: 1500,
      formatted: {
        input: '1,000',
        output: '500',
        total: '1,500',
      },
    },
    costSummary: {
      inputCost: 0.003,
      outputCost: 0.0075,
      totalCost: 0.0105,
      formatted: {
        inputCost: '0.0030',
        outputCost: '0.0075',
        totalCost: '0.0105',
      },
    },
    errorStats: {
      total: 0,
      rate: 0,
      recent: [],
    },
    lastUpdated: '2024-01-01 12:00:00',
  };

  it('should render dashboard overview', () => {
    render(<DashboardOverview data={mockData} />);

    expect(screen.getByText('Test Workflow')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('should show token summary when showTokens is true', () => {
    render(<DashboardOverview data={mockData} showTokens />);

    expect(screen.getByText('Token 使用')).toBeInTheDocument();
  });

  it('should show cost summary when showCost is true', () => {
    render(<DashboardOverview data={mockData} showCost />);

    expect(screen.getByText('预估成本')).toBeInTheDocument();
  });

  it('should handle refresh', () => {
    const handleRefresh = vi.fn();
    render(<DashboardOverview data={mockData} onRefresh={handleRefresh} />);

    // Find and click refresh button
    const refreshButton = screen.getByTitle('刷新');
    refreshButton.click();

    expect(handleRefresh).toHaveBeenCalled();
  });

  it('should show errors when present', () => {
    const dataWithErrors = {
      ...mockData,
      errorStats: {
        total: 2,
        rate: 20,
        recent: [
          { nodeId: 'n1', nodeName: 'Node 1', message: 'Error 1', timestamp: '2024-01-01' },
        ],
      },
    };

    render(<DashboardOverview data={dataWithErrors} showErrors />);

    expect(screen.getByText(/2 个错误/)).toBeInTheDocument();
  });
});

describe('TokenSummaryCard', () => {
  const mockSummary = {
    input: 10000,
    output: 5000,
    total: 15000,
    formatted: {
      input: '10,000',
      output: '5,000',
      total: '15,000',
    },
  };

  it('should render token summary', () => {
    render(<TokenSummaryCard summary={mockSummary} />);

    expect(screen.getByText('Token 使用')).toBeInTheDocument();
    expect(screen.getByText('15,000')).toBeInTheDocument();
  });

  it('should show details when showDetails is true', () => {
    render(<TokenSummaryCard summary={mockSummary} showDetails />);

    expect(screen.getByText(/输入:/)).toBeInTheDocument();
    expect(screen.getByText(/输出:/)).toBeInTheDocument();
  });
});

describe('CostSummaryCard', () => {
  const mockSummary = {
    inputCost: 0.03,
    outputCost: 0.075,
    totalCost: 0.105,
    formatted: {
      inputCost: '0.0300',
      outputCost: '0.0750',
      totalCost: '0.1050',
    },
  };

  it('should render cost summary', () => {
    render(<CostSummaryCard summary={mockSummary} />);

    expect(screen.getByText('预估成本')).toBeInTheDocument();
    expect(screen.getByText('$0.1050')).toBeInTheDocument();
  });

  it('should support custom currency symbol', () => {
    render(<CostSummaryCard summary={mockSummary} currencySymbol="¥" />);

    expect(screen.getByText('¥0.1050')).toBeInTheDocument();
  });
});

// ============================================================================
// Timeline Tests
// ============================================================================

describe('SimpleTimeline', () => {
  const mockEvents = [
    {
      id: 'e1',
      type: 'workflow_start' as const,
      timestamp: Date.now(),
      relativeTime: 0,
      formattedTime: '12:00:00',
      title: 'Workflow Started',
    },
    {
      id: 'e2',
      type: 'node_start' as const,
      timestamp: Date.now() + 1000,
      relativeTime: 1000,
      formattedTime: '12:00:01',
      title: 'Node Started',
      nodeId: 'n1',
      nodeName: 'Node 1',
    },
    {
      id: 'e3',
      type: 'node_complete' as const,
      timestamp: Date.now() + 5000,
      relativeTime: 5000,
      formattedTime: '12:00:05',
      title: 'Node Completed',
      nodeId: 'n1',
      nodeName: 'Node 1',
      duration: 4000,
      formattedDuration: '4.0s',
    },
  ];

  it('should render timeline events', () => {
    render(<SimpleTimeline events={mockEvents} />);

    expect(screen.getByText('Workflow Started')).toBeInTheDocument();
    expect(screen.getByText('Node Started')).toBeInTheDocument();
    expect(screen.getByText('Node Completed')).toBeInTheDocument();
  });

  it('should limit events to maxEvents', () => {
    render(<SimpleTimeline events={mockEvents} maxEvents={2} />);

    // Should only show last 2 events
    expect(screen.queryByText('Workflow Started')).not.toBeInTheDocument();
    expect(screen.getByText('Node Started')).toBeInTheDocument();
    expect(screen.getByText('Node Completed')).toBeInTheDocument();
  });
});

// ============================================================================
// Export Tests
// ============================================================================

describe('Components Export', () => {
  it('should export all expected components', async () => {
    const components = await import('../components');

    expect(components.ProgressBar).toBeDefined();
    expect(components.SimpleProgressBar).toBeDefined();
    expect(components.CircularProgress).toBeDefined();
    expect(components.NodeStatusCard).toBeDefined();
    expect(components.NodeStatusMiniCard).toBeDefined();
    expect(components.NodeStatusGrid).toBeDefined();
    expect(components.NodeStatusList).toBeDefined();
    expect(components.WorkflowDiagram).toBeDefined();
    expect(components.SimpleWorkflowDiagram).toBeDefined();
    expect(components.DashboardOverview).toBeDefined();
    expect(components.TokenSummaryCard).toBeDefined();
    expect(components.CostSummaryCard).toBeDefined();
    expect(components.StatsCardGroup).toBeDefined();
    expect(components.QuickStatsBar).toBeDefined();
    expect(components.TimelineView).toBeDefined();
    expect(components.SimpleTimeline).toBeDefined();
    expect(components.NodeGanttChart).toBeDefined();
  });
});
