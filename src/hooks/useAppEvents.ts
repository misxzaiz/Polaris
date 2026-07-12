/**
 * 应用事件监听 Hook
 *
 * 负责：
 * - Tauri EventRouter 初始化与注册
 * - file:opened / file:preview / editor:closed 事件
 * - 文件系统变更监听
 * - 定时任务到期事件（App 级常驻，确保调度面板未打开时任务仍执行）
 * - 工作区切换时清理聊天错误
 */

import { useEffect, useRef } from 'react';
import { listen } from '@/services/transport';
import { useTabStore } from '@/stores/tabStore';
import { useViewStore } from '@/stores/viewStore';
import { initEditorFileChangeListener } from '@/stores/fileEditorStore';
import { useTerminalScriptStore } from '@/stores/terminalScriptStore';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { useToastStore } from '@/stores/toastStore';
import { sessionStoreManager } from '@/stores/conversationStore';
import { getEventRouter } from '@/services/eventRouter';
import { browserAcquireComplete, normalizeBrowserUrl, type BrowserAcquireRequest } from '@/services/tauri/browserService';
import { initExecutionConsoleListeners } from '@/stores/executionConsoleStore';
import { isAIEvent } from '@/ai-runtime';
import i18n from '@/i18n';
import type { TaskDueEvent } from '@/types/scheduler';
import { createLogger } from '@/utils/logger';

const log = createLogger('AppEvents');

export function useAppEvents() {
  const eventListenerCleanupRef = useRef<(() => void) | null>(null);

  // 初始化事件路由器
  useEffect(() => {
    let mounted = true;

    const router = getEventRouter();
    router.initialize().then(() => {
      if (!mounted) return;
      const unregister = router.register('main', (payload: unknown) => {
        if (!isAIEvent(payload)) return;
        sessionStoreManager.getState().dispatchEvent(payload);
      });
      eventListenerCleanupRef.current = unregister;
    });

    return () => {
      mounted = false;
      eventListenerCleanupRef.current?.();
      eventListenerCleanupRef.current = null;
    };
  }, []);

  // AI 执行控制台：App 级安装集成执行监听（面板未打开也累计历史）
  useEffect(() => {
    initExecutionConsoleListeners().catch((e) =>
      log.warn('Execution console listeners init failed', { error: String(e) })
    );
  }, []);

  // 定时任务到期 → 执行任务（App 级常驻监听，原在 SchedulerPanel 内，
  // 面板未打开时事件无人消费导致任务不执行；handleTaskDue 自带重入保护）
  useEffect(() => {
    const unlistenPromise = listen<TaskDueEvent>('scheduler-task-due', async (event) => {
      const toast = useToastStore.getState();
      try {
        toast.info(
          i18n.t('scheduler:toast.taskDue'),
          i18n.t('scheduler:toast.executing', { name: event.taskName })
        );
        await useSchedulerStore.getState().handleTaskDue(event);
      } catch (e) {
        log.error('定时任务执行失败', e instanceof Error ? e : new Error(String(e)));
        toast.error(
          i18n.t('scheduler:toast.executeFailed'),
          e instanceof Error ? e.message : String(e)
        );
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // file:opened → 创建 Editor Tab
  useEffect(() => {
    const unlistenPromise = listen<{ path: string; name: string }>('file:opened', (payload) => {
      const { path, name } = payload;
      log.info('file:opened event', { path, name });
      useTabStore.getState().openEditorTab(path, name);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // file:preview → 创建 Preview Tab
  useEffect(() => {
    const unlistenPromise = listen<{ path: string; name: string; kind?: string }>('file:preview', (payload) => {
      const { path, name, kind } = payload;
      log.info('file:preview event', { path, name, kind });
      useTabStore.getState().openPreviewTab(path, name, { kind });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // browser://acquire-request -> create an agent-owned browser tab
  useEffect(() => {
    const unlistenPromise = listen<BrowserAcquireRequest>('browser://acquire-request', async (payload) => {
      try {
        const normalizedUrl = normalizeBrowserUrl(payload.url);
        useTabStore.getState().openBrowserTab(normalizedUrl, payload.title || 'Browser', {
          reuseExisting: false,
          activate: payload.activate !== false,
          metadata: {
            browserAcquireRequestId: payload.requestId,
            browserAgentKey: payload.agentKey || undefined,
            browserAcquireCreated: true,
          },
        });
      } catch (error) {
        await browserAcquireComplete({
          requestId: payload.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // browser://activate-tab-request -> focus a browser tab by id
  useEffect(() => {
    const unlistenPromise = listen<{ tabId: string }>('browser://activate-tab-request', (payload) => {
      if (!payload.tabId) return;
      useTabStore.getState().switchTab(payload.tabId);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // editor:closed → 隐藏编辑器视图
  useEffect(() => {
    const unlistenPromise = listen('editor:closed', () => {
      log.info('editor:closed event, hiding editor view');
      useViewStore.getState().setShowEditor(false);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // 文件系统变更监听
  useEffect(() => {
    const cleanup = initEditorFileChangeListener();
    return cleanup;
  }, []);

  // 终端脚本运行状态监听
  useEffect(() => {
    const cleanup = useTerminalScriptStore.getState().initEventListeners();
    return cleanup;
  }, []);

  // 工作区切换时清除聊天错误
  useEffect(() => {
    const handleWorkspaceSwitched = () => {
      const sessionId = sessionStoreManager.getState().activeSessionId;
      if (sessionId) {
        const store = sessionStoreManager.getState().stores.get(sessionId)?.getState();
        if (store?.error) {
          store.setError(null);
        }
      }
    };

    const handleWorkspaceChanged = (event: Event) => {
      const workspacePath = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (!workspacePath) return;
      useTerminalScriptStore.getState().runAutoScripts('workspace_open', workspacePath)
        .catch((error) => log.warn('Workspace auto scripts failed', { error: String(error) }));
    };

    window.addEventListener('workspace-switched', handleWorkspaceSwitched);
    window.addEventListener('workspace-changed', handleWorkspaceChanged);
    return () => {
      window.removeEventListener('workspace-switched', handleWorkspaceSwitched);
      window.removeEventListener('workspace-changed', handleWorkspaceChanged);
    };
  }, []);
}
