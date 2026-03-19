/**
 * Scheduler vNext - EventBus Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, resetEventBus, getEventBus } from '../index';
import { EventTypes } from '../types';

// ============================================================================
// Test Fixtures
// ============================================================================

const createTestEventBus = () => new EventBus({ enableLog: false });

// ============================================================================
// EventBus Tests
// ============================================================================

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createTestEventBus();
  });

  describe('emit() / subscribe()', () => {
    it('should emit and receive event', () => {
      const handler = vi.fn();
      eventBus.subscribe('test:event', handler);

      const event = eventBus.emit('test:event', { data: 'test' }, {
        workflowId: 'wf_001',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'test:event',
        payload: { data: 'test' },
        workflowId: 'wf_001',
      }));
      expect(event.id).toBeDefined();
      expect(event.consumed).toBe(false);
    });

    it('should support multiple subscribers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.subscribe('test:event', handler1);
      eventBus.subscribe('test:event', handler2);

      eventBus.emit('test:event', {}, { workflowId: 'wf_001' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should support wildcard subscription', () => {
      const handler = vi.fn();
      eventBus.subscribeAll(handler);

      eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.subscribe('test:event', handler);

      eventBus.emit('test:event', {}, { workflowId: 'wf_001' });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      eventBus.emit('test:event', {}, { workflowId: 'wf_001' });
      expect(handler).toHaveBeenCalledTimes(1); // 不再增加
    });
  });

  describe('事件优先级', () => {
    it('should emit events with priority', () => {
      eventBus.emit('event', { priority: 'low' }, {
        workflowId: 'wf_001',
        priority: 10,
      });
      eventBus.emit('event', { priority: 'high' }, {
        workflowId: 'wf_001',
        priority: 90,
      });
      eventBus.emit('event', { priority: 'medium' }, {
        workflowId: 'wf_001',
        priority: 50,
      });

      const events = eventBus.getPendingEvents('wf_001');
      expect(events).toHaveLength(3);
      // 高优先级应该排在前面
      expect(events[0].priority).toBe(90);
      expect(events[1].priority).toBe(50);
      expect(events[2].priority).toBe(10);
    });
  });

  describe('getPendingEvents()', () => {
    it('should return pending events', () => {
      eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });
      eventBus.emit('event3', {}, { workflowId: 'wf_002' });

      const events = eventBus.getPendingEvents('wf_001');
      expect(events).toHaveLength(2);
    });

    it('should return all events when no workflowId', () => {
      eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_002' });

      const events = eventBus.getPendingEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe('consumeEvent()', () => {
    it('should mark event as consumed', () => {
      const event = eventBus.emit('test:event', {}, { workflowId: 'wf_001' });

      const consumed = eventBus.consumeEvent(event.id);

      expect(consumed).toBeDefined();
      expect(consumed?.consumed).toBe(true);

      const pending = eventBus.getPendingEvents('wf_001');
      expect(pending).toHaveLength(0);
    });

    it('should return undefined for non-existent event', () => {
      const result = eventBus.consumeEvent('non_existent');
      expect(result).toBeUndefined();
    });
  });

  describe('getEventsByType()', () => {
    it('should filter events by type', () => {
      eventBus.emit('type1', {}, { workflowId: 'wf_001' });
      eventBus.emit('type2', {}, { workflowId: 'wf_001' });
      eventBus.emit('type1', {}, { workflowId: 'wf_001' });

      const events = eventBus.getEventsByType('type1', 'wf_001');
      expect(events).toHaveLength(2);
    });
  });

  describe('clearConsumedEvents()', () => {
    it('should clear consumed events', () => {
      const event1 = eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });

      eventBus.consumeEvent(event1.id);

      const cleared = eventBus.clearConsumedEvents();
      expect(cleared).toBe(1);

      expect(eventBus.getEventCount('wf_001')).toBe(1);
    });
  });

  describe('clearWorkflowEvents()', () => {
    it('should clear all events for a workflow', () => {
      eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });
      eventBus.emit('event3', {}, { workflowId: 'wf_002' });

      const cleared = eventBus.clearWorkflowEvents('wf_001');
      expect(cleared).toBe(2);

      expect(eventBus.getEventCount('wf_001')).toBe(0);
      expect(eventBus.getEventCount('wf_002')).toBe(1);
    });
  });

  describe('getStats()', () => {
    it('should return correct stats', () => {
      const handler = vi.fn();
      eventBus.subscribe('test:event', handler);

      const event1 = eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });
      eventBus.consumeEvent(event1.id);

      const stats = eventBus.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.pendingEvents).toBe(1);
      expect(stats.consumedEvents).toBe(1);
      expect(stats.subscriberCount).toBe(1);
    });
  });

  describe('emitBatch()', () => {
    it('should emit multiple events', () => {
      const handler = vi.fn();
      eventBus.subscribe('event', handler);

      const events = eventBus.emitBatch([
        { type: 'event', payload: { id: 1 }, options: { workflowId: 'wf_001' } },
        { type: 'event', payload: { id: 2 }, options: { workflowId: 'wf_001' } },
      ]);

      expect(events).toHaveLength(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribeMultiple()', () => {
    it('should subscribe to multiple event types', () => {
      const handler = vi.fn();
      eventBus.subscribeMultiple(['event1', 'event2'], handler);

      eventBus.emit('event1', {}, { workflowId: 'wf_001' });
      eventBus.emit('event2', {}, { workflowId: 'wf_001' });
      eventBus.emit('event3', {}, { workflowId: 'wf_001' });

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('consumeEventsByType()', () => {
    it('should consume all events of a type', () => {
      eventBus.emit('type1', {}, { workflowId: 'wf_001' });
      eventBus.emit('type1', {}, { workflowId: 'wf_001' });
      eventBus.emit('type2', {}, { workflowId: 'wf_001' });

      const consumed = eventBus.consumeEventsByType('type1', 'wf_001');

      expect(consumed).toHaveLength(2);
      expect(eventBus.getEventsByType('type1', 'wf_001')).toHaveLength(0);
    });
  });

  describe('队列限制', () => {
    it('should respect max queue size', () => {
      const smallEventBus = new EventBus({ maxQueueSize: 3, enableLog: false });

      smallEventBus.emit('event1', {}, { workflowId: 'wf_001', priority: 10 });
      smallEventBus.emit('event2', {}, { workflowId: 'wf_001', priority: 50 });
      smallEventBus.emit('event3', {}, { workflowId: 'wf_001', priority: 30 });
      smallEventBus.emit('event4', {}, { workflowId: 'wf_001', priority: 90 }); // 高优先级

      // 应该保留高优先级的
      const events = smallEventBus.getPendingEvents('wf_001');
      expect(events.length).toBeLessThanOrEqual(3);
    });
  });
});

// ============================================================================
// Global EventBus Tests
// ============================================================================

describe('getEventBus', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('should return singleton instance', () => {
    const bus1 = getEventBus();
    const bus2 = getEventBus();
    expect(bus1).toBe(bus2);
  });

  it('should create new instance after reset', () => {
    const bus1 = getEventBus();
    resetEventBus();
    const bus2 = getEventBus();
    expect(bus1).not.toBe(bus2);
  });
});

// ============================================================================
// Event Types Tests
// ============================================================================

describe('EventTypes', () => {
  it('should have predefined event types', () => {
    expect(EventTypes.WORKFLOW_START).toBe('workflow:start');
    expect(EventTypes.WORKFLOW_COMPLETE).toBe('workflow:complete');
    expect(EventTypes.NODE_READY).toBe('node:ready');
    expect(EventTypes.NODE_COMPLETE).toBe('node:complete');
    expect(EventTypes.REQUIREMENT_READY).toBe('requirement:ready');
    expect(EventTypes.CODE_READY).toBe('code:ready');
    expect(EventTypes.TEST_DONE).toBe('test:done');
  });
});
