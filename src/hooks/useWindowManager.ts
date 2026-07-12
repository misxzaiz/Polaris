/**
 * 窗口管理 Hook
 *
 * 负责：
 * - 窗口尺寸监听 + compact 模式同步
 * - 窗口透明度应用
 * - F12 DevTools 快捷键
 * - Shift+Ctrl+R 文件搜索/终端快速运行快捷键
 * - Ctrl+'+' 新建 AI 对话会话并自动切换、聚焦输入框
 * - Ctrl+Shift+'+' 弹出工作区/关联工作区选择（CreateSessionModal）
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
  /** Ctrl/Cmd+Shift+'+' 触发：弹出工作区/关联工作区选择弹窗 */
  onOpenCreateSessionModal: () => void;
  /** 新建会话弹窗是否已打开（打开期间屏蔽 '+' 系列快捷键，避免背后静默建会话） */
  isCreateSessionModalOpen: boolean;
}

export function useWindowManager({
  onOpenSettings,
  onToggleFileSearch,
  onOpenCreateSessionModal,
  isCreateSessionModalOpen,
}: UseWindowManagerOptions) {
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
      // 仅"裸 F12"切换 DevTools；带任何修饰键(Shift/Ctrl/Meta/Alt)交给应用内 keymap，
      // 例如 LSP 的 Shift+F12 查找引用。否则全局监听器会把这些组合也吞掉。
      if (
        e.key === 'F12' &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        isTauri()
      ) {
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
      // Ctrl/Cmd + '+' 系列快捷键（主键盘 Equal 物理键 / 小键盘 NumpadAdd）
      // 用 e.code 判断物理键，避免 Shift 状态下 e.key 值漂移（'=' → '+'）；
      // 同时保留 e.key 兜底，兼容 '+' 不在 Equal 键上的非美式布局
      // !e.repeat：避免按住不放时自动重复，连续创建大量会话
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.repeat &&
        (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=')
      ) {
        e.preventDefault();
        // 弹窗打开期间屏蔽，避免在弹窗背后静默创建会话
        if (isCreateSessionModalOpen) return;

        // Ctrl/Cmd + Shift + '+'：弹出工作区/关联工作区选择
        if (e.shiftKey) {
          onOpenCreateSessionModal();
          return;
        }

        // Ctrl/Cmd + '+'（不含 Shift）：快速新建会话并切换
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
        // 等一帧让视图完成切换后，请求聚焦聊天输入框（ChatInput 监听该事件）
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('chat:focus-input'));
        });
        log.info('快捷键新建会话', { newSessionId, workspaceId: activeWorkspaceId, engineId });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleFileSearch, onOpenCreateSessionModal, isCreateSessionModalOpen, t]);

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
