/**
 * MultiSessionGrid 组件 - 多会话窗口横向滚动布局
 *
 * 功能：
 * - 支持 1 行或 2 行布局
 * - 横向滚动显示多个会话
 * - 统一格子宽度
 * - 支持展开/关闭操作
 */

import { memo, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { LayoutGrid } from 'lucide-react';
import { SessionCell } from './SessionCell';
import { useViewStore } from '@/stores';
import {
  useSessionMetadataList,
  useActiveSessionId,
} from '@/stores/conversationStore/sessionStoreManager';

/** 第二行静态最小高度样式 */
const ROW2_MIN_HEIGHT_STYLE: React.CSSProperties = { minHeight: '50%' }

/** 暴露给父组件的方法 */
export interface MultiSessionGridRef {
  /** 滚动到指定会话 */
  scrollToSession: (sessionId: string) => void;
}

interface MultiSessionGridProps {
  /** 可选的 ref 转发 */
  ref?: React.Ref<MultiSessionGridRef>;
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
  function MultiSessionGrid(_, ref) {
    const { t } = useTranslation('chat');
    const multiSessionIds = useViewStore(state => state.multiSessionIds);
    const multiSessionMode = useViewStore(state => state.multiSessionMode);
    const multiSessionRows = useViewStore(state => state.multiSessionRows);
    const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);
    const expandSessionId = useViewStore(state => state.expandSessionId);
    const setExpandSessionId = useViewStore(state => state.setExpandSessionId);
    const activeSessionId = useActiveSessionId();
    const pendingScrollToId = useViewStore(state => state.pendingScrollToId);
    const clearScrollRequest = useViewStore(state => state.clearScrollRequest);

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

    // 如果未开启多会话模式，返回 null
    if (!multiSessionMode) {
      return null;
    }

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

    // 空状态：引导添加会话
    if (displaySessions.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
          <LayoutGrid className="w-12 h-12 text-text-muted mb-4" />
          <p className="text-text-secondary text-sm mb-4">{t('multiSession.mode')}</p>
          <p className="text-text-muted text-xs mb-4">{t('multiSession.hint')}</p>
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
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
));