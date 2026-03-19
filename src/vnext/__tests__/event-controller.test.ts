/**
 * Scheduler vNext - NodeEventController Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NodeEventController,
  getNodeEventController,
  resetNodeEventController,
} from '../event-controller';
import { resetEventBus } from '../event-bus';
import type { WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    workflowId: 'wf-1',
    name: 'Test Node',
    role: 'developer',
    enabled: true,
    state: 'IDLE',
    triggerType: 'event',
    subscribeEvents: ['data.ready', 'task.start'],
    emitEvents: ['node.completed', 'output.ready'],
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

describe('NodeEventController', () => {
  let controller: NodeEventController;

  beforeEach(() => {
    resetEventBus();
    resetNodeEventController();
    controller = new NodeEventController({ enableLog: false });
  });

  afterEach(() => {
    controller.clear();
  });

  // ==========================================================================
  // 订阅管理
  // ==========================================================================

  describe('activateNodeSubscriptions', () => {
    it('should activate subscriptions for a node', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      const subs = controller.getNodeSubscriptions(node.id);
      expect(subs.length).toBe(2);
      expect(subs[0].eventType).toBe('data.ready');
      expect(subs[1].eventType).toBe('task.start');
    });

    it('should handle node with no subscriptions', () => {
      const node = createTestNode({ subscribeEvents: [] });
      controller.activateNodeSubscriptions(node);

      const subs = controller.getNodeSubscriptions(node.id);
      expect(subs.length).toBe(0);
    });

    it('should store subscription records correctly', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      const allSubs = controller.getAllSubscriptions();
      expect(allSubs.size).toBe(1);
      expect(allSubs.has('node-1')).toBe(true);
    });
  });

  describe('deactivateNodeSubscriptions', () => {
    it('should deactivate subscriptions for a node', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      controller.deactivateNodeSubscriptions(node.id);

      const subs = controller.getNodeSubscriptions(node.id);
      expect(subs.length).toBe(0);
    });

    it('should handle deactivating non-existent subscriptions', () => {
      expect(() => {
        controller.deactivateNodeSubscriptions('non-existent');
      }).not.toThrow();
    });
  });

  describe('activateAllSubscriptions', () => {
    it('should activate subscriptions for multiple nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2', subscribeEvents: ['custom.event'] }),
      ];

      controller.activateAllSubscriptions(nodes);

      const stats = controller.getStats();
      expect(stats.nodesWithSubscriptions).toBe(2);
      expect(stats.activeSubscriptions).toBe(3); // 2 + 1
    });

    it('should skip disabled nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2', enabled: false }),
      ];

      controller.activateAllSubscriptions(nodes);

      const stats = controller.getStats();
      expect(stats.nodesWithSubscriptions).toBe(1);
    });
  });

  describe('deactivateAllSubscriptions', () => {
    it('should deactivate all subscriptions', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2' }),
      ];

      controller.activateAllSubscriptions(nodes);
      controller.deactivateAllSubscriptions();

      const stats = controller.getStats();
      expect(stats.activeSubscriptions).toBe(0);
      expect(stats.nodesWithSubscriptions).toBe(0);
    });
  });

  // ==========================================================================
  // 事件发射
  // ==========================================================================

  describe('emitNodeEvent', () => {
    it('should emit an event from a node', () => {
      const node = createTestNode();
      const event = controller.emitNodeEvent(node, 'custom.event', { data: 'test' });

      expect(event.type).toBe('custom.event');
      expect(event.sourceNodeId).toBe(node.id);
      expect(event.workflowId).toBe(node.workflowId);
      expect(event.payload).toEqual({ data: 'test' });
    });

    it('should emit event with priority', () => {
      const node = createTestNode();
      const event = controller.emitNodeEvent(node, 'high.priority', {}, { priority: 100 });

      expect(event.priority).toBe(100);
    });
  });

  describe('emitNodeEvents', () => {
    it('should emit all node events', () => {
      const node = createTestNode();
      const events = controller.emitNodeEvents(node);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe('node.completed');
      expect(events[1].type).toBe('output.ready');
    });

    it('should emit events with custom payloads', () => {
      const node = createTestNode();
      const events = controller.emitNodeEvents(node, {
        'node.completed': { result: 'success' },
      });

      expect(events[0].payload).toEqual({ result: 'success' });
    });
  });

  describe('emitNodeCompleted', () => {
    it('should emit node completed event', () => {
      const node = createTestNode();
      const event = controller.emitNodeCompleted(node, {
        success: true,
        summary: 'Task done',
        duration: 1000,
      });

      expect(event.type).toBe('node.completed');
      expect(event.priority).toBe(80);
      expect(event.payload).toMatchObject({
        nodeId: node.id,
        success: true,
        summary: 'Task done',
      });
    });
  });

  describe('emitNodeFailed', () => {
    it('should emit node failed event', () => {
      const node = createTestNode();
      const event = controller.emitNodeFailed(node, 'Something went wrong');

      expect(event.type).toBe('node.failed');
      expect(event.priority).toBe(90);
      expect(event.payload).toMatchObject({
        nodeId: node.id,
        error: 'Something went wrong',
      });
    });
  });

  // ==========================================================================
  // 事件处理
  // ==========================================================================

  describe('handleNodeEvent', () => {
    it('should add pending event for node', () => {
      const onEventReceived = vi.fn();
      const controllerWithCallback = new NodeEventController({ onEventReceived });

      const node = createTestNode();
      controllerWithCallback.activateNodeSubscriptions(node);

      // Emit event from event bus
      controllerWithCallback.emitNodeEvent(
        createTestNode({ id: 'node-2' }),
        'data.ready',
        { value: 42 }
      );

      expect(onEventReceived).toHaveBeenCalled();
      expect(onEventReceived).toHaveBeenCalledWith(
        'node-1',
        expect.objectContaining({ type: 'data.ready' })
      );

      controllerWithCallback.clear();
    });

    it('should not add event for different workflow', () => {
      const onEventReceived = vi.fn();
      const controllerWithCallback = new NodeEventController({ onEventReceived });

      const node = createTestNode();
      controllerWithCallback.activateNodeSubscriptions(node);

      // Emit event from different workflow
      controllerWithCallback.emitNodeEvent(
        createTestNode({ id: 'node-2', workflowId: 'wf-2' }),
        'data.ready',
        {}
      );

      expect(onEventReceived).not.toHaveBeenCalled();

      controllerWithCallback.clear();
    });
  });

  describe('getPendingEventsForNode', () => {
    it('should return pending events for a node', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      // No events initially
      expect(controller.getPendingEventsForNode(node.id).length).toBe(0);

      controller.clear();
    });
  });

  describe('consumePendingEventsForNode', () => {
    it('should consume and clear pending events', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      const events = controller.consumePendingEventsForNode(node.id);
      expect(Array.isArray(events)).toBe(true);

      // Should be cleared after consumption
      expect(controller.getPendingEventsForNode(node.id).length).toBe(0);
    });
  });

  // ==========================================================================
  // 事件匹配
  // ==========================================================================

  describe('isEventMatched', () => {
    it('should match event to subscribed node', () => {
      const node = createTestNode();
      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-1',
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      expect(controller.isEventMatched(node, event)).toBe(true);
    });

    it('should not match unsubscribed event type', () => {
      const node = createTestNode();
      const event: AgentEvent = {
        id: 'evt-1',
        type: 'unknown.event',
        payload: {},
        workflowId: 'wf-1',
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      expect(controller.isEventMatched(node, event)).toBe(false);
    });

    it('should not match different workflow', () => {
      const node = createTestNode();
      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-2',
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      expect(controller.isEventMatched(node, event)).toBe(false);
    });

    it('should match event with specific target node', () => {
      const node = createTestNode();
      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-1',
        targetNodeIds: ['node-1'],
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      expect(controller.isEventMatched(node, event)).toBe(true);
    });

    it('should not match event targeting other nodes', () => {
      const node = createTestNode();
      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-1',
        targetNodeIds: ['node-2'],
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      expect(controller.isEventMatched(node, event)).toBe(false);
    });
  });

  describe('findMatchingNodes', () => {
    it('should find all matching nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2', subscribeEvents: ['data.ready'] }),
        createTestNode({ id: 'node-3', subscribeEvents: ['other.event'] }),
      ];

      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-1',
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      const matched = controller.findMatchingNodes(event, nodes);
      expect(matched.length).toBe(2);
      expect(matched.map(n => n.id)).toContain('node-1');
      expect(matched.map(n => n.id)).toContain('node-2');
    });

    it('should exclude disabled nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1', enabled: false }),
        createTestNode({ id: 'node-2' }),
      ];

      const event: AgentEvent = {
        id: 'evt-1',
        type: 'data.ready',
        payload: {},
        workflowId: 'wf-1',
        createdAt: Date.now(),
        consumed: false,
        priority: 50,
        ttl: 0,
      };

      const matched = controller.findMatchingNodes(event, nodes);
      expect(matched.length).toBe(1);
      expect(matched[0].id).toBe('node-2');
    });
  });

  describe('matchEventsToNodes', () => {
    it('should match multiple events to nodes', () => {
      const nodes = [
        createTestNode({ id: 'node-1' }),
        createTestNode({ id: 'node-2', subscribeEvents: ['custom.event'] }),
      ];

      const events: AgentEvent[] = [
        {
          id: 'evt-1',
          type: 'data.ready',
          payload: {},
          workflowId: 'wf-1',
          createdAt: Date.now(),
          consumed: false,
          priority: 50,
          ttl: 0,
        },
        {
          id: 'evt-2',
          type: 'custom.event',
          payload: {},
          workflowId: 'wf-1',
          createdAt: Date.now(),
          consumed: false,
          priority: 50,
          ttl: 0,
        },
      ];

      const results = controller.matchEventsToNodes(events, nodes);
      expect(results.length).toBe(2);
      expect(results[0].targetNodes.length).toBe(1);
      expect(results[1].targetNodes.length).toBe(1);
    });
  });

  // ==========================================================================
  // 查询
  // ==========================================================================

  describe('getStats', () => {
    it('should return correct stats', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      const stats = controller.getStats();
      expect(stats.activeSubscriptions).toBe(2);
      expect(stats.nodesWithSubscriptions).toBe(1);
      expect(stats.pendingEventsCount).toBe(0);
    });
  });

  // ==========================================================================
  // 清理
  // ==========================================================================

  describe('clear', () => {
    it('should clear all subscriptions and events', () => {
      const node = createTestNode();
      controller.activateNodeSubscriptions(node);

      controller.clear();

      const stats = controller.getStats();
      expect(stats.activeSubscriptions).toBe(0);
      expect(stats.nodesWithSubscriptions).toBe(0);
    });
  });

  // ==========================================================================
  // 全局实例
  // ==========================================================================

  describe('getNodeEventController', () => {
    it('should return global instance', () => {
      const controller1 = getNodeEventController();
      const controller2 = getNodeEventController();

      expect(controller1).toBe(controller2);
    });
  });

  describe('resetNodeEventController', () => {
    it('should reset global instance', () => {
      const controller1 = getNodeEventController();
      resetNodeEventController();
      const controller2 = getNodeEventController();

      expect(controller1).not.toBe(controller2);
    });
  });
});
