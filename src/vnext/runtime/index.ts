/**
 * Scheduler vNext - Workflow Runtime
 *
 * 工作流运行时环境，集成所有 vnext 组件
 */

import type { Workflow, WorkflowNode, ExecutionRecord } from '../types';
import type { AgentProfile } from '../types/profile';

import { EventBus, getEventBus } from '../event-bus';
import { ExecutionStore, getExecutionStore } from '../execution-store';
import { ContextBuilder } from '../context';
import { MemoryManager, getMemoryManager } from '../memory-manager';
import { InterruptInbox, getInterruptInbox } from '../interrupt';
import { RuntimeMonitor, getRuntimeMonitor } from '../monitor';
import { WorkflowPersistence, getWorkflowPersistence } from '../persistence';
import { ErrorRecovery, getErrorRecovery } from '../recovery';
import { AIEngineAdapter, type ISession } from '../engine-adapter';

import type {
  WorkflowRuntimeConfig,
  RuntimeState,
  WorkflowRunStatus,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeEventType,
  WorkflowRunResult,
  NodeExecutorFn,
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowRegistration,
} from './types';

import { DEFAULT_RUNTIME_CONFIG } from './types';

// ============================================================================
// Workflow Runtime
// ============================================================================

/**
 * 工作流运行时
 *
 * 集成所有 vnext 组件，提供统一的工作流执行环境
 */
export class WorkflowRuntime {
  private config: Required<WorkflowRuntimeConfig>;
  private state: RuntimeState = 'IDLE';
  private workflow: Workflow | null = null;
  private nodes: WorkflowNode[] = [];
  private profiles: Map<string, AgentProfile> = new Map();
  private nodeProfiles: Map<string, string> = new Map();
  private customExecutors: Map<string, NodeExecutorFn> = new Map();

  private eventListeners: Set<RuntimeEventListener> = new Set();
  private startTime: number = 0;
  private endTime?: number;

  // 组件实例
  private eventBus: EventBus;
  private executionStore: ExecutionStore;
  private contextBuilder: ContextBuilder;
  private memoryManager: MemoryManager;
  private interruptInbox: InterruptInbox;
  private monitor: RuntimeMonitor;
  private persistence: WorkflowPersistence;
  private errorRecovery: ErrorRecovery;

  // 节点状态追踪
  private nodeStates: Map<string, 'pending' | 'running' | 'completed' | 'failed' | 'skipped'> = new Map();

  // AI 会话管理
  private sessions: Map<string, ISession> = new Map();
  private defaultEngineId: string = 'claude-code';

  // 自动保存定时器
  private autoSaveTimer?: ReturnType<typeof setInterval>;

  constructor(config: WorkflowRuntimeConfig = {}) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config };

    this.eventBus = getEventBus();
    this.executionStore = getExecutionStore();
    this.contextBuilder = new ContextBuilder();
    this.memoryManager = getMemoryManager();
    this.interruptInbox = getInterruptInbox();
    this.monitor = getRuntimeMonitor();
    this.persistence = getWorkflowPersistence();
    this.errorRecovery = getErrorRecovery();
  }

  // --------------------------------------------------------------------------
  // Workflow Registration
  // --------------------------------------------------------------------------

  registerWorkflow(registration: WorkflowRegistration): void {
    this.workflow = registration.workflow;
    this.nodes = registration.nodes;

    if (registration.profiles) {
      for (const [nodeId, profileId] of Object.entries(registration.profiles)) {
        this.nodeProfiles.set(nodeId, profileId);
      }
    }

    if (registration.executors) {
      for (const [nodeId, executor] of Object.entries(registration.executors)) {
        this.customExecutors.set(nodeId, executor);
      }
    }

    // 初始化节点状态
    for (const node of this.nodes) {
      this.nodeStates.set(node.id, 'pending');
    }

    // 注册到持久化
    if (this.config.enablePersistence) {
      this.persistence.registerWorkflow(this.workflow, this.nodes);
    }

    // 注册到监控
    if (this.config.enableMonitoring) {
      this.monitor.registerWorkflow(this.workflow.id, this.workflow.name);
      for (const node of this.nodes) {
        this.monitor.registerNode(node.id, node.name, this.workflow.id);
      }
    }

    this.log(`Registered workflow: ${this.workflow.name} (${this.nodes.length} nodes)`);
  }

  registerProfile(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile);
    this.contextBuilder.registerProfile(profile);
    this.log(`Registered profile: ${profile.name}`);
  }

  // --------------------------------------------------------------------------
  // Lifecycle Control
  // --------------------------------------------------------------------------

  async start(): Promise<WorkflowRunResult> {
    if (!this.workflow) {
      throw new Error('No workflow registered');
    }

    if (this.state !== 'IDLE' && this.state !== 'STOPPED') {
      throw new Error(`Cannot start workflow in state: ${this.state}`);
    }

    this.setState('STARTING');
    this.startTime = Date.now();
    this.endTime = undefined;

    try {
      // 初始化内存
      if (this.config.enableMemory) {
        await this.memoryManager.initialize(this.workflow.id);
        await this.memoryManager.updateActiveMemory(this.workflow.id, {
          currentGoal: this.workflow.name,
        });
      }

      // 启动监控
      if (this.config.enableMonitoring) {
        this.monitor.startWorkflow(this.workflow.id, this.nodes.length);
      }

      // 启动自动保存
      if (this.config.enablePersistence && this.config.autoSaveInterval > 0) {
        this.startAutoSave();
      }

      this.setState('RUNNING');
      this.emitEvent('workflow_started', { workflowId: this.workflow.id });

      // 执行工作流
      const result = await this.executeAll();

      return result;
    } catch (error) {
      this.setState('FAILED');
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent('workflow_failed', { error: errorMsg });

      return {
        success: false,
        workflowId: this.workflow.id,
        finalState: 'FAILED',
        stats: this.getStats(),
        errors: [{ nodeId: '', error: errorMsg, timestamp: Date.now() }],
        records: [],
      };
    }
  }

  pause(): boolean {
    if (this.state !== 'RUNNING') {
      return false;
    }

    this.setState('PAUSED');

    if (this.workflow) {
      this.monitor.pauseWorkflow(this.workflow.id);
      this.emitEvent('workflow_paused', { workflowId: this.workflow.id });
    }

    return true;
  }

  async resume(): Promise<WorkflowRunResult> {
    if (this.state !== 'PAUSED') {
      throw new Error(`Cannot resume workflow in state: ${this.state}`);
    }

    this.setState('RUNNING');

    if (this.workflow) {
      this.monitor.resumeWorkflow(this.workflow.id);
      this.emitEvent('workflow_resumed', { workflowId: this.workflow.id });
    }

    return this.executeAll();
  }

  stop(): boolean {
    if (this.state !== 'RUNNING' && this.state !== 'PAUSED') {
      return false;
    }

    this.setState('STOPPING');
    this.stopAutoSave();

    this.endTime = Date.now();
    this.setState('STOPPED');

    if (this.workflow) {
      this.monitor.stopWorkflow(this.workflow.id);
      this.emitEvent('workflow_stopped', { workflowId: this.workflow.id });
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  private async executeAll(): Promise<WorkflowRunResult> {
    if (!this.workflow) {
      throw new Error('No workflow registered');
    }

    let round = 0;
    const maxIterations = this.config.maxRounds * this.nodes.length;

    while (this.state === 'RUNNING' && round < maxIterations) {
      // 检查中断
      const interrupts = this.interruptInbox.getPendingInterrupts(this.workflow.id);
      if (interrupts.length > 0) {
        await this.handleInterrupts(interrupts);
        if (this.state !== 'RUNNING') break;
      }

      // 获取可执行节点
      const readyNodes = this.getReadyNodes();

      if (readyNodes.length === 0) {
        // 检查是否所有节点都已完成
        const stats = this.getStats();
        if (stats.executedNodes >= stats.totalNodes) {
          break;
        }
        // 没有可执行节点但还没完成 - 可能是死锁或等待
        await this.delay(this.config.executionInterval);
        round++;
        continue;
      }

      // 执行节点（控制并发）
      const toExecute = readyNodes.slice(0, this.config.maxConcurrency);
      await Promise.all(toExecute.map(nodeId => this.executeNode(nodeId)));

      round++;
      await this.delay(this.config.executionInterval);
    }

    // 完成工作流
    this.endTime = Date.now();

    const stats = this.getStats();
    const finalState = this.state === 'STOPPING' || this.state === 'STOPPED' ? 'STOPPED' :
                       stats.failedNodes > 0 ? 'FAILED' : 'COMPLETED';

    this.setState(finalState);

    if (finalState === 'COMPLETED') {
      this.monitor.completeWorkflow(this.workflow.id);
      this.emitEvent('workflow_completed', { workflowId: this.workflow.id });
    } else if (finalState === 'FAILED') {
      this.monitor.failWorkflow(this.workflow.id, 'Workflow failed');
      this.emitEvent('workflow_failed', { workflowId: this.workflow.id });
    }

    // 保存最终状态
    if (this.config.enablePersistence) {
      await this.persistence.save(this.workflow.id);
    }

    return {
      success: finalState === 'COMPLETED',
      workflowId: this.workflow.id,
      finalState,
      stats,
      errors: this.getErrors(),
      records: this.getExecutionRecords(),
    };
  }

  private getReadyNodes(): string[] {
    const ready: string[] = [];

    for (const node of this.nodes) {
      const state = this.nodeStates.get(node.id);
      if (state !== 'pending') continue;

      // 检查依赖
      const dependenciesMet = this.checkDependencies(node);
      if (dependenciesMet) {
        ready.push(node.id);
      }
    }

    return ready;
  }

  private checkDependencies(node: WorkflowNode): boolean {
    if (!node.dependencies || node.dependencies.length === 0) {
      // 没有依赖，检查 triggerType
      return node.triggerType === 'start';
    }

    // 检查所有依赖是否已完成
    for (const depId of node.dependencies) {
      const depState = this.nodeStates.get(depId);
      if (depState !== 'completed') {
        return false;
      }
    }

    return true;
  }

  private async executeNode(nodeId: string): Promise<void> {
    if (!this.workflow) return;

    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;

    this.nodeStates.set(nodeId, 'running');
    this.emitEvent('node_started', { workflowId: this.workflow.id, nodeId });

    this.monitor.startNode(this.workflow.id, nodeId);

    // 创建执行记录
    const executionRecord = this.executionStore.create({
      workflowId: this.workflow.id,
      nodeId,
      round: this.workflow.currentRound ?? 0,
    });

    try {
      const profileId = this.nodeProfiles.get(nodeId);
      const profile = profileId ? this.profiles.get(profileId) : undefined;

      const context: NodeExecutionContext = {
        round: this.workflow.currentRound ?? 0,
        profile,
        pendingEvents: [],
      };

      let result: NodeExecutionResult;

      if (this.customExecutors.has(nodeId)) {
        result = await this.customExecutors.get(nodeId)!(this.workflow, node, context);
      } else {
        result = await this.defaultExecutor(node, context);
      }

      if (result.success) {
        this.nodeStates.set(nodeId, 'completed');
        this.monitor.completeNode(this.workflow.id, nodeId);

        this.executionStore.completeExecution(executionRecord.id, {
          outputSnippet: result.output,
        });

        if (result.emitEvents) {
          for (const event of result.emitEvents) {
            this.eventBus.emit(event.type, event.data, {
              workflowId: this.workflow!.id,
              sourceNodeId: nodeId,
            });
          }
        }

        if (result.tokenUsage) {
          this.monitor.updateTokenUsage(this.workflow.id, nodeId, result.tokenUsage);
        }

        if (this.config.enableMemory) {
          await this.memoryManager.addEntry(this.workflow.id, 'active', {
            type: 'accomplishment',
            content: `Completed ${node.name}: ${result.output || 'success'}`,
            tags: ['node', node.role, nodeId],
            tokenCount: 50,
          });
        }

        this.emitEvent('node_completed', { workflowId: this.workflow.id, nodeId, output: result.output });
      } else {
        throw new Error(result.error || 'Node execution failed');
      }

    } catch (error) {
      this.nodeStates.set(nodeId, 'failed');
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.monitor.failNode(this.workflow.id, nodeId, errorMsg);

      this.executionStore.failExecution(executionRecord.id, errorMsg);

      if (this.config.enableErrorRecovery) {
        this.errorRecovery.captureException(this.workflow.id, error as Error, { nodeId });
      }

      this.emitEvent('node_failed', { workflowId: this.workflow.id, nodeId, error: errorMsg });
    }
  }

  /**
   * 设置默认引擎 ID
   */
  setDefaultEngine(engineId: string): void {
    this.defaultEngineId = engineId;
  }

  /**
   * 默认执行器 - 使用真实 AI 引擎
   */
  private async defaultExecutor(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (!this.workflow) {
      throw new Error('No workflow registered');
    }

    // 获取节点对应的 Profile
    const profileId = this.nodeProfiles.get(node.id);
    const profile = profileId ? this.profiles.get(profileId) : undefined;

    // 创建 AI 会话
    const sessionId = `session-${this.workflow.id}-${node.id}-${Date.now()}`;
    const session = new AIEngineAdapter(sessionId, {
      engineId: this.defaultEngineId,
      workDir: this.config.workDir || process.cwd(),
      timeout: this.config.nodeTimeout,
      profile,
      systemPrompt: profile?.systemPolicy ?? '',
    });

    this.sessions.set(node.id, session);

    // 构建执行提示词
    const prompt = this.buildNodePrompt(node, context, profile);

    // 执行并收集结果
    let output = '';
    const events: Array<{ type: string; data: unknown }> = [];
    let tokenUsage = { input: 0, output: 0 };

    try {
      const aiResult = await session.sendMessage(prompt, {
        onThinking: (thinking) => {
          this.log(`[${node.name}] Thinking: ${thinking.substring(0, 50)}...`);
        },
        onToolCall: (tool, input) => {
          this.log(`[${node.name}] Tool call: ${tool}`);
          events.push({ type: tool, data: input });
        },
        onToolResult: (tool, _toolResult, isError) => {
          this.log(`[${node.name}] Tool result: ${tool} (${isError ? 'error' : 'success'})`);
        },
        onOutput: (text) => {
          output += text;
        },
        onError: (error) => {
          this.log(`[${node.name}] Error: ${error}`);
        },
      });

      tokenUsage = {
        input: aiResult.tokenUsage.inputTokens,
        output: aiResult.tokenUsage.outputTokens,
      };

      // 清理会话
      this.sessions.delete(node.id);

      return {
        success: aiResult.success,
        output: aiResult.output || output,
        error: aiResult.error,
        emitEvents: node.emitEvents?.map(type => ({ type })) || [],
        tokenUsage,
      };

    } catch (error) {
      this.sessions.delete(node.id);
      throw error;
    }
  }

  /**
   * 构建节点执行提示词
   */
  private buildNodePrompt(
    node: WorkflowNode,
    context: NodeExecutionContext,
    profile?: AgentProfile
  ): string {
    const parts: string[] = [];

    // 添加 Profile 角色描述
    if (profile) {
      parts.push(`## 角色: ${profile.role}`);
      parts.push(``);
      if (profile.description) {
        parts.push(profile.description);
        parts.push(``);
      }
      if (profile.tags && profile.tags.length > 0) {
        parts.push(`**标签**: ${profile.tags.join(', ')}`);
        parts.push(``);
      }
    }

    // 添加节点任务描述
    parts.push(`## 任务: ${node.name}`);
    parts.push(``);

    if (node.role) {
      parts.push(`作为 ${node.role}，请完成以下任务。`);
      parts.push(``);
    }

    // 添加执行上下文
    if (context.round > 0) {
      parts.push(`**当前轮次**: ${context.round}`);
      parts.push(``);
    }

    // 添加待处理事件
    if (context.pendingEvents && context.pendingEvents.length > 0) {
      parts.push(`## 输入事件`);
      parts.push(``);
      for (const event of context.pendingEvents) {
        parts.push(`- [${event.type}] ${JSON.stringify(event.data)}`);
      }
      parts.push(``);
    }

    // 添加工作流目标
    if (this.workflow?.description) {
      parts.push(`## 工作流目标`);
      parts.push(``);
      parts.push(this.workflow.description);
      parts.push(``);
    }

    // 添加指令
    parts.push(`## 要求`);
    parts.push(``);
    parts.push(`1. 完成任务并输出结果`);
    parts.push(`2. 如果需要执行工具操作，请明确说明`);
    parts.push(`3. 如果遇到问题，请描述具体情况`);

    return parts.join('\n');
  }

  // --------------------------------------------------------------------------
  // Interrupt Handling
  // --------------------------------------------------------------------------

  private async handleInterrupts(interrupts: Array<{ id: string; type: string }>): Promise<void> {
    for (const interrupt of interrupts) {
      if (interrupt.type === 'user_pause' || interrupt.type === 'emergency_stop') {
        this.pause();
        this.interruptInbox.acknowledgeInterrupt(interrupt.id);
      }
    }
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private setState(state: RuntimeState): void {
    const oldState = this.state;
    this.state = state;
    this.emitEvent('state_changed', { oldState, newState: state });
  }

  getState(): RuntimeState {
    return this.state;
  }

  getStatus(): WorkflowRunStatus | null {
    if (!this.workflow) return null;

    const stats = this.getStats();

    return {
      workflowId: this.workflow.id,
      state: this.state,
      currentRound: this.workflow.currentRound ?? 0,
      executedNodes: stats.executedNodes,
      successNodes: stats.successNodes,
      failedNodes: stats.failedNodes,
      skippedNodes: stats.skippedNodes,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime,
      runningNodes: Array.from(this.nodeStates.entries())
        .filter(([_, s]) => s === 'running')
        .map(([id]) => id),
      pendingNodes: Array.from(this.nodeStates.entries())
        .filter(([_, s]) => s === 'pending')
        .map(([id]) => id),
      completedNodes: Array.from(this.nodeStates.entries())
        .filter(([_, s]) => s === 'completed')
        .map(([id]) => id),
    };
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  private getStats(): WorkflowRunResult['stats'] {
    let completed = 0, failed = 0, skipped = 0;

    for (const state of this.nodeStates.values()) {
      if (state === 'completed') completed++;
      else if (state === 'failed') failed++;
      else if (state === 'skipped') skipped++;
    }

    return {
      totalNodes: this.nodes.length,
      executedNodes: completed + failed + skipped,
      successNodes: completed,
      failedNodes: failed,
      skippedNodes: skipped,
      totalRounds: this.workflow?.currentRound || 0,
      duration: this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime,
    };
  }

  private getErrors(): WorkflowRunResult['errors'] {
    if (!this.workflow) return [];

    const errors: WorkflowRunResult['errors'] = [];

    for (const [nodeId, state] of this.nodeStates) {
      if (state === 'failed') {
        const records = this.executionStore.getByNode(nodeId);
        const failedRecord = records.find(r => r.status === 'FAILED');
        if (failedRecord) {
          errors.push({
            nodeId,
            error: failedRecord.error || 'Unknown error',
            timestamp: failedRecord.endTime || Date.now(),
          });
        }
      }
    }

    return errors;
  }

  private getExecutionRecords(): ExecutionRecord[] {
    if (!this.workflow) return [];
    return this.executionStore.getByWorkflow(this.workflow.id);
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  addEventListener(listener: RuntimeEventListener): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: RuntimeEventListener): void {
    this.eventListeners.delete(listener);
  }

  private emitEvent(type: RuntimeEventType, data?: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      type,
      timestamp: Date.now(),
      workflowId: this.workflow?.id || '',
      data,
    };

    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`Event listener error: ${error}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      if (this.workflow && this.state === 'RUNNING') {
        this.persistence.save(this.workflow.id);
      }
    }, this.config.autoSaveInterval);
  }

  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  async createSnapshot(label: string): Promise<string | null> {
    if (!this.workflow) return null;
    const snapshot = this.persistence.createSnapshot(this.workflow.id, 'manual' as any, { description: label });
    return snapshot?.id || null;
  }

  async restoreSnapshot(snapshotId: string): Promise<boolean> {
    if (!this.workflow) return false;
    return this.persistence.restoreSnapshot(this.workflow.id, snapshotId);
  }

  // --------------------------------------------------------------------------
  // Interrupts
  // --------------------------------------------------------------------------

  sendInterrupt(type: string, priority: number = 1, data?: unknown): string {
    if (!this.workflow) throw new Error('No workflow registered');

    const interrupt = this.interruptInbox.addInterrupt({
      id: `interrupt-${Date.now()}`,
      workflowId: this.workflow.id,
      type: type as any,
      priority: priority as any,
      status: 'pending' as any,
      title: `Interrupt: ${type}`,
      content: data ? String(data) : '',
      createdAt: Date.now(),
    });

    return interrupt.id;
  }

  addUserInput(type: string, content: string): string {
    if (!this.workflow) throw new Error('No workflow registered');

    const input = this.interruptInbox.createUserInput(
      this.workflow.id,
      type as any,
      `User ${type}`,
      content
    );

    return input.id;
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[WorkflowRuntime] ${message}`);
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let runtimeInstance: WorkflowRuntime | null = null;

export function getWorkflowRuntime(config?: WorkflowRuntimeConfig): WorkflowRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new WorkflowRuntime(config);
  }
  return runtimeInstance;
}

export function resetWorkflowRuntime(): void {
  if (runtimeInstance) {
    runtimeInstance.stop();
    runtimeInstance = null;
  }
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  WorkflowRuntimeConfig,
  RuntimeState,
  WorkflowRunStatus,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeEventType,
  WorkflowRunResult,
  NodeExecutorFn,
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowRegistration,
};

export { DEFAULT_RUNTIME_CONFIG };
