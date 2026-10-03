/**
 * BashTaskPanel - cap.bash 宿主任务管理面板
 *
 * 管理 AI 会话（或本地面板）经 cap.bash 启动的后台 shell 任务：
 * - 任务列表：taskId / 命令 / 状态 / pid / 耗时，运行中实时刷新
 * - 展开查看实时日志（运行中增量拉取，终态全量）
 * - 运行中任务可「停止」（kill 进程树）；终态可清除出列表
 * - 空态引导：AI 会话长命令默认 async，可在本面板统一管理/停止
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Square, Terminal, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import {
  bashKill,
  bashList,
  bashLog,
  type BashTaskItem,
  type BashTaskStatus,
} from '@/services/bashTaskService';
import { createLogger } from '@/utils/logger';
import { useViewStore } from '@/stores/viewStore';

const log = createLogger('BashTaskPanel');

/** 轮询间隔（运行中任务） */
const POLL_RUNNING_MS = 1500;
/** 轮询间隔（无运行中任务，低耗） */
const POLL_IDLE_MS = 5000;

const STATUS_META: Record<BashTaskStatus, { label: string; cls: string }> = {
  running: { label: '运行中', cls: 'text-primary border-primary/40 bg-primary/10' },
  completed: { label: '已完成', cls: 'text-success border-success/40 bg-success/10' },
  failed: { label: '失败', cls: 'text-error border-error/40 bg-error/10' },
  killed: { label: '已停止', cls: 'text-warning border-warning/40 bg-warning/10' },
  timeout: { label: '超时', cls: 'text-warning border-warning/40 bg-warning/10' },
};

function formatDurationMs(startedAt: number, finishedAt?: number | null, now = Date.now()): string {
  const end = finishedAt || now;
  const ms = Math.max(0, end - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusLabel(status: BashTaskStatus, t: (k: string) => string): string {
  void t;
  return STATUS_META[status].label;
}

export function BashTaskPanel({ highlightTaskId }: { highlightTaskId?: string | null }) {
  const { t } = useTranslation('common');
  const [tasks, setTasks] = useState<BashTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, { offset: number; total: number; lines: string[]; error?: string }>>({});
  const [killingId, setKillingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const autoRef = useRef<HTMLDivElement>(null);
  const lastRefreshRef = useRef(0);

  // 当前是否有运行中任务 → 决定轮询频率
  const hasRunning = useMemo(() => tasks.some((task) => task.status === 'running'), [tasks]);

  // 选中 taskId 首次出现时自动展开（tool_call 块「管理」入口跳转用）
  useEffect(() => {
    if (highlightTaskId && tasks.some((task) => task.taskId === highlightTaskId)) {
      setExpandedId(highlightTaskId);
      // 一次性消费：清空高亮，避免下次面板挂载再次展开
      useViewStore.getState().clearBashTaskHighlight();
    }
  }, [highlightTaskId, tasks]);

  const refresh = useCallback(async () => {
    // 防抖：轮询间隔内忽略手动刷新
    const nowMs = Date.now();
    if (nowMs - lastRefreshRef.current < 300) return;
    lastRefreshRef.current = nowMs;
    try {
      const list = await bashList();
      setTasks(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 定时轮询
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, hasRunning ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, hasRunning]);

  // 耗时刷新（运行中每秒跳动）
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  // 加载指定任务日志（展开时拉取，增量 offset）
  const loadLog = useCallback(async (taskId: string, offset = 0) => {
    try {
      const res = await bashLog(taskId, offset);
      setLogs((prev) => {
        const prevEntry = prev[taskId];
        const merged = offset === 0
          ? res.lines
          : [...(prevEntry?.lines ?? []), ...res.lines];
        return {
          ...prev,
          [taskId]: { offset: res.offset + res.lines.length, total: res.total, lines: merged },
        };
      });
    } catch (e) {
      setLogs((prev) => ({
        ...prev,
        [taskId]: { offset: 0, total: 0, lines: prev[taskId]?.lines ?? [], error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  // 展开：首次拉全量日志；已有则增量拉取
  const toggleExpand = useCallback(async (taskId: string) => {
    if (expandedId === taskId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(taskId);
    const entry = logs[taskId];
    await loadLog(taskId, entry ? entry.offset : 0);
  }, [expandedId, logs, loadLog]);

  // 停止任务
  const handleKill = useCallback(async (taskId: string) => {
    setKillingId(taskId);
    try {
      const res = await bashKill(taskId);
      log.info(`killed ${taskId}`, { res });
      // 立即刷新，反映 killed 状态
      await refresh();
    } catch (e) {
      log.error(`kill failed ${taskId}`, e instanceof Error ? e : new Error(String(e)));
    } finally {
      setKillingId(null);
    }
  }, [refresh]);

  // 清除已终态任务（仅隐藏，宿主任务记录仍保留可查）
  const handleClearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((task) => task.status === 'running'));
    setLogs((prev) => {
      const next: typeof prev = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (tasks.find((task) => task.taskId === id && task.status === 'running')) next[id] = entry;
      }
      return next;
    });
  }, [tasks]);

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* 头部：标题 + 刷新 + 清除已完成 */}
      <div className="flex items-center h-9 px-3 border-b border-border bg-background-elevated shrink-0 gap-2">
        <Terminal size={14} className="text-text-muted" />
        <span className="text-xs font-medium text-text-secondary">cap.bash 任务</span>
        <span className="text-[10px] text-text-muted">
          {tasks.filter((task) => task.status === 'running').length} 运行中
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="刷新"
            onClick={refresh}
            className="p-1 rounded hover:bg-background-hover text-text-muted hover:text-text-primary"
          >
            <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          </button>
          {tasks.some((task) => task.status !== 'running') && (
            <button
              type="button"
              title="清除已结束任务"
              onClick={handleClearFinished}
              className="p-1 rounded hover:bg-background-hover text-text-muted hover:text-text-primary"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-error bg-error/10 border-b border-error/20">
          加载失败：{error}
        </div>
      )}

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto" ref={autoRef}>
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center gap-2 h-24 text-text-muted text-xs">
            <Loader2 size={14} className="animate-spin" />
            加载中…
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 h-32 text-text-muted px-6 text-center">
            <Terminal size={20} className="opacity-40" />
            <p className="text-xs leading-relaxed">
              暂无后台任务。
              <br />
              AI 会话执行长命令（bash 工具）时会自动以后台任务运行，
              可在此面板查看日志与随时停止。
            </p>
          </div>
        ) : (
          tasks.map((task) => {
            const meta = STATUS_META[task.status];
            const expanded = expandedId === task.taskId;
            const entry = logs[task.taskId];
            return (
              <div
                key={task.taskId}
                className={clsx(
                  'border-b border-border',
                  expanded && 'bg-background-elevated/50',
                )}
              >
                {/* 任务行 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-background-hover"
                  onClick={() => toggleExpand(task.taskId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(task.taskId);
                    }
                  }}
                >
                  {expanded ? (
                    <ChevronDown size={14} className="text-text-muted shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-text-muted shrink-0" />
                  )}
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border shrink-0', meta.cls)}>
                    {statusLabel(task.status, t)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono truncate text-text-primary">{task.command}</div>
                    <div className="text-[10px] text-text-muted flex items-center gap-2 mt-0.5">
                      <span>{task.taskId}</span>
                      {task.pid > 0 && <span>pid {task.pid}</span>}
                      <span>
                        {formatDurationMs(task.startedAt, task.finishedAt, now)}
                      </span>
                    </div>
                  </div>
                  {/* 运行中：停止按钮；终态：日志行数 */}
                  {task.status === 'running' ? (
                    <button
                      type="button"
                      title="停止任务"
                      disabled={killingId === task.taskId}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleKill(task.taskId);
                      }}
                      className="p-1 rounded text-text-muted hover:text-error hover:bg-error/10 shrink-0 disabled:opacity-40"
                    >
                      <Square size={12} className={clsx(killingId === task.taskId && 'animate-pulse')} />
                    </button>
                  ) : (
                    <span className="text-[10px] text-text-muted shrink-0">{task.logLines} 行</span>
                  )}
                </div>

                {/* 展开：日志 */}
                {expanded && (
                  <div className="px-3 pb-2 -mt-0.5">
                    {entry?.error ? (
                      <div className="text-xs text-error px-2 py-1.5 bg-error/5 rounded">
                        日志加载失败：{entry.error}
                      </div>
                    ) : (
                      <pre className="text-[11px] font-mono leading-relaxed bg-background-surface rounded p-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-all text-text-secondary">
                        {entry && entry.lines.length > 0
                          ? entry.lines.join('\n')
                          : '（暂无输出）'}
                      </pre>
                    )}
                    {task.status === 'running' && (
                      <div className="flex items-center justify-between mt-1.5">
                        <button
                          type="button"
                          onClick={() => loadLog(task.taskId, entry?.offset ?? 0)}
                          className="text-[10px] text-primary hover:text-primary-hover flex items-center gap-1"
                        >
                          <RefreshCw size={10} />
                          刷新日志
                        </button>
                        <span className="text-[10px] text-text-muted">
                          {entry ? `${entry.lines.length}/${entry.total} 行` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
