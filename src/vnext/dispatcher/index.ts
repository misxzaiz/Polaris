/**
 * Scheduler vNext - Priority Dispatcher
 *
 * 优先级调度器，管理多个 Workflow 的执行调度
 */

import type { Workflow, WorkflowNode } from '../types';
import { ContinuousExecutor } from '../executor';
import type { IExecutor, ExecutionContext } from '../executor/types';
import type {
  DispatcherState,
  WorkflowEntry,
  DispatchStrategy,
  IWorkflowSelector,
  IDispatcher,
  PriorityDispatcherConfig,
  DispatcherRunResult,
} from './types';

// ============================================================================
// 默认 Workflow 选择器
// ============================================================================

/**
 * 默认 Workflow 选择器实现
 */
export class DefaultWorkflowSelector implements IWorkflowSelector {
  private strategy: DispatchStrategy;

  constructor(strategy: DispatchStrategy = 'priority') {
    this.strategy = strategy;
  }

  /**
   * 选择下一个要执行的 Workflow
   */
  selectWorkflow(entries: WorkflowEntry[]): WorkflowEntry | null {
    const executable = this.getExecutableEntries(entries);
    if (executable.length === 0) {
      return null;
    }

    switch (this.strategy) {
      case 'priority':
        // 按优先级排序（数值高的优先）
        return executable.sort((a, b) => b.priority - a.priority)[0];

      case 'fifo':
        // 先进先出（按加入时间排序）
        return executable.sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];

      case 'round_robin': {
        // 轮询（选择执行次数最少的）
        const sorted = executable.sort((a, b) => a.executionCount - b.executionCount);
        return sorted[0];
      }

      case 'shortest_first': {
        // 最短任务优先（节点数最少的优先）
        const sorted = executable.sort((a, b) => a.nodes.length - b.nodes.length);
        return sorted[0];
      }

      default:
        return executable[0];
    }
  }

  /**
   * 获取可执行的 Workflow 列表
   */
  getExecutableEntries(entries: WorkflowEntry[]): WorkflowEntry[] {
    return entries.filter(entry =>
      entry.status === 'pending' &&
      entry.workflow.status === 'CREATED'
    );
  }
}

// ============================================================================
// Priority Dispatcher 实现
// ============================================================================

/**
 * Priority Dispatcher - 优先级调度器
 *
 * 核心职责:
 * 1. 管理多个 Workflow 的执行优先级
 * 2. 根据优先级选择下一个要执行的 Workflow
 * 3. 支持并发执行控制
 * 4. 支持 workflow 队列管理
 */
export class PriorityDispatcher implements IDispatcher {
  private _state: DispatcherState = 'IDLE';
  private config: Required<Omit<PriorityDispatcherConfig,
    'executorFactory' | 'onWorkflowStart' | 'onWorkflowComplete' | 'onWorkflowError'>> &
    Pick<PriorityDispatcherConfig, 'executorFactory' | 'onWorkflowStart' | 'onWorkflowComplete' | 'onWorkflowError'>;

  private workflowSelector: IWorkflowSelector;
  private queue: Map<string, WorkflowEntry> = new Map();
  private running: Map<string, WorkflowEntry> = new Map();
  private pauseRequested = false;
  private stopRequested = false;

  constructor(config: PriorityDispatcherConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 3,
      dispatchInterval: config.dispatchInterval ?? 100,
      strategy: config.strategy ?? 'priority',
      enableLog: config.enableLog ?? false,
      workflowTimeout: config.workflowTimeout ?? 30 * 60 * 1000,
      executorFactory: config.executorFactory,
      onWorkflowStart: config.onWorkflowStart,
      onWorkflowComplete: config.onWorkflowComplete,
      onWorkflowError: config.onWorkflowError,
    };
    this.workflowSelector = new DefaultWorkflowSelector(this.config.strategy);
  }

  // ==========================================================================
  // 属性
  // ==========================================================================

  get state(): DispatcherState {
    return this._state;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get runningCount(): number {
    return this.running.size;
  }

  // ==========================================================================
  // 队列管理
  // ==========================================================================

  /**
   * 添加 Workflow 到队列
   */
  enqueue(workflow: Workflow, nodes: WorkflowNode[], priority: number = 50): WorkflowEntry {
    // 检查是否已存在
    if (this.queue.has(workflow.id) || this.running.has(workflow.id)) {
      const existing = this.queue.get(workflow.id) ?? this.running.get(workflow.id);
      if (existing) {
        // 更新优先级
        existing.priority = priority;
        return existing;
      }
    }

    const entry: WorkflowEntry = {
      workflow,
      nodes,
      priority,
      enqueuedAt: Date.now(),
      executionCount: 0,
      status: 'pending',
    };

    this.queue.set(workflow.id, entry);
    this.log(`Enqueued workflow ${workflow.name} (priority: ${priority})`);

    return entry;
  }

  /**
   * 移除 Workflow
   */
  dequeue(workflowId: string): WorkflowEntry | null {
    const entry = this.queue.get(workflowId);
    if (entry) {
      this.queue.delete(workflowId);
      this.log(`Dequeued workflow ${entry.workflow.name}`);
      return entry;
    }
    return null;
  }

  /**
   * 获取队列中的所有条目
   */
  getQueue(): WorkflowEntry[] {
    return Array.from(this.queue.values());
  }

  /**
   * 获取正在执行的条目
   */
  getRunning(): WorkflowEntry[] {
    return Array.from(this.running.values());
  }

  /**
   * 更新 Workflow 优先级
   */
  updatePriority(workflowId: string, priority: number): boolean {
    const entry = this.queue.get(workflowId);
    if (entry) {
      entry.priority = priority;
      this.log(`Updated workflow ${entry.workflow.name} priority to ${priority}`);
      return true;
    }
    return false;
  }

  // ==========================================================================
  // 调度控制
  // ==========================================================================

  /**
   * 启动调度
   */
  async start(): Promise<DispatcherRunResult> {
    if (this._state === 'RUNNING') {
      return this.createResult(0, 0, 0, 0, false, false, 'Already running');
    }

    this._state = 'RUNNING';
    this.pauseRequested = false;
    this.stopRequested = false;

    return this.runDispatchLoop();
  }

  /**
   * 暂停调度
   */
  pause(): void {
    if (this._state === 'RUNNING') {
      this.pauseRequested = true;
      this.log('Pause requested');

      // 暂停所有正在执行的执行器
      for (const entry of this.running.values()) {
        if (entry.executor) {
          entry.executor.pause();
        }
      }
    }
  }

  /**
   * 恢复调度
   */
  async resume(): Promise<DispatcherRunResult> {
    if (this._state !== 'PAUSED') {
      return this.createResult(0, 0, 0, 0, false, false, 'Not paused');
    }

    this._state = 'RUNNING';
    this.pauseRequested = false;
    this.stopRequested = false;

    // 恢复所有正在执行的执行器
    for (const entry of this.running.values()) {
      if (entry.executor) {
        entry.executor.resume();
      }
    }

    return this.runDispatchLoop();
  }

  /**
   * 停止调度
   */
  stop(): void {
    if (this._state === 'RUNNING' || this._state === 'PAUSED') {
      this.stopRequested = true;
      this.log('Stop requested');

      // 停止所有正在执行的执行器
      for (const entry of this.running.values()) {
        if (entry.executor) {
          entry.executor.stop();
        }
      }
    }
  }

  // ==========================================================================
  // 调度循环
  // ==========================================================================

  /**
   * 调度循环核心逻辑
   */
  private async runDispatchLoop(): Promise<DispatcherRunResult> {
    let dispatchCount = 0;
    let successCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // 防止无限循环的最大迭代次数
    const MAX_ITERATIONS = 100000;
    let iterations = 0;

    while (!this.shouldStop() && iterations < MAX_ITERATIONS) {
      iterations++;

      // 检查暂停请求
      if (this.pauseRequested) {
        this._state = 'PAUSED';
        return this.createResult(
          dispatchCount,
          successCount,
          failedCount,
          Date.now() - startTime,
          true,
          false,
          'Paused by request'
        );
      }

      // 检查是否有完成的 workflow
      this.checkCompletedWorkflows();

      // 检查是否可以调度新的 workflow
      if (this.canDispatch()) {
        const entry = this.workflowSelector.selectWorkflow(this.getQueue());

        if (entry) {
          dispatchCount++;
          const result = await this.dispatchWorkflow(entry);

          if (result.started) {
            successCount++;
          } else {
            failedCount++;
          }
        }
      }

      // 如果队列为空且没有正在执行的 workflow，完成调度
      if (this.queue.size === 0 && this.running.size === 0) {
        this._state = 'IDLE';
        return this.createResult(
          dispatchCount,
          successCount,
          failedCount,
          Date.now() - startTime,
          false,
          true,
          'All workflows completed'
        );
      }

      // 等待一段时间后继续
      await this.delay(this.config.dispatchInterval);
    }

    // 被停止或达到最大迭代
    this._state = iterations >= MAX_ITERATIONS ? 'IDLE' : 'STOPPED';
    return this.createResult(
      dispatchCount,
      successCount,
      failedCount,
      Date.now() - startTime,
      false,
      false,
      iterations >= MAX_ITERATIONS ? 'Max iterations reached' : 'Stopped by request'
    );
  }

  /**
   * 检查是否可以调度新的 workflow
   */
  private canDispatch(): boolean {
    return this.running.size < this.config.maxConcurrency;
  }

  /**
   * 调度一个 workflow 执行
   */
  private async dispatchWorkflow(entry: WorkflowEntry): Promise<{ started: boolean; error?: string }> {
    try {
      // 从队列移到运行中
      this.queue.delete(entry.workflow.id);
      entry.status = 'running';
      entry.lastExecutedAt = Date.now();
      entry.executionCount++;

      // 创建执行器
      const executor = this.createExecutor(entry);
      entry.executor = executor;

      this.running.set(entry.workflow.id, entry);
      this.log(`Starting workflow ${entry.workflow.name}`);

      // 调用开始回调
      if (this.config.onWorkflowStart) {
        this.config.onWorkflowStart(entry);
      }

      // 创建执行上下文
      const context: ExecutionContext = {
        workflow: entry.workflow,
        nodes: entry.nodes,
        pendingEvents: [],
        currentRound: 0,
      };

      // 异步执行 workflow（不等待完成）
      executor.start(context).then(result => {
        entry.result = result;
        entry.status = result.completed ? 'completed' : 'failed';

        // 调用完成回调
        if (this.config.onWorkflowComplete) {
          this.config.onWorkflowComplete(entry, result);
        }

        this.log(`Workflow ${entry.workflow.name} ${entry.status}`);
      }).catch(error => {
        entry.status = 'failed';
        const err = error instanceof Error ? error : new Error(String(error));

        // 调用错误回调
        if (this.config.onWorkflowError) {
          this.config.onWorkflowError(entry, err);
        }

        this.log(`Workflow ${entry.workflow.name} failed: ${err.message}`);
      });

      return { started: true };
    } catch (error) {
      entry.status = 'failed';
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { started: false, error: message };
    }
  }

  /**
   * 创建执行器
   */
  private createExecutor(entry: WorkflowEntry): IExecutor {
    if (this.config.executorFactory) {
      return this.config.executorFactory(entry.workflow);
    }

    // 默认使用 ContinuousExecutor
    return new ContinuousExecutor({
      enableLog: this.config.enableLog,
      onAfterExecute: (result) => {
        this.log(`Node ${result.nodeId} executed: ${result.success ? 'success' : 'failed'}`);
      },
    });
  }

  /**
   * 检查已完成的 workflow
   */
  private checkCompletedWorkflows(): void {
    for (const [id, entry] of this.running) {
      if (entry.status === 'completed' || entry.status === 'failed') {
        this.running.delete(id);
      }
    }
  }

  /**
   * 检查是否应该停止
   */
  private shouldStop(): boolean {
    return this.stopRequested;
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[PriorityDispatcher] ${message}`);
    }
  }

  private createResult(
    dispatchCount: number,
    successCount: number,
    failedCount: number,
    totalDuration: number,
    paused: boolean,
    completed: boolean,
    stopReason?: string
  ): DispatcherRunResult {
    return {
      dispatchCount,
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
