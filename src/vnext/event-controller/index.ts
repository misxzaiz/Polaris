/**
 * Scheduler vNext - Node Event Controller
 *
 * 节点事件控制器，管理节点的事件订阅和发射
 */

import type { WorkflowNode, AgentEvent, EventHandler } from '../types';
import type {
  NodeSubscriptionRecord,
  EventMatchResult,
  NodeEventControllerConfig,
  EmitEventOptions,
  NodeCompletionResult,
} from './types';
import { EventBus, getEventBus } from '../event-bus';

// Re-export types from types.ts
export type {
  NodeSubscriptionRecord,
  EventMatchResult,
  NodeEventControllerConfig,
  EmitEventOptions,
  NodeCompletionResult,
} from './types';

// ============================================================================
// NodeEventController 实现
// ============================================================================

/**
 * NodeEventController - 节点事件控制器
 *
 * 职责：
 * 1. 管理节点的事件订阅
 * 2. 处理节点事件发射
 * 3. 事件匹配和路由
 */
export class NodeEventController {
  private eventBus: EventBus;
  private config: Required<NodeEventControllerConfig>;
  private subscriptionRecords: Map<string, NodeSubscriptionRecord[]> = new Map();
  private pendingEventsForNodes: Map<string, AgentEvent[]> = new Map();

  constructor(config: NodeEventControllerConfig = {}) {
    this.eventBus = getEventBus();
    this.config = {
      autoActivate: config.autoActivate ?? true,
      onEventReceived: config.onEventReceived,
      enableLog: config.enableLog ?? false,
    };
  }

  // ==========================================================================
  // 订阅管理
  // ==========================================================================

  /**
   * 为节点激活事件订阅
   */
  activateNodeSubscriptions(node: WorkflowNode): void {
    const nodeId = node.id;
    const { subscribeEvents, workflowId } = node;

    if (subscribeEvents.length === 0) {
      this.log(`Node ${nodeId} has no events to subscribe`);
      return;
    }

    const records: NodeSubscriptionRecord[] = [];

    subscribeEvents.forEach(eventType => {
      // 创建节点特定的处理器
      const handler: EventHandler = (event: AgentEvent) => {
        this.handleNodeEvent(node, event);
      };

      // 订阅事件
      const unsubscribe = this.eventBus.subscribe(eventType, handler);

      records.push({
        nodeId,
        eventType,
        unsubscribe,
        subscribedAt: Date.now(),
      });

      this.log(`Node ${nodeId} subscribed to ${eventType}`);
    });

    this.subscriptionRecords.set(nodeId, records);
  }

  /**
   * 取消节点的所有订阅
   */
  deactivateNodeSubscriptions(nodeId: string): void {
    const records = this.subscriptionRecords.get(nodeId);

    if (!records) {
      return;
    }

    records.forEach(record => {
      record.unsubscribe();
      this.log(`Node ${nodeId} unsubscribed from ${record.eventType}`);
    });

    this.subscriptionRecords.delete(nodeId);
  }

  /**
   * 批量激活节点订阅
   */
  activateAllSubscriptions(nodes: WorkflowNode[]): void {
    nodes.forEach(node => {
      if (node.enabled && node.subscribeEvents.length > 0) {
        this.activateNodeSubscriptions(node);
      }
    });
  }

  /**
   * 批量取消节点订阅
   */
  deactivateAllSubscriptions(): void {
    this.subscriptionRecords.forEach((records, nodeId) => {
      this.deactivateNodeSubscriptions(nodeId);
    });
  }

  // ==========================================================================
  // 事件发射
  // ==========================================================================

  /**
   * 发射节点事件
   */
  emitNodeEvent(
    node: WorkflowNode,
    eventType: string,
    payload: unknown,
    options?: {
      priority?: number;
      targetNodeIds?: string[];
    }
  ): AgentEvent {
    const event = this.eventBus.emit(eventType, payload, {
      workflowId: node.workflowId,
      sourceNodeId: node.id,
      priority: options?.priority,
    });

    this.log(`Node ${node.id} emitted ${eventType}`);

    return event;
  }

  /**
   * 批量发射节点定义的所有事件
   */
  emitNodeEvents(
    node: WorkflowNode,
    payloadMap?: Record<string, unknown>
  ): AgentEvent[] {
    const events: AgentEvent[] = [];

    node.emitEvents.forEach(eventType => {
      const payload = payloadMap?.[eventType] ?? { nodeId: node.id };
      const event = this.emitNodeEvent(node, eventType, payload);
      events.push(event);
    });

    return events;
  }

  /**
   * 发射节点完成事件
   */
  emitNodeCompleted(node: WorkflowNode, result: {
    success: boolean;
    summary?: string;
    duration: number;
  }): AgentEvent {
    return this.emitNodeEvent(node, 'node.completed', {
      nodeId: node.id,
      nodeName: node.name,
      ...result,
    }, { priority: 80 });
  }

  /**
   * 发射节点失败事件
   */
  emitNodeFailed(node: WorkflowNode, error: string): AgentEvent {
    return this.emitNodeEvent(node, 'node.failed', {
      nodeId: node.id,
      nodeName: node.name,
      error,
    }, { priority: 90 });
  }

  // ==========================================================================
  // 事件处理
  // ==========================================================================

  /**
   * 处理节点接收到的事件
   */
  private handleNodeEvent(node: WorkflowNode, event: AgentEvent): void {
    // 检查事件是否针对此工作流
    if (event.workflowId !== node.workflowId) {
      return;
    }

    // 检查是否有特定目标节点
    if (event.targetNodeIds && event.targetNodeIds.length > 0) {
      if (!event.targetNodeIds.includes(node.id)) {
        return;
      }
    }

    // 添加到节点的待处理事件
    this.addPendingEventForNode(node.id, event);

    // 触发回调
    if (this.config.onEventReceived) {
      this.config.onEventReceived(node.id, event);
    }

    this.log(`Node ${node.id} received event ${event.type}`);
  }

  /**
   * 为节点添加待处理事件
   */
  private addPendingEventForNode(nodeId: string, event: AgentEvent): void {
    if (!this.pendingEventsForNodes.has(nodeId)) {
      this.pendingEventsForNodes.set(nodeId, []);
    }

    const events = this.pendingEventsForNodes.get(nodeId)!;

    // 避免重复添加
    if (!events.some(e => e.id === event.id)) {
      events.push(event);
    }
  }

  /**
   * 获取节点的待处理事件
   */
  getPendingEventsForNode(nodeId: string): AgentEvent[] {
    return this.pendingEventsForNodes.get(nodeId) ?? [];
  }

  /**
   * 清除节点的待处理事件
   */
  clearPendingEventsForNode(nodeId: string): void {
    this.pendingEventsForNodes.delete(nodeId);
  }

  /**
   * 消费节点的待处理事件
   */
  consumePendingEventsForNode(nodeId: string): AgentEvent[] {
    const events = this.pendingEventsForNodes.get(nodeId) ?? [];
    this.pendingEventsForNodes.delete(nodeId);
    return events;
  }

  // ==========================================================================
  // 事件匹配
  // ==========================================================================

  /**
   * 检查事件是否匹配节点订阅
   */
  isEventMatched(node: WorkflowNode, event: AgentEvent): boolean {
    // 检查事件类型
    if (!node.subscribeEvents.includes(event.type)) {
      return false;
    }

    // 检查工作流
    if (event.workflowId !== node.workflowId) {
      return false;
    }

    // 检查目标节点
    if (event.targetNodeIds && event.targetNodeIds.length > 0) {
      return event.targetNodeIds.includes(node.id);
    }

    return true;
  }

  /**
   * 查找匹配事件的节点
   */
  findMatchingNodes(event: AgentEvent, nodes: WorkflowNode[]): WorkflowNode[] {
    return nodes.filter(node =>
      node.enabled &&
      node.subscribeEvents.includes(event.type) &&
      this.isEventMatched(node, event)
    );
  }

  /**
   * 批量匹配事件到节点
   */
  matchEventsToNodes(
    events: AgentEvent[],
    nodes: WorkflowNode[]
  ): EventMatchResult[] {
    return events.map(event => ({
      matched: true,
      event,
      targetNodes: this.findMatchingNodes(event, nodes),
    }));
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  /**
   * 获取节点的订阅记录
   */
  getNodeSubscriptions(nodeId: string): NodeSubscriptionRecord[] {
    return this.subscriptionRecords.get(nodeId) ?? [];
  }

  /**
   * 获取所有订阅记录
   */
  getAllSubscriptions(): Map<string, NodeSubscriptionRecord[]> {
    return new Map(this.subscriptionRecords);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    activeSubscriptions: number;
    nodesWithSubscriptions: number;
    pendingEventsCount: number;
  } {
    let activeSubscriptions = 0;
    this.subscriptionRecords.forEach(records => {
      activeSubscriptions += records.length;
    });

    let pendingEventsCount = 0;
    this.pendingEventsForNodes.forEach(events => {
      pendingEventsCount += events.length;
    });

    return {
      activeSubscriptions,
      nodesWithSubscriptions: this.subscriptionRecords.size,
      pendingEventsCount,
    };
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  /**
   * 清理所有订阅和事件
   */
  clear(): void {
    this.deactivateAllSubscriptions();
    this.pendingEventsForNodes.clear();
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[NodeEventController] ${message}`);
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

let globalController: NodeEventController | null = null;

/**
 * 获取全局 NodeEventController 实例
 */
export function getNodeEventController(
  config?: NodeEventControllerConfig
): NodeEventController {
  if (!globalController) {
    globalController = new NodeEventController(config);
  }
  return globalController;
}

/**
 * 重置全局 NodeEventController（用于测试）
 */
export function resetNodeEventController(): void {
  if (globalController) {
    globalController.clear();
    globalController = null;
  }
}
