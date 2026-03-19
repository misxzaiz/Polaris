/**
 * Scheduler vNext - State Machine Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowStateMachine,
  NodeStateMachine,
  canTransitionWorkflow,
  canTransitionNode,
  canNodeBeReady,
  getReadyNodes,
  isWorkflowActive,
  isNodeActive,
  getWorkflowProgress,
} from '../index';
import type { Workflow, WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// Test Fixtures
// ============================================================================

const createMockWorkflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'wf_001',
  name: 'Test Workflow',
  templateId: 'tpl_001',
  status: 'CREATED',
  mode: 'continuous',
  priority: 50,
  continuousMode: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  currentRounds: 0,
  ...overrides,
});

const createMockNode = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: 'node_001',
  workflowId: 'wf_001',
  name: 'Test Node',
  role: 'developer',
  agentProfileId: 'profile_dev',
  state: 'IDLE',
  triggerType: 'start',
  subscribeEvents: [],
  emitEvents: [],
  nextNodes: [],
  dependencies: [],
  maxRounds: 10,
  currentRounds: 0,
  order: 1,
  enabled: true,
  ...overrides,
});

const createMockEvent = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'evt_001',
  type: 'node:complete',
  payload: {},
  workflowId: 'wf_001',
  createdAt: Date.now(),
  consumed: false,
  ...overrides,
});

// ============================================================================
// Workflow State Machine Tests
// ============================================================================

describe('WorkflowStateMachine', () => {
  let machine: WorkflowStateMachine;

  beforeEach(() => {
    machine = new WorkflowStateMachine(createMockWorkflow());
  });

  describe('状态转换', () => {
    it('should allow CREATED -> RUNNING', () => {
      expect(canTransitionWorkflow('CREATED', 'RUNNING')).toBe(true);
    });

    it('should allow RUNNING -> COMPLETED', () => {
      expect(canTransitionWorkflow('RUNNING', 'COMPLETED')).toBe(true);
    });

    it('should allow RUNNING -> WAITING_EVENT', () => {
      expect(canTransitionWorkflow('RUNNING', 'WAITING_EVENT')).toBe(true);
    });

    it('should not allow CREATED -> COMPLETED directly', () => {
      expect(canTransitionWorkflow('CREATED', 'COMPLETED')).toBe(false);
    });

    it('should not allow COMPLETED -> RUNNING directly', () => {
      expect(canTransitionWorkflow('COMPLETED', 'RUNNING')).toBe(false);
    });

    it('should allow FAILED -> RUNNING (retry)', () => {
      expect(canTransitionWorkflow('FAILED', 'RUNNING')).toBe(true);
    });

    it('should allow COMPLETED -> EVOLVING', () => {
      expect(canTransitionWorkflow('COMPLETED', 'EVOLVING')).toBe(true);
    });
  });

  describe('start()', () => {
    it('should start from CREATED', () => {
      expect(machine.start()).toBe(true);
      expect(machine.getWorkflow().status).toBe('RUNNING');
    });

    it('should start from FAILED', () => {
      machine = new WorkflowStateMachine(createMockWorkflow({ status: 'FAILED' }));
      expect(machine.start()).toBe(true);
      expect(machine.getWorkflow().status).toBe('RUNNING');
    });

    it('should not start from RUNNING', () => {
      machine = new WorkflowStateMachine(createMockWorkflow({ status: 'RUNNING' }));
      expect(machine.start()).toBe(false);
    });
  });

  describe('pause() / resume()', () => {
    it('should pause from RUNNING', () => {
      machine.start();
      expect(machine.pause()).toBe(true);
      expect(machine.getWorkflow().status).toBe('WAITING_EVENT');
    });

    it('should resume from WAITING_EVENT', () => {
      machine.start();
      machine.pause();
      expect(machine.resume()).toBe(true);
      expect(machine.getWorkflow().status).toBe('RUNNING');
    });
  });

  describe('complete() / fail()', () => {
    it('should complete from RUNNING', () => {
      machine.start();
      expect(machine.complete()).toBe(true);
      expect(machine.getWorkflow().status).toBe('COMPLETED');
    });

    it('should fail from RUNNING', () => {
      machine.start();
      expect(machine.fail()).toBe(true);
      expect(machine.getWorkflow().status).toBe('FAILED');
    });
  });

  describe('reset()', () => {
    it('should reset workflow', () => {
      machine.start();
      machine.getWorkflow().currentRounds = 5;
      machine.reset();
      expect(machine.getWorkflow().status).toBe('CREATED');
      expect(machine.getWorkflow().currentRounds).toBe(0);
    });
  });
});

// ============================================================================
// Node State Machine Tests
// ============================================================================

describe('NodeStateMachine', () => {
  let machine: NodeStateMachine;

  beforeEach(() => {
    machine = new NodeStateMachine(createMockNode());
  });

  describe('状态转换', () => {
    it('should allow IDLE -> READY', () => {
      expect(canTransitionNode('IDLE', 'READY')).toBe(true);
    });

    it('should allow READY -> RUNNING', () => {
      expect(canTransitionNode('READY', 'RUNNING')).toBe(true);
    });

    it('should allow RUNNING -> DONE', () => {
      expect(canTransitionNode('RUNNING', 'DONE')).toBe(true);
    });

    it('should allow RUNNING -> FAILED', () => {
      expect(canTransitionNode('RUNNING', 'FAILED')).toBe(true);
    });

    it('should allow DONE -> IDLE (continuous mode)', () => {
      expect(canTransitionNode('DONE', 'IDLE')).toBe(true);
    });

    it('should not allow IDLE -> DONE directly', () => {
      expect(canTransitionNode('IDLE', 'DONE')).toBe(false);
    });
  });

  describe('activate()', () => {
    it('should activate from IDLE', () => {
      expect(machine.activate()).toBe(true);
      expect(machine.getNode().state).toBe('READY');
    });

    it('should activate from DONE (for continuous mode)', () => {
      machine = new NodeStateMachine(createMockNode({ state: 'DONE' }));
      expect(machine.activate()).toBe(true);
      expect(machine.getNode().state).toBe('READY');
    });
  });

  describe('start()', () => {
    it('should start from READY', () => {
      machine.activate();
      expect(machine.start()).toBe(true);
      expect(machine.getNode().state).toBe('RUNNING');
    });

    it('should start from IDLE', () => {
      expect(machine.start()).toBe(true);
      expect(machine.getNode().state).toBe('RUNNING');
    });
  });

  describe('complete()', () => {
    it('should complete from RUNNING and increment rounds', () => {
      machine.start();
      expect(machine.complete()).toBe(true);
      expect(machine.getNode().state).toBe('DONE');
      expect(machine.getNode().currentRounds).toBe(1);
    });
  });

  describe('canExecute()', () => {
    it('should return true when READY and enabled', () => {
      machine.activate();
      expect(machine.canExecute()).toBe(true);
    });

    it('should return false when not READY', () => {
      expect(machine.canExecute()).toBe(false);
    });

    it('should return false when disabled', () => {
      machine = new NodeStateMachine(createMockNode({ enabled: false }));
      machine.activate();
      expect(machine.canExecute()).toBe(false);
    });
  });

  describe('isMaxRoundsReached()', () => {
    it('should return false when rounds < maxRounds', () => {
      machine.getNode().currentRounds = 5;
      machine.getNode().maxRounds = 10;
      expect(machine.isMaxRoundsReached()).toBe(false);
    });

    it('should return true when rounds >= maxRounds', () => {
      machine.getNode().currentRounds = 10;
      machine.getNode().maxRounds = 10;
      expect(machine.isMaxRoundsReached()).toBe(true);
    });
  });
});

// ============================================================================
// Node READY 判定逻辑 Tests
// ============================================================================

describe('canNodeBeReady', () => {
  it('should return true for start trigger when enabled and IDLE', () => {
    const node = createMockNode({ triggerType: 'start' });
    expect(canNodeBeReady(node, [], [])).toBe(true);
  });

  it('should return false when disabled', () => {
    const node = createMockNode({ triggerType: 'start', enabled: false });
    expect(canNodeBeReady(node, [], [])).toBe(false);
  });

  it('should return false when max rounds reached', () => {
    const node = createMockNode({
      triggerType: 'start',
      currentRounds: 10,
      maxRounds: 10,
    });
    expect(canNodeBeReady(node, [], [])).toBe(false);
  });

  it('should return true for dependency trigger when all deps are DONE', () => {
    const node = createMockNode({
      triggerType: 'dependency',
      dependencies: ['node_dep1', 'node_dep2'],
    });
    const allNodes = [
      node,
      createMockNode({ id: 'node_dep1', state: 'DONE' }),
      createMockNode({ id: 'node_dep2', state: 'DONE' }),
    ];
    expect(canNodeBeReady(node, allNodes, [])).toBe(true);
  });

  it('should return false for dependency trigger when dep not DONE', () => {
    const node = createMockNode({
      triggerType: 'dependency',
      dependencies: ['node_dep1'],
    });
    const allNodes = [
      node,
      createMockNode({ id: 'node_dep1', state: 'RUNNING' }),
    ];
    expect(canNodeBeReady(node, allNodes, [])).toBe(false);
  });

  it('should return true for event trigger when event exists', () => {
    const node = createMockNode({
      triggerType: 'event',
      subscribeEvents: ['code:ready'],
    });
    const events = [createMockEvent({ type: 'code:ready' })];
    expect(canNodeBeReady(node, [], events)).toBe(true);
  });

  it('should return false for event trigger when no matching event', () => {
    const node = createMockNode({
      triggerType: 'event',
      subscribeEvents: ['code:ready'],
    });
    const events = [createMockEvent({ type: 'other:event' })];
    expect(canNodeBeReady(node, [], events)).toBe(false);
  });

  it('should return false for event trigger when event consumed', () => {
    const node = createMockNode({
      triggerType: 'event',
      subscribeEvents: ['code:ready'],
    });
    const events = [createMockEvent({ type: 'code:ready', consumed: true })];
    expect(canNodeBeReady(node, [], events)).toBe(false);
  });
});

describe('getReadyNodes', () => {
  it('should return all ready nodes', () => {
    const nodes = [
      createMockNode({ id: 'node1', triggerType: 'start' }),
      createMockNode({ id: 'node2', triggerType: 'start' }),
      createMockNode({ id: 'node3', triggerType: 'start', enabled: false }),
    ];
    const readyNodes = getReadyNodes(nodes, []);
    expect(readyNodes).toHaveLength(2);
    expect(readyNodes.map(n => n.id)).toContain('node1');
    expect(readyNodes.map(n => n.id)).toContain('node2');
  });
});

// ============================================================================
// 状态查询工具 Tests
// ============================================================================

describe('isWorkflowActive', () => {
  it('should return true for RUNNING status', () => {
    expect(isWorkflowActive(createMockWorkflow({ status: 'RUNNING' }))).toBe(true);
  });

  it('should return true for WAITING_EVENT status', () => {
    expect(isWorkflowActive(createMockWorkflow({ status: 'WAITING_EVENT' }))).toBe(true);
  });

  it('should return false for CREATED status', () => {
    expect(isWorkflowActive(createMockWorkflow({ status: 'CREATED' }))).toBe(false);
  });

  it('should return false for COMPLETED status', () => {
    expect(isWorkflowActive(createMockWorkflow({ status: 'COMPLETED' }))).toBe(false);
  });
});

describe('isNodeActive', () => {
  it('should return true for RUNNING state', () => {
    expect(isNodeActive(createMockNode({ state: 'RUNNING' }))).toBe(true);
  });

  it('should return true for READY state', () => {
    expect(isNodeActive(createMockNode({ state: 'READY' }))).toBe(true);
  });

  it('should return false for IDLE state', () => {
    expect(isNodeActive(createMockNode({ state: 'IDLE' }))).toBe(false);
  });

  it('should return false for DONE state', () => {
    expect(isNodeActive(createMockNode({ state: 'DONE' }))).toBe(false);
  });
});

describe('getWorkflowProgress', () => {
  it('should calculate progress correctly', () => {
    const workflow = createMockWorkflow();
    const nodes = [
      createMockNode({ id: 'node1', state: 'DONE' }),
      createMockNode({ id: 'node2', state: 'DONE' }),
      createMockNode({ id: 'node3', state: 'RUNNING' }),
      createMockNode({ id: 'node4', state: 'IDLE' }),
    ];

    const progress = getWorkflowProgress(workflow, nodes);
    expect(progress.totalNodes).toBe(4);
    expect(progress.completedNodes).toBe(2);
    expect(progress.runningNodes).toBe(1);
    expect(progress.progress).toBe(50);
  });

  it('should handle empty nodes', () => {
    const workflow = createMockWorkflow();
    const progress = getWorkflowProgress(workflow, []);
    expect(progress.totalNodes).toBe(0);
    expect(progress.progress).toBe(0);
  });
});
