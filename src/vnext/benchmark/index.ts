/**
 * Performance Benchmark Suite for Polaris Scheduler vNext
 *
 * Provides performance benchmarks for critical components
 */

import type { Workflow, WorkflowNode, NodeState, WorkflowStatus } from '../types';
import type {
  BenchmarkResult,
  BenchmarkSuiteResult,
  BenchmarkConfig,
} from './types';
import { canTransitionWorkflow, canTransitionNode } from '../state-machine';
import { EventBus } from '../event-bus';
import { DefaultNodeSelector } from '../executor';
import { ExecutionStore } from '../execution-store';
import { MemoryManager } from '../memory-manager';

export type { BenchmarkResult, BenchmarkSuiteResult, BenchmarkConfig };

/**
 * Extended workflow with nodes for benchmarking
 */
export interface BenchmarkWorkflow extends Workflow {
  nodes: WorkflowNode[];
  edges: Array<{ id: string; source: string; target: string }>;
}

const DEFAULT_CONFIG: Required<BenchmarkConfig> = {
  warmupIterations: 10,
  iterations: 1000,
  collectMemory: true,
};

/**
 * Run a single benchmark
 */
export async function runBenchmark(
  name: string,
  fn: () => void | Promise<void>,
  config: BenchmarkConfig = {}
): Promise<BenchmarkResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < cfg.warmupIterations; i++) {
    await fn();
  }

  // Benchmark
  for (let i = 0; i < cfg.iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  // Calculate statistics
  const totalTime = times.reduce((a, b) => a + b, 0);
  const avgTime = totalTime / times.length;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const opsPerSecond = 1000 / avgTime;

  const result: BenchmarkResult = {
    name,
    iterations: cfg.iterations,
    totalTime,
    avgTime,
    minTime,
    maxTime,
    opsPerSecond,
  };

  // Collect memory usage if available
  if (cfg.collectMemory && typeof process !== 'undefined' && process.memoryUsage) {
    const mem = process.memoryUsage();
    result.memoryUsage = {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    };
  }

  return result;
}

/**
 * Create a mock workflow for benchmarking
 */
export function createBenchmarkWorkflow(nodeCount: number): BenchmarkWorkflow {
  const now = Date.now();
  const nodes: WorkflowNode[] = [];

  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      workflowId: 'benchmark-workflow',
      name: `Node ${i}`,
      role: 'agent',
      enabled: true,
      state: 'IDLE' as NodeState,
      triggerType: 'dependency' as const,
      subscribeEvents: [],
      emitEvents: [],
      dependencies: i > 0 ? [`node-${i - 1}`] : [],
      nextNodes: i < nodeCount - 1 ? [`node-${i + 1}`] : [],
      maxRounds: 10,
      currentRounds: 0,
      timeoutMs: 30000,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
      updatedAt: now,
      config: {
        priority: Math.floor(Math.random() * 10),
      },
    });
  }

  const edges = nodes.slice(1).map((node, i) => ({
    id: `edge-${i}`,
    source: `node-${i}`,
    target: node.id,
  }));

  return {
    id: 'benchmark-workflow',
    name: 'Benchmark Workflow',
    description: 'A workflow for performance benchmarking',
    status: 'CREATED' as WorkflowStatus,
    mode: 'continuous',
    priority: 5,
    memoryRoot: '/tmp/benchmark-memory',
    workDir: '/tmp/benchmark-workdir',
    createdAt: now,
    updatedAt: now,
    currentRounds: 0,
    maxRounds: 100,
    tags: ['benchmark'],
    nodes,
    edges,
  };
}

/**
 * Create simple workflow for node selection benchmarks
 */
export function createSimpleBenchmarkWorkflow(id = 'benchmark-workflow'): Workflow {
  const now = Date.now();
  return {
    id,
    name: `Workflow ${id}`,
    status: 'RUNNING' as WorkflowStatus,
    mode: 'continuous',
    priority: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create mock nodes for benchmarking with correct WorkflowNode type
 */
export function createBenchmarkNodes(count: number, workflowId = 'benchmark-workflow'): WorkflowNode[] {
  const now = Date.now();

  return Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    workflowId,
    name: `Node ${i}`,
    role: 'agent',
    enabled: true,
    state: 'IDLE' as NodeState,
    triggerType: 'dependency' as const,
    subscribeEvents: [],
    emitEvents: [],
    dependencies: i > 0 ? [`node-${i - 1}`] : [],
    nextNodes: i < count - 1 ? [`node-${i + 1}`] : [],
    maxRounds: 10,
    currentRounds: 0,
    timeoutMs: 30000,
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
    updatedAt: now,
    config: {
      priority: Math.floor(Math.random() * 10),
    },
  }));
}

/**
 * Format benchmark result as string
 */
export function formatBenchmarkResult(result: BenchmarkResult): string {
  const lines = [
    `📊 ${result.name}`,
    `   Iterations: ${result.iterations}`,
    `   Total Time: ${result.totalTime.toFixed(3)}ms`,
    `   Avg Time: ${result.avgTime.toFixed(4)}ms`,
    `   Min/Max: ${result.minTime.toFixed(4)}ms / ${result.maxTime.toFixed(4)}ms`,
    `   Ops/sec: ${result.opsPerSecond.toFixed(0)}`,
  ];

  if (result.memoryUsage) {
    lines.push(
      `   Memory: ${(result.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB heap`
    );
  }

  return lines.join('\n');
}

/**
 * Format benchmark suite result as string
 */
export function formatSuiteResult(result: BenchmarkSuiteResult): string {
  const lines = [
    `\n${'='.repeat(60)}`,
    `📋 ${result.suite}`,
    `${'='.repeat(60)}`,
    '',
  ];

  for (const benchmark of result.benchmarks) {
    lines.push(formatBenchmarkResult(benchmark));
    lines.push('');
  }

  lines.push(`Total Suite Time: ${result.totalTime.toFixed(3)}ms`);
  lines.push(`Timestamp: ${new Date(result.timestamp).toISOString()}`);

  return lines.join('\n');
}

/**
 * Benchmark suite runner
 */
export class BenchmarkSuite {
  private benchmarks: Array<{
    name: string;
    fn: () => void | Promise<void>;
  }> = [];
  private suiteName: string;
  private config: BenchmarkConfig;

  constructor(suiteName: string, config: BenchmarkConfig = {}) {
    this.suiteName = suiteName;
    this.config = config;
  }

  /**
   * Add a benchmark to the suite
   */
  add(name: string, fn: () => void | Promise<void>): this {
    this.benchmarks.push({ name, fn });
    return this;
  }

  /**
   * Run all benchmarks in the suite
   */
  async run(): Promise<BenchmarkSuiteResult> {
    const startTime = performance.now();
    const results: BenchmarkResult[] = [];

    for (const { name, fn } of this.benchmarks) {
      const result = await runBenchmark(name, fn, this.config);
      results.push(result);
    }

    const totalTime = performance.now() - startTime;

    return {
      suite: this.suiteName,
      benchmarks: results,
      totalTime,
      timestamp: Date.now(),
    };
  }

  /**
   * Run and print results
   */
  async runAndPrint(): Promise<BenchmarkSuiteResult> {
    const result = await this.run();
    console.log(formatSuiteResult(result));
    return result;
  }
}

// Pre-defined benchmark suites

/**
 * State Machine Benchmarks
 */
export function createStateMachineBenchmarkSuite(): BenchmarkSuite {
  return new BenchmarkSuite('State Machine Benchmarks')
    .add('workflow transition check', () => {
      canTransitionWorkflow('CREATED', 'RUNNING');
      canTransitionWorkflow('RUNNING', 'WAITING_EVENT');
      canTransitionWorkflow('WAITING_EVENT', 'RUNNING');
      canTransitionWorkflow('RUNNING', 'COMPLETED');
    })
    .add('node transition check', () => {
      canTransitionNode('IDLE', 'READY');
      canTransitionNode('READY', 'RUNNING');
      canTransitionNode('RUNNING', 'DONE');
      canTransitionNode('DONE', 'READY');
    });
}

/**
 * EventBus Benchmarks
 */
export function createEventBusBenchmarkSuite(): BenchmarkSuite {
  return new BenchmarkSuite('EventBus Benchmarks')
    .add('subscribe and emit', () => {
      const bus = new EventBus();
      const handler = () => {};
      const unsub = bus.subscribe('test-event', handler);
      bus.emit('test-event', { data: 'test' }, { workflowId: 'bench' });
      unsub();
    })
    .add('emit event', () => {
      const bus = new EventBus();
      bus.emit('test-event', { data: 'test' }, { workflowId: 'bench' });
    })
    .add('emit to 10 subscribers', () => {
      const bus = new EventBus();
      for (let i = 0; i < 10; i++) {
        bus.subscribe('test-event', () => {});
      }
      bus.emit('test-event', { data: 'test' }, { workflowId: 'bench' });
    });
}

/**
 * Node Selection Benchmarks
 */
export function createNodeSelectionBenchmarkSuite(): BenchmarkSuite {
  return new BenchmarkSuite('Node Selection Benchmarks')
    .add('select from 10 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(10);
      const workflow = createSimpleBenchmarkWorkflow('test');
      selector.selectNode({
        nodes,
        workflow,
        pendingEvents: [],
        currentRound: 1,
      });
    })
    .add('select from 100 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(100);
      const workflow = createSimpleBenchmarkWorkflow('test');
      selector.selectNode({
        nodes,
        workflow,
        pendingEvents: [],
        currentRound: 1,
      });
    })
    .add('select from 1000 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(1000);
      const workflow = createSimpleBenchmarkWorkflow('test');
      selector.selectNode({
        nodes,
        workflow,
        pendingEvents: [],
        currentRound: 1,
      });
    });
}

/**
 * Execution Store Benchmarks
 */
export function createExecutionStoreBenchmarkSuite(): BenchmarkSuite {
  return new BenchmarkSuite('Execution Store Benchmarks')
    .add('create and get execution', () => {
      const store = new ExecutionStore();
      const record = store.create({
        workflowId: 'test-workflow',
        nodeId: 'test-node',
        round: 1,
      });
      store.get(record.id);
    })
    .add('create 100 executions', () => {
      const store = new ExecutionStore();
      for (let i = 0; i < 100; i++) {
        store.create({
          workflowId: `workflow-${i}`,
          nodeId: `node-${i}`,
          round: 1,
        });
      }
    })
    .add('query executions', () => {
      const store = new ExecutionStore();
      for (let i = 0; i < 100; i++) {
        store.create({
          workflowId: 'test-workflow',
          nodeId: `node-${i}`,
          round: 1,
        });
      }
      store.getByWorkflow('test-workflow');
    });
}

/**
 * Memory Manager Benchmarks
 */
export function createMemoryBenchmarkSuite(): BenchmarkSuite {
  return new BenchmarkSuite('Memory Manager Benchmarks')
    .add('add entry to active layer', async () => {
      const manager = new MemoryManager();
      await manager.addEntry('test-workflow', 'active', {
        type: 'decision',
        content: 'Test decision',
        tags: [],
        tokenCount: 10,
      });
    })
    .add('add 100 entries', async () => {
      const manager = new MemoryManager();
      for (let i = 0; i < 100; i++) {
        await manager.addEntry('test-workflow', 'active', {
          type: 'note',
          content: `Note ${i}`,
          tags: [],
          tokenCount: 5,
        });
      }
    })
    .add('get workflow state', async () => {
      const manager = new MemoryManager();
      for (let i = 0; i < 10; i++) {
        await manager.addEntry('test-workflow', 'active', {
          type: 'note',
          content: `Note ${i}`,
          tags: [],
          tokenCount: 5,
        });
      }
      manager.getWorkflowState('test-workflow');
    });
}

/**
 * Run all benchmark suites
 */
export async function runAllBenchmarks(
  _config: BenchmarkConfig = {}
): Promise<BenchmarkSuiteResult[]> {
  const suites = [
    createStateMachineBenchmarkSuite(),
    createEventBusBenchmarkSuite(),
    createNodeSelectionBenchmarkSuite(),
    createExecutionStoreBenchmarkSuite(),
    createMemoryBenchmarkSuite(),
  ];

  const results: BenchmarkSuiteResult[] = [];

  for (const suite of suites) {
    const result = await suite.run();
    results.push(result);
    console.log(formatSuiteResult(result));
  }

  return results;
}

export * from './types';
