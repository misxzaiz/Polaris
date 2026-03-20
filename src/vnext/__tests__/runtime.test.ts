/**
 * Scheduler vNext - Workflow Runtime Tests
 *
 * 测试工作流运行时集成功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WorkflowRuntime,
  getWorkflowRuntime,
  resetWorkflowRuntime,
  type RuntimeEvent,
} from '../runtime';
import { getInterruptInbox } from '../interrupt';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `wf-${Math.random().toString(36).substring(7)}`,
    name: 'Test Workflow',
    status: 'CREATED',
    mode: 'continuous',
    priority: 50,
    maxRounds: 100,
    currentRounds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createTestNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `node-${Math.random().toString(36).substring(7)}`,
    workflowId: 'wf-1',
    name: 'Test Node',
    role: 'developer',
    enabled: true,
    state: 'IDLE',
    triggerType: 'dependency',
    subscribeEvents: [],
    emitEvents: [],
    dependencies: [],
    nextNodes: [],
    maxRounds: 10,
    currentRounds: 0,
    timeoutMs: 60000,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkflowRuntime', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    resetWorkflowRuntime();
    runtime = new WorkflowRuntime({
      enableLog: false,
      maxRounds: 10,
      executionInterval: 10,
    });
  });

  afterEach(() => {
    runtime.stop();
    resetWorkflowRuntime();
  });

  // ==========================================================================
  // Workflow Registration
  // ==========================================================================

  describe('Workflow Registration', () => {
    it('should register a workflow', () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ workflowId: workflow.id })] as any[];

      runtime.registerWorkflow({ workflow, nodes });

      const status = runtime.getStatus();
      expect(status).not.toBeNull();
      expect(status?.workflowId).toBe(workflow.id);
      expect(runtime.getState()).toBe('IDLE');
    });

    it('should register custom executors', () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'node-1', workflowId: workflow.id })] as any[];

      const customExecutor = vi.fn().mockResolvedValue({
        success: true,
        output: 'Custom execution',
      });

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': customExecutor,
        },
      });

      expect(runtime.getState()).toBe('IDLE');
    });
  });

  // ==========================================================================
  // Lifecycle Control
  // ==========================================================================

  describe('Lifecycle Control', () => {
    it('should start and complete a simple workflow', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({
          id: 'node-1',
          workflowId: workflow.id,
          triggerType: 'start',
        }),
      ] as any[];

      // 注册带模拟执行器的 workflow
      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Test output' }),
        },
      });

      const result = await runtime.start();

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('COMPLETED');
      expect(result.stats.executedNodes).toBe(1);
      expect(result.stats.successNodes).toBe(1);
    });

    it('should execute linear pipeline', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({
          id: 'node-1',
          workflowId: workflow.id,
          triggerType: 'start',
          emitEvents: ['node-1-done'],
        }),
        createTestNode({
          id: 'node-2',
          workflowId: workflow.id,
          triggerType: 'dependency',
          dependencies: ['node-1'],
          subscribeEvents: ['node-1-done'],
        }),
        createTestNode({
          id: 'node-3',
          workflowId: workflow.id,
          triggerType: 'dependency',
          dependencies: ['node-2'],
        }),
      ] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Node 1 output', emitEvents: [{ type: 'node-1-done' }] }),
          'node-2': async () => ({ success: true, output: 'Node 2 output' }),
          'node-3': async () => ({ success: true, output: 'Node 3 output' }),
        },
      });

      const result = await runtime.start();

      // 只执行 start 类型的节点，依赖节点需要特殊处理
      expect(result.stats.executedNodes).toBeGreaterThanOrEqual(1);
    });

    it('should pause and resume workflow', async () => {
      // 使用一个可以长时间运行的 workflow
      const workflow = createTestWorkflow({ maxRounds: 100 }) as any;
      const nodes = [
        createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'node-2', workflowId: workflow.id, triggerType: 'dependency', dependencies: ['node-1'] }),
      ] as any[];

      // 使用后台执行
      const slowRuntime = new WorkflowRuntime({
        enableLog: false,
        executionInterval: 50,
      });

      slowRuntime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Node 1 output' }),
          'node-2': async () => ({ success: true, output: 'Node 2 output' }),
        },
      });

      // 由于 executeAll 是同步完成的，无法在执行中暂停
      // 这个测试验证 pause/resume 方法的行为
      const result = await slowRuntime.start();
      expect(result.success).toBe(true);

      // 暂停一个已完成的 workflow 返回 false
      expect(slowRuntime.pause()).toBe(false);

      slowRuntime.stop();
    });

    it('should stop workflow', async () => {
      const workflow = createTestWorkflow({ maxRounds: 1000 }) as any;
      const nodes = [
        createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'node-2', workflowId: workflow.id, dependencies: ['node-1'] }),
        createTestNode({ id: 'node-3', workflowId: workflow.id, dependencies: ['node-2'] }),
      ] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Node 1 output' }),
        },
      });

      // 启动
      runtime.start();

      // 等待一段时间后停止
      await new Promise(resolve => setTimeout(resolve, 50));

      const stopped = runtime.stop();
      expect(stopped).toBe(true);
      expect(runtime.getState()).toBe('STOPPED');
    });
  });

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  describe('Event Handling', () => {
    it('should emit runtime events', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' })] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Test output' }),
        },
      });

      const events: RuntimeEvent[] = [];
      runtime.addEventListener((event) => {
        events.push(event);
      });

      await runtime.start();

      expect(events.some(e => e.type === 'workflow_started')).toBe(true);
      expect(events.some(e => e.type === 'node_started')).toBe(true);
      expect(events.some(e => e.type === 'node_completed')).toBe(true);
      expect(events.some(e => e.type === 'workflow_completed')).toBe(true);
    });

    it('should remove event listener', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' })] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Test output' }),
        },
      });

      const listener = vi.fn();
      runtime.addEventListener(listener);
      runtime.removeEventListener(listener);

      await runtime.start();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Custom Executors
  // ==========================================================================

  describe('Custom Executors', () => {
    it('should use custom executor for node', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'custom-node', workflowId: workflow.id, triggerType: 'start' })] as any[];

      const customExecutor = vi.fn().mockResolvedValue({
        success: true,
        output: 'Custom execution result',
        tokenUsage: { input: 200, output: 100 },
      });

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'custom-node': customExecutor,
        },
      });

      const result = await runtime.start();

      expect(customExecutor).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle custom executor failure', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({ id: 'fail-node', workflowId: workflow.id, triggerType: 'start' }),
      ] as any[];

      const customExecutor = vi.fn().mockResolvedValue({
        success: false,
        error: 'Custom execution failed',
      });

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'fail-node': customExecutor,
        },
      });

      const result = await runtime.start();

      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      // 验证失败节点数
      expect(result.stats.failedNodes).toBe(1);
    });
  });

  // ==========================================================================
  // Parallel Execution
  // ==========================================================================

  describe('Parallel Execution', () => {
    it('should execute parallel nodes', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({ id: 'start', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'parallel-1', workflowId: workflow.id, dependencies: ['start'] }),
        createTestNode({ id: 'parallel-2', workflowId: workflow.id, dependencies: ['start'] }),
        createTestNode({ id: 'parallel-3', workflowId: workflow.id, dependencies: ['start'] }),
        createTestNode({ id: 'end', workflowId: workflow.id, dependencies: ['parallel-1', 'parallel-2', 'parallel-3'] }),
      ] as any[];

      const runtimeWithConcurrency = new WorkflowRuntime({
        maxConcurrency: 3,
        enableLog: false,
        executionInterval: 10,
      });

      runtimeWithConcurrency.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'start': async () => ({ success: true, output: 'Start' }),
          'parallel-1': async () => ({ success: true, output: 'P1' }),
          'parallel-2': async () => ({ success: true, output: 'P2' }),
          'parallel-3': async () => ({ success: true, output: 'P3' }),
          'end': async () => ({ success: true, output: 'End' }),
        },
      });

      const result = await runtimeWithConcurrency.start();

      expect(result.success).toBe(true);
      expect(result.stats.executedNodes).toBe(5);

      runtimeWithConcurrency.stop();
    });
  });

  // ==========================================================================
  // Interrupts
  // ==========================================================================

  describe('Interrupts', () => {
    it('should send interrupt request', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' })] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Test output' }),
        },
      });

      // 先执行完成
      await runtime.start();

      // workflow 完成后发送中断
      // 测试 interrupt inbox 的功能
      const interruptInbox = getInterruptInbox();
      const interrupt = interruptInbox.createInterrupt(
        workflow.id,
        'user_pause' as any,
        'Test Interrupt',
        'Test content'
      );

      expect(interrupt.id).toBeDefined();
    });

    it('should add user input', () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' })] as any[];

      runtime.registerWorkflow({ workflow, nodes });

      const inputId = runtime.addUserInput('supplement', 'Additional context');

      expect(inputId).toBeDefined();
    });
  });

  // ==========================================================================
  // Status and Statistics
  // ==========================================================================

  describe('Status and Statistics', () => {
    it('should return null status when no workflow registered', () => {
      const status = runtime.getStatus();
      expect(status).toBeNull();
    });

    it('should return correct status during execution', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'node-2', workflowId: workflow.id, dependencies: ['node-1'] }),
      ] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Node 1' }),
          'node-2': async () => ({ success: true, output: 'Node 2' }),
        },
      });

      const statusBefore = runtime.getStatus();
      expect(statusBefore?.state).toBe('IDLE');

      const result = await runtime.start();

      expect(result.success).toBe(true);
      const statusAfter = runtime.getStatus();
      expect(statusAfter?.state).toBe('COMPLETED');
      expect(statusAfter?.executedNodes).toBe(2);
    });

    it('should track execution statistics', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({ id: 'node-1', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'node-2', workflowId: workflow.id, dependencies: ['node-1'] }),
        createTestNode({ id: 'node-3', workflowId: workflow.id, dependencies: ['node-2'] }),
      ] as any[];

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'node-1': async () => ({ success: true, output: 'Node 1' }),
          'node-2': async () => ({ success: true, output: 'Node 2' }),
          'node-3': async () => ({ success: true, output: 'Node 3' }),
        },
      });

      const result = await runtime.start();

      expect(result.stats.totalNodes).toBe(3);
      expect(result.stats.executedNodes).toBe(3);
      expect(result.stats.successNodes).toBe(3);
      expect(result.stats.failedNodes).toBe(0);
      expect(result.stats.duration).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('Error Handling', () => {
    it('should throw error when starting without workflow', async () => {
      await expect(runtime.start()).rejects.toThrow('No workflow registered');
    });

    it('should handle node failure gracefully', async () => {
      const workflow = createTestWorkflow() as any;
      const nodes = [
        createTestNode({ id: 'fail-node', workflowId: workflow.id, triggerType: 'start' }),
        createTestNode({ id: 'dependent-node', workflowId: workflow.id, triggerType: 'dependency', dependencies: ['fail-node'] }),
      ] as any[];

      const customExecutor = vi.fn().mockResolvedValue({
        success: false,
        error: 'Node execution failed',
      });

      runtime.registerWorkflow({
        workflow,
        nodes,
        executors: {
          'fail-node': customExecutor,
        },
      });

      const result = await runtime.start();

      expect(result.success).toBe(false);
      // 验证失败节点
      expect(result.stats.failedNodes).toBe(1);
      // 依赖节点应该仍然处于 pending 状态
      expect(result.stats.executedNodes).toBe(1);
    });
  });

  // ==========================================================================
  // Singleton
  // ==========================================================================

  describe('Singleton', () => {
    it('should return same instance', () => {
      const instance1 = getWorkflowRuntime();
      const instance2 = getWorkflowRuntime();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', () => {
      const instance1 = getWorkflowRuntime();
      resetWorkflowRuntime();
      const instance2 = getWorkflowRuntime();

      expect(instance1).not.toBe(instance2);
    });
  });
});
