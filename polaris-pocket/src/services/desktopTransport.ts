/**
 * desktopTransport — Pocket 桌面端 WS 事件流传输层
 *
 * 直接复用主项目 @/services/transport/httpTransport 的 createHttpTransport，
 * 封装为模块级单例，保持与 Pocket 现有 API 兼容。
 */
import { createHttpTransport } from '@/services/transport/httpTransport';
import { getServerUrl } from './auth';

// ============================================================================
// 单例传输适配器
// ============================================================================

let transport: ReturnType<typeof createHttpTransport> | null = null;
let statusCallback: ((status: 'connected' | 'disconnected' | 'failed') => void) | null = null;

function getOrCreateTransport() {
  const url = getServerUrl();
  if (!url) throw new Error('未配置桌面端连接');
  if (!transport) {
    transport = createHttpTransport(url, {
      onStatusChange: (status) => {
        if (statusCallback) statusCallback(status);
      },
    });
  }
  return transport;
}

/** 重建传输（URL 变更时调用） */
function rebuildTransport(): void {
  if (transport) {
    try { transport.disconnect?.(); } catch { /* ignore */ }
  }
  transport = null;
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 注册事件监听 — 直接代理主项目 transport.listen。
 * 返回取消订阅函数。
 */
export function onEvent(event: string, handler: (payload: unknown) => void): () => void {
  let unsub: (() => void) | undefined;
  getOrCreateTransport().listen(event, handler).then((u) => { unsub = u; });
  return () => unsub?.();
}

/** 初始化传输层 */
export function initTransport(options?: { onStatusChange?: (status: string) => void }): void {
  statusCallback = options?.onStatusChange ?? null;
  // createHttpTransport 内部已注册 visibilitychange / online / focus 事件
}

/** 建立 WS 连接 */
export function connect(): Promise<void> {
  const t = getOrCreateTransport();
  return t.manualReconnect?.() ?? Promise.resolve();
}

/** 断开 WS 连接 */
export function disconnect(): void {
  try { getOrCreateTransport().disconnect?.(); } catch { /* ignore */ }
  transport = null;
}

/** 手动重连 */
export function manualReconnect(): Promise<void> {
  rebuildTransport();
  return connect();
}

/** 查询连接状态 */
export function getTransportStatus(): 'connected' | 'disconnected' | 'connecting' {
  return transport ? 'connected' : 'disconnected';
}