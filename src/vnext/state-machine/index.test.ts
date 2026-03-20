/**
 * Scheduler vNext - State Machine Tests
 *
 * 测试 Workflow 和 Node 状态机逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  canTransitionWorkflow,
  getValidWorkflowTransitions,
  WorkflowStateMachine,
  canTransitionNode,
  getValidNodeTransitions,
  NodeStateMachine,
  canNodeBeReady,
  getReadyNodes,
  isWorkflowActive,
  canStartWorkflow,
  isNodeActive,
  isNodeExecutable,
  getWorkflowProgress,
} from './index';
import type { Workflow, WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// Test Fixtures
// ============================================================================

const createTestWorkflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'wf_test',
  name: 'Test Workflow',
  templateId: 'tpl_test',
  status: 'CREATED',
  mode: 'continuous',
  priority: 50,
  continuousMode: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  currentRounds: 0,
  ...overrides,
});

const createTestNode = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: 'node_test',
  workflowId: 'wf_test',
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
  order: 0,
  enabled: true,
  ...overrides,
});

const createTestEvent = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'evt_test',
  type: 'test:event',
  payload: {},
  workflowId: 'wf_test',
  createdAt: Date.now(),
  consumed: false,
  ...overrides,
});

// ============================================================================
// Workflow State Machine Tests
// ============================================================================

describe('Workflow State Machine', () => {
  describe('canTransitionWorkflow', () => {
    it('should allow valid transitions from CREATED', () => {
      expect(canTransitionWorkflow('CREATED', 'PLANNING')).toBe(true);
      expect(canTransitionWorkflow('CREATED', 'RUNNING')).toBe(true);
      expect(canTransitionWorkflow('CREATED', 'FAILED')).toBe(true);
      expect(canTransitionWorkflow('CREATED', 'COMPLETED')).toBe(false);
    });

    it('should allow valid transitions from RUNNING', () => {
      expect(canTransitionWorkflow('RUNNING', 'WAITING_EVENT')).toBe(true);
      expect(canTransitionWorkflow('RUNNING', 'BLOCKED')).toBe(true);
      expect(canTransitionWorkflow('RUNNING', 'FAILED')).toBe(true);
      expect(canTransitionWorkflow('RUNNING', 'COMPLETED')).toBe(true);
      expect(canTransitionWorkflow('RUNNING', 'EVOLVING')).toBe(true);
      expect(canTransitionWorkflow('RUNNING', 'CREATED')).toBe(true); // allowed for reset
    });

    it('should allow retry from FAILED', () => {
      expect(canTransitionWorkflow('FAILED', 'RUNNING')).toBe(true);
      expect(canTransitionWorkflow('FAILED', 'CREATED')).toBe(true);
      expect(canTransitionWorkflow('FAILED', 'COMPLETED')).toBe(false);
    });

    it('should allow restart from COMPLETED', () => {
      expect(canTransitionWorkflow('COMPLETED', 'EVOLVING')).toBe(true);
      expect(canTransitionWorkflow('COMPLETED', 'CREATED')).toBe(true);
      expect(canTransitionWorkflow('COMPLETED', 'RUNNING')).toBe(false);
    });
  });

  describe('getValidWorkflowTransitions', () => {
    it('should return all valid transitions for a status', () => {
      const transitions = getValidWorkflowTransitions('RUNNING');
      expect(transitions).toContain('WAITING_EVENT');
      expect(transitions).toContain('BLOCKED');
      expect(transitions).toContain('COMPACTING_MEMORY');
      expect(transitions).toContain('FAILED');
      expect(transitions).toContain('COMPLETED');
      expect(transitions).toContain('EVOLVING');
      expect(transitions).toContain('CREATED');
      expect(transitions).toContain('STOPPED');
      expect(transitions).toHaveLength(8);
    });

    it('should return empty array for unknown status', () => {
      const transitions = getValidWorkflowTransitions('UNKNOWN' as any);
      expect(transitions).toEqual([]);
    });
  });

  describe('WorkflowStateMachine', () => {
    let machine: WorkflowStateMachine;
    let workflow: Workflow;

    beforeEach(() => {
      workflow = createTestWorkflow();
      machine = new WorkflowStateMachine(workflow);
    });

    it('should start workflow from CREATED', () => {
      expect(machine.start()).toBe(true);
      expect(workflow.status).toBe('RUNNING');
    });

    it('should start workflow from PLANNING', () => {
      workflow.status = 'PLANNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.start()).toBe(true);
      expect(workflow.status).toBe('RUNNING');
    });

    it('should start workflow from FAILED', () => {
      workflow.status = 'FAILED';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.start()).toBe(true);
      expect(workflow.status).toBe('RUNNING');
    });

    it('should not start workflow from RUNNING', () => {
      workflow.status = 'RUNNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.start()).toBe(false);
    });

    it('should pause workflow to WAITING_EVENT', () => {
      workflow.status = 'RUNNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.pause()).toBe(true);
      expect(workflow.status).toBe('WAITING_EVENT');
    });

    it('should resume from WAITING_EVENT', () => {
      workflow.status = 'WAITING_EVENT';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.resume()).toBe(true);
      expect(workflow.status).toBe('RUNNING');
    });

    it('should resume from BLOCKED', () => {
      workflow.status = 'BLOCKED';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.resume()).toBe(true);
      expect(workflow.status).toBe('RUNNING');
    });

    it('should complete workflow', () => {
      workflow.status = 'RUNNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.complete()).toBe(true);
      expect(workflow.status).toBe('COMPLETED');
    });

    it('should fail workflow', () => {
      workflow.status = 'RUNNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.fail()).toBe(true);
      expect(workflow.status).toBe('FAILED');
    });

    it('should enter evolving mode', () => {
      workflow.status = 'RUNNING';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.evolve()).toBe(true);
      expect(workflow.status).toBe('EVOLVING');
    });

    it('should reset workflow', () => {
      workflow.status = 'COMPLETED';
      workflow.currentRounds = 10;
      workflow.currentNodeId = 'node_1';
      machine = new WorkflowStateMachine(workflow);
      expect(machine.reset()).toBe(true);
      expect(workflow.status).toBe('CREATED');
      expect(workflow.currentRounds).toBe(0);
      expect(workflow.currentNodeId).toBeUndefined();
    });

    it('should update updatedAt on transition', () => {
      const before = workflow.updatedAt;
      machine.start();
      expect(workflow.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });
});

// ============================================================================
// Node State Machine Tests
// ============================================================================

describe('Node State Machine', () => {
  describe('canTransitionNode', () => {
    it('should allow valid transitions from IDLE', () => {
      expect(canTransitionNode('IDLE', 'READY')).toBe(true);
      expect(canTransitionNode('IDLE', 'RUNNING')).toBe(true);
      expect(canTransitionNode('IDLE', 'DONE')).toBe(false);
    });

    it('should allow valid transitions from READY', () => {
      expect(canTransitionNode('READY', 'RUNNING')).toBe(true);
      expect(canTransitionNode('READY', 'IDLE')).toBe(true);
      expect(canTransitionNode('READY', 'DONE')).toBe(false);
    });

    it('should allow valid transitions from RUNNING', () => {
      expect(canTransitionNode('RUNNING', 'WAITING_INPUT')).toBe(true);
      expect(canTransitionNode('RUNNING', 'WAITING_EVENT')).toBe(true);
      expect(canTransitionNode('RUNNING', 'DONE')).toBe(true);
      expect(canTransitionNode('RUNNING', 'FAILED')).toBe(true);
      expect(canTransitionNode('RUNNING', 'IDLE')).toBe(false);
    });

    it('should allow reactivation from DONE (continuous mode)', () => {
      expect(canTransitionNode('DONE', 'IDLE')).toBe(true);
      expect(canTransitionNode('DONE', 'READY')).toBe(true);
      expect(canTransitionNode('DONE', 'RUNNING')).toBe(false);
    });

    it('should allow retry from FAILED', () => {
      expect(canTransitionNode('FAILED', 'IDLE')).toBe(true);
      expect(canTransitionNode('FAILED', 'READY')).toBe(true);
    });
  });

  describe('getValidNodeTransitions', () => {
    it('should return all valid transitions for a state', () => {
      const transitions = getValidNodeTransitions('RUNNING');
      expect(transitions).toContain('WAITING_INPUT');
      expect(transitions).toContain('WAITING_EVENT');
      expect(transitions).toContain('DONE');
      expect(transitions).toContain('FAILED');
      expect(transitions).toHaveLength(4);
    });
  });

  describe('NodeStateMachine', () => {
    let machine: NodeStateMachine;
    let node: WorkflowNode;

    beforeEach(() => {
      node = createTestNode();
      machine = new NodeStateMachine(node);
    });

    it('should activate node from IDLE', () => {
      expect(machine.activate()).toBe(true);
      expect(node.state).toBe('READY');
    });

    it('should activate node from DONE', () => {
      node.state = 'DONE';
      machine = new NodeStateMachine(node);
      expect(machine.activate()).toBe(true);
      expect(node.state).toBe('READY');
    });

    it('should activate node from FAILED', () => {
      node.state = 'FAILED';
      machine = new NodeStateMachine(node);
      expect(machine.activate()).toBe(true);
      expect(node.state).toBe('READY');
    });

    it('should not activate node from RUNNING', () => {
      node.state = 'RUNNING';
      machine = new NodeStateMachine(node);
      expect(machine.activate()).toBe(false);
    });

    it('should start execution from READY', () => {
      node.state = 'READY';
      machine = new NodeStateMachine(node);
      expect(machine.start()).toBe(true);
      expect(node.state).toBe('RUNNING');
    });

    it('should start execution from IDLE', () => {
      expect(machine.start()).toBe(true);
      expect(node.state).toBe('RUNNING');
    });

    it('should wait for input', () => {
      node.state = 'RUNNING';
      machine = new NodeStateMachine(node);
      expect(machine.waitForInput()).toBe(true);
      expect(node.state).toBe('WAITING_INPUT');
    });

    it('should wait for event', () => {
      node.state = 'RUNNING';
      machine = new NodeStateMachine(node);
      expect(machine.waitForEvent()).toBe(true);
      expect(node.state).toBe('WAITING_EVENT');
    });

    it('should complete and increment rounds', () => {
      node.state = 'RUNNING';
      machine = new NodeStateMachine(node);
      const beforeRounds = node.currentRounds;
      expect(machine.complete()).toBe(true);
      expect(node.state).toBe('DONE');
      expect(node.currentRounds).toBe(beforeRounds + 1);
    });

    it('should complete from WAITING_INPUT', () => {
      node.state = 'WAITING_INPUT';
      machine = new NodeStateMachine(node);
      expect(machine.complete()).toBe(true);
      expect(node.state).toBe('DONE');
    });

    it('should complete from WAITING_EVENT', () => {
      node.state = 'WAITING_EVENT';
      machine = new NodeStateMachine(node);
      expect(machine.complete()).toBe(true);
      expect(node.state).toBe('DONE');
    });

    it('should fail', () => {
      node.state = 'RUNNING';
      machine = new NodeStateMachine(node);
      expect(machine.fail()).toBe(true);
      expect(node.state).toBe('FAILED');
    });

    it('should reset', () => {
      node.state = 'DONE';
      machine = new NodeStateMachine(node);
      expect(machine.reset()).toBe(true);
      expect(node.state).toBe('IDLE');
    });

    it('should check if can execute', () => {
      node.state = 'READY';
      expect(machine.canExecute()).toBe(true);

      node.state = 'IDLE';
      expect(machine.canExecute()).toBe(false);

      node.state = 'READY';
      node.enabled = false;
      expect(machine.canExecute()).toBe(false);
    });

    it('should check if max rounds reached', () => {
      node.currentRounds = 5;
      node.maxRounds = 10;
      expect(machine.isMaxRoundsReached()).toBe(false);

      node.currentRounds = 10;
      expect(machine.isMaxRoundsReached()).toBe(true);

      node.currentRounds = 11;
      expect(machine.isMaxRoundsReached()).toBe(true);
    });

    it('should record transitions', () => {
      machine.activate();
      machine.start();
      const transitions = machine.getTransitions();
      expect(transitions).toHaveLength(2);
      expect(transitions[0].from).toBe('IDLE');
      expect(transitions[0].to).toBe('READY');
      expect(transitions[1].from).toBe('READY');
      expect(transitions[1].to).toBe('RUNNING');
    });
  });
});

// ============================================================================
// Node READY 判定逻辑 Tests
// ============================================================================

describe('Node READY Logic', () => {
  describe('canNodeBeReady', () => {
    it('should return true for start trigger', () => {
      const node = createTestNode({ triggerType: 'start' });
      expect(canNodeBeReady(node, [], [])).toBe(true);
    });

    it('should return false for disabled node', () => {
      const node = createTestNode({ triggerType: 'start', enabled: false });
      expect(canNodeBeReady(node, [], [])).toBe(false);
    });

    it('should return false for non-IDLE node', () => {
      const node = createTestNode({ triggerType: 'start', state: 'RUNNING' });
      expect(canNodeBeReady(node, [], [])).toBe(false);
    });

    it('should return false if max rounds reached', () => {
      const node = createTestNode({
        triggerType: 'start',
        currentRounds: 10,
        maxRounds: 10,
      });
      expect(canNodeBeReady(node, [], [])).toBe(false);
    });

    it('should check dependency trigger', () => {
      const depNode = createTestNode({ id: 'dep_1', state: 'DONE' });
      const node = createTestNode({
        triggerType: 'dependency',
        dependencies: ['dep_1'],
      });

      expect(canNodeBeReady(node, [depNode], [])).toBe(true);

      depNode.state = 'RUNNING';
      expect(canNodeBeReady(node, [depNode], [])).toBe(false);
    });

    it('should check multiple dependencies', () => {
      const dep1 = createTestNode({ id: 'dep_1', state: 'DONE' });
      const dep2 = createTestNode({ id: 'dep_2', state: 'DONE' });
      const node = createTestNode({
        triggerType: 'dependency',
        dependencies: ['dep_1', 'dep_2'],
      });

      expect(canNodeBeReady(node, [dep1, dep2], [])).toBe(true);

      dep2.state = 'RUNNING';
      expect(canNodeBeReady(node, [dep1, dep2], [])).toBe(false);
    });

    it('should check event trigger', () => {
      const node = createTestNode({
        triggerType: 'event',
        subscribeEvents: ['requirement:ready'],
      });

      const event = createTestEvent({ type: 'requirement:ready' });

      expect(canNodeBeReady(node, [], [event])).toBe(true);
      expect(canNodeBeReady(node, [], [])).toBe(false);

      event.consumed = true;
      expect(canNodeBeReady(node, [], [event])).toBe(false);
    });

    it('should check multiple subscribed events', () => {
      const node = createTestNode({
        triggerType: 'event',
        subscribeEvents: ['code:ready', 'test:done'],
      });

      const event1 = createTestEvent({ type: 'code:ready' });
      const event2 = createTestEvent({ type: 'other:event' });

      expect(canNodeBeReady(node, [], [event1])).toBe(true);
      expect(canNodeBeReady(node, [], [event2])).toBe(false);
    });
  });

  describe('getReadyNodes', () => {
    it('should return all ready nodes', () => {
      const nodes = [
        createTestNode({ id: 'node_1', triggerType: 'start' }),
        createTestNode({ id: 'node_2', triggerType: 'start', state: 'RUNNING' }),
        createTestNode({ id: 'node_3', triggerType: 'start', enabled: false }),
        createTestNode({ id: 'node_4', triggerType: 'start', currentRounds: 10, maxRounds: 10 }),
      ];

      const ready = getReadyNodes(nodes, []);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('node_1');
    });

    it('should return empty array if no nodes ready', () => {
      const nodes = [
        createTestNode({ id: 'node_1', state: 'RUNNING' }),
        createTestNode({ id: 'node_2', enabled: false }),
      ];

      const ready = getReadyNodes(nodes, []);
      expect(ready).toHaveLength(0);
    });
  });
});

// ============================================================================
// State Query Utils Tests
// ============================================================================

describe('State Query Utils', () => {
  describe('isWorkflowActive', () => {
    it('should return true for active statuses', () => {
      expect(isWorkflowActive(createTestWorkflow({ status: 'RUNNING' }))).toBe(true);
      expect(isWorkflowActive(createTestWorkflow({ status: 'PLANNING' }))).toBe(true);
      expect(isWorkflowActive(createTestWorkflow({ status: 'WAITING_EVENT' }))).toBe(true);
      expect(isWorkflowActive(createTestWorkflow({ status: 'EVOLVING' }))).toBe(true);
    });

    it('should return false for inactive statuses', () => {
      expect(isWorkflowActive(createTestWorkflow({ status: 'CREATED' }))).toBe(false);
      expect(isWorkflowActive(createTestWorkflow({ status: 'COMPLETED' }))).toBe(false);
      expect(isWorkflowActive(createTestWorkflow({ status: 'FAILED' }))).toBe(false);
      expect(isWorkflowActive(createTestWorkflow({ status: 'BLOCKED' }))).toBe(false);
    });
  });

  describe('canStartWorkflow', () => {
    it('should return true for startable statuses', () => {
      expect(canStartWorkflow(createTestWorkflow({ status: 'CREATED' }))).toBe(true);
      expect(canStartWorkflow(createTestWorkflow({ status: 'FAILED' }))).toBe(true);
      expect(canStartWorkflow(createTestWorkflow({ status: 'COMPLETED' }))).toBe(true);
    });

    it('should return false for non-startable statuses', () => {
      expect(canStartWorkflow(createTestWorkflow({ status: 'RUNNING' }))).toBe(false);
      expect(canStartWorkflow(createTestWorkflow({ status: 'PLANNING' }))).toBe(false);
      expect(canStartWorkflow(createTestWorkflow({ status: 'WAITING_EVENT' }))).toBe(false);
    });
  });

  describe('isNodeActive', () => {
    it('should return true for active states', () => {
      expect(isNodeActive(createTestNode({ state: 'READY' }))).toBe(true);
      expect(isNodeActive(createTestNode({ state: 'RUNNING' }))).toBe(true);
      expect(isNodeActive(createTestNode({ state: 'WAITING_INPUT' }))).toBe(true);
      expect(isNodeActive(createTestNode({ state: 'WAITING_EVENT' }))).toBe(true);
    });

    it('should return false for inactive states', () => {
      expect(isNodeActive(createTestNode({ state: 'IDLE' }))).toBe(false);
      expect(isNodeActive(createTestNode({ state: 'DONE' }))).toBe(false);
      expect(isNodeActive(createTestNode({ state: 'FAILED' }))).toBe(false);
    });
  });

  describe('isNodeExecutable', () => {
    it('should return true for executable nodes', () => {
      expect(isNodeExecutable(createTestNode({ state: 'READY', enabled: true }))).toBe(true);
    });

    it('should return false for non-executable nodes', () => {
      expect(isNodeExecutable(createTestNode({ state: 'IDLE', enabled: true }))).toBe(false);
      expect(isNodeExecutable(createTestNode({ state: 'READY', enabled: false }))).toBe(false);
      expect(isNodeExecutable(createTestNode({ state: 'RUNNING', enabled: true }))).toBe(false);
    });
  });

  describe('getWorkflowProgress', () => {
    it('should calculate progress correctly', () => {
      const workflow = createTestWorkflow();
      const nodes = [
        createTestNode({ id: 'node_1', state: 'DONE' }),
        createTestNode({ id: 'node_2', state: 'DONE' }),
        createTestNode({ id: 'node_3', state: 'RUNNING' }),
        createTestNode({ id: 'node_4', state: 'IDLE' }),
      ];

      const progress = getWorkflowProgress(workflow, nodes);
      expect(progress.totalNodes).toBe(4);
      expect(progress.completedNodes).toBe(2);
      expect(progress.runningNodes).toBe(1);
      expect(progress.progress).toBe(50);
    });

    it('should handle empty nodes', () => {
      const progress = getWorkflowProgress(createTestWorkflow(), []);
      expect(progress.totalNodes).toBe(0);
      expect(progress.completedNodes).toBe(0);
      expect(progress.runningNodes).toBe(0);
      expect(progress.progress).toBe(0);
    });
  });
});
