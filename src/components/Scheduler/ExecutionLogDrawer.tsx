/**
 * 执行日志抽屉组件
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionLogEntry, TaskExecutionInfo, ExecutionState } from '../../types/scheduler';
import { useSchedulerStore } from '../../stores';

/** 状态图标 */
function StateIcon({ state }: { state: ExecutionState }) {
  const styles: Record<ExecutionState, string> = {
    idle: 'text-text-muted',
    running: 'text-info animate-pulse',
    success: 'text-success',
    failed: 'text-danger',
  };

  const icons: Record<ExecutionState, string> = {
    idle: '○',
    running: '●',
    success: '✓',
    failed: '✗',
  };

  return <span className={styles[state]}>{icons[state]}</span>;
}

/** 格式化用时 */
function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime || Date.now();
  const diff = Math.floor((end - startTime) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

/** 日志类型图标 */
function LogTypeIcon({ type }: { type: ExecutionLogEntry['type'] }) {
  const styles: Record<ExecutionLogEntry['type'], string> = {
    session_start: 'text-info',
    message: 'text-text-primary',
    thinking: 'text-text-muted',
    tool_call_start: 'text-warning',
    tool_call_end: 'text-success',
    error: 'text-danger',
    session_end: 'text-text-secondary',
  };

  const icons: Record<ExecutionLogEntry['type'], string> = {
    session_start: '▶',
    message: '💬',
    thinking: '💭',
    tool_call_start: '🔧',
    tool_call_end: '✅',
    error: '❌',
    session_end: '⏹',
  };

  return <span className={styles[type]}>{icons[type]}</span>;
}

/** 单条日志 */
function LogItem({ log }: { log: ExecutionLogEntry }) {
  const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex items-start gap-2 py-1 text-sm font-mono">
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
      className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-t-lg transition-colors ${
        isActive
          ? 'bg-background-surface text-text-primary border-t border-l border-r border-border-subtle'
          : 'bg-background-hover text-text-secondary hover:text-text-primary'
      }`}
    >
      <StateIcon state={execution.state} />
      <span className="max-w-32 truncate">{execution.taskName}</span>
      {isRunning && (
        <span className="text-xs text-text-muted">
          {formatDuration(execution.startTime)}
        </span>
      )}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-1 text-text-muted hover:text-text-primary"
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
  }, [activeExecution?.logs, autoScroll]);

  // 检测用户滚动
  const handleScroll = () => {
    if (logContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  // 如果没有执行任务，不显示
  if (executionList.length === 0) {
    return null;
  }

  // 计算执行中任务数量
  const runningCount = executionList.filter((e) => e.state === 'running').length;

  return (
    <div className="border-t border-border-subtle bg-background-surface">
      {/* 抽屉头部 */}
      <button
        onClick={() => setDrawerOpen(!drawerOpen)}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-background-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`transform transition-transform ${drawerOpen ? 'rotate-180' : ''}`}>
            ▼
          </span>
          <span className="text-sm text-text-secondary">
            {t('drawer.title')}
          </span>
          {runningCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-info-faint text-info rounded">
              {t('drawer.runningCount', { count: runningCount })}
            </span>
          )}
        </div>
        <span className="text-xs text-text-muted">
          {drawerOpen ? t('drawer.collapse') : t('drawer.expand')}
        </span>
      </button>

      {/* 抽屉内容 */}
      {drawerOpen && (
        <div className="border-t border-border-subtle">
          {/* Tab 栏 */}
          <div className="flex items-center gap-1 px-2 pt-2 bg-background-base">
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

          {/* 日志内容 */}
          <div className="bg-background-surface border-t border-border-subtle">
            {/* 工具栏 */}
            <div className="px-4 py-2 flex items-center justify-between border-b border-border-subtle">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                {activeExecution && (
                  <>
                    <StateIcon state={activeExecution.state} />
                    <span>
                      {t(`status.${activeExecution.state}`)}
                    </span>
                    <span>·</span>
                    <span>
                      {t('drawer.duration')}: {formatDuration(activeExecution.startTime, activeExecution.endTime)}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    autoScroll
                      ? 'bg-primary-faint text-primary'
                      : 'bg-background-hover text-text-muted'
                  }`}
                >
                  {autoScroll ? t('drawer.autoScroll') : t('drawer.manualScroll')}
                </button>
                <button
                  onClick={() => activeTaskId && clearLogs(activeTaskId)}
                  className="px-2 py-1 text-xs bg-background-hover text-text-muted hover:text-text-primary rounded transition-colors"
                >
                  {t('drawer.clear')}
                </button>
              </div>
            </div>

            {/* 日志列表 */}
            <div
              ref={logContainerRef}
              onScroll={handleScroll}
              className="h-48 overflow-y-auto p-4 bg-background-elevated"
            >
              {activeExecution ? (
                activeExecution.logs.length > 0 ? (
                  <div className="space-y-0.5">
                    {activeExecution.logs.map((log) => (
                      <LogItem key={log.id} log={log} />
                    ))}
                  </div>
                ) : (
                  <div className="text-center text-text-muted py-8">
                    {t('drawer.waitingOutput')}
                  </div>
                )
              ) : (
                <div className="text-center text-text-muted py-8">
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
