/**
 * MultiWindowMenu - 多窗口设置上拉菜单
 *
 * 只保留多窗口模式（无单窗口开关）：
 * - 布局（1行/2行）
 * - 格子宽度调整
 */

import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Grid3x3, RowsIcon, ColumnsIcon, Minus, Plus } from 'lucide-react';
import { useViewStore } from '@/stores';

/** 预设宽度选项 */
const WIDTH_PRESETS = [250, 450, 650, 850];

/**
 * 多窗口设置菜单组件
 */
export const MultiWindowMenu = memo(function MultiWindowMenu() {
  const { t } = useTranslation('chat');
  const multiSessionRows = useViewStore(state => state.multiSessionRows);
  const multiSessionCellWidth = useViewStore(state => state.multiSessionCellWidth);

  const setMultiSessionRows = useViewStore(state => state.setMultiSessionRows);
  const setMultiSessionCellWidth = useViewStore(state => state.setMultiSessionCellWidth);

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

  // 调整宽度
  const handleAdjustWidth = useCallback((delta: number) => {
    const newWidth = Math.max(100, multiSessionCellWidth + delta);
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
            : 'text-text-muted hover:text-text-primary hover:bg-background-hover'
        )}
        title={t('multiWindow.settings')}
        aria-label={t('multiWindow.settings')}
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
          {/* 分隔线 */}
          <div className="my-2 border-t border-border-subtle" />

          {/* 布局 */}
          <div className="mb-3">
            <div className="text-xs text-text-muted mb-1.5 px-1">{t('multiWindow.layout')}</div>
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
                <span>{t('multiWindow.row1')}</span>
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
                <span>{t('multiWindow.row2')}</span>
              </button>
            </div>
          </div>

          {/* 格子宽度 */}
          <div>
            <div className="text-xs text-text-muted mb-1.5 px-1">{t('multiWindow.cellWidth')}</div>

            {/* 步进调整 */}
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => handleAdjustWidth(-25)}
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
                aria-label={t('multiWindow.decreaseWidth')}
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <div className="flex-1 text-center text-sm font-medium tabular-nums">
                {multiSessionCellWidth}px
              </div>
              <button
                onClick={() => handleAdjustWidth(25)}
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-background-hover"
                aria-label={t('multiWindow.increaseWidth')}
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
        </div>
      )}
    </div>
  );
});