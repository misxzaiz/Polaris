/**
 * Scheduler vNext - Event Bus
 *
 * Agent 间通信的事件总线实现（内存版）
 */

import type { AgentEvent, EventHandler, EventTypes } from '../types';

// ============================================================================
// EventBus 配置
// ============================================================================

export interface EventBusConfig {
  /** 最大事件队列长度 */
  maxQueueSize?: number;
  /** 事件过期时间（毫秒） */
  eventTTL?: number;
  /** 是否启用日志 */
  enableLog?: boolean;
}

const DEFAULT_CONFIG: Required<EventBusConfig> = {
  maxQueueSize: 1000,
  eventTTL: 24 * 60 * 60 * 1000, // 24 小时
  enableLog: false,
};

// ============================================================================
// EventBus 实现
// ============================================================================

/**
 * EventBus（内存版）
 *
 * 发布-订阅模式的事件总线，支持：
 * - 事件发布与订阅
 * - 事件过滤
 * - 事件优先级
 * - 事件过期清理
 */
export class EventBus {
  private config: Required<EventBusConfig>;
  private eventQueue: AgentEvent[] = [];
  private subscribers: Map<string, Set<EventHandler>> = new Map();
  private wildcardSubscribers: Set<EventHandler> = new Set();
  private eventIdCounter = 0;

  constructor(config: EventBusConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // 发布事件
  // ==========================================================================

  /**
   * 发布事件
   */
  emit(
    type: string,
    payload: unknown,
    options: {
      workflowId: string;
      sourceNodeId?: string;
      targetNodeId?: string;
      priority?: number;
    }
  ): AgentEvent {
    const event: AgentEvent = {
      id: this.generateEventId(),
      type,
      payload,
      workflowId: options.workflowId,
      sourceNodeId: options.sourceNodeId,
      targetNodeId: options.targetNodeId,
      createdAt: Date.now(),
      consumed: false,
      priority: options.priority ?? 50,
    };

    // 检查队列大小限制
    if (this.eventQueue.length >= this.config.maxQueueSize) {
      this.cleanupExpiredEvents();
      if (this.eventQueue.length >= this.config.maxQueueSize) {
        // 移除最旧的低优先级事件
        this.eventQueue.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
        this.eventQueue.pop();
      }
    }

    // 按优先级插入
    this.insertByPriority(event);

    if (this.config.enableLog) {
      console.log('[EventBus] Emitted:', event.type, event.id);
    }

    // 同步触发订阅者
    this.dispatchToSubscribers(event);

    return event;
  }

  /**
   * 批量发布事件
   */
  emitBatch(events: Array<{
    type: string;
    payload: unknown;
    options: {
      workflowId: string;
      sourceNodeId?: string;
      targetNodeId?: string;
      priority?: number;
    };
  }>): AgentEvent[] {
    return events.map(e => this.emit(e.type, e.payload, e.options));
  }

  // ==========================================================================
  // 订阅事件
  // ==========================================================================

  /**
   * 订阅特定类型事件
   */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(handler);

    // 返回取消订阅函数
    return () => {
      this.subscribers.get(eventType)?.delete(handler);
    };
  }

  /**
   * 订阅所有事件（通配符）
   */
  subscribeAll(handler: EventHandler): () => void {
    this.wildcardSubscribers.add(handler);
    return () => {
      this.wildcardSubscribers.delete(handler);
    };
  }

  /**
   * 订阅多种事件类型
   */
  subscribeMultiple(eventTypes: string[], handler: EventHandler): () => void {
    const unsubscribers = eventTypes.map(type => this.subscribe(type, handler));
    return () => unsubscribers.forEach(unsub => unsub());
  }

  // ==========================================================================
  // 消费事件
  // ==========================================================================

  /**
   * 获取待处理事件（按优先级）
   */
  getPendingEvents(workflowId?: string): AgentEvent[] {
    let events = this.eventQueue.filter(e => !e.consumed);

    if (workflowId) {
      events = events.filter(e => e.workflowId === workflowId);
    }

    // 按优先级和时间排序
    return events.sort((a, b) => {
      const priorityDiff = (b.priority ?? 50) - (a.priority ?? 50);
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * 获取特定类型的事件
   */
  getEventsByType(eventType: string, workflowId?: string): AgentEvent[] {
    return this.getPendingEvents(workflowId).filter(e => e.type === eventType);
  }

  /**
   * 消费事件
   */
  consumeEvent(eventId: string): AgentEvent | undefined {
    const event = this.eventQueue.find(e => e.id === eventId);
    if (event) {
      event.consumed = true;
      if (this.config.enableLog) {
        console.log('[EventBus] Consumed:', event.type, event.id);
      }
    }
    return event;
  }

  /**
   * 批量消费事件
   */
  consumeEvents(eventIds: string[]): AgentEvent[] {
    return eventIds
      .map(id => this.consumeEvent(id))
      .filter((e): e is AgentEvent => e !== undefined);
  }

  /**
   * 消费特定类型的所有事件
   */
  consumeEventsByType(eventType: string, workflowId?: string): AgentEvent[] {
    const events = this.getEventsByType(eventType, workflowId);
    events.forEach(e => e.consumed = true);
    return events;
  }

  // ==========================================================================
  // 清理事件
  // ==========================================================================

  /**
   * 清理已消费的事件
   */
  clearConsumedEvents(): number {
    const before = this.eventQueue.length;
    this.eventQueue = this.eventQueue.filter(e => !e.consumed);
    return before - this.eventQueue.length;
  }

  /**
   * 清理过期事件
   */
  cleanupExpiredEvents(): number {
    const now = Date.now();
    const before = this.eventQueue.length;
    this.eventQueue = this.eventQueue.filter(
      e => now - e.createdAt < this.config.eventTTL
    );
    return before - this.eventQueue.length;
  }

  /**
   * 清理工作流的所有事件
   */
  clearWorkflowEvents(workflowId: string): number {
    const before = this.eventQueue.length;
    this.eventQueue = this.eventQueue.filter(e => e.workflowId !== workflowId);
    return before - this.eventQueue.length;
  }

  /**
   * 清空所有事件
   */
  clearAll(): void {
    this.eventQueue = [];
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  /**
   * 获取事件数量
   */
  getEventCount(workflowId?: string): number {
    if (workflowId) {
      return this.eventQueue.filter(e => e.workflowId === workflowId && !e.consumed).length;
    }
    return this.eventQueue.filter(e => !e.consumed).length;
  }

  /**
   * 检查是否有待处理事件
   */
  hasPendingEvents(workflowId?: string): boolean {
    return this.getEventCount(workflowId) > 0;
  }

  /**
   * 获取事件统计
   */
  getStats(): {
    totalEvents: number;
    pendingEvents: number;
    consumedEvents: number;
    subscriberCount: number;
  } {
    const pending = this.eventQueue.filter(e => !e.consumed).length;
    return {
      totalEvents: this.eventQueue.length,
      pendingEvents: pending,
      consumedEvents: this.eventQueue.length - pending,
      subscriberCount: Array.from(this.subscribers.values())
        .reduce((sum, set) => sum + set.size, 0) + this.wildcardSubscribers.size,
    };
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private generateEventId(): string {
    return `evt_${Date.now()}_${++this.eventIdCounter}`;
  }

  private insertByPriority(event: AgentEvent): void {
    const priority = event.priority ?? 50;
    let inserted = false;

    for (let i = 0; i < this.eventQueue.length; i++) {
      const existingPriority = this.eventQueue[i].priority ?? 50;
      if (priority > existingPriority) {
        this.eventQueue.splice(i, 0, event);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.eventQueue.push(event);
    }
  }

  private dispatchToSubscribers(event: AgentEvent): void {
    // 分发给特定类型订阅者
    const handlers = this.subscribers.get(event.type);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(event);
        } catch (error) {
          console.error('[EventBus] Handler error:', error);
        }
      });
    }

    // 分发给通配符订阅者
    this.wildcardSubscribers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.error('[EventBus] Wildcard handler error:', error);
      }
    });
  }
}

// ============================================================================
// 全局 EventBus 实例
// ============================================================================

let globalEventBus: EventBus | null = null;

/**
 * 获取全局 EventBus 实例
 */
export function getEventBus(config?: EventBusConfig): EventBus {
  if (!globalEventBus) {
    globalEventBus = new EventBus(config);
  }
  return globalEventBus;
}

/**
 * 重置全局 EventBus（用于测试）
 */
export function resetEventBus(): void {
  globalEventBus = null;
}
