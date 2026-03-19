/**
 * Runtime Monitor
 * 实时执行监控数据输出
 *
 * 功能:
 * - 工作流/节点状态追踪
 * - Token 使用量统计
 * - 执行日志收集
 * - 成本估算
 * - 实时指标计算
 * - 事件推送
 */

import {
  MonitorEventType,
  WorkflowRuntimeStatus,
  NodeRuntimeStatus,
  TokenUsage,
  ExecutionLogEntry,
  ResourceUsageStats,
  RealtimeMetrics,
  MonitorConfig,
  MonitorEvent,
  MonitorListener,
  DEFAULT_MONITOR_CONFIG,
  EMPTY_TOKEN_USAGE,
  createExecutionLogEntry,
  calculateCost,
  mergeTokenUsage,
} from './types';

/**
 * RuntimeMonitor 运行时监控器
 */
export class RuntimeMonitor {
  private readonly config: MonitorConfig;
  private readonly workflowStatuses: Map<string, WorkflowRuntimeStatus> = new Map();
  private readonly nodeStatuses: Map<string, NodeRuntimeStatus> = new Map();
  private readonly logs: ExecutionLogEntry[] = [];
  private readonly listeners: Set<MonitorListener> = new Set();
  private readonly tokenHistory: Array<{ timestamp: number; usage: TokenUsage }> = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<MonitorConfig>) {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };

    if (this.config.enabled) {
      this.startHeartbeat();
    }
  }

  // ==================== 工作流状态管理 ====================

  /**
   * 注册工作流
   */
  registerWorkflow(workflowId: string, workflowName: string): void {
    this.workflowStatuses.set(workflowId, {
      workflowId,
      workflowName,
      status: 'idle',
      completedNodes: 0,
      totalNodes: 0,
      currentRound: 0,
      tokenUsage: { ...EMPTY_TOKEN_USAGE },
      estimatedCost: 0,
      lastUpdatedAt: Date.now(),
    });
  }

  /**
   * 更新工作流状态
   */
  updateWorkflowStatus(
    workflowId: string,
    updates: Partial<WorkflowRuntimeStatus>
  ): WorkflowRuntimeStatus | undefined {
    const status = this.workflowStatuses.get(workflowId);
    if (!status) return undefined;

    Object.assign(status, updates, { lastUpdatedAt: Date.now() });

    // 更新运行时长
    if (status.startedAt) {
      status.duration = Date.now() - status.startedAt;
    }

    return status;
  }

  /**
   * 工作流开始
   */
  startWorkflow(workflowId: string, totalNodes: number): void {
    const status = this.workflowStatuses.get(workflowId);
    if (!status) return;

    status.status = 'running';
    status.totalNodes = totalNodes;
    status.startedAt = Date.now();
    status.currentRound = 1;
    status.lastUpdatedAt = Date.now();

    this.emitEvent({
      type: MonitorEventType.WORKFLOW_STARTED,
      workflowId,
      timestamp: Date.now(),
      data: { totalNodes },
    });

    this.addLog(
      workflowId,
      MonitorEventType.WORKFLOW_STARTED,
      'Workflow Started',
      `Workflow "${status.workflowName}" started with ${totalNodes} nodes`
    );
  }

  /**
   * 工作流暂停
   */
  pauseWorkflow(workflowId: string): void {
    this.updateWorkflowStatus(workflowId, { status: 'paused' });
    this.emitEvent({
      type: MonitorEventType.WORKFLOW_PAUSED,
      workflowId,
      timestamp: Date.now(),
    });
  }

  /**
   * 工作流恢复
   */
  resumeWorkflow(workflowId: string): void {
    this.updateWorkflowStatus(workflowId, { status: 'running' });
    this.emitEvent({
      type: MonitorEventType.WORKFLOW_RESUMED,
      workflowId,
      timestamp: Date.now(),
    });
  }

  /**
   * 工作流停止
   */
  stopWorkflow(workflowId: string): void {
    const status = this.updateWorkflowStatus(workflowId, { status: 'stopped' });
    if (status) {
      this.addLog(
        workflowId,
        MonitorEventType.WORKFLOW_STOPPED,
        'Workflow Stopped',
        `Workflow "${status.workflowName}" stopped`
      );
    }
    this.emitEvent({
      type: MonitorEventType.WORKFLOW_STOPPED,
      workflowId,
      timestamp: Date.now(),
    });
  }

  /**
   * 工作流完成
   */
  completeWorkflow(workflowId: string): void {
    const status = this.updateWorkflowStatus(workflowId, { status: 'completed' });
    if (status) {
      this.addLog(
        workflowId,
        MonitorEventType.WORKFLOW_COMPLETED,
        'Workflow Completed',
        `Workflow "${status.workflowName}" completed successfully. Total duration: ${status.duration}ms, Total tokens: ${status.tokenUsage.total}`
      );
    }
    this.emitEvent({
      type: MonitorEventType.WORKFLOW_COMPLETED,
      workflowId,
      timestamp: Date.now(),
      data: status,
    });
  }

  /**
   * 工作流失败
   */
  failWorkflow(workflowId: string, error: string): void {
    const status = this.updateWorkflowStatus(workflowId, { status: 'failed', lastError: error });
    if (status) {
      this.addLog(
        workflowId,
        MonitorEventType.WORKFLOW_FAILED,
        'Workflow Failed',
        error,
        { level: 'error' }
      );
    }
    this.emitEvent({
      type: MonitorEventType.WORKFLOW_FAILED,
      workflowId,
      timestamp: Date.now(),
      data: { error },
    });
  }

  /**
   * 获取工作流状态
   */
  getWorkflowStatus(workflowId: string): WorkflowRuntimeStatus | undefined {
    return this.workflowStatuses.get(workflowId);
  }

  /**
   * 获取所有活跃工作流
   */
  getActiveWorkflows(): WorkflowRuntimeStatus[] {
    return Array.from(this.workflowStatuses.values()).filter(
      (w) => w.status === 'running' || w.status === 'paused'
    );
  }

  // ==================== 节点状态管理 ====================

  /**
   * 注册节点
   */
  registerNode(
    nodeId: string,
    nodeName: string,
    workflowId: string
  ): void {
    this.nodeStatuses.set(nodeId, {
      nodeId,
      nodeName,
      workflowId,
      status: 'idle',
      executionCount: 0,
      tokenUsage: { ...EMPTY_TOKEN_USAGE },
      lastUpdatedAt: Date.now(),
    });
  }

  /**
   * 节点开始执行
   */
  startNode(workflowId: string, nodeId: string, round?: number): void {
    const nodeStatus = this.nodeStatuses.get(nodeId);
    if (!nodeStatus) return;

    nodeStatus.status = 'running';
    nodeStatus.startedAt = Date.now();
    nodeStatus.finishedAt = undefined;
    nodeStatus.duration = undefined;
    nodeStatus.currentRound = round;
    nodeStatus.executionCount++;
    nodeStatus.lastUpdatedAt = Date.now();

    // 更新工作流当前节点
    this.updateWorkflowStatus(workflowId, {
      currentNodeId: nodeId,
      currentNodeName: nodeStatus.nodeName,
    });

    this.emitEvent({
      type: MonitorEventType.NODE_STARTED,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { round, executionCount: nodeStatus.executionCount },
    });

    this.addLog(
      workflowId,
      MonitorEventType.NODE_STARTED,
      'Node Started',
      `Node "${nodeStatus.nodeName}" started execution #${nodeStatus.executionCount}`,
      { nodeId }
    );
  }

  /**
   * 节点完成
   */
  completeNode(workflowId: string, nodeId: string, outputSummary?: string): void {
    const nodeStatus = this.nodeStatuses.get(nodeId);
    if (!nodeStatus) return;

    const now = Date.now();
    nodeStatus.status = 'completed';
    nodeStatus.finishedAt = now;
    nodeStatus.duration = nodeStatus.startedAt ? now - nodeStatus.startedAt : undefined;
    nodeStatus.outputSummary = outputSummary;
    nodeStatus.lastUpdatedAt = now;

    // 更新工作流进度
    const workflowStatus = this.workflowStatuses.get(workflowId);
    if (workflowStatus) {
      workflowStatus.completedNodes++;
    }

    this.emitEvent({
      type: MonitorEventType.NODE_COMPLETED,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { duration: nodeStatus.duration },
    });

    this.addLog(
      workflowId,
      MonitorEventType.NODE_COMPLETED,
      'Node Completed',
      `Node "${nodeStatus.nodeName}" completed in ${nodeStatus.duration}ms`,
      { nodeId, duration: nodeStatus.duration }
    );
  }

  /**
   * 节点失败
   */
  failNode(workflowId: string, nodeId: string, error: string): void {
    const nodeStatus = this.nodeStatuses.get(nodeId);
    if (!nodeStatus) return;

    const now = Date.now();
    nodeStatus.status = 'failed';
    nodeStatus.finishedAt = now;
    nodeStatus.duration = nodeStatus.startedAt ? now - nodeStatus.startedAt : undefined;
    nodeStatus.lastError = error;
    nodeStatus.lastUpdatedAt = now;

    this.emitEvent({
      type: MonitorEventType.NODE_FAILED,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { error },
    });

    this.addLog(
      workflowId,
      MonitorEventType.NODE_FAILED,
      'Node Failed',
      `Node "${nodeStatus.nodeName}" failed: ${error}`,
      { nodeId, level: 'error' }
    );
  }

  /**
   * 获取节点状态
   */
  getNodeStatus(nodeId: string): NodeRuntimeStatus | undefined {
    return this.nodeStatuses.get(nodeId);
  }

  /**
   * 获取工作流的所有节点状态
   */
  getWorkflowNodes(workflowId: string): NodeRuntimeStatus[] {
    return Array.from(this.nodeStatuses.values()).filter((n) => n.workflowId === workflowId);
  }

  // ==================== 执行事件追踪 ====================

  /**
   * 记录思考过程
   */
  recordThinking(workflowId: string, nodeId: string, content: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_THINKING,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { content },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_THINKING,
      'Thinking',
      content.substring(0, 500),
      { nodeId, level: 'debug' }
    );
  }

  /**
   * 记录文件读取
   */
  recordReading(workflowId: string, nodeId: string, filePath: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_READING,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { filePath },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_READING,
      'Reading File',
      filePath,
      { nodeId }
    );
  }

  /**
   * 记录文件写入
   */
  recordWriting(workflowId: string, nodeId: string, filePath: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_WRITING,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { filePath },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_WRITING,
      'Writing File',
      filePath,
      { nodeId }
    );
  }

  /**
   * 记录工具调用
   */
  recordToolCall(
    workflowId: string,
    nodeId: string,
    toolName: string,
    args?: Record<string, unknown>
  ): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_TOOL_CALL,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { toolName, args },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_TOOL_CALL,
      'Tool Call',
      `${toolName}${args ? `: ${JSON.stringify(args).substring(0, 100)}` : ''}`,
      { nodeId, metadata: { toolName, args } }
    );
  }

  /**
   * 记录决策
   */
  recordDecision(workflowId: string, nodeId: string, decision: string, reason?: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_DECISION,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { decision, reason },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_DECISION,
      'Decision',
      `${decision}${reason ? ` - ${reason}` : ''}`,
      { nodeId }
    );
  }

  /**
   * 记录输出
   */
  recordOutput(workflowId: string, nodeId: string, content: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_OUTPUT,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { content },
    });
  }

  /**
   * 记录错误
   */
  recordError(workflowId: string, nodeId: string, error: string): void {
    this.emitEvent({
      type: MonitorEventType.EXECUTION_ERROR,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: { error },
    });

    this.addLog(
      workflowId,
      MonitorEventType.EXECUTION_ERROR,
      'Error',
      error,
      { nodeId, level: 'error' }
    );
  }

  // ==================== Token 和成本追踪 ====================

  /**
   * 更新 Token 使用量
   */
  updateTokenUsage(
    workflowId: string,
    nodeId: string,
    usage: Partial<TokenUsage>
  ): void {
    const workflowStatus = this.workflowStatuses.get(workflowId);
    const nodeStatus = this.nodeStatuses.get(nodeId);

    const delta: TokenUsage = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      total: (usage.input ?? 0) + (usage.output ?? 0),
    };

    if (workflowStatus) {
      workflowStatus.tokenUsage = mergeTokenUsage(workflowStatus.tokenUsage, delta);
      workflowStatus.estimatedCost = calculateCost(workflowStatus.tokenUsage, this.config.tokenPricing);
    }

    if (nodeStatus) {
      nodeStatus.tokenUsage = mergeTokenUsage(nodeStatus.tokenUsage, delta);
    }

    // 记录到历史
    this.tokenHistory.push({
      timestamp: Date.now(),
      usage: delta,
    });

    // 清理旧历史
    const cutoff = Date.now() - this.config.metricsWindowSizeMs * 10;
    while (this.tokenHistory.length > 0 && this.tokenHistory[0].timestamp < cutoff) {
      this.tokenHistory.shift();
    }

    this.emitEvent({
      type: MonitorEventType.TOKEN_USAGE_UPDATE,
      workflowId,
      nodeId,
      timestamp: Date.now(),
      data: {
        delta,
        workflowTotal: workflowStatus?.tokenUsage,
        nodeTotal: nodeStatus?.tokenUsage,
      },
    });
  }

  /**
   * 获取 Token 使用统计
   */
  getTokenUsageStats(workflowId: string): TokenUsage | undefined {
    return this.workflowStatuses.get(workflowId)?.tokenUsage;
  }

  /**
   * 获取成本估算
   */
  getEstimatedCost(workflowId: string): number | undefined {
    return this.workflowStatuses.get(workflowId)?.estimatedCost;
  }

  // ==================== 日志管理 ====================

  /**
   * 获取执行日志
   */
  getLogs(
    workflowId: string,
    options?: {
      nodeId?: string;
      types?: MonitorEventType[];
      level?: 'info' | 'warning' | 'error' | 'debug';
      limit?: number;
      offset?: number;
    }
  ): ExecutionLogEntry[] {
    let filtered = this.logs.filter((log) => log.workflowId === workflowId);

    if (options?.nodeId) {
      filtered = filtered.filter((log) => log.nodeId === options.nodeId);
    }

    if (options?.types && options.types.length > 0) {
      filtered = filtered.filter((log) => options.types!.includes(log.type));
    }

    if (options?.level) {
      filtered = filtered.filter((log) => log.level === options.level);
    }

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * 获取所有日志
   */
  getAllLogs(limit?: number): ExecutionLogEntry[] {
    return limit ? this.logs.slice(-limit) : [...this.logs];
  }

  // ==================== 统计和指标 ====================

  /**
   * 获取资源使用统计
   */
  getResourceUsageStats(workflowId: string, timeRange?: { start: number; end: number }): ResourceUsageStats | undefined {
    const workflowStatus = this.workflowStatuses.get(workflowId);
    if (!workflowStatus) return undefined;

    const nodes = this.getWorkflowNodes(workflowId);
    const now = Date.now();
    const start = timeRange?.start ?? workflowStatus.startedAt ?? now;
    const end = timeRange?.end ?? now;

    let totalDuration = 0;
    let errorCount = 0;
    const totalTokens = { ...EMPTY_TOKEN_USAGE };
    let executionCount = 0;

    for (const node of nodes) {
      if (node.duration) totalDuration += node.duration;
      if (node.status === 'failed') errorCount++;
      totalTokens.input += node.tokenUsage.input;
      totalTokens.output += node.tokenUsage.output;
      totalTokens.total += node.tokenUsage.total;
      executionCount += node.executionCount;
    }

    const costBreakdown = {
      inputCost: (totalTokens.input / 1_000_000) * this.config.tokenPricing.input,
      outputCost: (totalTokens.output / 1_000_000) * this.config.tokenPricing.output,
      totalCost: workflowStatus.estimatedCost,
    };

    return {
      workflowId,
      timeRange: { start, end },
      totalTokens,
      totalDuration,
      nodeExecutionCount: executionCount,
      avgExecutionTime: executionCount > 0 ? totalDuration / executionCount : 0,
      avgTokensPerExecution: executionCount > 0
        ? {
            input: Math.round(totalTokens.input / executionCount),
            output: Math.round(totalTokens.output / executionCount),
            total: Math.round(totalTokens.total / executionCount),
          }
        : { ...EMPTY_TOKEN_USAGE },
      errorCount,
      errorRate: executionCount > 0 ? errorCount / executionCount : 0,
      estimatedCost: workflowStatus.estimatedCost,
      costBreakdown,
    };
  }

  /**
   * 获取实时指标
   */
  getRealtimeMetrics(): RealtimeMetrics {
    const now = Date.now();
    const windowStart = now - this.config.metricsWindowSizeMs;

    // 计算窗口内的 Token 速率
    const windowTokens = this.tokenHistory
      .filter((t) => t.timestamp >= windowStart)
      .reduce((sum, t) => sum + t.usage.total, 0);

    const tokenRate = (windowTokens / this.config.metricsWindowSizeMs) * 60000; // tokens/min

    // 计算运行中的工作流和节点
    const activeWorkflows = this.getActiveWorkflows();
    const runningNodes = Array.from(this.nodeStatuses.values()).filter(
      (n) => n.status === 'running'
    );

    // 平均响应时间
    const completedNodes = Array.from(this.nodeStatuses.values()).filter(
      (n) => n.duration !== undefined
    );
    const avgResponseTime = completedNodes.length > 0
      ? completedNodes.reduce((sum, n) => sum + (n.duration ?? 0), 0) / completedNodes.length
      : 0;

    // 系统负载 (简单估算)
    const systemLoad = (activeWorkflows.length * 0.3 + runningNodes.length * 0.1);

    return {
      activeWorkflows: activeWorkflows.length,
      runningNodes: runningNodes.length,
      tokenRate: Math.round(tokenRate),
      requestRate: Math.round((this.tokenHistory.filter(t => t.timestamp >= windowStart).length / this.config.metricsWindowSizeMs) * 60000),
      avgResponseTime: Math.round(avgResponseTime),
      systemLoad: Math.min(systemLoad, 1.0),
      timestamp: now,
    };
  }

  // ==================== 清理和管理 ====================

  /**
   * 清除工作流数据
   */
  clearWorkflow(workflowId: string): void {
    this.workflowStatuses.delete(workflowId);

    // 删除相关节点
    for (const [nodeId, status] of this.nodeStatuses.entries()) {
      if (status.workflowId === workflowId) {
        this.nodeStatuses.delete(nodeId);
      }
    }

    // 可选：删除相关日志
    // this.logs = this.logs.filter(log => log.workflowId !== workflowId);
  }

  /**
   * 清理过期日志
   */
  cleanupExpiredLogs(): number {
    const cutoff = Date.now() - this.config.logRetentionMs;
    const before = this.logs.length;

    while (this.logs.length > 0 && this.logs[0].timestamp < cutoff) {
      this.logs.shift();
    }

    // 同时限制最大条数
    while (this.logs.length > this.config.maxLogEntries) {
      this.logs.shift();
    }

    return before - this.logs.length;
  }

  /**
   * 重置监控器
   */
  reset(): void {
    this.workflowStatuses.clear();
    this.nodeStatuses.clear();
    this.logs.length = 0;
    this.tokenHistory.length = 0;
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.reset();
    this.listeners.clear();
  }

  // ==================== 事件监听 ====================

  /**
   * 添加监听器
   */
  addListener(listener: MonitorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 移除监听器
   */
  removeListener(listener: MonitorListener): void {
    this.listeners.delete(listener);
  }

  // ==================== 私有方法 ====================

  private addLog(
    workflowId: string,
    type: MonitorEventType,
    title: string,
    content: string,
    options?: {
      nodeId?: string;
      level?: 'info' | 'warning' | 'error' | 'debug';
      duration?: number;
      metadata?: Record<string, unknown>;
    }
  ): ExecutionLogEntry {
    const entry = createExecutionLogEntry(workflowId, type, title, content, options);

    this.logs.push(entry);

    // 限制日志数量
    while (this.logs.length > this.config.maxLogEntries) {
      this.logs.shift();
    }

    return entry;
  }

  private emitEvent(event: MonitorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('RuntimeMonitor listener error:', error);
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const activeWorkflows = this.getActiveWorkflows();
      for (const workflow of activeWorkflows) {
        this.emitEvent({
          type: MonitorEventType.HEARTBEAT,
          workflowId: workflow.workflowId,
          timestamp: Date.now(),
          data: {
            status: workflow.status,
            currentNodeId: workflow.currentNodeId,
            tokenUsage: workflow.tokenUsage,
          },
        });
      }
    }, this.config.heartbeatIntervalMs);
  }
}

// 全局实例
let globalMonitor: RuntimeMonitor | undefined;

/**
 * 获取全局 RuntimeMonitor 实例
 */
export function getRuntimeMonitor(config?: Partial<MonitorConfig>): RuntimeMonitor {
  if (!globalMonitor) {
    globalMonitor = new RuntimeMonitor(config);
  }
  return globalMonitor;
}

/**
 * 重置全局实例
 */
export function resetRuntimeMonitor(): void {
  if (globalMonitor) {
    globalMonitor.destroy();
    globalMonitor = undefined;
  }
}

export * from './types';
