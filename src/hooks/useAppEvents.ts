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

import { useEffect } from 'react';
import { listen } from '@/services/transport';
import { useTabStore } from '@/stores/tabStore';
import { useViewStore } from '@/stores/viewStore';
import { useNarrowTabStore } from '@/stores/narrowTabStore';
import { initEditorFileChangeListener } from '@/stores/fileEditorStore';
import { initPluginLifecycleSubscriber } from '@/stores/pluginLifecycleSubscriber';
import { createLogger } from '@/utils/logger';

const log = createLogger('AppEvents');

export function useAppEvents() {
  // P6：EventRouter 路由与 dispatch_task 监听随对话域迁入 chat-desk 插件
  //（插件 bootstrap.ts）；宿主仅保留非对话域事件。

  // 插件生命周期事件（plugin.lifecycle）→ 刷新插件状态/清单（App 级常驻，
  // 非 PluginTab 消费方也能感知安装/卸载/更新/开关变化）
  useEffect(() => {
    return initPluginLifecycleSubscriber();
  }, []);

  // file:opened → 创建 Editor Tab
  // 窄窗口（isCompact）下 CenterStage 被门控不渲染，tab 静默创建无反馈。
  // 此时同步打开窄窗口 tab 覆盖层（信号为 tabId，覆盖层按 tab.type 分流渲染），
  // 让用户能看到文件内容。宽窗口下 narrowTabId 不被消费（App.tsx 的覆盖层分支
  // 由 isCompact 门控），不影响内联 CenterStage 渲染。
  useEffect(() => {
    const unlistenPromise = listen<{ path: string; name: string }>('file:opened', (payload) => {
      const { path, name } = payload;
      log.info('file:opened event', { path, name });
      const tabId = useTabStore.getState().openEditorTab(path, name);
      if (useViewStore.getState().compactMode.isCompactMode) {
        useNarrowTabStore.getState().openNarrowTab(tabId);
      }
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

  // 终端脚本监听/自动运行已随内置终端出仓（terminal-desk 插件 + H4 事件桥承接）

  // P6：工作区切换清聊天错误随对话域迁入 chat-desk 插件。

}
