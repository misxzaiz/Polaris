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
import { getServerUrl } from './auth';
import { useToastStore } from '../../stores/toastStore';
import i18n from 'i18next';

/** Track the "connection lost" toast so it can be dismissed on reconnect */
let connectionLostToastId: string | null = null;

function handleConnectionStatusChange(status: ConnectionStatus): void {
  const store = useToastStore.getState();

  if (status === 'failed') {
    if (!connectionLostToastId) {
      connectionLostToastId = store.error(
        i18n.t('settings:web.connectionLost'),
        i18n.t('settings:web.connectionLostDesc'),
      );
    }
  } else if (status === 'connected') {
    if (connectionLostToastId) {
      store.removeToast(connectionLostToastId);
      connectionLostToastId = null;
      store.success(i18n.t('settings:web.connectionRestored'));
    }
  }
}

/** 当前传输模式 */
export const currentMode = detectTransport();

/** 全局传输适配器单例 */
const transport = currentMode === 'tauri'
  ? tauriTransport
  : createHttpTransport(
      getServerUrl(),
      { onStatusChange: handleConnectionStatusChange },
    );

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
      console.error(`[Transport] Local event listener failed for "${event}":`, error);
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
 */
export const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  transport.invoke<T>(cmd, args);

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
