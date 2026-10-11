/**
 * MultiSessionGrid 组件 - 多会话窗口横向滚动布局
 *
 * 功能：
 * - 支持 1 行或 2 行布局
 * - 横向滚动显示多个会话
 * - 统一格子宽度
 * - 支持展开/关闭操作
 */

import { memo, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { LayoutGrid, Cloud, Loader2 } from 'lucide-react';
import { SessionCell } from './SessionCell';
import { useViewStore, useToastStore } from '@/stores';
import {
  useSessionMetadataList,
  useActiveSessionId,
} from '@/stores/conversationStore/sessionStoreManager';
import {
  useMergedSessionList,
  materializeRemoteSession,
  type RemoteSessionRef,
} from '@/hooks/useWorkspaceSessionSync';
import { createLogger } from '@/utils/logger';

const log = createLogger('MultiSessionGrid');

/** 第二行静态最小高度样式 */
const ROW2_MIN_HEIGHT_STYLE: React.CSSProperties = { minHeight: '50%' }

/** 简短时间格式化（与历史面板一致，仅显示相对时间） */
function formatUpdatedAt(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = now - d.getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return d.toLocaleDateString()
}

/**
 * 远程会话条：展示「其他窗口/端创建的、本端尚未打开的」会话，提供按需恢复。
 *
 * 设计约束：绝不自动进 multiSessionIds（本端视口），只列出可恢复条目，
 * 用户点击「恢复」才调用 historyService.restoreFromHistory 落地为本地会话。
 */
interface RemoteSessionsStripProps {
  remoteSessions: RemoteSessionRef[];
  restoring: string | null;
  onRestore: (ref: RemoteSessionRef) => void;
}

function RemoteSessionsStrip({ remoteSessions, restoring, onRestore }: RemoteSessionsStripProps) {
  const { t } = useTranslation('chat')
  if (remoteSessions.length === 0) return null
  return (
    <div className="shrink-0 border-t border-border bg-background-surface/60 px-2 py-1.5">
      <div className="flex items-center gap-1 text-text-tertiary text-[10px] uppercase tracking-wide mb-1">
        <Cloud className="w-3 h-3" />
        <span>{t('multiSession.remoteSessions', '其他窗口的会话')}</span>
        <span className="ml-1 bg-background-hover rounded-full px-1.5 py-0.5 text-[10px] leading-none">
          {remoteSessions.length}
        </span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto">
        {remoteSessions.map((ref) => {
          const busy = restoring === ref.sessionId
          return (
            <button
              key={ref.sessionId}
              onClick={() => onRestore(ref)}
              disabled={busy || restoring !== null}
              title={ref.preview || ref.sessionId}
              className={clsx(
                'shrink-0 flex flex-col items-start gap-0.5 max-w-[220px] px-2 py-1 rounded-md border text-xs transition-colors',
                busy
                  ? 'border-border bg-background-hover text-text-muted cursor-wait'
                  : 'border-border-subtle bg-background-surface text-text-secondary hover:bg-background-hover hover:text-text-primary hover:border-border'
              )}
            >
              <span className="flex items-center gap-1.5 w-full min-w-0">
                {busy ? (
                  <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                ) : (
                  <Cloud className="w-3 h-3 shrink-0 text-text-muted" />
                )}
                <span className="truncate flex-1">{ref.title || '远端会话'}</span>
                {ref.streaming && (
                  <span className="shrink-0 flex items-center gap-1 text-[10px] text-text-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  </span>
                )}
                <span className="shrink-0 text-text-tertiary text-[10px]">
                  {formatUpdatedAt(ref.updatedAt)}
                </span>
              </span>
              {(ref.preview || ref.streaming) && (
                <span
                  className={clsx(
                    'w-full truncate text-[10px] leading-tight',
                    ref.streaming ? 'text-text-secondary' : 'text-text-tertiary'
                  )}
                >
                  {ref.preview || (ref.streaming ? '正在生成回复…' : '')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 暴露给父组件的方法 */
export interface MultiSessionGridRef {
  /** 滚动到指定会话 */
  scrollToSession: (sessionId: string) => void;
}

interface MultiSessionGridProps {
  /** 可选的 ref 转发 */
  ref?: React.Ref<MultiSessionGridRef>;
  /** 编辑消息回调 */
  onEditMessage?: (messageId: string, content: string) => void;
}

/** 内部滚动辅助函数 */
function scrollRowTo(rowRef: React.RefObject<HTMLDivElement | null>, index: number, cellWidth: number) {
  if (rowRef.current) {
    rowRef.current.scrollTo({ left: index * cellWidth, behavior: 'smooth' });
  }
}

/**
 * MultiSessionGrid 组件
 */
export const MultiSessionGrid = memo(forwardRef<MultiSessionGridRef, MultiSessionGridProps>(
  function MultiSessionGrid({ onEditMessage }, ref) {
    const { t } = useTranslation('chat');
    const multiSessionIds = useViewStore(state => state.multiSessionIds);
    const multiSessionRows = useViewStore(state => state.multiSessionRows);
    const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);
    const expandSessionId = useViewStore(state => state.expandSessionId);
    const setExpandSessionId = useViewStore(state => state.setExpandSessionId);
    const activeSessionId = useActiveSessionId();
    const pendingScrollToId = useViewStore(state => state.pendingScrollToId);
    const clearScrollRequest = useViewStore(state => state.clearScrollRequest);

    // 远端会话（其他窗口/端创建、本端未打开的可恢复条目）
    const { remote: remoteSessions } = useMergedSessionList();
    const [restoring, setRestoring] = useState<string | null>(null);

    // 滚动容器 ref
    const row1Ref = useRef<HTMLDivElement>(null);
    const row2Ref = useRef<HTMLDivElement>(null);

    // 获取所有会话元数据
    const allSessionMetadata = useSessionMetadataList();

    // 过滤出多窗口中显示的会话
    const displaySessions = useMemo(() => {
      return multiSessionIds
        .map(id => allSessionMetadata.find(m => m.id === id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined);
    }, [multiSessionIds, allSessionMetadata]);

    // 恢复远端会话：落地为本地会话（restoreFromHistory 内部 addToMultiView）
    const handleRestoreRemote = useCallback(async (ref: RemoteSessionRef) => {
      if (restoring) return
      setRestoring(ref.sessionId)
      try {
        const newActive = await materializeRemoteSession(ref.sessionId, ref.engineId, ref.title)
        if (newActive) {
          log.info('远端会话恢复成功', { sessionId: ref.sessionId, newActive })
        } else {
          useToastStore.getState().addToast({
            type: 'error',
            title: t('history.restoreFailed', '恢复会话失败'),
            message: t('history.restoreFailedMessage', '无法加载会话消息，会话数据可能已过期'),
          })
        }
      } catch (e) {
        useToastStore.getState().addToast({
          type: 'error',
          title: t('history.restoreFailed', '恢复会话失败'),
          message: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setRestoring(null)
      }
    }, [restoring, t]);

    // 按行分配会话
    const { row1Sessions, row2Sessions } = useMemo(() => {
      if (multiSessionRows === 1) {
        return { row1Sessions: displaySessions, row2Sessions: [] };
      } else {
        // 2 行模式：平均分配
        const mid = Math.ceil(displaySessions.length / 2);
        return {
          row1Sessions: displaySessions.slice(0, mid),
          row2Sessions: displaySessions.slice(mid),
        };
      }
    }, [displaySessions, multiSessionRows]);

    // 内部滚动实现
    const scrollToIndex = useCallback((index: number) => {
      if (multiSessionRows === 1) {
        scrollRowTo(row1Ref, index, multiSessionCellWidth);
      } else {
        const inRow1 = index < row1Sessions.length;
        const targetRef = inRow1 ? row1Ref : row2Ref;
        const targetIndex = inRow1 ? index : index - row1Sessions.length;
        scrollRowTo(targetRef, targetIndex, multiSessionCellWidth);
      }
    }, [multiSessionRows, multiSessionCellWidth, row1Sessions.length]);

    // 暴露滚动方法
    useImperativeHandle(ref, () => ({
      scrollToSession: (sessionId: string) => {
        const index = displaySessions.findIndex(s => s.id === sessionId);
        if (index === -1) return;
        scrollToIndex(index);
      },
    }), [displaySessions, scrollToIndex]);

    // 消费滚动信号
    useEffect(() => {
      if (!pendingScrollToId) return;
      const index = displaySessions.findIndex(s => s.id === pendingScrollToId);
      if (index !== -1) {
        scrollToIndex(index);
        clearScrollRequest();
      }
    }, [pendingScrollToId, displaySessions, scrollToIndex, clearScrollRequest]);

    // 展开切换回调
    const handleToggleExpand = useCallback((sessionId: string) => {
      setExpandSessionId(expandSessionId === sessionId ? null : sessionId);
    }, [expandSessionId, setExpandSessionId]);

    // 展开模式：只显示展开的会话
    if (expandSessionId) {
      const expandedSession = allSessionMetadata.find(m => m.id === expandSessionId);
      if (!expandedSession) {
        setExpandSessionId(null);
        return null;
      }

      return (
        <div className="flex flex-col h-full">
          <div className="flex-1 p-1">
            <SessionCell
              sessionId={expandSessionId}
              isActive={true}
              isExpanded={true}
              onToggleExpand={() => setExpandSessionId(null)}
            />
          </div>
        </div>
      );
    }

    // 空状态：引导添加会话（远程条垫底，仍可恢复其他窗口的会话）
    if (displaySessions.length === 0) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
            <LayoutGrid className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-secondary text-sm mb-4">{t('multiSession.mode')}</p>
            <p className="text-text-muted text-xs mb-4">{t('multiSession.hint')}</p>
          </div>
          <RemoteSessionsStrip
            remoteSessions={remoteSessions}
            restoring={restoring}
            onRestore={handleRestoreRemote}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* 第一行 */}
        <div
          ref={row1Ref}
          className={clsx(
            'flex-1 flex gap-1 p-1 overflow-x-auto overflow-y-hidden',
            multiSessionRows === 2 && 'border-b border-border'
          )}
          style={{ minHeight: multiSessionRows === 2 ? '50%' : '100%' }}
        >
          {row1Sessions.map((session) => (
            <div
              key={session.id}
              className="flex-shrink-0 h-full"
              style={{ width: multiSessionCellWidth }}
            >
              <SessionCell
                sessionId={session.id}
                isActive={session.id === activeSessionId}
                onToggleExpand={() => handleToggleExpand(session.id)}
                onEditMessage={onEditMessage}
              />
            </div>
          ))}
        </div>

        {/* 第二行（如果配置为 2 行）*/}
        {multiSessionRows === 2 && (
          <div
            ref={row2Ref}
            className="flex-1 flex gap-1 p-1 overflow-x-auto overflow-y-hidden"
            style={ROW2_MIN_HEIGHT_STYLE}
          >
            {row2Sessions.map((session) => (
              <div
                key={session.id}
                className="flex-shrink-0 h-full"
                style={{ width: multiSessionCellWidth }}
              >
                <SessionCell
                  sessionId={session.id}
                  isActive={session.id === activeSessionId}
                  onToggleExpand={() => handleToggleExpand(session.id)}
                  onEditMessage={onEditMessage}
                />
              </div>
            ))}
          </div>
        )}

        {/* 远程会话条：展示其他窗口/端创建、本端未打开的可恢复会话 */}
        <RemoteSessionsStrip
          remoteSessions={remoteSessions}
          restoring={restoring}
          onRestore={handleRestoreRemote}
        />
      </div>
    );
  }
));