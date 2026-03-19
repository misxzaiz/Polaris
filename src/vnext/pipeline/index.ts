/**
 * Scheduler vNext - Pipeline Orchestrator
 *
 * Pipeline 推进机制，管理节点间的执行流程
 */

import type { Workflow, WorkflowNode, AgentEvent } from '../types';
import { NodeStateMachine, getReadyNodes } from '../state-machine';
import { NodeEventController } from '../event-controller';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Pipeline 状态
 */
export type PipelineState =
  | 'IDLE'       // 空闲
  | 'RUNNING'    // 运行中
  | 'PAUSED'     // 已暂停
  | 'COMPLETED'  // 已完成
  | 'FAILED';    // 失败

/**
 * 节点执行状态记录
 */
export interface NodeExecutionState {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startTime?: number;
  endTime?: number;
  error?: string;
}

/**
 * Pipeline 推进结果
 */
export interface PipelineAdvanceResult {
  /** 是否成功推进 */
  success: boolean;

  /** 当前状态 */
  state: PipelineState;

  /** 已完成的节点 */
  completedNodes: string[];

  /** 当前执行中的节点 */
  runningNodes: string[];

  /** 待执行的节点 */
  pendingNodes: string[];

  /** 被阻塞的节点及其原因 */
  blockedNodes: Array<{ nodeId: string; reason: string }>;

  /** 下一个要执行的节点 */
  nextNode?: WorkflowNode;

  /** 发出的事件 */
  emittedEvents: AgentEvent[];
}

/**
 * Pipeline 配置
 */
export interface PipelineConfig {
  /** 是否自动推进 */
  autoAdvance?: boolean;

  /** 并行执行最大数量 */
  maxParallel?: number;

  /** 节点执行回调 */
  onNodeStart?: (node: WorkflowNode) => void;
  onNodeComplete?: (node: WorkflowNode, success: boolean) => void;

  /** 是否启用日志 */
  enableLog?: boolean;
}

// ============================================================================
// PipelineOrchestrator 实现
// ============================================================================

/**
 * PipelineOrchestrator - Pipeline 推进协调器
 *
 * 职责：
 * 1. 管理节点执行顺序
 * 2. 处理依赖关系
 * 3. 推进 Pipeline 执行
 * 4. 处理分支和合并
 */
export class PipelineOrchestrator {
  private config: Required<PipelineConfig>;
  private _state: PipelineState = 'IDLE';
  private nodeStates: Map<string, NodeExecutionState> = new Map();
  private eventController: NodeEventController;
  private workflow: Workflow | null = null;
  private nodes: WorkflowNode[] = [];

  constructor(config: PipelineConfig = {}) {
    this.config = {
      autoAdvance: config.autoAdvance ?? true,
      maxParallel: config.maxParallel ?? 1,
      onNodeStart: config.onNodeStart,
      onNodeComplete: config.onNodeComplete,
      enableLog: config.enableLog ?? false,
    };
    this.eventController = new NodeEventController();
  }

  // ==========================================================================
  // 初始化
  // ==========================================================================

  /**
   * 初始化 Pipeline
   */
  initialize(workflow: Workflow, nodes: WorkflowNode[]): void {
    this.workflow = workflow;
    this.nodes = nodes;
    this._state = 'IDLE';
    this.nodeStates.clear();

    // 初始化所有节点状态
    nodes.forEach(node => {
      this.nodeStates.set(node.id, {
        nodeId: node.id,
        status: 'pending',
      });
    });

    // 激活事件订阅
    this.eventController.activateAllSubscriptions(nodes);

    this.log(`Pipeline initialized with ${nodes.length} nodes`);
  }

  /**
   * 重置 Pipeline
   */
  reset(): void {
    this._state = 'IDLE';
    this.nodeStates.clear();
    this.eventController.deactivateAllSubscriptions();
    this.workflow = null;
    this.nodes = [];
  }

  // ==========================================================================
  // 推进控制
  // ==========================================================================

  /**
   * 开始 Pipeline 执行
   */
  start(): PipelineAdvanceResult {
    if (this._state === 'RUNNING') {
      return this.createResult(false, 'Pipeline already running');
    }

    this._state = 'RUNNING';
    return this.advance();
  }

  /**
   * 推进 Pipeline
   */
  advance(): PipelineAdvanceResult {
    if (this._state !== 'RUNNING') {
      return this.createResult(false, `Pipeline not running (state: ${this._state})`);
    }

    // 获取当前状态
    const runningNodes = this.getNodesByStatus('running');
    const completedNodes = this.getNodesByStatus('completed');

    // 检查并行限制
    if (runningNodes.length >= this.config.maxParallel) {
      return this.createResult(true, 'Max parallel nodes reached');
    }

    // 获取下一个可执行节点
    const nextNode = this.getNextExecutableNode();

    if (!nextNode) {
      // 检查是否全部完成
      if (this.checkAllCompleted()) {
        this._state = 'COMPLETED';
        return this.createResult(true, 'Pipeline completed');
      }

      // 检查是否有阻塞
      const blocked = this.getBlockedNodes();
      if (blocked.length > 0) {
        return this.createResult(false, 'Pipeline blocked', { blockedNodes: blocked });
      }

      // 等待事件
      return this.createResult(true, 'Waiting for events');
    }

    // 标记节点为执行中
    this.setNodeStatus(nextNode.id, 'running');
    nextNode.state = 'RUNNING';

    // 触发回调
    if (this.config.onNodeStart) {
      this.config.onNodeStart(nextNode);
    }

    return this.createResult(true, 'Advanced to next node', { nextNode });
  }

  /**
   * 标记节点完成
   */
  completeNode(nodeId: string, success: boolean, error?: string): PipelineAdvanceResult {
    const nodeState = this.nodeStates.get(nodeId);

    if (!nodeState) {
      return this.createResult(false, `Node ${nodeId} not found`);
    }

    if (nodeState.status !== 'running') {
      return this.createResult(false, `Node ${nodeId} not running`);
    }

    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) {
      return this.createResult(false, `Node ${nodeId} not found in pipeline`);
    }

    // 更新状态
    nodeState.status = success ? 'completed' : 'failed';
    nodeState.endTime = Date.now();
    if (error) {
      nodeState.error = error;
    }

    // 更新节点状态
    const nodeMachine = new NodeStateMachine(node);
    if (success) {
      nodeMachine.complete();
    } else {
      nodeMachine.fail();
    }

    // 发射事件
    const emittedEvents: AgentEvent[] = [];
    if (success) {
      const event = this.eventController.emitNodeCompleted(node, {
        success,
        duration: (nodeState.endTime - (nodeState.startTime ?? 0)),
      });
      emittedEvents.push(event);

      // 发射节点定义的事件
      const nodeEvents = this.eventController.emitNodeEvents(node);
      emittedEvents.push(...nodeEvents);
    } else {
      const event = this.eventController.emitNodeFailed(node, error ?? 'Unknown error');
      emittedEvents.push(event);
    }

    // 触发回调
    if (this.config.onNodeComplete) {
      this.config.onNodeComplete(node, success);
    }

    // 检查是否需要更新后续节点
    this.updateDownstreamNodes(nodeId, success);

    // 自动推进
    if (this.config.autoAdvance) {
      return this.advance();
    }

    return this.createResult(true, 'Node completed', { emittedEvents });
  }

  /**
   * 暂停 Pipeline
   */
  pause(): void {
    if (this._state === 'RUNNING') {
      this._state = 'PAUSED';
      this.log('Pipeline paused');
    }
  }

  /**
   * 恢复 Pipeline
   */
  resume(): PipelineAdvanceResult {
    if (this._state === 'PAUSED') {
      this._state = 'RUNNING';
      this.log('Pipeline resumed');
      return this.advance();
    }
    return this.createResult(false, 'Pipeline not paused');
  }

  /**
   * 停止 Pipeline
   */
  stop(): void {
    this._state = 'IDLE';
    this.log('Pipeline stopped');
  }

  // ==========================================================================
  // 节点选择
  // ==========================================================================

  /**
   * 获取下一个可执行节点
   */
  getNextExecutableNode(): WorkflowNode | null {
    const pendingNodes = this.getNodesByStatus('pending');

    for (const nodeId of pendingNodes) {
      const node = this.nodes.find(n => n.id === nodeId);
      if (!node || !node.enabled) continue;

      // 检查依赖是否满足
      if (this.checkDependenciesMet(node)) {
        // 检查事件触发条件
        if (node.triggerType === 'event') {
          const pendingEvents = this.eventController.getPendingEventsForNode(nodeId);
          if (pendingEvents.length === 0) {
            continue;
          }
        }

        return node;
      }
    }

    return null;
  }

  /**
   * 获取所有可执行节点
   */
  getExecutableNodes(): WorkflowNode[] {
    const executable: WorkflowNode[] = [];
    const pendingNodes = this.getNodesByStatus('pending');

    for (const nodeId of pendingNodes) {
      const node = this.nodes.find(n => n.id === nodeId);
      if (!node || !node.enabled) continue;

      if (this.checkDependenciesMet(node)) {
        executable.push(node);
      }
    }

    return executable;
  }

  // ==========================================================================
  // 依赖检查
  // ==========================================================================

  /**
   * 检查节点依赖是否满足
   */
  checkDependenciesMet(node: WorkflowNode): boolean {
    if (node.dependencies.length === 0) {
      return true;
    }

    return node.dependencies.every(depId => {
      const depState = this.nodeStates.get(depId);
      return depState?.status === 'completed';
    });
  }

  /**
   * 获取阻塞的节点
   */
  getBlockedNodes(): Array<{ nodeId: string; reason: string }> {
    const blocked: Array<{ nodeId: string; reason: string }> = [];
    const pendingNodes = this.getNodesByStatus('pending');

    for (const nodeId of pendingNodes) {
      const node = this.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      // 检查依赖
      const unmetDeps = node.dependencies.filter(depId => {
        const depState = this.nodeStates.get(depId);
        return depState?.status !== 'completed';
      });

      if (unmetDeps.length > 0) {
        blocked.push({
          nodeId,
          reason: `Waiting for dependencies: ${unmetDeps.join(', ')}`,
        });
        continue;
      }

      // 检查事件触发
      if (node.triggerType === 'event') {
        const pendingEvents = this.eventController.getPendingEventsForNode(nodeId);
        if (pendingEvents.length === 0) {
          blocked.push({
            nodeId,
            reason: `Waiting for events: ${node.subscribeEvents.join(', ')}`,
          });
        }
      }
    }

    return blocked;
  }

  // ==========================================================================
  // 节点更新
  // ==========================================================================

  /**
   * 更新下游节点状态
   */
  private updateDownstreamNodes(nodeId: string, success: boolean): void {
    // 找到所有依赖此节点的节点
    const downstreamNodes = this.nodes.filter(n => n.dependencies.includes(nodeId));

    downstreamNodes.forEach(node => {
      if (success) {
        // 依赖完成，检查是否可以变为 READY
        if (this.checkDependenciesMet(node) && node.state === 'IDLE') {
          node.state = 'READY';
        }
      } else {
        // 依赖失败，标记为跳过
        const nodeState = this.nodeStates.get(node.id);
        if (nodeState && nodeState.status === 'pending') {
          nodeState.status = 'skipped';
          node.state = 'SKIPPED';
        }
      }
    });
  }

  /**
   * 跳过节点
   */
  skipNode(nodeId: string, reason: string): void {
    const nodeState = this.nodeStates.get(nodeId);
    const node = this.nodes.find(n => n.id === nodeId);

    if (nodeState && node) {
      nodeState.status = 'skipped';
      node.state = 'SKIPPED';
      this.log(`Node ${nodeId} skipped: ${reason}`);
    }
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  /**
   * 获取 Pipeline 状态
   */
  get state(): PipelineState {
    return this._state;
  }

  /**
   * 获取节点执行状态
   */
  getNodeState(nodeId: string): NodeExecutionState | undefined {
    return this.nodeStates.get(nodeId);
  }

  /**
   * 获取所有节点状态
   */
  getAllNodeStates(): Map<string, NodeExecutionState> {
    return new Map(this.nodeStates);
  }

  /**
   * 获取指定状态的节点
   */
  getNodesByStatus(status: NodeExecutionState['status']): string[] {
    const result: string[] = [];
    this.nodeStates.forEach((state, nodeId) => {
      if (state.status === status) {
        result.push(nodeId);
      }
    });
    return result;
  }

  /**
   * 检查是否全部完成
   */
  checkAllCompleted(): boolean {
    let allDone = true;
    this.nodeStates.forEach(state => {
      if (state.status !== 'completed' && state.status !== 'skipped' && state.status !== 'failed') {
        allDone = false;
      }
    });
    return allDone;
  }

  /**
   * 获取执行进度
   */
  getProgress(): {
    total: number;
    completed: number;
    running: number;
    pending: number;
    failed: number;
    skipped: number;
  } {
    let completed = 0, running = 0, pending = 0, failed = 0, skipped = 0;

    this.nodeStates.forEach(state => {
      switch (state.status) {
        case 'completed': completed++; break;
        case 'running': running++; break;
        case 'pending': pending++; break;
        case 'failed': failed++; break;
        case 'skipped': skipped++; break;
      }
    });

    return {
      total: this.nodeStates.size,
      completed,
      running,
      pending,
      failed,
      skipped,
    };
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private setNodeStatus(nodeId: string, status: NodeExecutionState['status']): void {
    const state = this.nodeStates.get(nodeId);
    if (state) {
      state.status = status;
      if (status === 'running') {
        state.startTime = Date.now();
      }
    }
  }

  private createResult(
    success: boolean,
    message: string,
    extras: Partial<PipelineAdvanceResult> = {}
  ): PipelineAdvanceResult {
    const progress = this.getProgress();
    const emittedEvents = extras.emittedEvents ?? [];

    return {
      success,
      state: this._state,
      completedNodes: this.getNodesByStatus('completed'),
      runningNodes: this.getNodesByStatus('running'),
      pendingNodes: this.getNodesByStatus('pending'),
      blockedNodes: extras.blockedNodes ?? [],
      nextNode: extras.nextNode,
      emittedEvents,
    };
  }

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[PipelineOrchestrator] ${message}`);
    }
  }
}

// ============================================================================
// 导出
// ============================================================================

export * from './types';
