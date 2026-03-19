/**
 * Scheduler vNext - Continuous Executor
 *
 * 连续执行引擎，支持无等待的 Pipeline 推进
 */

import type { Workflow, WorkflowNode, AgentEvent } from '../types';
import {
  WorkflowStateMachine,
  NodeStateMachine,
  canNodeBeReady,
  getReadyNodes,
  isWorkflowActive,
} from '../state-machine';
import { getEventBus } from '../event-bus';
import type {
  ExecutorState,
  ExecutionContext,
  ExecutionResult,
  ExecutorRunResult,
  IExecutor,
  ContinuousExecutorConfig,
  INodeSelector,
  NodeSelectionStrategy,
} from './types';

// ============================================================================
// 默认节点选择器
// ============================================================================

/**
 * 默认节点选择器 - 按优先级选择就绪节点
 */
export class DefaultNodeSelector implements INodeSelector {
  private strategy: NodeSelectionStrategy;

  constructor(strategy: NodeSelectionStrategy = 'ready_first') {
    this.strategy = strategy;
  }

  /**
   * 选择下一个要执行的节点
   */
  selectNode(context: ExecutionContext): WorkflowNode | null {
    const executableNodes = this.getExecutableNodes(context);

    if (executableNodes.length === 0) {
      return null;
    }

    switch (this.strategy) {
      case 'priority':
        // 按节点优先级排序（假设节点有 config.priority）
        return executableNodes.sort((a, b) => {
          const priorityA = (a.config?.priority as number) ?? 50;
          const priorityB = (b.config?.priority as number) ?? 50;
          return priorityB - priorityA;
        })[0];

      case 'sequential':
        // 按节点创建时间排序
        return executableNodes.sort((a, b) => a.createdAt - b.createdAt)[0];

      case 'ready_first':
      default:
        // 优先选择 READY 状态的节点
        const readyNode = executableNodes.find(n => n.state === 'READY');
        return readyNode ?? executableNodes[0];
    }
  }

  /**
   * 获取所有可执行节点
   */
  getExecutableNodes(context: ExecutionContext): WorkflowNode[] {
    const { nodes, pendingEvents } = context;

    // 获取可以就绪的节点
    const readyNodes = getReadyNodes(nodes, pendingEvents);

    // 同时包含已经是 READY 状态的节点
    const alreadyReady = nodes.filter(n => n.state === 'READY' && n.enabled);

    // 合并并去重
    const allReady = [...new Map([...alreadyReady, ...readyNodes].map(n => [n.id, n])).values()];

    return allReady;
  }
}

// ============================================================================
// Continuous Executor 实现
// ============================================================================

/**
 * Continuous Executor - 连续执行引擎
 *
 * 核心执行循环:
 * while(workflow.running){
 *   node = pickNextRunnableNode()
 *   runAgent(node)
 *   if(next exists): continue
 * }
 */
export class ContinuousExecutor implements IExecutor {
  private _state: ExecutorState = 'IDLE';
  private config: Required<ContinuousExecutorConfig>;
  private nodeSelector: INodeSelector;
  private context: ExecutionContext | null = null;
  private pauseRequested = false;
  private stopRequested = false;

  constructor(
    config: ContinuousExecutorConfig = {},
    nodeSelector?: INodeSelector
  ) {
    this.config = {
      maxRounds: config.maxRounds ?? 0,
      nodeTimeout: config.nodeTimeout ?? 5 * 60 * 1000,
      executionInterval: config.executionInterval ?? 100,
      continueOnFailure: config.continueOnFailure ?? false,
      enableLog: config.enableLog ?? false,
      onBeforeExecute: config.onBeforeExecute,
      onAfterExecute: config.onAfterExecute,
    };
    this.nodeSelector = nodeSelector ?? new DefaultNodeSelector();
  }

  // ==========================================================================
  // 属性
  // ==========================================================================

  get state(): ExecutorState {
    return this._state;
  }

  // ==========================================================================
  // 生命周期控制
  // ==========================================================================

  /**
   * 启动执行
   */
  async start(context: ExecutionContext): Promise<ExecutorRunResult> {
    if (this._state === 'RUNNING') {
      return this.createResult(0, 0, 0, 0, false, false, 'Already running');
    }

    this.context = context;
    this._state = 'RUNNING';
    this.pauseRequested = false;
    this.stopRequested = false;

    return this.runExecutionLoop();
  }

  /**
   * 暂停执行
   */
  pause(): void {
    if (this._state === 'RUNNING') {
      this.pauseRequested = true;
      this.log('Pause requested');
    }
  }

  /**
   * 恢复执行
   */
  async resume(): Promise<ExecutorRunResult> {
    if (this._state !== 'PAUSED' || !this.context) {
      return this.createResult(0, 0, 0, 0, false, false, 'Not paused');
    }

    this._state = 'RUNNING';
    this.pauseRequested = false;
    this.stopRequested = false;

    return this.runExecutionLoop();
  }

  /**
   * 停止执行
   */
  stop(): void {
    if (this._state === 'RUNNING' || this._state === 'PAUSED') {
      this.stopRequested = true;
      this.log('Stop requested');
    }
  }

  // ==========================================================================
  // 节点执行
  // ==========================================================================

  /**
   * 执行单个节点
   *
   * 这是一个模板方法，实际执行逻辑由子类或回调实现
   */
  async executeNode(node: WorkflowNode, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const nodeMachine = new NodeStateMachine(node);

    // 如果节点是 IDLE 状态，先激活为 READY
    if (node.state === 'IDLE') {
      nodeMachine.activate();
    }

    // 检查节点是否可执行
    if (!nodeMachine.canExecute()) {
      return {
        nodeId: node.id,
        success: false,
        error: `Node is not executable (state: ${node.state}, enabled: ${node.enabled})`,
        duration: 0,
        emittedEvents: [],
      };
    }

    // 开始执行
    nodeMachine.start();

    try {
      // 调用前置回调
      if (this.config.onBeforeExecute) {
        this.config.onBeforeExecute(node, context);
      }

      // 模拟执行 (实际执行由 Agent Runtime 完成)
      const result = await this.doExecute(node, context);

      // 更新节点状态
      if (result.success) {
        nodeMachine.complete();
      } else {
        nodeMachine.fail();
      }

      // 记录执行时间
      result.duration = Date.now() - startTime;

      // 调用后置回调
      if (this.config.onAfterExecute) {
        this.config.onAfterExecute(result, context);
      }

      return result;
    } catch (error) {
      nodeMachine.fail();
      return {
        nodeId: node.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
        emittedEvents: [],
      };
    }
  }

  /**
   * 实际执行逻辑 - 模拟实现
   *
   * 在实际使用中，这里会调用 Agent Runtime
   */
  protected async doExecute(
    node: WorkflowNode,
    _context: ExecutionContext
  ): Promise<ExecutionResult> {
    // 模拟执行延迟
    await this.delay(this.config.executionInterval);

    // 发射节点定义的事件
    const emittedEvents: AgentEvent[] = [];
    const eventBus = getEventBus();

    if (node.emitEvents.length > 0 && _context.workflow) {
      node.emitEvents.forEach(eventType => {
        const event = eventBus.emit(eventType, { nodeId: node.id }, {
          workflowId: _context.workflow.id,
          sourceNodeId: node.id,
        });
        emittedEvents.push(event);
      });
    }

    return {
      nodeId: node.id,
      success: true,
      duration: 0,
      emittedEvents,
      summary: `Node ${node.name} executed successfully`,
    };
  }

  // ==========================================================================
  // 执行循环
  // ==========================================================================

  /**
   * 执行循环核心逻辑
   */
  private async runExecutionLoop(): Promise<ExecutorRunResult> {
    let executedNodes = 0;
    let successCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // 防止无限循环的最大迭代次数
    const MAX_ITERATIONS = 10000;
    let iterations = 0;

    while (!this.shouldStop() && iterations < MAX_ITERATIONS) {
      iterations++;

      // 检查暂停请求
      if (this.pauseRequested) {
        this._state = 'PAUSED';
        return this.createResult(
          executedNodes,
          successCount,
          failedCount,
          Date.now() - startTime,
          true,
          false,
          'Paused by request'
        );
      }

      // 刷新 pendingEvents 从 EventBus
      this.refreshPendingEvents();

      // 选择下一个节点
      const node = this.nodeSelector.selectNode(this.context!);

      if (!node) {
        // 没有可执行节点，检查是否完成
        const allDone = this.checkAllNodesDone();
        if (allDone) {
          this._state = 'IDLE';
          return this.createResult(
            executedNodes,
            successCount,
            failedCount,
            Date.now() - startTime,
            false,
            true,
            'All nodes completed'
          );
        }

        // 没有可执行节点也没有完成，说明被阻塞
        // 检查是否有等待事件的节点
        const waitingForEvent = this.context!.nodes.some(
          n => n.state === 'IDLE' && n.triggerType === 'event' && n.enabled
        );

        if (waitingForEvent && this.context!.pendingEvents.length === 0) {
          // 等待事件但无事件，标记为完成（避免无限等待）
          this._state = 'IDLE';
          return this.createResult(
            executedNodes,
            successCount,
            failedCount,
            Date.now() - startTime,
            false,
            true,
            'No more executable nodes (waiting for events)'
          );
        }

        // 等待事件或新节点就绪
        await this.delay(this.config.executionInterval);
        continue;
      }

      // 更新当前节点
      this.context!.currentNodeId = node.id;

      // 执行节点
      const result = await this.executeNode(node, this.context!);
      executedNodes++;

      if (result.success) {
        successCount++;

        // 将发出的事件添加到 pendingEvents
        result.emittedEvents.forEach(event => {
          if (!this.context!.pendingEvents.some(e => e.id === event.id)) {
            this.context!.pendingEvents.push(event);
          }
        });
      } else {
        failedCount++;
        if (!this.config.continueOnFailure) {
          this._state = 'IDLE';
          return this.createResult(
            executedNodes,
            successCount,
            failedCount,
            Date.now() - startTime,
            false,
            false,
            `Node ${node.id} failed: ${result.error}`
          );
        }
      }

      // 检查最大轮次
      if (this.config.maxRounds > 0 && executedNodes >= this.config.maxRounds) {
        this._state = 'IDLE';
        return this.createResult(
          executedNodes,
          successCount,
          failedCount,
          Date.now() - startTime,
          false,
          false,
          'Max rounds reached'
        );
      }

      // 更新上下文
      this.context!.currentRound++;
    }

    // 被停止或达到最大迭代
    this._state = iterations >= MAX_ITERATIONS ? 'IDLE' : 'STOPPED';
    return this.createResult(
      executedNodes,
      successCount,
      failedCount,
      Date.now() - startTime,
      false,
      false,
      iterations >= MAX_ITERATIONS ? 'Max iterations reached' : 'Stopped by request'
    );
  }

  /**
   * 刷新 pendingEvents 从 EventBus
   */
  private refreshPendingEvents(): void {
    if (!this.context) return;

    const eventBus = getEventBus();
    const workflowEvents = eventBus.getPendingEvents(this.context.workflow.id);

    // 合并新事件
    workflowEvents.forEach(event => {
      if (!this.context!.pendingEvents.some(e => e.id === event.id)) {
        this.context!.pendingEvents.push(event);
      }
    });
  }

  /**
   * 检查是否应该停止
   */
  private shouldStop(): boolean {
    return this.stopRequested;
  }

  /**
   * 检查所有节点是否已完成
   */
  private checkAllNodesDone(): boolean {
    if (!this.context) return false;

    const { nodes } = this.context;
    return nodes.every(n =>
      n.state === 'DONE' ||
      n.state === 'FAILED' ||
      n.state === 'SKIPPED' ||
      !n.enabled
    );
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[ContinuousExecutor] ${message}`);
    }
  }

  private createResult(
    executedNodes: number,
    successCount: number,
    failedCount: number,
    totalDuration: number,
    paused: boolean,
    completed: boolean,
    stopReason?: string
  ): ExecutorRunResult {
    return {
      executedNodes,
      successCount,
      failedCount,
      totalDuration,
      paused,
      completed,
      stopReason,
    };
  }
}

// ============================================================================
// 导出
// ============================================================================

export * from './types';
