/**
 * MultiSessionGrid 组件 - 多会话窗口横向滚动布局
 *
 * 功能：
 * - 支持 1 行或 2 行布局
 * - 横向滚动显示多个会话
 * - 统一格子宽度
 * - 支持展开/关闭操作
 */

import { memo, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { LayoutGrid, Square, RowsIcon, ColumnsIcon, Minus, Plus } from 'lucide-react';
import { SessionCell } from './SessionCell';
import { useViewStore } from '../../stores';
import {
  useSessionMetadataList,
  useActiveSessionId,
} from '../../stores/conversationStore/sessionStoreManager';

/** 暴露给父组件的方法 */
export interface MultiSessionGridRef {
  /** 滚动到指定会话 */
  scrollToSession: (sessionId: string) => void;
}

interface MultiSessionGridProps {
  /** 可选的 ref 转发 */
  ref?: React.Ref<MultiSessionGridRef>;
}

/**
 * MultiSessionGrid 组件
 */
export const MultiSessionGrid = memo(forwardRef<MultiSessionGridRef, MultiSessionGridProps>(
  function MultiSessionGrid(_, ref) {
    const multiSessionIds = useViewStore(state => state.multiSessionIds);
    const multiSessionMode = useViewStore(state => state.multiSessionMode);
    const multiSessionRows = useViewStore(state => state.multiSessionRows);
    const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);
    const expandSessionId = useViewStore(state => state.expandSessionId);
    const setExpandSessionId = useViewStore(state => state.setExpandSessionId);
    const activeSessionId = useActiveSessionId();

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

    // 暴露滚动方法
    useImperativeHandle(ref, () => ({
      scrollToSession: (sessionId: string) => {
        const index = displaySessions.findIndex(s => s.id === sessionId);
        if (index === -1) return;

        if (multiSessionRows === 1) {
          // 1 行模式：滚动到对应位置
          if (row1Ref.current) {
            const scrollLeft = index * multiSessionCellWidth;
            row1Ref.current.scrollTo({ left: scrollLeft, behavior: 'smooth' });
          }
        } else {
          // 2 行模式：确定在哪一行并滚动
          const inRow1 = index < row1Sessions.length;
          const targetRef = inRow1 ? row1Ref : row2Ref;
          const targetIndex = inRow1 ? index : index - row1Sessions.length;

          if (targetRef.current) {
            const scrollLeft = targetIndex * multiSessionCellWidth;
            targetRef.current.scrollTo({ left: scrollLeft, behavior: 'smooth' });
          }
        }
      },
    }), [displaySessions, multiSessionRows, multiSessionCellWidth, row1Sessions.length]);

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
          <p className="text-text-secondary text-sm mb-4">多会话窗口模式</p>
          <p className="text-text-muted text-xs mb-4">使用状态栏上的按钮新建会话</p>
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
            style={{ minHeight: '50%' }}
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

/**
 * 多会话模式切换按钮
 */
export const MultiSessionToggle = memo(function MultiSessionToggle() {
  const multiSessionMode = useViewStore(state => state.multiSessionMode);
  const toggleMultiSessionMode = useViewStore(state => state.toggleMultiSessionMode);
  const setMultiSessionIds = useViewStore(state => state.setMultiSessionIds);
  const activeSessionId = useActiveSessionId();

  const handleToggle = useCallback(() => {
    if (!multiSessionMode && activeSessionId) {
      // 开启多会话模式时，将当前活跃会话添加到多窗口
      setMultiSessionIds([activeSessionId]);
    }
    toggleMultiSessionMode();
  }, [multiSessionMode, activeSessionId, toggleMultiSessionMode, setMultiSessionIds]);

  return (
    <button
      onClick={handleToggle}
      className={clsx(
        'p-1.5 rounded transition-colors',
        multiSessionMode
          ? 'bg-primary text-white'
          : 'text-text-muted hover:text-text-primary hover:bg-background-hover'
      )}
      title={multiSessionMode ? '切换单会话模式' : '切换多会话模式'}
    >
      <Square className="w-4 h-4" />
    </button>
  );
});

/**
 * 行数切换按钮
 */
export const MultiSessionRowsToggle = memo(function MultiSessionRowsToggle() {
  const multiSessionRows = useViewStore(state => state.multiSessionRows);
  const setMultiSessionRows = useViewStore(state => state.setMultiSessionRows);
  const multiSessionMode = useViewStore(state => state.multiSessionMode);

  const handleToggle = useCallback(() => {
    setMultiSessionRows(multiSessionRows === 1 ? 2 : 1);
  }, [multiSessionRows, setMultiSessionRows]);

  // 非多窗口模式时不显示 - 必须在所有 hooks 之后返回
  if (!multiSessionMode) return null;

  return (
    <button
      onClick={handleToggle}
      className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-background-hover transition-colors"
      title={multiSessionRows === 1 ? '切换为 2 行布局' : '切换为 1 行布局'}
    >
      {multiSessionRows === 1 ? (
        <RowsIcon className="w-4 h-4" />
      ) : (
        <ColumnsIcon className="w-4 h-4" />
      )}
    </button>
  );
});

/** 预设宽度选项 */
const WIDTH_PRESETS = [250, 300, 350, 400, 450];

/**
 * 格子宽度设置上拉面板
 */
export const MultiSessionWidthPopover = memo(function MultiSessionWidthPopover() {
  const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);
  const setMultiSessionCellWidth = useViewStore(state => state.setMultiSessionCellWidth);
  const multiSessionMode = useViewStore(state => state.multiSessionMode);

  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // 调整宽度
  const handleAdjust = useCallback((delta: number) => {
    const newWidth = Math.max(200, Math.min(600, multiSessionCellWidth + delta));
    setMultiSessionCellWidth(newWidth);
  }, [multiSessionCellWidth, setMultiSessionCellWidth]);

  // 选择预设
  const handleSelectPreset = useCallback((width: number) => {
    setMultiSessionCellWidth(width);
    setIsOpen(false);
  }, [setMultiSessionCellWidth]);

  // 非多窗口模式时不显示 - 必须在所有 hooks 之后返回
  if (!multiSessionMode) return null;

  return (
    <div className="relative" ref={panelRef}>
      {/* 触发按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-background-hover transition-colors"
        title="设置格子宽度"
      >
        <Minus className="w-4 h-4" />
      </button>

      {/* 上拉面板 */}
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 z-50 p-3 bg-background-elevated border border-border rounded-lg shadow-lg min-w-[180px]">
          {/* 标题 */}
          <div className="text-xs text-text-secondary mb-2">格子宽度</div>

          {/* 滑块区域 */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => handleAdjust(-25)}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
            >
              <Minus className="w-3 h-3" />
            </button>
            <div className="flex-1 text-center text-sm font-medium tabular-nums">
              {multiSessionCellWidth}px
            </div>
            <button
              onClick={() => handleAdjust(25)}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* 预设按钮 */}
          <div className="flex gap-1">
            {WIDTH_PRESETS.map((width) => (
              <button
                key={width}
                onClick={() => handleSelectPreset(width)}
                className={clsx(
                  'px-2 py-1 text-xs rounded transition-colors',
                  width === multiSessionCellWidth
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
                )}
              >
                {width}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});