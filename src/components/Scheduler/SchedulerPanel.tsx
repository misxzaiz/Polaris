/**
 * 定时任务管理面板
 */

import { useEffect, useState } from 'react';
import { useSchedulerStore, useToastStore } from '../../stores';
import type { TaskLog, CreateTaskParams } from '../../types/scheduler';
import type { ScheduledTask } from '../../types/scheduler';
import { TriggerTypeLabels, TaskModeLabels } from '../../types/scheduler';
import * as tauri from '../../services/tauri';
import type { ProtocolFileType } from '../../services/tauri';
import { TaskEditor } from './TaskEditor';

/** 格式化时间戳 */
function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  return new Date(timestamp * 1000).toLocaleString('zh-CN');
}

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  const now = Date.now() / 1000;
  const diff = timestamp - now;

  if (diff < 0) return '已过期';
  if (diff < 60) return `${Math.floor(diff)} 秒后`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时后`;
  return `${Math.floor(diff / 86400)} 天后`;
}

/** 状态徽章 */
function StatusBadge({ status }: { status?: 'running' | 'success' | 'failed' }) {
  if (!status) return <span className="text-gray-400">未执行</span>;

  const styles = {
    running: 'bg-blue-500/20 text-blue-400',
    success: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
  };

  const labels = {
    running: '执行中',
    success: '成功',
    failed: '失败',
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/** 任务卡片 */
function TaskCard({
  task,
  onEdit,
  onCopy,
  onDelete,
  onToggle,
  onRun,
  onSubscribe,
  onCancelSubscription,
  onUnsubscribe,
  onViewDocs,
  isSubscribing,
  isSubscribed,
  showGroupTag,
}: {
  task: ScheduledTask;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onSubscribe: () => void;
  onCancelSubscription?: () => void;
  onUnsubscribe?: () => void;
  onViewDocs?: () => void;
  isSubscribing?: boolean;
  /** 是否已订阅（有 subscribedContextId） */
  isSubscribed?: boolean;
  /** 是否显示分组标签（当任务列表有多个分组时显示） */
  showGroupTag?: boolean;
}) {
  return (
    <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`} />
            <h3 className="text-white font-medium">{task.name}</h3>
            {/* 分组标签 */}
            {showGroupTag && task.group && (
              <span className="px-2 py-0.5 rounded text-xs bg-orange-500/20 text-orange-400">
                {task.group}
              </span>
            )}
            {/* 模式徽章 */}
            <span className={`px-2 py-0.5 rounded text-xs ${
              task.mode === 'protocol'
                ? 'bg-purple-500/20 text-purple-400'
                : 'bg-gray-500/20 text-gray-400'
            }`}>
              {TaskModeLabels[task.mode]}
            </span>
          </div>

          <div className="mt-2 text-sm text-gray-400 space-y-1">
            <p>
              <span className="text-gray-500">触发: </span>
              {TriggerTypeLabels[task.triggerType]} - {task.triggerValue}
            </p>
            <p>
              <span className="text-gray-500">引擎: </span>
              {task.engineId}
            </p>
            <div className="flex items-center gap-4">
              <span>
                <span className="text-gray-500">状态: </span>
                <StatusBadge status={task.lastRunStatus} />
              </span>
              {task.enabled && task.nextRunAt && (
                <span>
                  <span className="text-gray-500">下次: </span>
                  {formatRelativeTime(task.nextRunAt)}
                </span>
              )}
              {/* 执行轮次显示 */}
              {task.maxRuns !== undefined && task.maxRuns !== null && (
                <span>
                  <span className="text-gray-500">轮次: </span>
                  <span className={task.currentRuns >= task.maxRuns ? 'text-yellow-400' : 'text-gray-300'}>
                    {task.currentRuns}/{task.maxRuns}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 协议模式显示查看文档按钮 */}
          {task.mode === 'protocol' && onViewDocs && (
            <button
              onClick={onViewDocs}
              className="px-3 py-1 text-sm bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded transition-colors"
              title="查看任务文档"
            >
              文档
            </button>
          )}
          {/* 订阅执行按钮 - 在 AI 对话窗口实时显示执行过程 */}
          {isSubscribing ? (
            // 正在订阅执行中 - 显示停止按钮
            <button
              onClick={onCancelSubscription}
              className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center gap-1"
              title="取消订阅并中断任务"
            >
              ⏹ 停止
            </button>
          ) : isSubscribed ? (
            // 已订阅等待触发 - 显示订阅状态和取消订阅按钮
            <div className="flex items-center gap-1">
              <span className="px-2 py-1 text-xs bg-cyan-600/30 text-cyan-400 rounded flex items-center gap-1">
                🔔 已订阅
              </span>
              <button
                onClick={onUnsubscribe}
                className="px-2 py-1 text-xs bg-gray-600/20 text-gray-400 hover:bg-gray-600/30 rounded transition-colors"
                title="取消订阅"
              >
                取消
              </button>
            </div>
          ) : (
            // 未订阅 - 显示订阅按钮
            <button
              onClick={onSubscribe}
              className="px-3 py-1 text-sm bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded transition-colors flex items-center gap-1"
              title="订阅执行 - 在 AI 对话窗口查看执行过程"
            >
              👁 订阅
            </button>
          )}
          <button
            onClick={onRun}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
            title="立即执行（后台）"
          >
            执行
          </button>
          <button
            onClick={onToggle}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              task.enabled
                ? 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
                : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
            }`}
          >
            {task.enabled ? '禁用' : '启用'}
          </button>
          <button
            onClick={onEdit}
            className="px-3 py-1 text-sm bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
          >
            编辑
          </button>
          <button
            onClick={onCopy}
            className="px-3 py-1 text-sm bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 rounded transition-colors"
            title="复制任务"
          >
            复制
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** 可折叠的内容块 */
function CollapsibleContent({
  label,
  content,
  maxHeight = 100,
  className = 'text-gray-300',
}: {
  label: string;
  content: string;
  maxHeight?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = content.length > 200 || content.split('\n').length > 5;

  return (
    <div>
      <div
        className="flex items-center justify-between text-sm text-gray-400 mb-1 cursor-pointer hover:text-gray-300"
        onClick={() => needsExpand && setExpanded(!expanded)}
      >
        <span>{label}</span>
        {needsExpand && (
          <span className="text-xs text-blue-400">
            {expanded ? '收起' : '展开全部'}
          </span>
        )}
      </div>
      <pre
        className={`text-xs ${className} bg-[#12122a] p-2 rounded overflow-x-auto whitespace-pre-wrap transition-all ${!expanded && needsExpand ? `max-h-[${maxHeight}px] overflow-hidden relative` : ''}`}
        style={!expanded && needsExpand ? { maxHeight: `${maxHeight}px`, overflow: 'hidden' } : {}}
      >
        {content}
        {!expanded && needsExpand && (
          <span className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[#12122a] to-transparent pointer-events-none" />
        )}
      </pre>
    </div>
  );
}

/** 日志列表 */
function LogList({ logs }: { logs: TaskLog[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (logs.length === 0) {
    return (
      <div className="text-center text-gray-500 py-8">
        暂无执行日志
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div key={log.id} className="bg-[#1a1a2e] rounded-lg p-3 border border-[#2a2a4a]">
          <div
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={log.status} />
              <span className="text-white">{log.taskName}</span>
            </div>
            <div className="text-sm text-gray-400">
              {formatTime(log.startedAt)}
              {/* 使用 durationMs 显示耗时 */}
              {log.durationMs != null && log.durationMs > 0 ? (
                <span className="ml-2">
                  耗时 {log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
                </span>
              ) : log.finishedAt && log.startedAt ? (
                <span className="ml-2">
                  耗时 {log.finishedAt - log.startedAt}s
                </span>
              ) : null}
            </div>
          </div>

          {expandedId === log.id && (
            <div className="mt-3 pt-3 border-t border-[#2a2a4a] space-y-3">
              {/* 显示增强字段：Session ID、工具调用次数 */}
              <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                {log.sessionId && (
                  <span>
                    Session: <code className="text-blue-400 bg-[#12122a] px-1 rounded">{log.sessionId.slice(0, 8)}...</code>
                  </span>
                )}
                {log.toolCallCount != null && log.toolCallCount > 0 && (
                  <span className="text-yellow-400">
                    工具调用: {log.toolCallCount} 次
                  </span>
                )}
              </div>

              {/* 提示词 - 默认折叠 */}
              <CollapsibleContent
                label="提示词"
                content={log.prompt}
                maxHeight={60}
                className="text-gray-300"
              />

              {/* 显示思考过程摘要 */}
              {log.thinkingSummary && (
                <CollapsibleContent
                  label="思考过程"
                  content={log.thinkingSummary}
                  maxHeight={80}
                  className="text-purple-400"
                />
              )}

              {log.output && (
                <CollapsibleContent
                  label="输出"
                  content={log.output}
                  maxHeight={120}
                  className="text-green-400"
                />
              )}

              {log.error && (
                <CollapsibleContent
                  label="错误"
                  content={log.error}
                  maxHeight={80}
                  className="text-red-400"
                />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 分组折叠组件 */
function TaskGroup({
  name,
  tasks,
  defaultExpanded = true,
  children,
}: {
  name: string;
  tasks: ScheduledTask[];
  defaultExpanded?: boolean;
  children: (task: ScheduledTask) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="mb-4">
      {/* 分组标题 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#1a1a2e] rounded-t border border-[#2a2a4a] hover:bg-[#22224a] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`transform transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-white font-medium">{name}</span>
          <span className="text-xs px-2 py-0.5 bg-[#2a2a4a] text-gray-400 rounded-full">
            {tasks.length}
          </span>
        </div>
        <span className="text-xs text-gray-500">
          {expanded ? '点击收起' : '点击展开'}
        </span>
      </button>

      {/* 任务列表 */}
      {expanded && (
        <div className="space-y-2 p-2 bg-[#16162a] border-x border-b border-[#2a2a4a] rounded-b">
          {tasks.map((task) => children(task))}
        </div>
      )}
    </div>
  );
}

/** 主面板 */
export function SchedulerPanel() {
  const { tasks, logs, loading, subscribingTaskId, loadTasks, loadLogs, createTask, updateTask, deleteTask, toggleTask, runTask, runTaskWithSubscription, clearSubscription, subscribeTask, unsubscribeTask, initSchedulerEventListener } =
    useSchedulerStore();
  const toast = useToastStore();

  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [copyingTask, setCopyingTask] = useState<ScheduledTask | undefined>();
  const [activeTab, setActiveTab] = useState<'tasks' | 'logs'>('tasks');
  const [viewingTask, setViewingTask] = useState<ScheduledTask | undefined>();

  // 按分组整理任务
  const groupedTasks = tasks.reduce((acc, task) => {
    const groupKey = task.group || '默认';
    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }
    acc[groupKey].push(task);
    return acc;
  }, {} as Record<string, ScheduledTask[]>);

  // 获取排序后的分组名
  const groupNames = Object.keys(groupedTasks).sort((a, b) => {
    // "默认" 组放在最后
    if (a === '默认') return 1;
    if (b === '默认') return -1;
    return a.localeCompare(b);
  });

  // 初始化事件监听
  useEffect(() => {
    const cleanup = initSchedulerEventListener();
    return () => {
      cleanup();
    };
  }, [initSchedulerEventListener]);

  useEffect(() => {
    loadTasks();
    loadLogs(50);
  }, [loadTasks, loadLogs]);

  /** 处理立即执行任务（后台执行） */
  const handleRunTask = async (task: ScheduledTask) => {
    try {
      await runTask(task.id);
      // 任务在后台执行，这里只是提交成功
      toast.info('任务已提交', `任务 ${task.name} 已在后台开始执行`);
      // 刷新任务列表和日志
      loadTasks();
      loadLogs(50);
    } catch (e) {
      toast.error('提交失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 取消订阅（中断正在执行的任务） */
  const handleCancelSubscription = async () => {
    // 通过 eventChatStore 的 interruptChat 来中断
    const { useEventChatStore } = await import('../../stores/eventChatStore');
    try {
      await useEventChatStore.getState().interruptChat();
      toast.info('已中断', '任务执行已被中断');
    } catch (e) {
      console.error('中断任务失败:', e);
    }
    clearSubscription();
  };

  /** 订阅并立即执行任务（在 AI 对话窗口实时显示） */
  const handleSubscribeAndRun = async (task: ScheduledTask) => {
    // 防抖：如果已有任务在执行，不允许再次点击
    if (subscribingTaskId) {
      toast.warning('请等待', '已有任务在执行中，请等待完成后再试');
      return;
    }

    try {
      // 获取当前会话 ID 作为上下文 ID
      const { useEventChatStore } = await import('../../stores/eventChatStore');
      const conversationId = useEventChatStore.getState().conversationId;
      
      // 先持久化订阅状态
      if (conversationId) {
        await subscribeTask(task.id, conversationId);
      }
      
      await runTaskWithSubscription(task.id, task.name, conversationId || undefined);
      toast.info('订阅执行', `任务「${task.name}」正在执行，请在 AI 对话窗口查看实时进度`);
      // 刷新任务列表和日志
      loadTasks();
      loadLogs(50);
    } catch (e) {
      toast.error('执行失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 取消任务订阅 */
  const handleUnsubscribe = async (task: ScheduledTask) => {
    try {
      await unsubscribeTask(task.id);
      toast.info('已取消订阅', `任务「${task.name}」已取消订阅`);
      loadTasks();
    } catch (e) {
      toast.error('取消订阅失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success('创建成功');
      setShowEditor(false);
    } catch (e) {
      toast.error('创建失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 处理复制任务 */
  const handleCopy = (task: ScheduledTask) => {
    // 清除编辑状态，设置复制状态
    setEditingTask(undefined);
    // 复制任务，清除运行时状态字段
    setCopyingTask({
      ...task,
      name: `${task.name}（副本）`,
      // 清除运行时状态
      subscribedContextId: undefined,
      retryCount: 0,
      currentRuns: 0,
      lastRunStatus: undefined,
      lastRunAt: undefined,
      nextRunAt: undefined,
    });
    setShowEditor(true);
  };

  /** 处理复制任务保存 */
  const handleCopySave = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success('复制成功');
      setShowEditor(false);
      setCopyingTask(undefined);
    } catch (e) {
      toast.error('复制失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleUpdate = async (params: CreateTaskParams) => {
    if (!editingTask) return;
    try {
      await updateTask({
        ...editingTask,
        ...params,
      });
      toast.success('更新成功');
      setShowEditor(false);
      setEditingTask(undefined);
    } catch (e) {
      toast.error('更新失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个任务吗？')) return;
    try {
      await deleteTask(id);
      toast.success('删除成功');
    } catch (e) {
      toast.error('删除失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#12122a]">
      {/* 头部 */}
      <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between">
        <h1 className="text-xl font-medium text-white flex items-center gap-2">
          定时任务
        </h1>
        <button
          onClick={() => {
            setEditingTask(undefined);
            setShowEditor(true);
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
        >
          + 新建任务
        </button>
      </div>

      {/* 标签页 */}
      <div className="border-b border-[#2a2a4a]">
        <div className="flex">
          <button
            onClick={() => setActiveTab('tasks')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'tasks'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            任务列表 ({tasks.length})
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'logs'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            执行日志 ({logs.length})
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-gray-500 py-8">加载中...</div>
        ) : activeTab === 'tasks' ? (
          tasks.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              暂无定时任务，点击右上角按钮创建
            </div>
          ) : (
            <div className="space-y-2">
              {/* 按分组显示任务 */}
              {groupNames.map((groupName) => (
                <TaskGroup
                  key={groupName}
                  name={groupName}
                  tasks={groupedTasks[groupName]}
                >
                  {(task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      showGroupTag={tasks.length > groupedTasks[groupName].length}
                      onEdit={() => {
                        setCopyingTask(undefined);
                        setEditingTask(task);
                        setShowEditor(true);
                      }}
                      onCopy={() => handleCopy(task)}
                      onDelete={() => handleDelete(task.id)}
                      onToggle={() => toggleTask(task.id, !task.enabled)}
                      onRun={() => handleRunTask(task)}
                      onSubscribe={() => handleSubscribeAndRun(task)}
                      onCancelSubscription={handleCancelSubscription}
                      onUnsubscribe={() => handleUnsubscribe(task)}
                      onViewDocs={() => setViewingTask(task)}
                      isSubscribing={subscribingTaskId === task.id}
                      isSubscribed={!!task.subscribedContextId}
                    />
                  )}
                </TaskGroup>
              ))}
            </div>
          )
        ) : (
          <LogList logs={logs} />
        )}
      </div>

      {/* 编辑弹窗 */}
      {showEditor && (
        <TaskEditor
          task={editingTask || copyingTask}
          onSave={editingTask ? handleUpdate : (copyingTask ? handleCopySave : handleCreate)}
          title={editingTask ? '编辑任务' : (copyingTask ? '复制任务' : '新建任务')}
          onClose={() => {
            setShowEditor(false);
            setEditingTask(undefined);
            setCopyingTask(undefined);
          }}
        />
      )}

      {/* 协议文档查看器 */}
      {viewingTask && (
        <ProtocolDocViewer
          task={viewingTask}
          onClose={() => setViewingTask(undefined)}
        />
      )}
    </div>
  );
}

/** 协议文档查看器 */
function ProtocolDocViewer({
  task,
  onClose,
}: {
  task: ScheduledTask;
  onClose: () => void;
}) {
  const toast = useToastStore();
  const [activeDoc, setActiveDoc] = useState<'task' | 'supplement' | 'memory'>('task');
  const [content, setContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [loading, setLoading] = useState(true);

  // 读取文档内容
  useEffect(() => {
    if (!task.workDir || !task.taskPath) return;

    setLoading(true);
    const fileType: ProtocolFileType = activeDoc === 'memory' ? 'memory_index' : activeDoc;

    tauri.schedulerReadProtocolFile(task.workDir, task.taskPath, fileType)
      .then((data) => {
        setContent(data);
        setEditedContent(data);
      })
      .catch((e) => {
        toast.error('读取文档失败', e instanceof Error ? e.message : '未知错误');
      })
      .finally(() => setLoading(false));
  }, [task, activeDoc, toast]);

  const handleSave = async () => {
    if (!task.workDir || !task.taskPath) return;

    const fileType: ProtocolFileType = activeDoc === 'memory' ? 'memory_index' : activeDoc;

    try {
      await tauri.schedulerWriteProtocolFile(task.workDir, task.taskPath, fileType, editedContent);
      setContent(editedContent);
      setIsEditing(false);
      toast.success('保存成功');
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const docTabs = [
    { id: 'task' as const, label: '协议文档' },
    { id: 'supplement' as const, label: '用户补充' },
    { id: 'memory' as const, label: '记忆索引' },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16162a] rounded-lg w-[800px] h-[80vh] flex flex-col border border-[#2a2a4a]">
        {/* 头部 */}
        <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between">
          <h2 className="text-lg font-medium text-white">
            {task.name} - 文档管理
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        </div>

        {/* 文档标签页 */}
        <div className="border-b border-[#2a2a4a]">
          <div className="flex">
            {docTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveDoc(tab.id);
                  setIsEditing(false);
                }}
                className={`px-4 py-2 text-sm transition-colors ${
                  activeDoc === tab.id
                    ? 'text-purple-400 border-b-2 border-purple-400'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden p-4">
          {loading ? (
            <div className="text-center text-gray-500 py-8">加载中...</div>
          ) : isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="w-full h-full p-3 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-purple-500 resize-none font-mono text-sm"
            />
          ) : (
            <pre className="w-full h-full p-3 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-gray-300 overflow-auto text-sm whitespace-pre-wrap">
              {content || '(空文档)'}
            </pre>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="p-4 border-t border-[#2a2a4a] flex justify-between items-center">
          <div className="text-xs text-gray-500">
            路径: {task.taskPath}/{activeDoc === 'memory' ? 'memory/index.md' : `${activeDoc}.md`}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors"
                >
                  保存
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setEditedContent(content);
                  setIsEditing(true);
                }}
                className="px-4 py-2 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded transition-colors"
              >
                编辑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SchedulerPanel;
