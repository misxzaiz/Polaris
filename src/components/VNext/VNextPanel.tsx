/**
 * VNextPanel - Scheduler vNext 工作流管理面板
 *
 * 集成 vnext 可视化组件，提供工作流创建、管理和监控功能
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Play,
  Pause,
  Square,
  Plus,
  RefreshCw,
  Trash2,
  ChevronRight,
  Activity,
  Layers,
  Clock,
  Zap,
} from 'lucide-react';
import {
  // vnext 核心模块
  WorkflowRuntime,
  WorkflowPersistence,
  getWorkflowRuntime,
  getWorkflowPersistence,
  resetWorkflowRuntime,
  resetWorkflowPersistence,
  // 类型
  type Workflow,
  type WorkflowNode,
  type WorkflowStatus,
  type NodeStatus,
  WorkflowStatus as WS,
  NodeStatus as NS,
  // 可视化组件
  SimpleWorkflowDiagram,
  NodeStatusGrid,
  SimpleProgressBar,
  QuickStatsBar,
  SimpleTimeline,
  type NodeStatusConfig,
  getNodeStatusConfig,
} from '@/vnext';
import { createLogger } from '@/utils/logger';

const log = createLogger('VNextPanel');

/** 格式化持续时间 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** 状态颜色映射 */
const statusColors: Record<WorkflowStatus, string> = {
  [WS.IDLE]: 'bg-gray-500',
  [WS.READY]: 'bg-blue-500',
  [WS.RUNNING]: 'bg-green-500 animate-pulse',
  [WS.PAUSED]: 'bg-yellow-500',
  [WS.COMPLETED]: 'bg-emerald-500',
  [WS.FAILED]: 'bg-red-500',
  [WS.CANCELLED]: 'bg-gray-400',
  [WS.WAITING]: 'bg-orange-500',
  [WS.WAITING_FOR_EVENTS]: 'bg-orange-400',
  [WS.COMPACTING_MEMORY]: 'bg-purple-500',
  [WS.SKIPPED]: 'bg-gray-300',
};

/** 状态标签 */
const statusLabels: Record<WorkflowStatus, string> = {
  [WS.IDLE]: '空闲',
  [WS.READY]: '就绪',
  [WS.RUNNING]: '运行中',
  [WS.PAUSED]: '已暂停',
  [WS.COMPLETED]: '已完成',
  [WS.FAILED]: '失败',
  [WS.CANCELLED]: '已取消',
  [WS.WAITING]: '等待中',
  [WS.WAITING_FOR_EVENTS]: '等待事件',
  [WS.COMPACTING_MEMORY]: '压缩内存',
  [WS.SKIPPED]: '已跳过',
};

interface VNextPanelProps {
  /** 是否填充剩余空间 */
  fillRemaining?: boolean;
}

export function VNextPanel({ fillRemaining = false }: VNextPanelProps) {
  const { t } = useTranslation('common');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'workflows' | 'monitor' | 'templates'>('workflows');

  // 获取选中的工作流
  const selectedWorkflow = useMemo(() => {
    return workflows.find(w => w.id === selectedWorkflowId) || null;
  }, [workflows, selectedWorkflowId]);

  // 刷新工作流列表
  const refreshWorkflows = useCallback(async () => {
    setIsLoading(true);
    try {
      const persistence = getWorkflowPersistence();
      const allWorkflows = persistence.getAllWorkflows();
      setWorkflows(allWorkflows);
    } catch (error) {
      log.error('刷新工作流列表失败', error as Error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 初始化
  useEffect(() => {
    refreshWorkflows();
  }, [refreshWorkflows]);

  // 创建示例工作流
  const createSampleWorkflow = useCallback(() => {
    const workflow: Workflow = {
      id: `workflow-${Date.now()}`,
      name: `工作流 ${workflows.length + 1}`,
      description: '示例工作流',
      status: WS.IDLE,
      nodes: [
        {
          id: 'node-1',
          name: '需求分析',
          type: 'task',
          status: NS.IDLE,
          profileId: 'developer-v1',
          dependencies: [],
          triggers: [],
          conditions: {},
        },
        {
          id: 'node-2',
          name: '代码实现',
          type: 'task',
          status: NS.IDLE,
          profileId: 'developer-v1',
          dependencies: ['node-1'],
          triggers: [],
          conditions: {},
        },
        {
          id: 'node-3',
          name: '代码审查',
          type: 'task',
          status: NS.IDLE,
          profileId: 'developer-v1',
          dependencies: ['node-2'],
          triggers: [],
          conditions: {},
        },
        {
          id: 'node-4',
          name: '测试验证',
          type: 'task',
          status: NS.IDLE,
          profileId: 'tester-v1',
          dependencies: ['node-3'],
          triggers: [],
          conditions: {},
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      priority: 5,
      tags: ['demo'],
    };

    const persistence = getWorkflowPersistence();
    persistence.registerWorkflow(workflow);
    setWorkflows(prev => [...prev, workflow]);
    setSelectedWorkflowId(workflow.id);
  }, [workflows.length]);

  // 启动工作流
  const startWorkflow = useCallback(async (workflowId: string) => {
    try {
      const runtime = getWorkflowRuntime();
      await runtime.start(workflowId);
      await refreshWorkflows();
    } catch (error) {
      log.error('启动工作流失败', error as Error);
    }
  }, [refreshWorkflows]);

  // 暂停工作流
  const pauseWorkflow = useCallback(async (workflowId: string) => {
    try {
      const runtime = getWorkflowRuntime();
      await runtime.pause(workflowId);
      await refreshWorkflows();
    } catch (error) {
      log.error('暂停工作流失败', error as Error);
    }
  }, [refreshWorkflows]);

  // 恢复工作流
  const resumeWorkflow = useCallback(async (workflowId: string) => {
    try {
      const runtime = getWorkflowRuntime();
      await runtime.resume(workflowId);
      await refreshWorkflows();
    } catch (error) {
      log.error('恢复工作流失败', error as Error);
    }
  }, [refreshWorkflows]);

  // 停止工作流
  const stopWorkflow = useCallback(async (workflowId: string) => {
    try {
      const runtime = getWorkflowRuntime();
      await runtime.stop(workflowId);
      await refreshWorkflows();
    } catch (error) {
      log.error('停止工作流失败', error as Error);
    }
  }, [refreshWorkflows]);

  // 删除工作流
  const deleteWorkflow = useCallback((workflowId: string) => {
    const persistence = getWorkflowPersistence();
    persistence.removeWorkflow(workflowId);
    setWorkflows(prev => prev.filter(w => w.id !== workflowId));
    if (selectedWorkflowId === workflowId) {
      setSelectedWorkflowId(null);
    }
  }, [selectedWorkflowId]);

  // 计算统计信息
  const stats = useMemo(() => {
    const running = workflows.filter(w => w.status === WS.RUNNING).length;
    const completed = workflows.filter(w => w.status === WS.COMPLETED).length;
    const failed = workflows.filter(w => w.status === WS.FAILED).length;
    return { running, completed, failed, total: workflows.length };
  }, [workflows]);

  return (
    <div className={`flex flex-col h-full bg-background ${fillRemaining ? 'flex-1' : ''}`}>
      {/* 头部标签页 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background-elevated">
        <button
          onClick={() => setActiveTab('workflows')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'workflows'
              ? 'bg-primary/20 text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-background-surface'
          }`}
        >
          <Layers className="w-3.5 h-3.5 inline mr-1" />
          工作流
        </button>
        <button
          onClick={() => setActiveTab('monitor')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'monitor'
              ? 'bg-primary/20 text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-background-surface'
          }`}
        >
          <Activity className="w-3.5 h-3.5 inline mr-1" />
          监控
        </button>
        <button
          onClick={() => setActiveTab('templates')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'templates'
              ? 'bg-primary/20 text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-background-surface'
          }`}
        >
          <Zap className="w-3.5 h-3.5 inline mr-1" />
          模板
        </button>
      </div>

      {/* 统计栏 */}
      <QuickStatsBar
        stats={[
          { label: '运行中', value: stats.running, color: 'green' },
          { label: '已完成', value: stats.completed, color: 'blue' },
          { label: '失败', value: stats.failed, color: 'red' },
          { label: '总计', value: stats.total, color: 'gray' },
        ]}
      />

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden flex">
        {/* 工作流列表 */}
        {activeTab === 'workflows' && (
          <>
            <div className="w-64 border-r border-border flex flex-col">
              {/* 工具栏 */}
              <div className="flex items-center gap-1 p-2 border-b border-border">
                <button
                  onClick={createSampleWorkflow}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-white rounded hover:bg-primary/90"
                >
                  <Plus className="w-3 h-3" />
                  新建
                </button>
                <button
                  onClick={refreshWorkflows}
                  disabled={isLoading}
                  className="p-1.5 text-text-muted hover:text-text-primary hover:bg-background-surface rounded"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* 列表 */}
              <div className="flex-1 overflow-auto">
                {workflows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-text-muted text-xs">
                    <Layers className="w-8 h-8 mb-2 opacity-50" />
                    <p>暂无工作流</p>
                    <p className="mt-1">点击"新建"创建示例工作流</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {workflows.map(workflow => (
                      <div
                        key={workflow.id}
                        onClick={() => setSelectedWorkflowId(workflow.id)}
                        className={`p-2 cursor-pointer transition-colors ${
                          selectedWorkflowId === workflow.id
                            ? 'bg-primary/10 border-l-2 border-primary'
                            : 'hover:bg-background-surface border-l-2 border-transparent'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-text-primary truncate">
                            {workflow.name}
                          </span>
                          <span className={`w-2 h-2 rounded-full ${statusColors[workflow.status]}`} />
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-text-muted">
                            {workflow.nodes.length} 节点
                          </span>
                          <span className="text-xs text-text-muted">•</span>
                          <span className="text-xs text-text-muted">
                            {formatRelativeTime(workflow.updatedAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 工作流详情 */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {selectedWorkflow ? (
                <>
                  {/* 详情头部 */}
                  <div className="p-3 border-b border-border bg-background-elevated">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">
                          {selectedWorkflow.name}
                        </h3>
                        <p className="text-xs text-text-muted mt-0.5">
                          {selectedWorkflow.description || '无描述'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {selectedWorkflow.status === WS.IDLE && (
                          <button
                            onClick={() => startWorkflow(selectedWorkflow.id)}
                            className="p-1.5 text-green-500 hover:bg-green-500/10 rounded"
                            title="启动"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        )}
                        {selectedWorkflow.status === WS.RUNNING && (
                          <button
                            onClick={() => pauseWorkflow(selectedWorkflow.id)}
                            className="p-1.5 text-yellow-500 hover:bg-yellow-500/10 rounded"
                            title="暂停"
                          >
                            <Pause className="w-4 h-4" />
                          </button>
                        )}
                        {selectedWorkflow.status === WS.PAUSED && (
                          <button
                            onClick={() => resumeWorkflow(selectedWorkflow.id)}
                            className="p-1.5 text-green-500 hover:bg-green-500/10 rounded"
                            title="恢复"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        )}
                        {(selectedWorkflow.status === WS.RUNNING ||
                          selectedWorkflow.status === WS.PAUSED) && (
                          <button
                            onClick={() => stopWorkflow(selectedWorkflow.id)}
                            className="p-1.5 text-red-500 hover:bg-red-500/10 rounded"
                            title="停止"
                          >
                            <Square className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => deleteWorkflow(selectedWorkflow.id)}
                          className="p-1.5 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* 进度条 */}
                    <div className="mt-2">
                      <SimpleProgressBar
                        progress={(() => {
                          const completed = selectedWorkflow.nodes.filter(
                            n => n.status === NS.COMPLETED
                          ).length;
                          return (completed / selectedWorkflow.nodes.length) * 100;
                        })()}
                        height={4}
                        showLabel
                        label={`${selectedWorkflow.nodes.filter(n => n.status === NS.COMPLETED).length}/${selectedWorkflow.nodes.length} 节点完成`}
                      />
                    </div>
                  </div>

                  {/* 工作流图 */}
                  <div className="flex-1 overflow-auto p-3">
                    <SimpleWorkflowDiagram
                      workflow={selectedWorkflow}
                      onNodeClick={node => {
                        log.info('点击节点', node);
                      }}
                    />
                  </div>

                  {/* 节点状态列表 */}
                  <div className="border-t border-border p-2 max-h-40 overflow-auto">
                    <h4 className="text-xs font-medium text-text-muted mb-2">节点状态</h4>
                    <div className="grid grid-cols-2 gap-1">
                      {selectedWorkflow.nodes.map(node => {
                        const config = getNodeStatusConfig(node.status);
                        return (
                          <div
                            key={node.id}
                            className="flex items-center gap-2 p-1.5 rounded bg-background-surface"
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: config.color }}
                            />
                            <span className="text-xs text-text-primary truncate">
                              {node.name}
                            </span>
                            <span className="text-xs text-text-muted ml-auto">
                              {config.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
                  <ChevronRight className="w-8 h-8 mb-2 opacity-50" />
                  <p className="text-sm">选择一个工作流查看详情</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* 监控视图 */}
        {activeTab === 'monitor' && (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
            <Activity className="w-12 h-12 mb-3 opacity-50" />
            <p className="text-sm">运行时监控</p>
            <p className="text-xs mt-1">启动工作流后可查看实时数据</p>
          </div>
        )}

        {/* 模板视图 */}
        {activeTab === 'templates' && (
          <div className="flex-1 overflow-auto p-3">
            <h3 className="text-sm font-semibold text-text-primary mb-3">工作流模板</h3>
            <div className="grid grid-cols-1 gap-2">
              {[
                {
                  id: 'dev-pipeline',
                  name: '开发流水线',
                  description: '需求分析 → 开发 → 审查 → 测试',
                  nodes: 4,
                },
                {
                  id: 'feature-flow',
                  name: '功能开发流程',
                  description: '设计 → 开发 → 集成测试',
                  nodes: 3,
                },
                {
                  id: 'bug-fix',
                  name: 'Bug 修复流程',
                  description: '问题分析 → 修复 → 验证',
                  nodes: 3,
                },
              ].map(template => (
                <div
                  key={template.id}
                  className="p-3 border border-border rounded-lg hover:border-primary/50 cursor-pointer transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {template.name}
                    </span>
                    <span className="text-xs text-text-muted">{template.nodes} 节点</span>
                  </div>
                  <p className="text-xs text-text-muted mt-1">{template.description}</p>
                  <button className="mt-2 px-2 py-1 text-xs bg-primary/10 text-primary rounded hover:bg-primary/20">
                    使用模板
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default VNextPanel;
