/**
 * VNextPanel - Scheduler vNext 工作流管理面板
 *
 * 集成 vnext 可视化组件，提供工作流创建、管理和监控功能
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  ChevronRight,
  Activity,
  Layers,
  Zap,
} from 'lucide-react';
import {
  // vnext 核心模块
  getWorkflowPersistence,
  // 类型
  type Workflow,
  type WorkflowNode,
  // 可视化组件
  SimpleWorkflowDiagram,
  SimpleProgressBar,
  QuickStatsBar,
  getNodeStatusConfig,
} from '@/vnext';
import { createLogger } from '@/utils/logger';

const log = createLogger('VNextPanel');

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
const getStatusColor = (status: string): string => {
  const colors: Record<string, string> = {
    'CREATED': 'bg-gray-500',
    'PLANNING': 'bg-blue-400',
    'RUNNING': 'bg-green-500 animate-pulse',
    'WAITING_EVENT': 'bg-orange-500',
    'BLOCKED': 'bg-red-400',
    'COMPACTING_MEMORY': 'bg-purple-500',
    'FAILED': 'bg-red-500',
    'COMPLETED': 'bg-emerald-500',
    'EVOLVING': 'bg-indigo-500',
  };
  return colors[status] || 'bg-gray-400';
};

/** 状态标签 */
const getStatusLabel = (status: string): string => {
  const labels: Record<string, string> = {
    'CREATED': '已创建',
    'PLANNING': '规划中',
    'RUNNING': '运行中',
    'WAITING_EVENT': '等待事件',
    'BLOCKED': '阻塞',
    'COMPACTING_MEMORY': '压缩内存',
    'FAILED': '失败',
    'COMPLETED': '已完成',
    'EVOLVING': '进化中',
  };
  return labels[status] || status;
};

interface VNextPanelProps {
  /** 是否填充剩余空间 */
  fillRemaining?: boolean;
}

export function VNextPanel({ fillRemaining = false }: VNextPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [nodes, setNodes] = useState<Map<string, WorkflowNode[]>>(new Map());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'workflows' | 'monitor' | 'templates'>('workflows');

  // 获取选中的工作流
  const selectedWorkflow = useMemo(() => {
    return workflows.find(w => w.id === selectedWorkflowId) || null;
  }, [workflows, selectedWorkflowId]);

  // 获取选中工作流的节点
  const selectedNodes = useMemo(() => {
    if (!selectedWorkflowId) return [];
    return nodes.get(selectedWorkflowId) || [];
  }, [nodes, selectedWorkflowId]);

  // 刷新工作流列表
  const refreshWorkflows = useCallback(async () => {
    setIsLoading(true);
    try {
      const persistence = getWorkflowPersistence();
      const workflowIds = persistence.getWorkflowIds();
      const workflowList: Workflow[] = [];
      const nodesMap = new Map<string, WorkflowNode[]>();

      for (const id of workflowIds) {
        const workflow = persistence.getWorkflow(id);
        if (workflow) {
          workflowList.push(workflow);
          const workflowNodes = persistence.getNodes(id);
          nodesMap.set(id, workflowNodes);
        }
      }

      setWorkflows(workflowList);
      setNodes(nodesMap);
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
    const now = Date.now();
    const workflowId = `workflow-${now}`;

    const workflow: Workflow = {
      id: workflowId,
      name: `工作流 ${workflows.length + 1}`,
      description: '示例工作流',
      status: 'CREATED',
      mode: 'single',
      priority: 5,
      createdAt: now,
      updatedAt: now,
      tags: ['demo'],
    };

    const sampleNodes: WorkflowNode[] = [
      {
        id: 'node-1',
        name: '需求分析',
        role: 'analyst',
        workflowId,
        state: 'IDLE',
        triggerType: 'start',
        subscribeEvents: [],
        emitEvents: ['analysis-done'],
        dependencies: [],
        enabled: true,
        maxRounds: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'node-2',
        name: '代码实现',
        role: 'developer',
        workflowId,
        state: 'IDLE',
        triggerType: 'dependency',
        subscribeEvents: ['analysis-done'],
        emitEvents: ['code-done'],
        dependencies: ['node-1'],
        enabled: true,
        maxRounds: 3,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'node-3',
        name: '代码审查',
        role: 'reviewer',
        workflowId,
        state: 'IDLE',
        triggerType: 'dependency',
        subscribeEvents: ['code-done'],
        emitEvents: ['review-done'],
        dependencies: ['node-2'],
        enabled: true,
        maxRounds: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'node-4',
        name: '测试验证',
        role: 'tester',
        workflowId,
        state: 'IDLE',
        triggerType: 'dependency',
        subscribeEvents: ['review-done'],
        emitEvents: ['test-done'],
        dependencies: ['node-3'],
        enabled: true,
        maxRounds: 2,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const persistence = getWorkflowPersistence();
    persistence.registerWorkflow(workflow, sampleNodes);

    setWorkflows(prev => [...prev, workflow]);
    setNodes(prev => new Map(prev).set(workflowId, sampleNodes));
    setSelectedWorkflowId(workflow.id);
  }, [workflows.length]);

  // 删除工作流
  const deleteWorkflow = useCallback((workflowId: string) => {
    const persistence = getWorkflowPersistence();
    persistence.removeWorkflow(workflowId);
    setWorkflows(prev => prev.filter(w => w.id !== workflowId));
    setNodes(prev => {
      const newMap = new Map(prev);
      newMap.delete(workflowId);
      return newMap;
    });
    if (selectedWorkflowId === workflowId) {
      setSelectedWorkflowId(null);
    }
  }, [selectedWorkflowId]);

  // 计算统计信息
  const stats = useMemo(() => {
    const running = workflows.filter(w => w.status === 'RUNNING').length;
    const completed = workflows.filter(w => w.status === 'COMPLETED').length;
    const failed = workflows.filter(w => w.status === 'FAILED').length;
    return { running, completed, failed, total: workflows.length };
  }, [workflows]);

  // 计算节点进度
  const nodeProgress = useMemo(() => {
    if (selectedNodes.length === 0) return 0;
    const completed = selectedNodes.filter(n => n.state === 'DONE').length;
    return (completed / selectedNodes.length) * 100;
  }, [selectedNodes]);

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
                          <span className={`w-2 h-2 rounded-full ${getStatusColor(workflow.status)}`} />
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-text-muted">
                            {getStatusLabel(workflow.status)}
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
                      <div className="flex items-center justify-between text-xs text-text-muted mb-1">
                        <span>{selectedNodes.filter(n => n.state === 'DONE').length}/{selectedNodes.length} 节点完成</span>
                        <span>{nodeProgress.toFixed(0)}%</span>
                      </div>
                      <SimpleProgressBar
                        percentage={nodeProgress}
                        height="sm"
                        showLabel={false}
                      />
                    </div>
                  </div>

                  {/* 工作流图 */}
                  <div className="flex-1 overflow-auto p-3">
                    {selectedNodes.length > 0 ? (
                      <SimpleWorkflowDiagram
                        nodes={selectedNodes.map(n => ({
                          id: n.id,
                          name: n.name,
                          state: n.state,
                          role: n.role,
                          dependencies: n.dependencies,
                        }))}
                        onNodeClick={(nodeId: string) => {
                          log.info('点击节点', { nodeId });
                        }}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-text-muted">
                        <p className="text-sm">此工作流暂无节点</p>
                      </div>
                    )}
                  </div>

                  {/* 节点状态列表 */}
                  {selectedNodes.length > 0 && (
                    <div className="border-t border-border p-2 max-h-40 overflow-auto">
                      <h4 className="text-xs font-medium text-text-muted mb-2">节点状态</h4>
                      <div className="grid grid-cols-2 gap-1">
                        {selectedNodes.map(node => {
                          const config = getNodeStatusConfig(node.state);
                          return (
                            <div
                              key={node.id}
                              className="flex items-center gap-2 p-1.5 rounded bg-background-surface"
                            >
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: config.color.replace('text-', '').replace('-500', '') }}
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
                  )}
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
