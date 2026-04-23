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
export {
  getTokenFromUrl,
  getStoredToken,
  storeToken,
  clearStoredToken,
  getServerUrl,
  storeServerUrl,
  initWebAuth,
} from './auth';

import { detectTransport } from './detector';
import { tauriTransport } from './tauriTransport';
import { createHttpTransport } from './httpTransport';
import { getStoredToken, getServerUrl } from './auth';

/** 当前传输模式 */
export const currentMode = detectTransport();

/** 全局传输适配器单例 */
const transport = currentMode === 'tauri'
  ? tauriTransport
  : createHttpTransport(
      getServerUrl(),
      () => getStoredToken() || '',
    );

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
export const listen = <T>(event: string, handler: (p: T) => void): Promise<() => void> =>
  transport.listen<T>(event, handler);
