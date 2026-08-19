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
import { schedulerStop, schedulerStart } from '@/services/tauri/schedulerService';
import { useLspIndexStore } from '@/stores/lspIndexStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
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
  // scheduler daemon：false → true 时热启动
  // 用户开启开关 = 明确意图想要守护进程运行，直接 schedulerStart。
  // 后端命令层会获取锁并启动；若已运行（is_holding_lock）则幂等返回。
  // 与 setup 闭包的懒激活（无任务不启）不同 —— 热切换是用户主动开启，
  // 即便无任务也拉起（空转开销极低：10s 一次轻查询），尊重用户意图。
  if (!prev.schedulerDaemon && next.schedulerDaemon) {
    log.info('schedulerDaemon 开启，热启动调度器守护进程');
    schedulerStart().catch((err) => {
      log.warn('热启动调度器失败', { error: String(err) });
    });
  }

  // lspIndex：true → false 时关闭所有 workspace 索引引擎（释放 DB + watcher）
  if (prev.lspIndex && !next.lspIndex) {
    log.info('lspIndex 关闭，释放索引引擎');
    const { openedWorkspaces, ensureClose } = useLspIndexStore.getState();
    // 关闭所有已打开 workspace 的引擎（确保 watcher / DB 句柄释放）
    openedWorkspaces.forEach((ws) => {
      void ensureClose(ws);
    });
    // 空集合时也补一层保险：清理 UI 状态占位（无动作，如无 workspace 则 no-op）
    if (openedWorkspaces.size === 0) {
      log.debug('lspIndex 关闭时无已打开 workspace');
    }
  }
  // lspIndex：false → true 时热开启当前 workspace（按需拉起，非阻塞）
  if (!prev.lspIndex && next.lspIndex) {
    log.info('lspIndex 开启，热启动索引引擎');
    const ws = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
    if (ws) {
      void useLspIndexStore.getState().ensureOpen(ws);
    }
  }

  // codeEditorLanguages：false → true 时预热全部编辑器语言包，
  // 使后续打开任意文件时命中模块缓存、消除首延迟。
  // true → false 无需动作（已加载的模块留在缓存，只是不再预热新的；行为自然降级）。
  if (!prev.codeEditorLanguages && next.codeEditorLanguages) {
    log.info('codeEditorLanguages 开启，预热编辑器语言包');
    import('@/components/Editor/Editor')
      .then(({ preloadLanguageExtensions }) => {
        void preloadLanguageExtensions().catch((err) => {
          log.warn('编辑器语言包预热失败', { error: String(err) });
        });
      })
      .catch((err) => {
        log.warn('加载 Editor 模块失败', { error: String(err) });
      });
  }

  // 其余开关（syntaxHighlighting / mermaidDiagrams / katexMath /
  // pluginAutoStart）均为"下次调用时生效"型，
  // 无需主动停止 —— 关闭后渲染层/命令层门控会自然降级。
}
