/**
 * 订阅执行日志面板组件
 *
 * 显示订阅任务的实时执行日志，支持：
 * - 实时日志流显示
 * - 多任务 Tab 切换
 * - 停止执行功能
 * - 可折叠面板
 */

import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSchedulerStore } from '../../stores';
import { createLogger } from '../../utils/logger';

const log = createLogger('SubscriptionChatPanel');

/** 单条日志条目 */
export interface SubscriptionLogEntry {
  id: string;
  timestamp: number;
  type: 'info' | 'tool' | 'thinking' | 'result' | 'error' | 'warning';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

/** 订阅会话状态 */
export interface SubscriptionSession {
  taskId: string;
  taskName: string;
  startTime: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  logs: SubscriptionLogEntry[];
}

/** 格式化时间戳 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 获取日志类型样式 */
function getLogTypeStyle(type: SubscriptionLogEntry['type']): string {
  switch (type) {
    case 'info':
      return 'text-gray-400';
    case 'tool':
      return 'text-yellow-400';
    case 'thinking':
      return 'text-purple-400';
    case 'result':
      return 'text-green-400';
    case 'error':
      return 'text-red-400';
    case 'warning':
      return 'text-orange-400';
    default:
      return 'text-gray-300';
  }
}

/** 获取日志类型图标 */
function getLogTypeIcon(type: SubscriptionLogEntry['type']): string {
  switch (type) {
    case 'info':
      return 'ℹ';
    case 'tool':
      return '🔧';
    case 'thinking':
      return '💭';
    case 'result':
      return '✓';
    case 'error':
      return '✗';
    case 'warning':
      return '⚠';
    default:
      return '•';
  }
}

/** 单条日志组件 */
function LogEntry({ entry }: { entry: SubscriptionLogEntry }) {
  return (
    <div className={`text-xs font-mono leading-relaxed ${getLogTypeStyle(entry.type)}`}>
      <span className="text-gray-500 mr-2">[{formatTimestamp(entry.timestamp)}]</span>
      <span className="mr-2">{getLogTypeIcon(entry.type)}</span>
      {entry.toolName && (
        <span className="text-yellow-400 mr-1">[{entry.toolName}]</span>
      )}
      <span className="whitespace-pre-wrap break-all">{entry.content}</span>
    </div>
  );
}

/** 主面板组件 */
export function SubscriptionChatPanel() {
  const { t } = useTranslation('scheduler');
  const {
    subscriptionSessions,
    activeSubscriptionId,
    isPanelCollapsed,
    setActiveSubscription,
    togglePanelCollapse,
    stopSubscription,
    clearSubscriptionSession,
  } = useSchedulerStore();

  const logsEndRef = useRef<HTMLDivElement>(null);
  const currentSession = activeSubscriptionId
    ? subscriptionSessions[activeSubscriptionId]
    : null;

  // 自动滚动到底部
  useEffect(() => {
    if (logsEndRef.current && currentSession && !isPanelCollapsed) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentSession?.logs, isPanelCollapsed]);

  const handleStop = useCallback(async () => {
    if (!activeSubscriptionId) return;
    try {
      await stopSubscription(activeSubscriptionId);
    } catch (e) {
      log.error('停止订阅任务失败', e as Error);
    }
  }, [activeSubscriptionId, stopSubscription]);

  const handleClear = useCallback(() => {
    if (!activeSubscriptionId) return;
    clearSubscriptionSession(activeSubscriptionId);
  }, [activeSubscriptionId, clearSubscriptionSession]);

  // 如果没有订阅会话，不显示面板
  const sessionIds = Object.keys(subscriptionSessions);
  if (sessionIds.length === 0) {
    return null;
  }

  return (
    <div className="border-t-2 border-cyan-500/50 bg-[#0a0a1a]/95">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-cyan-500/10 cursor-pointer hover:bg-cyan-500/15 transition-colors"
        onClick={togglePanelCollapse}
      >
        <div className="flex items-center gap-3">
          <span className="text-cyan-400 font-medium text-sm">
            📝 {currentSession?.taskName || t('subscription.activeTask')}
          </span>
          {currentSession?.status === 'running' && (
            <span className="px-2 py-0.5 text-xs bg-blue-500/20 text-blue-400 rounded animate-pulse">
              {t('subscription.executing')}
            </span>
          )}
          {currentSession?.status === 'completed' && (
            <span className="px-2 py-0.5 text-xs bg-green-500/20 text-green-400 rounded">
              {t('subscription.completed')}
            </span>
          )}
          {currentSession?.status === 'failed' && (
            <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-400 rounded">
              {t('subscription.failed')}
            </span>
          )}
          {currentSession?.status === 'cancelled' && (
            <span className="px-2 py-0.5 text-xs bg-yellow-500/20 text-yellow-400 rounded">
              {t('subscription.cancelled')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 多任务 Tab 切换 */}
          {sessionIds.length > 1 && (
            <div className="flex items-center gap-1 mr-2" onClick={(e) => e.stopPropagation()}>
              {sessionIds.map((id) => {
                const session = subscriptionSessions[id];
                return (
                  <button
                    key={id}
                    onClick={() => setActiveSubscription(id)}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${
                      id === activeSubscriptionId
                        ? 'bg-cyan-500/30 text-cyan-300'
                        : 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
                    }`}
                  >
                    {session.taskName.slice(0, 8)}
                  </button>
                );
              })}
            </div>
          )}
          {/* 操作按钮 */}
          {currentSession?.status === 'running' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleStop();
              }}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
            >
              {t('subscription.stop')}
            </button>
          )}
          {currentSession && currentSession.status !== 'running' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
              className="px-2 py-1 text-xs bg-gray-600/50 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            >
              {t('subscription.clear')}
            </button>
          )}
          {/* 折叠按钮 */}
          <span className={`text-gray-400 text-sm transition-transform ${isPanelCollapsed ? '' : 'rotate-180'}`}>
            ▼
          </span>
        </div>
      </div>

      {/* 日志内容区域 */}
      {!isPanelCollapsed && currentSession && (
        <div className="h-48 overflow-y-auto p-3 bg-[#0d0d1a] font-mono text-xs">
          {currentSession.logs.length === 0 ? (
            <div className="text-gray-500 text-center py-4">
              {t('subscription.waitingForOutput')}
            </div>
          ) : (
            <div className="space-y-1">
              {currentSession.logs.map((entry) => (
                <LogEntry key={entry.id} entry={entry} />
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SubscriptionChatPanel;
