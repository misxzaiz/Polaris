/**
 * 应用事件监听 Hook
 *
 * 负责：
 * - Tauri EventRouter 初始化与注册
 * - file:opened / file:preview / editor:closed 事件
 * - 文件系统变更监听
 * - 工作区切换时清理聊天错误
 */

import { useEffect, useRef } from 'react';
import { listen } from '../services/transport';
import { useTabStore } from '../stores/tabStore';
import { useViewStore } from '../stores/viewStore';
import { initEditorFileChangeListener } from '../stores/fileEditorStore';
import { sessionStoreManager } from '../stores/conversationStore';
import { getEventRouter } from '../services/eventRouter';
import { isAIEvent } from '../ai-runtime';
import { createLogger } from '../utils/logger';

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

    window.addEventListener('workspace-switched', handleWorkspaceSwitched);
    return () => window.removeEventListener('workspace-switched', handleWorkspaceSwitched);
  }, []);
}
