/**
 * MultiWindowMenu - 多窗口设置上拉菜单
 *
 * 合并功能：
 * - 多窗口模式开关
 * - 布局（1行/2行）
 * - 格子宽度调整
 */

import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { clsx } from 'clsx';
import { Grid3x3, RowsIcon, ColumnsIcon, Minus, Plus, Check } from 'lucide-react';
import { useViewStore } from '@/stores';
import { useActiveSessionId } from '@/stores/conversationStore/sessionStoreManager';

/** 预设宽度选项 */
const WIDTH_PRESETS = [250, 300, 350, 400, 450];

/**
 * 多窗口设置菜单组件
 */
export const MultiWindowMenu = memo(function MultiWindowMenu() {
  const multiSessionMode = useViewStore(state => state.multiSessionMode);
  const multiSessionRows = useViewStore(state => state.multiSessionRows);
  const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);

  const toggleMultiSessionMode = useViewStore(state => state.toggleMultiSessionMode);
  const setMultiSessionIds = useViewStore(state => state.setMultiSessionIds);
  const setMultiSessionRows = useViewStore(state => state.setMultiSessionRows);
  const setMultiSessionCellWidth = useViewStore(state => state.setMultiSessionCellWidth);

  const activeSessionId = useActiveSessionId();

  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // 切换多窗口模式
  const handleToggleMode = useCallback(() => {
    if (!multiSessionMode && activeSessionId) {
      setMultiSessionIds([activeSessionId]);
    }
    toggleMultiSessionMode();
  }, [multiSessionMode, activeSessionId, toggleMultiSessionMode, setMultiSessionIds]);

  // 调整宽度
  const handleAdjustWidth = useCallback((delta: number) => {
    const newWidth = Math.max(200, Math.min(600, multiSessionCellWidth + delta));
    setMultiSessionCellWidth(newWidth);
  }, [multiSessionCellWidth, setMultiSessionCellWidth]);

  // 选择预设宽度
  const handleSelectPreset = useCallback((width: number) => {
    setMultiSessionCellWidth(width);
  }, [setMultiSessionCellWidth]);

  return (
    <div className="relative">
      {/* 触发按钮 */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'p-1.5 rounded transition-colors',
          isOpen
            ? 'bg-primary/10 text-primary'
            : multiSessionMode
              ? 'bg-primary text-white'
              : 'text-text-muted hover:text-text-primary hover:bg-background-hover'
        )}
        title="多窗口设置"
        aria-label="多窗口设置"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Grid3x3 className="w-4 h-4" />
      </button>

      {/* 上拉菜单面板 */}
      {isOpen && (
        <div
          ref={panelRef}
          className={clsx(
            'absolute bottom-full left-0 mb-1 z-50 p-3',
            'min-w-[200px] rounded-lg shadow-lg',
            'bg-background-elevated border border-border'
          )}
          role="menu"
        >
          {/* Section 1: 开关 */}
          <button
            onClick={handleToggleMode}
            className={clsx(
              'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded',
              'text-sm transition-colors',
              multiSessionMode
                ? 'text-primary bg-primary/10'
                : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
            )}
            role="menuitemcheckbox"
            aria-checked={multiSessionMode}
          >
            <span>多窗口模式</span>
            {multiSessionMode && <Check className="w-4 h-4" />}
          </button>

          {/* Section 2-3: 仅多窗口时显示 */}
          {multiSessionMode && (
            <>
              {/* 分隔线 */}
              <div className="my-2 border-t border-border-subtle" />

              {/* Section 2: 布局 */}
              <div className="mb-3">
                <div className="text-xs text-text-muted mb-1.5 px-1">布局</div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setMultiSessionRows(1)}
                    className={clsx(
                      'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-sm',
                      'transition-colors',
                      multiSessionRows === 1
                        ? 'bg-primary text-white'
                        : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                    )}
                    role="menuitemradio"
                    aria-checked={multiSessionRows === 1}
                  >
                    <RowsIcon className="w-3.5 h-3.5" />
                    <span>1行</span>
                  </button>
                  <button
                    onClick={() => setMultiSessionRows(2)}
                    className={clsx(
                      'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-sm',
                      'transition-colors',
                      multiSessionRows === 2
                        ? 'bg-primary text-white'
                        : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                    )}
                    role="menuitemradio"
                    aria-checked={multiSessionRows === 2}
                  >
                    <ColumnsIcon className="w-3.5 h-3.5" />
                    <span>2行</span>
                  </button>
                </div>
              </div>

              {/* Section 3: 格子宽度 */}
              <div>
                <div className="text-xs text-text-muted mb-1.5 px-1">格子宽度</div>

                {/* 步进调整 */}
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => handleAdjustWidth(-25)}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
                    aria-label="减少宽度"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <div className="flex-1 text-center text-sm font-medium tabular-nums">
                    {multiSessionCellWidth}px
                  </div>
                  <button
                    onClick={() => handleAdjustWidth(25)}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
                    aria-label="增加宽度"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* 预设按钮 */}
                <div className="flex gap-1">
                  {WIDTH_PRESETS.map((width) => (
                    <button
                      key={width}
                      onClick={() => handleSelectPreset(width)}
                      className={clsx(
                        'flex-1 px-1 py-1 text-xs rounded transition-colors',
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
            </>
          )}
        </div>
      )}
    </div>
  );
});
