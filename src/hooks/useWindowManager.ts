/**
 * 窗口管理 Hook
 *
 * 负责：
 * - 窗口尺寸监听 + compact 模式同步
 * - 窗口透明度应用
 * - F12 DevTools 快捷键
 * - Shift+Ctrl+R 文件搜索/终端快速运行快捷键
 * - Ctrl+'+' 新建 AI 对话会话并自动切换
 * - navigate-to-settings 事件监听
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '@/stores';
import { useViewStore } from '@/stores/viewStore';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { useWindowSize } from './useWindowSize';
import * as tauri from '@/services/tauri';
import { isTauri } from '@/utils/platform';
import { createLogger } from '@/utils/logger';

const log = createLogger('WindowManager');

interface UseWindowManagerOptions {
  onOpenSettings: (tab?: string) => void;
  onToggleFileSearch: () => void;
}

export function useWindowManager({ onOpenSettings, onToggleFileSearch }: UseWindowManagerOptions) {
  const { t } = useTranslation('chat');
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
      if (e.key === 'F12' && isTauri()) {
        e.preventDefault();
        try {
          await tauri.invoke('toggle_devtools');
        } catch (error) {
          log.error('切换 DevTools 失败', error as Error);
        }
      }
      if (e.key === 'R' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (useViewStore.getState().leftPanelType === 'terminal') {
          window.dispatchEvent(new CustomEvent('terminal:open-runner'));
        } else {
          onToggleFileSearch();
        }
      }
      // Ctrl/Cmd + '+' 新建 AI 对话会话并切换过去
      // 兼容：主键盘 Shift+= 得到的 '+'、不按 Shift 的 '='（与浏览器放大同手感）、小键盘 NumpadAdd
      // !e.repeat：避免按住不放时自动重复，连续创建大量会话
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.repeat &&
        (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')
      ) {
        e.preventDefault();
        const manager = sessionStoreManager.getState();
        // 新会话跟随当前活跃会话的工作区：有工作区则建 project 会话，否则建 free 会话
        const activeId = manager.activeSessionId;
        const activeWorkspaceId = activeId
          ? manager.sessionMetadata.get(activeId)?.workspaceId ?? undefined
          : undefined;
        const engineId = normalizeEngineId(useConfigStore.getState().config?.defaultEngine);
        const number = manager.sessionMetadata.size + 1;

        const newSessionId = manager.createSession({
          type: activeWorkspaceId ? 'project' : 'free',
          title: t('newSession.newChat', { number }),
          workspaceId: activeWorkspaceId,
          workspaceLocked: Boolean(activeWorkspaceId),
          engineId,
        });
        // createSession 已设为活跃会话并按需 addToMultiView；switchSession 补充滚动定位
        manager.switchSession(newSessionId);
        log.info('快捷键新建会话', { newSessionId, workspaceId: activeWorkspaceId, engineId });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleFileSearch, t]);

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
