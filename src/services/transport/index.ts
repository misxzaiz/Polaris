/**
 * Transport 抽象层统一入口
 *
 * 根据运行环境自动选择 Tauri IPC 或 HTTP/WS 传输方式，
 * 对外暴露统一的 invoke / listen 接口。
 */

export type { TransportAdapter, TransportMode } from './types';
export { detectTransport } from './detector';
export { tauriTransport } from './tauriTransport';
export { createHttpTransport } from './httpTransport';
export type { ConnectionStatus, HttpTransportOptions } from './httpTransport';
export {
  getServerUrl,
  storeServerUrl,
} from './auth';

import { detectTransport } from './detector';
import { tauriTransport } from './tauriTransport';
import { createHttpTransport } from './httpTransport';
import type { ConnectionStatus } from './httpTransport';
import type { TransportAdapter } from './types';
import { getServerUrl } from './auth';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/utils/logger';
import { eventBus } from '@/services/eventBus';
import i18n from 'i18next';

const log = createLogger('Transport');

/** Track the "connection lost" toast so it can be dismissed on reconnect */
let connectionLostToastId: string | null = null;

function handleConnectionStatusChange(status: ConnectionStatus): void {
  const store = useToastStore.getState();

  if (status === 'failed') {
    if (!connectionLostToastId) {
      // 批 6（审计 5.10）：断线提示常驻——此前 6s 自动消失，之后用户面对的是
      // 静默停住的流式与状态栏角落一个 title-only 小图标。duration 0 = 不自动
      // 移除，恢复时主动 removeToast（下方 connected 分支已有）。
      connectionLostToastId = store.addToast({
        type: 'error',
        title: i18n.t('settings:web.connectionLost'),
        message: i18n.t('settings:web.connectionLostDesc'),
        duration: 0,
      });
    }
  } else if (status === 'connected') {
    if (connectionLostToastId) {
      store.removeToast(connectionLostToastId);
      connectionLostToastId = null;
      store.success(i18n.t('settings:web.connectionRestored'));
    }
  }
}

/**
 * 服务端重放缓冲无法覆盖断线窗口（resume-gap）时的兜底：
 * 对仍在流式输出的会话重新拉取落盘历史并校正状态。
 * 动态 import 避免 transport ↔ store 的模块级循环依赖。
 */
function handleResumeGap(): void {
  // P6：resyncAfterResumeGap 随对话域迁入 chat-desk 插件，经反向桥服务调用
  const svc = (window as unknown as {
    __POLARIS_APP_CORE__?: { services?: { webReconnectResync?: { resyncAfterResumeGap?: () => Promise<void> } } }
  }).__POLARIS_APP_CORE__?.services?.webReconnectResync
  if (!svc?.resyncAfterResumeGap) return
  svc.resyncAfterResumeGap().catch((err: unknown) => {
    log.error('Resume-gap 兜底恢复失败', err instanceof Error ? err : new Error(String(err)));
  });
}

/**
 * 首次连接（页面重载，lastSeq=0）兜底：页面关闭窗口内的流式增量不在 WS
 * 重放范围内，恢复只能靠后端权威快照。延迟触发（等 app init 重建 stores），
 * resyncAfterResumeGap 幂等且只作用于后端仍在 running 的会话。
 * （审计 1.7 缺口2 的近似修复；完整的投影发现机制在跨端批次落地。）
 */
function handleFreshConnect(): void {
  setTimeout(() => handleResumeGap(), 3000);
}

/** 当前传输模式 */
export const currentMode = detectTransport();

/**
 * 判断是否为移动端 Tauri（内嵌前端 + 本地 HTTP 服务模式）
 * 移动端需要从 Rust 后端读取服务器配置，而非使用 window.location.origin
 */
function isMobileTauri(): boolean {
  return currentMode === 'http' && typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    ('__TAURI_INTERNALS__' in window);
}

function createConfiguredHttpTransport(): TransportAdapter {
  return createHttpTransport(
    getServerUrl(),
    {
      onStatusChange: handleConnectionStatusChange,
      onResumeGap: handleResumeGap,
      onFreshConnect: handleFreshConnect,
    },
  );
}

let transport: TransportAdapter = currentMode === 'tauri'
  ? tauriTransport
  : createConfiguredHttpTransport();

function rebuildHttpTransport(): void {
  if (currentMode !== 'http') return;
  transport.disconnect?.();
  transport = createConfiguredHttpTransport();
}

/** 供 MobileConnectionGate 在用户保存新服务地址后重建 HTTP transport */
export const rebuildTransport = rebuildHttpTransport;

// Dev-only: 后端发现文件就绪后重建 HTTP transport。
// 首次模块初始化时 fetch('/.polaris-dev/server.json') 可能尚未返回，
// getServerUrl() 会回退到页面 origin(9827)；发现文件到达后需重建以指向真实后端。
// 仅 dev + VITE_FORCE_HTTP=1 时该事件会被 auth.ts 派发，线上不受影响。
if (typeof window !== 'undefined' && import.meta.env.DEV && import.meta.env.VITE_FORCE_HTTP === '1') {
  eventBus.on('polaris:dev-discovery-ready', () => {
    rebuildHttpTransport();
    void transport.manualReconnect?.().catch(() => {});
  });
}

/**
 * 尝试从移动端 Rust 后端加载服务器配置到 localStorage。
 * 启动时异步调用，不阻塞 transport 初始化。
 */
async function loadMobileServerConfig(): Promise<void> {
  if (!isMobileTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const config = await invoke<{ serverUrl?: string; server_url?: string; token?: string }>('get_server_config');
    const serverUrl = config?.serverUrl || config?.server_url || '';
    if (serverUrl) {
      localStorage.setItem('polaris_server_url', serverUrl);
      if (config.token) {
        localStorage.setItem('polaris_web_token_md5', config.token);
      }
      rebuildHttpTransport();
      log.info(`Mobile server config loaded: ${serverUrl}`);
    }
  } catch (err) {
    log.warn('Failed to load mobile server config', { error: err instanceof Error ? err.message : String(err) });
  }
}

// 移动端异步加载服务器配置，加载完成后重新连接
const mobileConfigLoadPromise = isMobileTauri()
  ? loadMobileServerConfig().then(() => {
      const url = getServerUrl();
      if (url && transport.manualReconnect) {
        log.info('Mobile config loaded, reconnecting...');
        transport.manualReconnect().catch(() => {});
      }
    })
  : Promise.resolve();

/** 供 MobileConnectionGate 等组件等待移动端配置从后端加载完毕 */
export const waitForMobileConfig = (): Promise<void> => mobileConfigLoadPromise;

const LOCAL_EVENTS = new Set([
  'file:opened',
  'file:preview',
  'editor:closed',
]);

const localListeners = new Map<string, Set<(payload: unknown) => void>>();

function emitLocal(event: string, payload: unknown): void {
  const listeners = localListeners.get(event);
  if (!listeners) return;

  for (const listener of Array.from(listeners)) {
    try {
      listener(payload);
    } catch (error) {
      log.error(`Local event listener failed for "${event}"`, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function listenLocal<T>(event: string, handler: (payload: T) => void): () => void {
  if (!localListeners.has(event)) {
    localListeners.set(event, new Set());
  }

  const listeners = localListeners.get(event);
  listeners?.add(handler as (payload: unknown) => void);

  return () => {
    const current = localListeners.get(event);
    if (!current) return;
    current.delete(handler as (payload: unknown) => void);
    if (current.size === 0) {
      localListeners.delete(event);
    }
  };
}

/**
 * 统一 emit — 向其他组件发送本地事件
 *
 * Tauri 模式：通过 Tauri event system 广播
 * HTTP 模式：使用简单本地 pub/sub（同页面内通信）
 */
export const emit = currentMode === 'tauri'
  ? (async (event: string, payload: unknown) => {
      const { emit: tauriEmit } = await import('@tauri-apps/api/event');
      return tauriEmit(event, payload);
    })
  : (async (event: string, payload: unknown) => {
      emitLocal(event, payload);
    }) as (event: string, payload: unknown) => Promise<void>;

/**
 * 断开传输层连接（清理 WebSocket 等资源）。
 * 仅在 HTTP 模式下有效；Tauri 模式为空操作。
 */
export const disconnect = (): void => { transport.disconnect?.(); };

/**
 * 统一 invoke — 调用后端命令
 *
 * Tauri 模式：直接 IPC invoke
 * HTTP 模式：POST 到对应 API endpoint
 *
 * Git 域已整体出仓（2026-11-12，架构方案 C）：此前 `git_*` → cap.git 的透明
 * 转发 shim 随宿主 Git 后端一并删除。前端不再存在任何 `invoke('git_*')` 调用，
 * Git 数据统一由插件自带 service 提供（经 cap.pluginServiceManager.request 转发）。
 */

export const invoke = transport.invoke;

/**
 * 统一 listen — 监听后端事件
 *
 * Tauri 模式：Tauri event system
 * HTTP 模式：WebSocket 消息分发
 */
export const listen = <T>(event: string, handler: (p: T) => void): Promise<() => void> => {
  if (currentMode === 'http' && LOCAL_EVENTS.has(event)) {
    return Promise.resolve(listenLocal(event, handler));
  }
  return transport.listen<T>(event, handler);
};

/**
 * 手动重连 — 重置重连计数器并立即尝试重新建立连接
 *
 * 仅在 HTTP 模式下有效；Tauri 模式会抛出错误。
 * 用于 Web 端在达到最大重连次数后，用户手动触发重连。
 */
export const manualReconnect = (): Promise<void> => {
  if (transport.manualReconnect) {
    return transport.manualReconnect();
  }
  return Promise.reject(new Error('Manual reconnect not supported in this mode'));
};
