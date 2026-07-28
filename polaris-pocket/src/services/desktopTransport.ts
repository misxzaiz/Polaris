/**
 * desktopTransport — Pocket 桌面端 WebSocket 事件流传输层
 *
 * 参考 polaris-mobile httpTransport.ts 的 WS 实现，精简为 Pocket 专用。
 * 提供：
 * - WS 连接管理（自动重连、指数退避）
 * - 客户端心跳（25s）
 * - resume 协议（断线重连后补发丢失事件）
 * - 事件订阅/取消订阅
 * - wake-up 处理器（锁屏/切回后立即重连）
 *
 * 不包含 HTTP invoke 部分（由 desktopClient.ts 提供）。
 */

import { getServerUrl, getTokenMd5 } from './auth';

// ============================================================================
// 配置
// ============================================================================

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER = 0.3;
const MAX_RECONNECT_ATTEMPTS = 50;
const CLIENT_HEARTBEAT_MS = 25_000;
const PROBE_TIMEOUT_MS = 5_000;

export type ConnectionStatus = 'connected' | 'disconnected' | 'failed';

export interface TransportOptions {
  onStatusChange?: (status: ConnectionStatus) => void;
  onResumeGap?: () => void;
}

// ============================================================================
// 事件回调
// ============================================================================

const listeners = new Map<string, Set<(payload: unknown) => void>>();

export function onEvent(event: string, handler: (payload: unknown) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);

  // 同步订阅到服务端
  sendWsMsg({ type: 'subscribe', events: [event] });

  return () => {
    const set = listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        sendWsMsg({ type: 'unsubscribe', events: [event] });
      }
    }
  };
}

// ============================================================================
// WS 连接管理
// ============================================================================

let ws: WebSocket | null = null;
let wsConnecting: Promise<void> | null = null;
let reconnectAttempt = 0;
let intentionalClose = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeq = 0;
let statusCallback: ((status: ConnectionStatus) => void) | null = null;
let resumeGapCallback: (() => void) | null = null;

function buildWsUrl(): string {
  const baseUrl = getServerUrl();
  if (!baseUrl) return '';
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  const tokenMd5 = getTokenMd5();
  if (tokenMd5) {
    const sep = wsUrl.includes('?') ? '&' : '?';
    return `${wsUrl}/api/ws${sep}token=${encodeURIComponent(tokenMd5)}`;
  }
  return `${wsUrl}/api/ws`;
}

function sendWsMsg(obj: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function syncSubscriptions(): void {
  const events = Array.from(listeners.keys()).filter(
    (key) => (listeners.get(key)?.size ?? 0) > 0,
  );
  if (events.length > 0) {
    sendWsMsg({ type: 'subscribe', events });
  }
}

function backoffDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  const jitter = base * RECONNECT_JITTER * Math.random();
  return base + jitter;
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearProbe(): void {
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

function scheduleReconnect(): void {
  if (intentionalClose) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    statusCallback?.('failed');
    return;
  }
  const delay = backoffDelay(reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!intentionalClose) {
      connectWs().catch(() => { /* scheduleReconnect called on close */ });
    }
  }, delay);
}

function connectWs(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (wsConnecting) return wsConnecting;

  const url = buildWsUrl();
  if (!url) {
    statusCallback?.('disconnected');
    return Promise.reject(new Error('未配置服务端地址'));
  }

  wsConnecting = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);

    const openHandler = () => {
      socket.removeEventListener('open', openHandler);
      socket.removeEventListener('error', errorHandler);
      ws = socket;
      wsConnecting = null;
      reconnectAttempt = 0;
      statusCallback?.('connected');

      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        sendWsMsg({ type: 'ping' });
      }, CLIENT_HEARTBEAT_MS);

      syncSubscriptions();

      if (lastSeq > 0) {
        sendWsMsg({ type: 'resume', lastSeq });
      }
      resolve();
    };

    const errorHandler = () => {
      socket.removeEventListener('open', openHandler);
      socket.removeEventListener('error', errorHandler);
      ws = null;
      wsConnecting = null;
      statusCallback?.('disconnected');
      socket.onclose = null;
      reject(new Error('WebSocket connection failed'));
    };

    socket.addEventListener('open', openHandler);
    socket.addEventListener('error', errorHandler);

    socket.addEventListener('message', (msg) => {
      clearProbe();
      try {
        const raw = typeof msg.data === 'string' ? msg.data : '';
        const data = JSON.parse(raw) as {
          event?: string;
          type?: string;
          payload: unknown;
          seq?: number;
          gap?: boolean;
          latestSeq?: number;
        };

        // Resume 协议控制消息
        if (data.type === 'resume-complete') {
          const latest = typeof data.latestSeq === 'number' ? data.latestSeq : null;
          const serverRestarted = latest !== null && latest < lastSeq;
          if (latest !== null) {
            lastSeq = latest;
          }
          if (data.gap || serverRestarted) {
            resumeGapCallback?.();
          }
          return;
        }

        if (!data.event) return;

        if (typeof data.seq === 'number') {
          if (data.seq <= lastSeq) return;
          lastSeq = data.seq;
        }

        listeners.get(data.event)?.forEach((cb) => cb(data.payload));
      } catch {
        // 忽略解析失败的消息
      }
    });

    socket.addEventListener('close', () => {
      ws = null;
      wsConnecting = null;
      stopHeartbeat();
      clearProbe();
      statusCallback?.('disconnected');
      scheduleReconnect();
    });
  });

  return wsConnecting;
}

function wakeUp(): void {
  if (intentionalClose) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    if (probeTimer === null) {
      sendWsMsg({ type: 'ping' });
      probeTimer = setTimeout(() => {
        probeTimer = null;
        reconnectAttempt = 0;
        ws?.close();
      }, PROBE_TIMEOUT_MS);
    }
    return;
  }

  if (wsConnecting) return;

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  connectWs().catch(() => { /* scheduleReconnect called on close */ });
}

// ============================================================================
// 公开 API
// ============================================================================

export function initTransport(options?: TransportOptions): void {
  statusCallback = options?.onStatusChange ?? null;
  resumeGapCallback = options?.onResumeGap ?? null;

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wakeUp();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wakeUp);
    window.addEventListener('focus', wakeUp);
  }
}

export function connect(): Promise<void> {
  intentionalClose = false;
  return connectWs();
}

export function disconnect(): void {
  intentionalClose = true;
  stopHeartbeat();
  clearProbe();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

export function manualReconnect(): Promise<void> {
  reconnectAttempt = 0;
  intentionalClose = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  return connectWs();
}

export function getTransportStatus(): 'connected' | 'disconnected' | 'connecting' {
  if (ws && ws.readyState === WebSocket.OPEN) return 'connected';
  if (wsConnecting) return 'connecting';
  return 'disconnected';
}