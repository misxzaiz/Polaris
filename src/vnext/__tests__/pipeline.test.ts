/**
 * Scheduler vNext - Pipeline Orchestrator Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineOrchestrator } from '../pipeline';
import { resetEventBus } from '../event-bus';
import { resetNodeEventController } from '../event-controller';
import type { Workflow, WorkflowNode } from '../types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestWorkflow(): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    state: 'IDLE',
    priority: 50,
    triggerType: 'manual',
    nodes: [],
    maxRounds: 10,
    currentRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createTestNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
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
    currentRound: 0,
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

describe('PipelineOrchestrator', () => {
  let orchestrator: PipelineOrchestrator;
  let workflow: Workflow;

  beforeEach(() => {
    resetEventBus();
    resetNodeEventController();
    orchestrator = new PipelineOrchestrator({ enableLog: false });
    workflow = createTestWorkflow();
  });

  afterEach(() => {
    orchestrator.reset();
  });

  // ==========================================================================
  // 初始化
  // ==========================================================================

  describe('initialize', () => {
    it('should initialize pipeline with nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2' }),
      ];

      orchestrator.initialize(workflow, nodes);

      const progress = orchestrator.getProgress();
      expect(progress.total).toBe(2);
      expect(progress.pending).toBe(2);
    });

    it('should set state to IDLE after initialization', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);

      expect(orchestrator.state).toBe('IDLE');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      orchestrator.reset();

      expect(orchestrator.state).toBe('IDLE');
      expect(orchestrator.getProgress().total).toBe(0);
    });
  });

  // ==========================================================================
  // 推进控制
  // ==========================================================================

  describe('start', () => {
    it('should start pipeline and advance', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);

      const result = orchestrator.start();

      expect(result.success).toBe(true);
      expect(orchestrator.state).toBe('RUNNING');
    });

    it('should not start if already running', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      const result = orchestrator.start();

      expect(result.success).toBe(false);
    });
  });

  describe('advance', () => {
    it('should advance to next executable node', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
      ];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      // 节点应该在 running 状态
      const runningNodes = orchestrator.getNodesByStatus('running');
      expect(runningNodes.length).toBe(1);
    });

    it('should respect dependency order', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      // 只有 node-1 应该在 running
      const runningNodes = orchestrator.getNodesByStatus('running');
      expect(runningNodes).toContain('node-1');
      expect(runningNodes).not.toContain('node-2');
    });

    it('should mark pipeline as completed when all nodes done', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      // 完成节点
      orchestrator.completeNode('node-1', true);

      // 由于只有一个节点，应该继续推进直到完成
      expect(orchestrator.state).toBe('COMPLETED');
    });
  });

  describe('completeNode', () => {
    it('should mark node as completed', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      const result = orchestrator.completeNode('node-1', true);

      expect(result.success).toBe(true);
      const nodeState = orchestrator.getNodeState('node-1');
      expect(nodeState?.status).toBe('completed');
    });

    it('should mark node as failed on failure', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      orchestrator.completeNode('node-1', false, 'Test error');

      const nodeState = orchestrator.getNodeState('node-1');
      expect(nodeState?.status).toBe('failed');
      expect(nodeState?.error).toBe('Test error');
    });

    it('should trigger callback on complete', () => {
      const onNodeComplete = vi.fn();
      const orchestratorWithCallback = new PipelineOrchestrator({ onNodeComplete });

      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestratorWithCallback.initialize(workflow, nodes);
      orchestratorWithCallback.start();
      orchestratorWithCallback.completeNode('node-1', true);

      expect(onNodeComplete).toHaveBeenCalled();
      expect(onNodeComplete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'node-1' }),
        true
      );

      orchestratorWithCallback.reset();
    });
  });

  describe('pause/resume', () => {
    it('should pause pipeline', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      orchestrator.pause();

      expect(orchestrator.state).toBe('PAUSED');
    });

    it('should resume paused pipeline', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();
      orchestrator.pause();

      const result = orchestrator.resume();

      expect(result.success).toBe(true);
      expect(orchestrator.state).toBe('RUNNING');
    });

    it('should not resume if not paused', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);

      const result = orchestrator.resume();

      expect(result.success).toBe(false);
    });
  });

  describe('stop', () => {
    it('should stop pipeline', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      orchestrator.stop();

      expect(orchestrator.state).toBe('IDLE');
    });
  });

  // ==========================================================================
  // 节点选择
  // ==========================================================================

  describe('getNextExecutableNode', () => {
    it('should return first node with no dependencies', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);

      // 在 start 之前调用，节点应该处于 pending 状态
      const next = orchestrator.getNextExecutableNode();

      expect(next?.id).toBe('node-1');
    });

    it('should skip disabled nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1', enabled: false }),
        createTestNode({ id: 'node-2', triggerType: 'start' }),
      ];
      orchestrator.initialize(workflow, nodes);

      const next = orchestrator.getNextExecutableNode();
      expect(next?.id).toBe('node-2');
    });
  });

  describe('getExecutableNodes', () => {
    it('should return all nodes with met dependencies', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', triggerType: 'start' }),
        createTestNode({ id: 'node-3', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);

      const executable = orchestrator.getExecutableNodes();

      expect(executable.length).toBe(2);
      expect(executable.map(n => n.id)).toContain('node-1');
      expect(executable.map(n => n.id)).toContain('node-2');
    });
  });

  // ==========================================================================
  // 依赖检查
  // ==========================================================================

  describe('checkDependenciesMet', () => {
    it('should return true for node with no dependencies', () => {
      const node = createTestNode({ dependencies: [] });
      orchestrator.initialize(workflow, [node]);

      expect(orchestrator.checkDependenciesMet(node)).toBe(true);
    });

    it('should return false when dependencies not completed', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);

      const node2 = nodes.find(n => n.id === 'node-2')!;
      expect(orchestrator.checkDependenciesMet(node2)).toBe(false);
    });

    it('should return true when all dependencies completed', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();
      orchestrator.completeNode('node-1', true);

      const node2 = nodes.find(n => n.id === 'node-2')!;
      expect(orchestrator.checkDependenciesMet(node2)).toBe(true);
    });
  });

  describe('getBlockedNodes', () => {
    it('should return nodes waiting for dependencies', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();

      const blocked = orchestrator.getBlockedNodes();

      expect(blocked.length).toBe(1);
      expect(blocked[0].nodeId).toBe('node-2');
    });
  });

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  describe('getProgress', () => {
    it('should return correct progress', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2' }),
      ];
      orchestrator.initialize(workflow, nodes);

      const progress = orchestrator.getProgress();

      expect(progress.total).toBe(2);
      expect(progress.pending).toBe(2);
      expect(progress.completed).toBe(0);
    });

    it('should reflect completed nodes', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();
      orchestrator.completeNode('node-1', true);

      const progress = orchestrator.getProgress();

      expect(progress.completed).toBe(1);
      expect(progress.pending).toBe(0);
    });
  });

  describe('getNodesByStatus', () => {
    it('should return nodes by status', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2' }),
      ];
      orchestrator.initialize(workflow, nodes);

      const pending = orchestrator.getNodesByStatus('pending');

      expect(pending.length).toBe(2);
    });
  });

  describe('checkAllCompleted', () => {
    it('should return false when nodes pending', () => {
      const nodes = [createTestNode()];
      orchestrator.initialize(workflow, nodes);

      expect(orchestrator.checkAllCompleted()).toBe(false);
    });

    it('should return true when all completed', () => {
      const nodes = [createTestNode({ id: 'node-1', triggerType: 'start' })];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();
      orchestrator.completeNode('node-1', true);

      expect(orchestrator.checkAllCompleted()).toBe(true);
    });
  });

  // ==========================================================================
  // 跳过节点
  // ==========================================================================

  describe('skipNode', () => {
    it('should skip node', () => {
      const nodes = [createTestNode({ id: 'node-1' })];
      orchestrator.initialize(workflow, nodes);

      orchestrator.skipNode('node-1', 'Test skip');

      const nodeState = orchestrator.getNodeState('node-1');
      expect(nodeState?.status).toBe('skipped');
    });
  });

  // ==========================================================================
  // 并行限制
  // ==========================================================================

  describe('maxParallel', () => {
    it('should respect max parallel limit', () => {
      const orchestratorLimited = new PipelineOrchestrator({
        maxParallel: 1,
        enableLog: false,
      });

      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', triggerType: 'start' }),
      ];

      orchestratorLimited.initialize(workflow, nodes);
      orchestratorLimited.start();

      const running = orchestratorLimited.getNodesByStatus('running');
      expect(running.length).toBe(1);

      orchestratorLimited.reset();
    });

    it('should allow multiple parallel with higher limit', () => {
      const orchestratorMulti = new PipelineOrchestrator({
        maxParallel: 3,
        enableLog: false,
      });

      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', triggerType: 'start' }),
        createTestNode({ id: 'node-3', triggerType: 'start' }),
      ];

      orchestratorMulti.initialize(workflow, nodes);
      orchestratorMulti.start();

      // 继续推进直到达到限制
      orchestratorMulti.advance();
      orchestratorMulti.advance();

      const running = orchestratorMulti.getNodesByStatus('running');
      expect(running.length).toBe(3);

      orchestratorMulti.reset();
    });
  });

  // ==========================================================================
  // 下游节点更新
  // ==========================================================================

  describe('updateDownstreamNodes', () => {
    it('should mark downstream nodes as skipped on failure', () => {
      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];
      orchestrator.initialize(workflow, nodes);
      orchestrator.start();
      orchestrator.completeNode('node-1', false, 'Failed');

      const node2State = orchestrator.getNodeState('node-2');
      expect(node2State?.status).toBe('skipped');
    });
  });

  // ==========================================================================
  // 自动推进
  // ==========================================================================

  describe('autoAdvance', () => {
    it('should auto advance when enabled', () => {
      const orchestratorAuto = new PipelineOrchestrator({
        autoAdvance: true,
        enableLog: false,
      });

      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];

      orchestratorAuto.initialize(workflow, nodes);
      orchestratorAuto.start();

      // 完成 node-1 后应该自动推进到 node-2
      orchestratorAuto.completeNode('node-1', true);

      const running = orchestratorAuto.getNodesByStatus('running');
      expect(running).toContain('node-2');

      orchestratorAuto.reset();
    });

    it('should not auto advance when disabled', () => {
      const orchestratorManual = new PipelineOrchestrator({
        autoAdvance: false,
        enableLog: false,
      });

      const nodes = [
        createTestNode({ id: 'node-1', triggerType: 'start' }),
        createTestNode({ id: 'node-2', dependencies: ['node-1'] }),
      ];

      orchestratorManual.initialize(workflow, nodes);
      orchestratorManual.start();

      // 完成 node-1 后不应该自动推进
      orchestratorManual.completeNode('node-1', true);

      const running = orchestratorManual.getNodesByStatus('running');
      expect(running.length).toBe(0);

      orchestratorManual.reset();
    });
  });
});
