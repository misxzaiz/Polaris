/**
 * 窗口管理 Hook
 *
 * 负责：
 * - 窗口尺寸监听 + compact 模式同步
 * - 窗口透明度应用
 * - F12 DevTools 快捷键
 * - Shift+Ctrl+R 文件搜索快捷键
 * - navigate-to-settings 事件监听
 */

import { useEffect } from 'react';
import { useConfigStore } from '../stores';
import { useViewStore } from '../stores/viewStore';
import { useWindowSize } from './useWindowSize';
import * as tauri from '../services/tauri';
import { createLogger } from '../utils/logger';

const log = createLogger('WindowManager');

interface UseWindowManagerOptions {
  onOpenSettings: (tab?: string) => void;
  onToggleFileSearch: () => void;
}

export function useWindowManager({ onOpenSettings, onToggleFileSearch }: UseWindowManagerOptions) {
  const config = useConfigStore(state => state.config);
  const compactMode = useViewStore(state => state.compactMode);
  const updateCompactMode = useViewStore(state => state.updateCompactMode);

  const { width: windowWidth, height: windowHeight, isCompact } = useWindowSize({ compactThreshold: 500 });

  // 同步 compact 模式到 store
  useEffect(() => {
    if (compactMode.isCompactMode !== isCompact ||
        compactMode.windowWidth !== windowWidth ||
        compactMode.windowHeight !== windowHeight) {
      updateCompactMode({
        isCompactMode: isCompact,
        windowWidth,
        windowHeight,
      });
    }
  }, [isCompact, windowWidth, windowHeight, compactMode, updateCompactMode]);

  // 窗口透明度
  useEffect(() => {
    const windowSettings = config?.window;
    if (!windowSettings) return;

    const opacityValue = isCompact
      ? (windowSettings.compactOpacity ?? 100) / 100
      : (windowSettings.normalOpacity ?? 100) / 100;

    document.documentElement.style.setProperty('--window-opacity', String(opacityValue));
  }, [config?.window, isCompact]);

  // F12 + Shift+Ctrl+R 快捷键
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        try {
          await tauri.invoke('toggle_devtools');
        } catch (error) {
          log.error('切换 DevTools 失败', error as Error);
        }
      }
      if (e.key === 'R' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onToggleFileSearch();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleFileSearch]);

  // navigate-to-settings 事件
  useEffect(() => {
    const handleNavigateToSettings = (e: CustomEvent<{ tab?: string }>) => {
      onOpenSettings(e.detail?.tab);
    };

    window.addEventListener('navigate-to-settings', handleNavigateToSettings as EventListener);
    return () => window.removeEventListener('navigate-to-settings', handleNavigateToSettings as EventListener);
  }, [onOpenSettings]);

  return { windowWidth, windowHeight, isCompact };
}
