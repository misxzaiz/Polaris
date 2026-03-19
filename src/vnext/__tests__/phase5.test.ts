/**
 * Phase 5 工程增强模块测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Interrupt Inbox
import {
  InterruptInbox,
  InterruptType,
  InterruptPriority,
  InterruptStatus,
  UserInputType,
  resetInterruptInbox,
} from '../interrupt';

// Runtime Monitor
import {
  RuntimeMonitor,
  MonitorEventType,
  resetRuntimeMonitor,
} from '../monitor';

// Workflow Persistence
import {
  WorkflowPersistence,
  MemoryStorage,
  StorageType,
  SnapshotType,
  resetWorkflowPersistence,
} from '../persistence';

// Error Recovery
import {
  ErrorRecovery,
  ErrorType,
  ErrorSeverity,
  RecoveryStrategy,
  RecoveryStatus,
  resetErrorRecovery,
} from '../recovery';

// 测试用的 Workflow 和 Node 数据
import type { Workflow, WorkflowNode } from '../types';

const createTestWorkflow = (id: string = 'test-workflow'): Workflow => ({
  id,
  name: 'Test Workflow',
  status: 'IDLE',
  mode: 'continuous',
  priority: 1,
  nodes: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const createTestNode = (id: string = 'test-node', workflowId: string = 'test-workflow'): WorkflowNode => ({
  id,
  workflowId,
  name: 'Test Node',
  role: 'developer',
  state: 'IDLE',
  triggerType: 'start',
  nextNodes: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// ==================== Interrupt Inbox Tests ====================

describe('InterruptInbox', () => {
  let inbox: InterruptInbox;

  beforeEach(() => {
    resetInterruptInbox();
    inbox = new InterruptInbox();
  });

  afterEach(() => {
    inbox.destroy();
  });

  describe('中断请求管理', () => {
    it('应该创建并添加中断请求', () => {
      const request = inbox.createInterrupt(
        'workflow-1',
        InterruptType.USER_PAUSE,
        'Pause Request',
        'User requested pause'
      );

      expect(request.id).toBeDefined();
      expect(request.workflowId).toBe('workflow-1');
      expect(request.type).toBe(InterruptType.USER_PAUSE);
      expect(request.status).toBe(InterruptStatus.PENDING);
    });

    it('应该按优先级排序中断', () => {
      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Low', 'low', { priority: InterruptPriority.LOW });
      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Urgent', 'urgent', { priority: InterruptPriority.URGENT });
      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Normal', 'normal', { priority: InterruptPriority.NORMAL });

      const pending = inbox.getPendingInterrupts('w1');
      expect(pending).toHaveLength(3);
      expect(pending[0].priority).toBe(InterruptPriority.URGENT);
      expect(pending[2].priority).toBe(InterruptPriority.LOW);
    });

    it('应该确认中断', () => {
      const request = inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Test', 'test');
      const acknowledged = inbox.acknowledgeInterrupt(request.id);

      // acknowledgeInterrupt 更新状态为 ACKNOWLEDGED
      expect(acknowledged?.status).toBe(InterruptStatus.ACKNOWLEDGED);
      // ACKNOWLEDGED 状态的中断仍保留在列表中
      const pending = inbox.getPendingInterrupts('w1');
      expect(pending).toHaveLength(1);
    });

    it('应该完成中断处理', () => {
      const request = inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Test', 'test');
      inbox.completeInterrupt(request.id, 'Handled');

      expect(inbox.hasPendingInterrupts('w1')).toBe(false);
    });

    it('应该忽略中断', () => {
      const request = inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Test', 'test');
      inbox.dismissInterrupt(request.id, 'Not needed');

      expect(inbox.hasPendingInterrupts('w1')).toBe(false);
    });

    it('应该检测紧急中断', () => {
      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Normal', 'normal');
      expect(inbox.hasUrgentInterrupt('w1')).toBe(false);

      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Urgent', 'urgent', {
        priority: InterruptPriority.URGENT,
      });
      expect(inbox.hasUrgentInterrupt('w1')).toBe(true);
    });
  });

  describe('用户输入管理', () => {
    it('应该添加用户输入', () => {
      const input = inbox.createUserInput('w1', UserInputType.SUPPLEMENT, 'Supplement', 'Additional info');

      expect(input.id).toBeDefined();
      expect(input.workflowId).toBe('w1');
      expect(input.type).toBe(UserInputType.SUPPLEMENT);
      expect(input.processed).toBe(false);
    });

    it('应该消费用户输入', () => {
      const input = inbox.createUserInput('w1', UserInputType.SUPPLEMENT, 'Test', 'test');
      inbox.consumeUserInput(input.id, 'node-1');

      const pending = inbox.getPendingUserInputs('w1');
      expect(pending).toHaveLength(0);

      const history = inbox.getProcessedUserInputs('w1');
      expect(history).toHaveLength(1);
      expect(history[0].processedByNode).toBe('node-1');
    });

    it('应该提供快捷方法', () => {
      inbox.requestPause('w1', 'Need a break');
      inbox.addSupplement('w1', 'More info');
      inbox.addCorrection('w1', 'Fix this');
      inbox.emergencyStop('w1', 'Critical issue');

      expect(inbox.hasPendingInterrupts('w1')).toBe(true);
      expect(inbox.hasPendingUserInputs('w1')).toBe(true);
      expect(inbox.hasUrgentInterrupt('w1')).toBe(true);
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Test', 'test');
      inbox.createUserInput('w1', UserInputType.SUPPLEMENT, 'Test', 'test');
      inbox.createUserInput('w1', UserInputType.CORRECTION, 'Test', 'test');

      const stats = inbox.getStats('w1');
      expect(stats.pendingInterrupts).toBe(1);
      expect(stats.pendingUserInputs).toBe(2);
      expect(stats.processedUserInputs).toBe(0);
    });
  });

  describe('事件监听', () => {
    it('应该触发事件', () => {
      const listener = vi.fn();
      inbox.addListener(listener);

      inbox.createInterrupt('w1', InterruptType.USER_PAUSE, 'Test', 'test');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'interrupt_added',
          workflowId: 'w1',
        })
      );
    });
  });
});

// ==================== Runtime Monitor Tests ====================

describe('RuntimeMonitor', () => {
  let monitor: RuntimeMonitor;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
  });

  afterEach(() => {
    monitor.destroy();
  });

  describe('工作流状态管理', () => {
    it('应该注册工作流', () => {
      monitor.registerWorkflow('w1', 'Test Workflow');
      const status = monitor.getWorkflowStatus('w1');

      expect(status).toBeDefined();
      expect(status?.workflowName).toBe('Test Workflow');
      expect(status?.status).toBe('idle');
    });

    it('应该启动工作流', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.startWorkflow('w1', 5);

      const status = monitor.getWorkflowStatus('w1');
      expect(status?.status).toBe('running');
      expect(status?.totalNodes).toBe(5);
      expect(status?.startedAt).toBeDefined();
    });

    it('应该暂停和恢复工作流', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.startWorkflow('w1', 3);

      monitor.pauseWorkflow('w1');
      expect(monitor.getWorkflowStatus('w1')?.status).toBe('paused');

      monitor.resumeWorkflow('w1');
      expect(monitor.getWorkflowStatus('w1')?.status).toBe('running');
    });

    it('应该完成工作流', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.startWorkflow('w1', 3);
      monitor.completeWorkflow('w1');

      const status = monitor.getWorkflowStatus('w1');
      expect(status?.status).toBe('completed');
      expect(status?.duration).toBeDefined();
    });
  });

  describe('节点状态管理', () => {
    it('应该注册节点', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      const status = monitor.getNodeStatus('n1');
      expect(status).toBeDefined();
      expect(status?.nodeName).toBe('Node 1');
      expect(status?.status).toBe('idle');
    });

    it('应该跟踪节点执行', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      monitor.startNode('w1', 'n1', 1);
      expect(monitor.getNodeStatus('n1')?.status).toBe('running');
      expect(monitor.getNodeStatus('n1')?.executionCount).toBe(1);

      monitor.completeNode('w1', 'n1', 'Done');
      expect(monitor.getNodeStatus('n1')?.status).toBe('completed');
      expect(monitor.getNodeStatus('n1')?.duration).toBeDefined();
    });

    it('应该跟踪节点失败', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      monitor.startNode('w1', 'n1');
      monitor.failNode('w1', 'n1', 'Something went wrong');

      const status = monitor.getNodeStatus('n1');
      expect(status?.status).toBe('failed');
      expect(status?.lastError).toBe('Something went wrong');
    });
  });

  describe('执行事件追踪', () => {
    it('应该记录思考过程', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      const listener = vi.fn();
      monitor.addListener(listener);

      monitor.recordThinking('w1', 'n1', 'Analyzing the problem...');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MonitorEventType.EXECUTION_THINKING,
          nodeId: 'n1',
        })
      );
    });

    it('应该记录工具调用', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      monitor.recordToolCall('w1', 'n1', 'readFile', { path: '/test.ts' });

      const logs = monitor.getLogs('w1', { nodeId: 'n1' });
      expect(logs.some(l => l.type === MonitorEventType.EXECUTION_TOOL_CALL)).toBe(true);
    });
  });

  describe('Token 和成本追踪', () => {
    it('应该更新 Token 使用量', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      monitor.updateTokenUsage('w1', 'n1', { input: 100, output: 50 });
      monitor.updateTokenUsage('w1', 'n1', { input: 50, output: 30 });

      const workflowStatus = monitor.getWorkflowStatus('w1');
      expect(workflowStatus?.tokenUsage.input).toBe(150);
      expect(workflowStatus?.tokenUsage.output).toBe(80);
      expect(workflowStatus?.tokenUsage.total).toBe(230);
    });

    it('应该估算成本', () => {
      monitor.registerWorkflow('w1', 'Test');
      monitor.registerNode('n1', 'Node 1', 'w1');

      monitor.updateTokenUsage('w1', 'n1', { input: 1000000, output: 500000 });

      const cost = monitor.getEstimatedCost('w1');
      // $3/1M input + $15/1M output = $3 + $7.5 = $10.5
      expect(cost).toBeCloseTo(10.5, 1);
    });
  });

  describe('实时指标', () => {
    it('应该返回实时指标', () => {
      monitor.registerWorkflow('w1', 'Test 1');
      monitor.registerWorkflow('w2', 'Test 2');
      monitor.startWorkflow('w1', 3);

      const metrics = monitor.getRealtimeMetrics();
      expect(metrics.activeWorkflows).toBe(1);
    });
  });
});

// ==================== Workflow Persistence Tests ====================

describe('WorkflowPersistence', () => {
  let persistence: WorkflowPersistence;

  beforeEach(() => {
    resetWorkflowPersistence();
    persistence = new WorkflowPersistence();
  });

  afterEach(() => {
    persistence.destroy();
  });

  describe('工作流管理', () => {
    it('应该注册工作流', () => {
      const workflow = createTestWorkflow();
      const nodes = [createTestNode()];

      persistence.registerWorkflow(workflow, nodes);

      expect(persistence.getWorkflow(workflow.id)).toEqual(workflow);
      expect(persistence.getNodes(workflow.id)).toEqual(nodes);
    });

    it('应该更新工作流', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      persistence.updateWorkflow({ ...workflow, name: 'Updated Name' });

      const updated = persistence.getWorkflow(workflow.id);
      expect(updated?.name).toBe('Updated Name');
    });

    it('应该更新节点', () => {
      const workflow = createTestWorkflow();
      const node = createTestNode();
      persistence.registerWorkflow(workflow, [node]);

      persistence.updateNode(workflow.id, { ...node, name: 'Updated Node' });

      const updated = persistence.getNode(workflow.id, node.id);
      expect(updated?.name).toBe('Updated Node');
    });
  });

  describe('快照管理', () => {
    it('应该创建快照', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      const snapshot = persistence.createSnapshot(workflow.id, SnapshotType.MANUAL, {
        description: 'Test snapshot',
      });

      expect(snapshot).toBeDefined();
      expect(snapshot?.workflowId).toBe(workflow.id);
      expect(snapshot?.type).toBe(SnapshotType.MANUAL);
    });

    it('应该获取快照列表', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      persistence.createSnapshot(workflow.id, SnapshotType.MANUAL);
      persistence.createSnapshot(workflow.id, SnapshotType.AUTO);

      const snapshots = persistence.getSnapshots(workflow.id);
      expect(snapshots).toHaveLength(2);
    });

    it('应该恢复快照', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      const snapshot = persistence.createSnapshot(workflow.id, SnapshotType.MANUAL);

      // 修改工作流
      persistence.updateWorkflow({ ...workflow, name: 'Changed' });

      // 恢复快照
      const restored = persistence.restoreSnapshot(workflow.id, snapshot!.id);
      expect(restored).toBe(true);

      const restoredWorkflow = persistence.getWorkflow(workflow.id);
      expect(restoredWorkflow?.name).toBe('Test Workflow');
    });

    it('应该删除快照', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      const snapshot = persistence.createSnapshot(workflow.id, SnapshotType.MANUAL);
      persistence.deleteSnapshot(workflow.id, snapshot!.id);

      expect(persistence.getSnapshots(workflow.id)).toHaveLength(0);
    });
  });

  describe('保存和加载', () => {
    it('应该保存和加载工作流', async () => {
      const workflow = createTestWorkflow();
      const nodes = [createTestNode()];
      persistence.registerWorkflow(workflow, nodes);

      const saved = await persistence.save(workflow.id);
      expect(saved).toBe(true);

      // 清除内存
      persistence.removeWorkflow(workflow.id);
      expect(persistence.getWorkflow(workflow.id)).toBeUndefined();

      // 重新加载
      const loaded = await persistence.load(workflow.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.workflow.name).toBe('Test Workflow');
      expect(loaded?.nodes).toHaveLength(1);
    });

    it('应该跟踪未保存的更改', () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      expect(persistence.hasUnsavedChanges(workflow.id)).toBe(false);

      persistence.updateWorkflow({ ...workflow, name: 'Changed' });

      expect(persistence.hasUnsavedChanges(workflow.id)).toBe(true);
    });
  });

  describe('导入导出', () => {
    it('应该导出和导入工作流', async () => {
      const workflow = createTestWorkflow();
      persistence.registerWorkflow(workflow, []);

      const json = await persistence.exportToJson([workflow.id]);

      // 清除并重新导入
      persistence.removeWorkflow(workflow.id);

      const result = await persistence.importFromJson(json);
      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });
});

// ==================== Error Recovery Tests ====================

describe('ErrorRecovery', () => {
  let recovery: ErrorRecovery;

  beforeEach(() => {
    resetErrorRecovery();
    recovery = new ErrorRecovery({ enableAutoRecovery: false });
  });

  afterEach(() => {
    recovery.destroy();
  });

  describe('错误捕获', () => {
    it('应该捕获错误', () => {
      const error = recovery.captureError(
        'w1',
        ErrorType.NETWORK,
        'Connection failed',
        { severity: ErrorSeverity.MEDIUM }
      );

      expect(error.id).toBeDefined();
      expect(error.workflowId).toBe('w1');
      expect(error.type).toBe(ErrorType.NETWORK);
      expect(error.severity).toBe(ErrorSeverity.MEDIUM);
      expect(error.recoveryStatus).toBe(RecoveryStatus.PENDING);
    });

    it('应该从异常捕获错误', () => {
      const exception = new Error('Request timeout');
      const error = recovery.captureException('w1', exception, {
        nodeId: 'n1',
      });

      expect(error.type).toBe(ErrorType.TIMEOUT);
      expect(error.nodeId).toBe('n1');
    });

    it('应该获取工作流的错误列表', () => {
      recovery.captureError('w1', ErrorType.NETWORK, 'Error 1');
      recovery.captureError('w1', ErrorType.API, 'Error 2');
      recovery.captureError('w2', ErrorType.EXECUTION, 'Error 3');

      const errors = recovery.getWorkflowErrors('w1');
      expect(errors).toHaveLength(2);
    });
  });

  describe('恢复机制', () => {
    it('应该尝试恢复', async () => {
      const error = recovery.captureError(
        'w1',
        ErrorType.NETWORK,
        'Connection failed',
        { severity: ErrorSeverity.LOW }
      );

      const result = await recovery.attemptRecovery(error.id);
      expect(result.success).toBe(true);
      expect(result.strategy).toBe(RecoveryStrategy.RETRY_IMMEDIATE);
    });

    it('应该跳过恢复', () => {
      const error = recovery.captureError('w1', ErrorType.NETWORK, 'Error');

      recovery.skipRecovery(error.id);

      const updated = recovery.getError(error.id);
      expect(updated?.recoveryStatus).toBe(RecoveryStatus.SKIPPED);
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      recovery.captureError('w1', ErrorType.NETWORK, 'Error 1', { severity: ErrorSeverity.LOW });
      recovery.captureError('w1', ErrorType.API, 'Error 2', { severity: ErrorSeverity.HIGH });
      recovery.captureError('w1', ErrorType.EXECUTION, 'Error 3', { severity: ErrorSeverity.MEDIUM });

      const stats = recovery.getStats('w1');
      expect(stats.total).toBe(3);
      expect(stats.byType[ErrorType.NETWORK]).toBe(1);
      expect(stats.bySeverity[ErrorSeverity.HIGH]).toBe(1);
    });

    it('应该计算恢复成功率', async () => {
      const error1 = recovery.captureError('w1', ErrorType.NETWORK, 'Error 1', { severity: ErrorSeverity.LOW });
      const error2 = recovery.captureError('w1', ErrorType.API, 'Error 2', { severity: ErrorSeverity.LOW });

      await recovery.attemptRecovery(error1.id);

      const rate = recovery.getRecoveryRate('w1');
      expect(rate).toBe(0.5);
    });
  });

  describe('事件监听', () => {
    it('应该触发错误事件', () => {
      const listener = vi.fn();
      recovery.addListener(listener);

      recovery.captureError('w1', ErrorType.NETWORK, 'Error');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error_occurred',
          workflowId: 'w1',
        })
      );
    });
  });

  describe('清理', () => {
    it('应该清除错误记录', () => {
      const error = recovery.captureError('w1', ErrorType.NETWORK, 'Error');

      recovery.clearError(error.id);

      expect(recovery.getError(error.id)).toBeUndefined();
    });

    it('应该清除工作流错误', () => {
      recovery.captureError('w1', ErrorType.NETWORK, 'Error 1');
      recovery.captureError('w1', ErrorType.API, 'Error 2');

      const count = recovery.clearWorkflowErrors('w1');

      expect(count).toBe(2);
      expect(recovery.getWorkflowErrors('w1')).toHaveLength(0);
    });
  });
});
