/**
 * 性能开关热切换 Store
 *
 * 监听后端 `config-changed` 事件，在性能开关从 true → false 时，
 * 停止对应的后端守护服务（file watcher / scheduler）。
 *
 * 前端 React 渲染层无需此 store —— configStore.updateConfig 保存后
 * 已通过 getConfig() 重拉 config，usePerformanceFlag 等响应式 selector
 * 会自动跟随。此 store 仅负责"后端长生命周期服务的停止"这一缺口。
 *
 * 开关从 false → true 时不主动启动服务（避免非预期的后台进程拉起），
 * 由对应功能首次调用时按需启动。
 */

import { create } from 'zustand';
import { listen } from '@/services/transport';
import { createLogger } from '@/utils/logger';
import { fsWatchStop } from '@/services/tauri/fileService';
import { schedulerStop } from '@/services/tauri/schedulerService';
import type { PerformanceFeatures } from '@/types';

type UnlistenFn = () => void;

const log = createLogger('PerformanceHotSwitch');

interface PerformanceHotSwitchState {
  /** 上一次的 performance 快照（用于对比检测 true→false 跳变） */
  prev: PerformanceFeatures;
  /** 是否已注册监听（幂等保护，防多次 init 累积 listener） */
  listening: boolean;
  /** 初始化事件监听。返回 cleanup 函数。需在应用启动时调用一次。 */
  init: (initialPerf: PerformanceFeatures) => () => void;
}

export const usePerformanceHotSwitch = create<PerformanceHotSwitchState>((set, get) => ({
  prev: {},
  listening: false,

  init: (initialPerf) => {
    // 幂等：若已监听则仅更新 prev 快照，不重复注册
    if (get().listening) {
      set({ prev: initialPerf });
      return () => {};
    }
    set({ prev: initialPerf, listening: true });
    let unlisten: UnlistenFn | null = null;

    listen<{ performance?: PerformanceFeatures }>('config-changed', (event) => {
      const next = event.performance ?? {};
      const prev = get().prev;
      handleSwitch(prev, next);
      set({ prev: next });
    }).then((fn) => {
      unlisten = fn;
    }).catch((err) => {
      log.warn('监听 config-changed 失败', { error: String(err) });
      set({ listening: false });
    });

    return () => {
      if (unlisten) unlisten();
      set({ listening: false });
    };
  },
}));

/**
 * 检测开关从 true→false 的跳变，停止对应后端守护服务。
 * false→true 不主动启动（按需启动原则）。
 */
function handleSwitch(prev: PerformanceFeatures, next: PerformanceFeatures): void {
  // file watcher：true → false 时停止
  if (prev.fileWatcher && !next.fileWatcher) {
    log.info('fileWatcher 关闭，停止文件监听');
    fsWatchStop().catch((err) => {
      log.warn('停止文件监听失败', { error: String(err) });
    });
  }

  // scheduler daemon：true → false 时停止
  if (prev.schedulerDaemon && !next.schedulerDaemon) {
    log.info('schedulerDaemon 关闭，停止调度器守护进程');
    schedulerStop().catch((err) => {
      log.warn('停止调度器失败', { error: String(err) });
    });
  }

  // 其余开关（syntaxHighlighting / mermaidDiagrams / katexMath / lspIndex /
  // codeEditorLanguages / pluginAutoStart）均为"下次调用时生效"型，
  // 无需主动停止 —— 关闭后渲染层/命令层门控会自然降级。
}
