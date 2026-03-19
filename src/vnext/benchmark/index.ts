/**
 * Performance Benchmark Suite for Polaris Scheduler vNext
 *
 * Provides performance benchmarks for critical components
 */

import type { Workflow, WorkflowNode } from '../types';

/**
 * Benchmark result
 */
export interface BenchmarkResult {
  /** Benchmark name */
  name: string;
  /** Number of iterations */
  iterations: number;
  /** Total time in milliseconds */
  totalTime: number;
  /** Average time per iteration in milliseconds */
  avgTime: number;
  /** Minimum time in milliseconds */
  minTime: number;
  /** Maximum time in milliseconds */
  maxTime: number;
  /** Operations per second */
  opsPerSecond: number;
  /** Memory usage (if available) */
  memoryUsage?: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

/**
 * Benchmark suite result
 */
export interface BenchmarkSuiteResult {
  /** Suite name */
  suite: string;
  /** Individual benchmark results */
  benchmarks: BenchmarkResult[];
  /** Total suite time */
  totalTime: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Benchmark configuration
 */
export interface BenchmarkConfig {
  /** Number of warmup iterations */
  warmupIterations?: number;
  /** Number of benchmark iterations */
  iterations?: number;
  /** Collect memory usage */
  collectMemory?: boolean;
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
export function createBenchmarkWorkflow(nodeCount: number): Workflow {
  const nodes: WorkflowNode[] = [];

  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      name: `Node ${i}`,
      type: 'task',
      status: 'idle',
      dependencies: i > 0 ? [`node-${i - 1}`] : [],
      createdAt: Date.now(),
      config: {
        priority: Math.floor(Math.random() * 10),
      },
    });
  }

  return {
    id: 'benchmark-workflow',
    name: 'Benchmark Workflow',
    version: '1.0.0',
    status: 'idle',
    nodes,
    edges: nodes.slice(1).map((node, i) => ({
      id: `edge-${i}`,
      source: `node-${i}`,
      target: node.id,
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Create mock nodes for benchmarking
 */
export function createBenchmarkNodes(count: number): WorkflowNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    name: `Node ${i}`,
    type: 'task' as const,
    status: 'idle' as const,
    dependencies: [],
    createdAt: Date.now(),
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
  const { canTransitionWorkflow, canTransitionNode } = require('../state-machine');

  return new BenchmarkSuite('State Machine Benchmarks')
    .add('workflow transition check', () => {
      canTransitionWorkflow('idle', 'running');
      canTransitionWorkflow('running', 'paused');
      canTransitionWorkflow('paused', 'running');
      canTransitionWorkflow('running', 'completed');
    })
    .add('node transition check', () => {
      canTransitionNode('idle', 'ready');
      canTransitionNode('ready', 'running');
      canTransitionNode('running', 'completed');
      canTransitionNode('completed', 'idle');
    });
}

/**
 * EventBus Benchmarks
 */
export function createEventBusBenchmarkSuite(): BenchmarkSuite {
  const { EventBus } = require('../event-bus');

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
      let count = 0;
      bus.subscribe('test-event', () => { count++; });
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
  const { DefaultNodeSelector } = require('../executor');

  return new BenchmarkSuite('Node Selection Benchmarks')
    .add('select from 10 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(10).map(n => ({ ...n, state: 'IDLE' as const }));
      selector.selectNode({
        nodes,
        workflow: { id: 'test', status: 'running' },
        pendingEvents: [],
      });
    })
    .add('select from 100 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(100).map(n => ({ ...n, state: 'IDLE' as const }));
      selector.selectNode({
        nodes,
        workflow: { id: 'test', status: 'running' },
        pendingEvents: [],
      });
    })
    .add('select from 1000 nodes', () => {
      const selector = new DefaultNodeSelector('priority');
      const nodes = createBenchmarkNodes(1000).map(n => ({ ...n, state: 'IDLE' as const }));
      selector.selectNode({
        nodes,
        workflow: { id: 'test', status: 'running' },
        pendingEvents: [],
      });
    });
}

/**
 * Execution Store Benchmarks
 */
export function createExecutionStoreBenchmarkSuite(): BenchmarkSuite {
  const { ExecutionStore } = require('../execution-store');

  return new BenchmarkSuite('Execution Store Benchmarks')
    .add('create and get execution', () => {
      const store = new ExecutionStore();
      const id = store.create({
        workflowId: 'test-workflow',
        nodeId: 'test-node',
      });
      store.get(id);
    })
    .add('create 100 executions', () => {
      const store = new ExecutionStore();
      for (let i = 0; i < 100; i++) {
        store.create({
          workflowId: `workflow-${i}`,
          nodeId: `node-${i}`,
        });
      }
    })
    .add('query executions', () => {
      const store = new ExecutionStore();
      for (let i = 0; i < 100; i++) {
        store.create({
          workflowId: 'test-workflow',
          nodeId: `node-${i}`,
        });
      }
      store.getByWorkflow('test-workflow');
    });
}

/**
 * Memory Manager Benchmarks
 */
export function createMemoryBenchmarkSuite(): BenchmarkSuite {
  const { MemoryManager } = require('../memory-manager');

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
  config: BenchmarkConfig = {}
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
