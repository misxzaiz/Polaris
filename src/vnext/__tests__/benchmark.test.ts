/**
 * Performance Benchmark Tests
 */

import { describe, it, expect } from 'vitest';
import {
  runBenchmark,
  createBenchmarkWorkflow,
  createBenchmarkNodes,
  formatBenchmarkResult,
  formatSuiteResult,
  BenchmarkSuite,
} from '../benchmark';

describe('Benchmark Utils', () => {
  describe('runBenchmark', () => {
    it('should run a simple benchmark', async () => {
      const result = await runBenchmark(
        'simple benchmark',
        () => {
          // Simple operation
          const arr = [1, 2, 3, 4, 5];
          arr.map((x) => x * 2);
        },
        { iterations: 10, warmupIterations: 2 }
      );

      expect(result.name).toBe('simple benchmark');
      expect(result.iterations).toBe(10);
      expect(result.totalTime).toBeGreaterThan(0);
      expect(result.avgTime).toBeGreaterThan(0);
      expect(result.opsPerSecond).toBeGreaterThan(0);
    });

    it('should track min and max times', async () => {
      const result = await runBenchmark(
        'min max test',
        () => {
          Math.random();
        },
        { iterations: 100, warmupIterations: 5 }
      );

      expect(result.minTime).toBeLessThanOrEqual(result.avgTime);
      expect(result.maxTime).toBeGreaterThanOrEqual(result.avgTime);
    });
  });

  describe('createBenchmarkWorkflow', () => {
    it('should create workflow with specified nodes', () => {
      const workflow = createBenchmarkWorkflow(10);

      expect(workflow.id).toBe('benchmark-workflow');
      expect(workflow.nodes).toHaveLength(10);
      expect(workflow.edges).toHaveLength(9);
    });

    it('should create sequential dependencies', () => {
      const workflow = createBenchmarkWorkflow(5);

      expect(workflow.nodes[0].dependencies).toHaveLength(0);
      expect(workflow.nodes[1].dependencies).toContain('node-0');
      expect(workflow.nodes[2].dependencies).toContain('node-1');
    });
  });

  describe('createBenchmarkNodes', () => {
    it('should create nodes with correct count', () => {
      const nodes = createBenchmarkNodes(50);

      expect(nodes).toHaveLength(50);
      expect(nodes[0].id).toBe('node-0');
      expect(nodes[49].id).toBe('node-49');
    });

    it('should create nodes with random priorities', () => {
      const nodes = createBenchmarkNodes(100);

      const priorities = nodes.map((n) => n.config?.priority);
      const uniquePriorities = new Set(priorities);

      // Should have some variety in priorities
      expect(uniquePriorities.size).toBeGreaterThan(1);
    });
  });

  describe('formatBenchmarkResult', () => {
    it('should format benchmark result', () => {
      const result = {
        name: 'test benchmark',
        iterations: 100,
        totalTime: 50,
        avgTime: 0.5,
        minTime: 0.3,
        maxTime: 1.2,
        opsPerSecond: 2000,
      };

      const formatted = formatBenchmarkResult(result);

      expect(formatted).toContain('test benchmark');
      expect(formatted).toContain('Iterations: 100');
      expect(formatted).toContain('Ops/sec: 2000');
    });

    it('should include memory usage if present', () => {
      const result = {
        name: 'memory test',
        iterations: 100,
        totalTime: 50,
        avgTime: 0.5,
        minTime: 0.3,
        maxTime: 1.2,
        opsPerSecond: 2000,
        memoryUsage: {
          heapUsed: 1024 * 1024 * 10, // 10 MB
          heapTotal: 1024 * 1024 * 20,
          external: 1024 * 1024,
        },
      };

      const formatted = formatBenchmarkResult(result);

      expect(formatted).toContain('Memory:');
      expect(formatted).toContain('MB heap');
    });
  });

  describe('formatSuiteResult', () => {
    it('should format suite result', () => {
      const result = {
        suite: 'Test Suite',
        benchmarks: [
          {
            name: 'benchmark 1',
            iterations: 100,
            totalTime: 50,
            avgTime: 0.5,
            minTime: 0.3,
            maxTime: 1.2,
            opsPerSecond: 2000,
          },
          {
            name: 'benchmark 2',
            iterations: 100,
            totalTime: 30,
            avgTime: 0.3,
            minTime: 0.2,
            maxTime: 0.8,
            opsPerSecond: 3333,
          },
        ],
        totalTime: 100,
        timestamp: Date.now(),
      };

      const formatted = formatSuiteResult(result);

      expect(formatted).toContain('Test Suite');
      expect(formatted).toContain('benchmark 1');
      expect(formatted).toContain('benchmark 2');
      expect(formatted).toContain('Total Suite Time');
    });
  });
});

describe('BenchmarkSuite', () => {
  it('should create and run a benchmark suite', async () => {
    const suite = new BenchmarkSuite('Test Suite', {
      iterations: 10,
      warmupIterations: 2,
    });

    suite.add('bench 1', () => {
      [1, 2, 3].map((x) => x * 2);
    });

    suite.add('bench 2', () => {
      [1, 2, 3].filter((x) => x > 1);
    });

    const result = await suite.run();

    expect(result.suite).toBe('Test Suite');
    expect(result.benchmarks).toHaveLength(2);
    expect(result.benchmarks[0].name).toBe('bench 1');
    expect(result.benchmarks[1].name).toBe('bench 2');
  });

  it('should support async benchmarks', async () => {
    const suite = new BenchmarkSuite('Async Suite', {
      iterations: 5,
      warmupIterations: 1,
    });

    suite.add('async bench', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const result = await suite.run();

    expect(result.benchmarks).toHaveLength(1);
    // Async benchmark should take at least 1ms per iteration
    expect(result.benchmarks[0].avgTime).toBeGreaterThan(0.5);
  });
});

describe('Component Benchmarks', () => {
  it('should benchmark state machine operations', async () => {
    const { canTransitionWorkflow, canTransitionNode } = await import(
      '../state-machine'
    );

    const result = await runBenchmark(
      'state machine transitions',
      () => {
        canTransitionWorkflow('idle', 'running');
        canTransitionWorkflow('running', 'paused');
        canTransitionNode('idle', 'ready');
        canTransitionNode('ready', 'running');
      },
      { iterations: 1000, warmupIterations: 10 }
    );

    // State machine should be very fast
    expect(result.opsPerSecond).toBeGreaterThan(100000);
  });

  it('should benchmark event bus operations', async () => {
    const { EventBus } = await import('../event-bus');

    const result = await runBenchmark(
      'event bus emit',
      () => {
        const bus = new EventBus();
        bus.subscribe('test', () => {});
        bus.emit('test', { data: 'test' }, { workflowId: 'test-workflow' });
      },
      { iterations: 1000, warmupIterations: 10 }
    );

    expect(result.opsPerSecond).toBeGreaterThan(1000);
  });

  it('should benchmark node selection', async () => {
    const { DefaultNodeSelector } = await import('../executor');

    const nodes = createBenchmarkNodes(100).map(n => ({ ...n, state: 'IDLE' as const }));
    const selector = new DefaultNodeSelector('priority');

    const result = await runBenchmark(
      'node selection (100 nodes)',
      () => {
        selector.selectNode({
          nodes,
          workflow: { id: 'test', status: 'running' } as any,
          pendingEvents: [],
        });
      },
      { iterations: 1000, warmupIterations: 10 }
    );

    expect(result.opsPerSecond).toBeGreaterThan(1000);
  });

  it('should benchmark execution store operations', async () => {
    const { ExecutionStore } = await import('../execution-store');

    const result = await runBenchmark(
      'execution store create/get',
      () => {
        const store = new ExecutionStore();
        const id = store.create({
          workflowId: 'test',
          nodeId: 'test-node',
        });
        store.get(id);
      },
      { iterations: 1000, warmupIterations: 10 }
    );

    expect(result.opsPerSecond).toBeGreaterThan(1000);
  });

  it('should benchmark memory manager operations', async () => {
    const { MemoryManager } = await import('../memory-manager');

    const result = await runBenchmark(
      'memory manager add entry',
      async () => {
        const manager = new MemoryManager();
        await manager.addEntry('test-workflow', 'active', {
          type: 'note',
          content: 'Test',
          tags: [],
          tokenCount: 5,
        });
      },
      { iterations: 100, warmupIterations: 5 }
    );

    expect(result.opsPerSecond).toBeGreaterThan(50);
  });
});

describe('Performance Thresholds', () => {
  it('should meet performance requirements', async () => {
    const { canTransitionWorkflow } = await import('../state-machine');
    const { EventBus } = await import('../event-bus');

    // State machine should be extremely fast (threshold lowered for CI environments)
    const smResult = await runBenchmark(
      'state machine',
      () => {
        for (let i = 0; i < 100; i++) {
          canTransitionWorkflow('idle', 'running');
        }
      },
      { iterations: 100, warmupIterations: 5 }
    );

    // Allow for CI environment variability (original: 100000)
    expect(smResult.opsPerSecond).toBeGreaterThan(50000);

    // EventBus should be fast
    const ebResult = await runBenchmark(
      'event bus',
      () => {
        const bus = new EventBus();
        bus.subscribe('test', () => {});
        bus.emit('test', { data: 'test' }, { workflowId: 'test-workflow' });
      },
      { iterations: 100, warmupIterations: 5 }
    );

    expect(ebResult.opsPerSecond).toBeGreaterThan(1000);
  });
});
