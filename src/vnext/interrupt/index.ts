/**
 * Interrupt Inbox
 * 中断与补充需求机制
 *
 * 功能:
 * - 管理工作流中断请求
 * - 处理用户补充输入
 * - 支持优先级队列
 * - 自动过期清理
 */

import {
  InterruptRequest,
  UserInputEntry,
  InterruptConfig,
  InterruptInboxState,
  InterruptEvent,
  InterruptListener,
  InterruptFilter,
  InterruptStatus,
  InterruptPriority,
  InterruptType,
  UserInputType,
  DEFAULT_INTERRUPT_CONFIG,
  createInterruptRequest,
  createUserInputEntry,
} from './types';

/**
 * InterruptInbox 中断收件箱
 */
export class InterruptInbox {
  private readonly config: InterruptConfig;
  private readonly states: Map<string, InterruptInboxState> = new Map();
  private readonly listeners: Set<InterruptListener> = new Set();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<InterruptConfig>) {
    this.config = { ...DEFAULT_INTERRUPT_CONFIG, ...config };

    if (this.config.enableExpiryCleanup) {
      this.startCleanupTimer();
    }
  }

  // ==================== 中断请求管理 ====================

  /**
   * 添加中断请求
   */
  addInterrupt(request: InterruptRequest): InterruptRequest {
    const state = this.getOrCreateState(request.workflowId);

    // 检查最大数量限制
    if (state.pendingInterrupts.length >= this.config.maxPendingInterrupts) {
      // 移除最低优先级的待处理中断
      this.removeLowestPriorityInterrupt(state);
    }

    state.pendingInterrupts.push(request);
    state.pendingInterrupts.sort((a, b) => b.priority - a.priority);
    state.lastUpdatedAt = Date.now();
    state.hasUrgentInterrupt = state.pendingInterrupts.some(
      (i) => i.priority === InterruptPriority.URGENT && i.status === InterruptStatus.PENDING
    );

    this.emitEvent({
      type: 'interrupt_added',
      workflowId: request.workflowId,
      data: request,
      timestamp: Date.now(),
    });

    return request;
  }

  /**
   * 创建并添加中断请求
   */
  createInterrupt(
    workflowId: string,
    type: InterruptType,
    title: string,
    content: string,
    options?: Parameters<typeof createInterruptRequest>[4]
  ): InterruptRequest {
    const request = createInterruptRequest(workflowId, type, title, content, options);
    return this.addInterrupt(request);
  }

  /**
   * 获取待处理中断
   */
  getPendingInterrupts(workflowId: string, filter?: InterruptFilter): InterruptRequest[] {
    const state = this.states.get(workflowId);
    if (!state) return [];

    return this.filterInterrupts(state.pendingInterrupts, filter);
  }

  /**
   * 获取下一个待处理中断
   */
  getNextInterrupt(workflowId: string): InterruptRequest | undefined {
    const state = this.states.get(workflowId);
    if (!state) return undefined;

    return state.pendingInterrupts.find(
      (i) => i.status === InterruptStatus.PENDING
    );
  }

  /**
   * 确认中断
   */
  acknowledgeInterrupt(interruptId: string): InterruptRequest | undefined {
    const interrupt = this.findInterruptById(interruptId);
    if (!interrupt) return undefined;

    interrupt.status = InterruptStatus.ACKNOWLEDGED;
    this.updateStateTimestamp(interrupt.workflowId);

    return interrupt;
  }

  /**
   * 开始处理中断
   */
  startProcessingInterrupt(interruptId: string): InterruptRequest | undefined {
    const interrupt = this.findInterruptById(interruptId);
    if (!interrupt) return undefined;

    interrupt.status = InterruptStatus.PROCESSING;
    interrupt.processedAt = Date.now();
    this.updateStateTimestamp(interrupt.workflowId);

    return interrupt;
  }

  /**
   * 完成中断处理
   */
  completeInterrupt(interruptId: string, result?: string): InterruptRequest | undefined {
    const interrupt = this.findInterruptById(interruptId);
    if (!interrupt) return undefined;

    interrupt.status = InterruptStatus.COMPLETED;
    interrupt.processedAt = Date.now();
    interrupt.result = result;

    // 从待处理列表移除
    const state = this.states.get(interrupt.workflowId);
    if (state) {
      state.pendingInterrupts = state.pendingInterrupts.filter((i) => i.id !== interruptId);
      state.hasUrgentInterrupt = state.pendingInterrupts.some(
        (i) => i.priority === InterruptPriority.URGENT && i.status === InterruptStatus.PENDING
      );
    }

    this.emitEvent({
      type: 'interrupt_processed',
      workflowId: interrupt.workflowId,
      data: interrupt,
      timestamp: Date.now(),
    });

    return interrupt;
  }

  /**
   * 忽略中断
   */
  dismissInterrupt(interruptId: string, reason?: string): InterruptRequest | undefined {
    const interrupt = this.findInterruptById(interruptId);
    if (!interrupt) return undefined;

    interrupt.status = InterruptStatus.DISMISSED;
    interrupt.processedAt = Date.now();
    interrupt.result = reason;

    // 从待处理列表移除
    const state = this.states.get(interrupt.workflowId);
    if (state) {
      state.pendingInterrupts = state.pendingInterrupts.filter((i) => i.id !== interruptId);
      state.hasUrgentInterrupt = state.pendingInterrupts.some(
        (i) => i.priority === InterruptPriority.URGENT && i.status === InterruptStatus.PENDING
      );
    }

    this.emitEvent({
      type: 'interrupt_dismissed',
      workflowId: interrupt.workflowId,
      data: interrupt,
      timestamp: Date.now(),
    });

    return interrupt;
  }

  // ==================== 用户输入管理 ====================

  /**
   * 添加用户输入
   */
  addUserInput(input: UserInputEntry): UserInputEntry {
    const state = this.getOrCreateState(input.workflowId);

    state.pendingUserInputs.push(input);
    state.pendingUserInputs.sort((a, b) => b.priority - a.priority);
    state.lastUpdatedAt = Date.now();

    this.emitEvent({
      type: 'user_input_added',
      workflowId: input.workflowId,
      data: input,
      timestamp: Date.now(),
    });

    return input;
  }

  /**
   * 创建并添加用户输入
   */
  createUserInput(
    workflowId: string,
    type: UserInputType,
    title: string,
    content: string,
    options?: Parameters<typeof createUserInputEntry>[4]
  ): UserInputEntry {
    const input = createUserInputEntry(workflowId, type, title, content, options);
    return this.addUserInput(input);
  }

  /**
   * 获取待处理用户输入
   */
  getPendingUserInputs(workflowId: string): UserInputEntry[] {
    const state = this.states.get(workflowId);
    if (!state) return [];

    return state.pendingUserInputs.filter((i) => !i.processed);
  }

  /**
   * 获取下一个待处理用户输入
   */
  getNextUserInput(workflowId: string): UserInputEntry | undefined {
    const state = this.states.get(workflowId);
    if (!state) return undefined;

    return state.pendingUserInputs.find((i) => !i.processed);
  }

  /**
   * 消费用户输入（标记为已处理并移动到历史）
   */
  consumeUserInput(inputId: string, nodeId?: string): UserInputEntry | undefined {
    const input = this.findUserInputById(inputId);
    if (!input || input.processed) return undefined;

    input.processed = true;
    input.processedAt = Date.now();
    input.processedByNode = nodeId;

    const state = this.states.get(input.workflowId);
    if (state) {
      // 从待处理移到已处理
      state.pendingUserInputs = state.pendingUserInputs.filter((i) => i.id !== inputId);
      state.processedUserInputs.push(input);

      // 限制历史数量
      if (state.processedUserInputs.length > this.config.maxUserInputHistory) {
        state.processedUserInputs = state.processedUserInputs.slice(-this.config.maxUserInputHistory);
      }

      state.lastUpdatedAt = Date.now();
    }

    this.emitEvent({
      type: 'user_input_processed',
      workflowId: input.workflowId,
      data: input,
      timestamp: Date.now(),
    });

    return input;
  }

  /**
   * 获取已处理用户输入历史
   */
  getProcessedUserInputs(workflowId: string, limit?: number): UserInputEntry[] {
    const state = this.states.get(workflowId);
    if (!state) return [];

    const history = state.processedUserInputs;
    return limit ? history.slice(-limit) : history;
  }

  // ==================== 快捷方法 ====================

  /**
   * 用户暂停请求
   */
  requestPause(workflowId: string, reason: string, nodeId?: string): InterruptRequest {
    return this.createInterrupt(
      workflowId,
      InterruptType.USER_PAUSE,
      'User Pause Request',
      reason,
      { nodeId, priority: InterruptPriority.HIGH }
    );
  }

  /**
   * 用户补充说明
   */
  addSupplement(
    workflowId: string,
    content: string,
    title?: string
  ): UserInputEntry {
    return this.createUserInput(
      workflowId,
      UserInputType.SUPPLEMENT,
      title ?? 'User Supplement',
      content,
      { priority: InterruptPriority.NORMAL }
    );
  }

  /**
   * 用户需求修正
   */
  addCorrection(
    workflowId: string,
    content: string,
    title?: string
  ): UserInputEntry {
    return this.createUserInput(
      workflowId,
      UserInputType.CORRECTION,
      title ?? 'User Correction',
      content,
      { priority: InterruptPriority.HIGH }
    );
  }

  /**
   * 紧急停止
   */
  emergencyStop(workflowId: string, reason: string): InterruptRequest {
    return this.createInterrupt(
      workflowId,
      InterruptType.USER_PAUSE,
      'Emergency Stop',
      reason,
      { priority: InterruptPriority.URGENT }
    );
  }

  /**
   * 审批请求
   */
  requestApproval(
    workflowId: string,
    title: string,
    content: string,
    nodeId?: string
  ): InterruptRequest {
    return this.createInterrupt(
      workflowId,
      InterruptType.AWAITING_APPROVAL,
      title,
      content,
      { nodeId, priority: InterruptPriority.HIGH }
    );
  }

  // ==================== 状态查询 ====================

  /**
   * 获取收件箱状态
   */
  getState(workflowId: string): InterruptInboxState | undefined {
    return this.states.get(workflowId);
  }

  /**
   * 检查是否有待处理中断
   */
  hasPendingInterrupts(workflowId: string): boolean {
    const state = this.states.get(workflowId);
    if (!state) return false;
    return state.pendingInterrupts.some((i) => i.status === InterruptStatus.PENDING);
  }

  /**
   * 检查是否有待处理用户输入
   */
  hasPendingUserInputs(workflowId: string): boolean {
    const state = this.states.get(workflowId);
    if (!state) return false;
    return state.pendingUserInputs.some((i) => !i.processed);
  }

  /**
   * 检查是否有紧急中断
   */
  hasUrgentInterrupt(workflowId: string): boolean {
    const state = this.states.get(workflowId);
    return state?.hasUrgentInterrupt ?? false;
  }

  /**
   * 获取统计信息
   */
  getStats(workflowId: string): {
    pendingInterrupts: number;
    pendingUserInputs: number;
    processedUserInputs: number;
    urgentCount: number;
  } {
    const state = this.states.get(workflowId);
    if (!state) {
      return {
        pendingInterrupts: 0,
        pendingUserInputs: 0,
        processedUserInputs: 0,
        urgentCount: 0,
      };
    }

    return {
      pendingInterrupts: state.pendingInterrupts.filter(
        (i) => i.status === InterruptStatus.PENDING
      ).length,
      pendingUserInputs: state.pendingUserInputs.filter((i) => !i.processed).length,
      processedUserInputs: state.processedUserInputs.length,
      urgentCount: state.pendingInterrupts.filter(
        (i) => i.priority === InterruptPriority.URGENT
      ).length,
    };
  }

  // ==================== 清理和管理 ====================

  /**
   * 清空工作流的收件箱
   */
  clearInbox(workflowId: string): void {
    const state = this.states.get(workflowId);
    if (!state) return;

    const count = state.pendingInterrupts.length + state.pendingUserInputs.length;

    state.pendingInterrupts = [];
    state.pendingUserInputs = [];
    state.hasUrgentInterrupt = false;
    state.lastUpdatedAt = Date.now();

    this.emitEvent({
      type: 'inbox_cleared',
      workflowId,
      data: { count },
      timestamp: Date.now(),
    });
  }

  /**
   * 删除工作流状态
   */
  removeWorkflow(workflowId: string): void {
    this.states.delete(workflowId);
  }

  /**
   * 清理过期中断
   */
  cleanupExpired(): number {
    const now = Date.now();
    let totalExpired = 0;

    for (const state of this.states.values()) {
      const before = state.pendingInterrupts.length;
      state.pendingInterrupts = state.pendingInterrupts.filter((i) => {
        if (i.expiresAt && i.expiresAt < now) {
          i.status = InterruptStatus.EXPIRED;
          return false;
        }
        return true;
      });
      totalExpired += before - state.pendingInterrupts.length;

      state.hasUrgentInterrupt = state.pendingInterrupts.some(
        (i) => i.priority === InterruptPriority.URGENT && i.status === InterruptStatus.PENDING
      );
    }

    return totalExpired;
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.states.clear();
    this.listeners.clear();
  }

  // ==================== 事件监听 ====================

  /**
   * 添加监听器
   */
  addListener(listener: InterruptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 移除监听器
   */
  removeListener(listener: InterruptListener): void {
    this.listeners.delete(listener);
  }

  // ==================== 私有方法 ====================

  private getOrCreateState(workflowId: string): InterruptInboxState {
    let state = this.states.get(workflowId);
    if (!state) {
      state = {
        workflowId,
        pendingInterrupts: [],
        pendingUserInputs: [],
        processedUserInputs: [],
        lastUpdatedAt: Date.now(),
        hasUrgentInterrupt: false,
      };
      this.states.set(workflowId, state);
    }
    return state;
  }

  private findInterruptById(id: string): InterruptRequest | undefined {
    for (const state of this.states.values()) {
      const interrupt = state.pendingInterrupts.find((i) => i.id === id);
      if (interrupt) return interrupt;
    }
    return undefined;
  }

  private findUserInputById(id: string): UserInputEntry | undefined {
    for (const state of this.states.values()) {
      const input = state.pendingUserInputs.find((i) => i.id === id);
      if (input) return input;
    }
    return undefined;
  }

  private removeLowestPriorityInterrupt(state: InterruptInboxState): void {
    if (state.pendingInterrupts.length === 0) return;

    // 找到最低优先级的 PENDING 状态中断
    let lowestIndex = -1;
    let lowestPriority = Infinity;

    for (let i = 0; i < state.pendingInterrupts.length; i++) {
      const interrupt = state.pendingInterrupts[i];
      if (interrupt.status === InterruptStatus.PENDING && interrupt.priority < lowestPriority) {
        lowestPriority = interrupt.priority;
        lowestIndex = i;
      }
    }

    if (lowestIndex >= 0) {
      state.pendingInterrupts.splice(lowestIndex, 1);
    }
  }

  private updateStateTimestamp(workflowId: string): void {
    const state = this.states.get(workflowId);
    if (state) {
      state.lastUpdatedAt = Date.now();
    }
  }

  private filterInterrupts(
    interrupts: InterruptRequest[],
    filter?: InterruptFilter
  ): InterruptRequest[] {
    if (!filter) return interrupts;

    return interrupts.filter((i) => {
      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        if (!types.includes(i.type)) return false;
      }

      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(i.status)) return false;
      }

      if (filter.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
        if (!priorities.includes(i.priority)) return false;
      }

      if (filter.nodeId && i.nodeId !== filter.nodeId) return false;

      if (filter.tags && filter.tags.length > 0) {
        const interruptTags = i.tags;
        if (!interruptTags || !filter.tags.some((t) => interruptTags.includes(t))) return false;
      }

      if (filter.timeRange) {
        if (i.createdAt < filter.timeRange.start || i.createdAt > filter.timeRange.end) {
          return false;
        }
      }

      return true;
    });
  }

  private emitEvent(event: InterruptEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('InterruptInbox listener error:', error);
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.config.cleanupIntervalMs);
  }
}

// 全局实例
let globalInbox: InterruptInbox | undefined;

/**
 * 获取全局 InterruptInbox 实例
 */
export function getInterruptInbox(config?: Partial<InterruptConfig>): InterruptInbox {
  if (!globalInbox) {
    globalInbox = new InterruptInbox(config);
  }
  return globalInbox;
}

/**
 * 重置全局实例
 */
export function resetInterruptInbox(): void {
  if (globalInbox) {
    globalInbox.destroy();
    globalInbox = undefined;
  }
}

export * from './types';
