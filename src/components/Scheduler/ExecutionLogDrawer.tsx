/**
 * 执行日志抽屉组件
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  XCircle,
  Circle,
  Play,
  MessageSquare,
  Brain,
  Wrench,
  Check,
  Square,
  Trash2,
} from 'lucide-react';
import { ResizeHandle } from '../Common';
import { useViewStore } from '@/stores/viewStore';
import type { ExecutionLogEntry, TaskExecutionInfo, ExecutionState } from '@/types/scheduler';
import { useSchedulerStore } from '@/stores';

/** 状态图标 - lucide-react */
function StateIcon({ state }: { state: ExecutionState }) {
  const iconMap: Record<ExecutionState, React.ReactNode> = {
    idle: <Circle size={14} className="text-text-muted" />,
    running: <Loader2 size={14} className="text-info animate-spin" />,
    success: <CheckCircle size={14} className="text-success" />,
    failed: <XCircle size={14} className="text-danger" />,
  };
  return iconMap[state];
}

/** 格式化用时 */
function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime || Date.now();
  const diff = Math.floor((end - startTime) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

/** 日志类型图标 - lucide-react */
function LogTypeIcon({ type }: { type: ExecutionLogEntry['type'] }) {
  const iconMap: Record<ExecutionLogEntry['type'], React.ReactNode> = {
    session_start: <Play size={12} className="text-info" />,
    message: <MessageSquare size={12} className="text-text-secondary" />,
    thinking: <Brain size={12} className="text-text-muted" />,
    tool_call_start: <Wrench size={12} className="text-warning" />,
    tool_call_end: <Check size={12} className="text-success" />,
    error: <XCircle size={12} className="text-danger" />,
    session_end: <Square size={12} className="text-text-secondary" />,
  };
  return iconMap[type];
}

/** 单条日志 */
function LogItem({ log }: { log: ExecutionLogEntry }) {
  const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex items-start gap-2 py-0.5 text-xs font-mono">
      <span className="text-text-muted shrink-0">[{time}]</span>
      <LogTypeIcon type={log.type} />
      <span className="text-text-secondary break-all">{log.content}</span>
    </div>
  );
}

/** Tab 组件 */
function ExecutionTab({
  execution,
  isActive,
  onClick,
  onClose,
}: {
  execution: TaskExecutionInfo;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const isRunning = execution.state === 'running';

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
        isActive
          ? 'bg-background-surface text-text-primary border border-border-subtle'
          : 'bg-background-hover text-text-secondary hover:text-text-primary'
      }`}
    >
      <StateIcon state={execution.state} />
      <span className="max-w-24 truncate">{execution.taskName}</span>
      {isRunning && (
        <span className="text-text-muted">{formatDuration(execution.startTime)}</span>
      )}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 text-text-muted hover:text-text-primary"
      >
        ×
      </span>
    </button>
  );
}

export function ExecutionLogDrawer() {
  const { t } = useTranslation('scheduler');
  const {
    executions,
    activeTaskId,
    drawerOpen,
    setDrawerOpen,
    setActiveTask,
    closeExecutionTab,
    clearLogs,
  } = useSchedulerStore();

  // 从 viewStore 获取高度
  const drawerHeight = useViewStore((state) => state.schedulerLogDrawerHeight);
  const setDrawerHeight = useViewStore((state) => state.setSchedulerLogDrawerHeight);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // 获取所有执行中的任务
  const executionList = Array.from(executions.values());
  const activeExecution = activeTaskId ? executions.get(activeTaskId) : null;

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && logContainerRef.current && activeExecution) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [autoScroll, activeExecution]);

  // 检测用户滚动
  const handleScroll = () => {
    if (logContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  // 拖拽处理 - 使用 ResizeHandle
  const handleResize = (delta: number) => {
    // ResizeHandle direction="vertical" position="right"（相当于 bottom）：
    // - 不取反，原始 deltaY 直接传出
    // - 向下拖：delta 为正（clientY 增大）
    // - 向上拖：delta 为负（clientY 减小）
    // 对于顶部拖拽手柄（抽屉上方）：
    // - 向上拖应该减小高度，向下拖应该增大高度
    // - 用加法：向上拖（delta负）→ 高度减小，向下拖（delta正）→ 高度增大
    const newHeight = Math.max(96, Math.min(320, drawerHeight + delta));
    setDrawerHeight(newHeight);
  };

  // 如果没有执行任务，不显示
  if (executionList.length === 0) {
    return null;
  }

  // 计算执行中任务数量
  const runningCount = executionList.filter((e) => e.state === 'running').length;

  return (
    <div className="shrink-0 bg-background-surface flex flex-col" style={{ height: drawerOpen ? drawerHeight : 32 }}>
      {/* 拖拽手柄 - 仅展开时显示 */}
      {drawerOpen && (
        <ResizeHandle direction="vertical" position="right" onDrag={handleResize} />
      )}

      {/* 抽屉头部 */}
      <div
        onClick={() => setDrawerOpen(!drawerOpen)}
        className="shrink-0 h-8 px-3 flex items-center justify-between hover:bg-background-hover transition-colors border-t border-border-subtle cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {drawerOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronUp size={14} className="text-text-muted" />}
          <span className="text-xs text-text-secondary">{t('drawer.title')}</span>
          {runningCount > 0 && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-info-faint text-info rounded">
              <Loader2 size={10} className="animate-spin" />
              {runningCount}
            </span>
          )}
        </div>
        {drawerOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (activeTaskId) clearLogs(activeTaskId);
            }}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title={t('drawer.clear')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* 抽屉内容 */}
      {drawerOpen && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-border-subtle">
          {/* Tab 栏 */}
          <div className="shrink-0 h-7 flex items-center gap-1 px-2 bg-background-base overflow-x-auto">
            {executionList.map((execution) => (
              <ExecutionTab
                key={execution.taskId}
                execution={execution}
                isActive={execution.taskId === activeTaskId}
                onClick={() => setActiveTask(execution.taskId)}
                onClose={() => closeExecutionTab(execution.taskId)}
              />
            ))}
          </div>

          {/* 工具栏 + 日志 */}
          <div className="flex-1 min-h-0 flex flex-col bg-background-elevated">
            {/* 状态工具栏 */}
            <div className="shrink-0 h-7 px-3 flex items-center justify-between border-b border-border-subtle">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                {activeExecution && (
                  <>
                    <StateIcon state={activeExecution.state} />
                    <span>{t(`status.${activeExecution.state}`)}</span>
                    <span className="text-text-faint">·</span>
                    <span>{formatDuration(activeExecution.startTime, activeExecution.endTime)}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                    autoScroll
                      ? 'bg-primary-faint text-primary'
                      : 'bg-background-hover text-text-muted'
                  }`}
                >
                  {autoScroll ? t('drawer.autoScroll') : t('drawer.manualScroll')}
                </button>
              </div>
            </div>

            {/* 日志列表 */}
            <div
              ref={logContainerRef}
              onScroll={handleScroll}
              className="flex-1 min-h-0 overflow-y-auto p-2"
            >
              {activeExecution ? (
                activeExecution.logs.length > 0 ? (
                  <div className="space-y-0.5">
                    {activeExecution.logs.map((log) => (
                      <LogItem key={log.id} log={log} />
                    ))}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-text-muted">
                    {t('drawer.waitingOutput')}
                  </div>
                )
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-text-muted">
                  {t('drawer.noTaskSelected')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
