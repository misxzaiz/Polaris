/**
 * HTTP + WebSocket 传输适配器 — Web 端通过 HTTP API + WS 事件流通信
 *
 * invoke → HTTP POST（带 Bearer token）
 * listen → WebSocket 消息分发（按 event type 路由到 handler）
 */

import type { TransportAdapter } from './types';
import { createLogger } from '../../utils/logger';

const log = createLogger('HttpTransport');

/** Reconnection config */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER = 0.3;
const MAX_RECONNECT_ATTEMPTS = 50;
/** Client sends application-level ping every this interval (ms). */
const CLIENT_HEARTBEAT_MS = 25_000;

/** HTTP request timeout in milliseconds. */
const HTTP_TIMEOUT_MS = 30_000;

/** Tauri 命令名 → HTTP 路由映射 */
function commandToPath(command: string): string {
  // Tauri command 使用 snake_case，HTTP 路由使用 kebab-case
  // 例: get_config → /api/settings, start_chat → /api/chat/send
  const mapping: Record<string, string> = {
    // Chat
    start_chat: '/api/chat/send',
    continue_chat: '/api/chat/send',
    interrupt_chat: '/api/chat/interrupt',
    get_session_history: '/api/chat/history',
    answer_question: '/api/chat/answer-question',
    approve_plan: '/api/chat/approve-plan',
    reject_plan: '/api/chat/reject-plan',
    // Sessions
    list_sessions: '/api/sessions',
    create_session: '/api/sessions',
    delete_session: '/api/sessions',
    // Settings
    get_config: '/api/settings',
    update_config: '/api/settings',
    // Auth
    health_check: '/api/auth/verify',
  };

  if (command in mapping) {
    return mapping[command];
  }

  // 兜底：snake_case → kebab-case，挂在 /api/ 下
  const kebab = command.replace(/_/g, '-');
  return `/api/${kebab}`;
}

/** 判断命令是否使用 GET（只读操作，无 URL 参数） */
function isGetCommand(command: string): boolean {
  return ['get_config', 'list_sessions', 'health_check'].includes(command);
}

/** 判断命令是否使用 DELETE */
function isDeleteCommand(command: string, args?: Record<string, unknown>): boolean {
  return command === 'delete_session' && !!args?.sessionId;
}

/** Compute backoff delay with exponential increase and jitter */
function backoffDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  const jitter = base * RECONNECT_JITTER * Math.random();
  return base + jitter;
}

/**
 * 创建 HTTP 传输适配器
 *
 * @param baseUrl 服务器地址（如 http://192.168.1.100:9800）
 * @param getToken 获取 auth token 的函数（支持动态刷新）
 */
export function createHttpTransport(
  baseUrl: string,
  getToken: () => string
): TransportAdapter {
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  let wsConnecting: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  /** Send a JSON message to the WebSocket if connected */
  function sendWsMsg(obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  /** Track which event types have been subscribed on the server */
  function syncSubscriptions(): void {
    const events = Array.from(listeners.keys()).filter(
      (key) => (listeners.get(key)?.size ?? 0) > 0
    );
    if (events.length > 0) {
      sendWsMsg({ type: 'subscribe', events });
    }
  }

  /** Schedule an automatic reconnect with exponential backoff */
  function scheduleReconnect(): void {
    if (intentionalClose) return;
    // Cancel any pending reconnect timer to avoid stacking
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      return;
    }
    const delay = backoffDelay(reconnectAttempt);
    reconnectAttempt++;
    log.warn(`WebSocket disconnected, reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!intentionalClose) {
        connectWs().catch(() => { /* scheduleReconnect called on close */ });
      }
    }, delay);
  }

  /** Establish WebSocket connection and wire up event handlers */
  function connectWs(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (wsConnecting) return wsConnecting;

    wsConnecting = new Promise<void>((resolve, reject) => {
      const token = getToken();
      const socket = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);

      const openHandler = () => {
        socket.removeEventListener('open', openHandler);
        socket.removeEventListener('error', errorHandler);
        ws = socket;
        wsConnecting = null;
        reconnectAttempt = 0;
        // Start client-side heartbeat
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          sendWsMsg({ type: 'ping' });
        }, CLIENT_HEARTBEAT_MS);
        // Re-sync subscriptions after (re)connect
        syncSubscriptions();
        resolve();
      };

      const errorHandler = (_ev: Event) => {
        socket.removeEventListener('open', openHandler);
        socket.removeEventListener('error', errorHandler);
        ws = null;
        wsConnecting = null;
        reject(new Error('WebSocket connection failed'));
      };

      socket.addEventListener('open', openHandler);
      socket.addEventListener('error', errorHandler);

      socket.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data as string) as { event: string; payload: unknown };
          listeners.get(data.event)?.forEach((cb) => cb(data.payload));
        } catch {
          log.warn('Failed to parse WS message');
        }
      });

      socket.addEventListener('close', () => {
        ws = null;
        wsConnecting = null;
        stopHeartbeat();
        scheduleReconnect();
      });
    });

    return wsConnecting;
  }

  /** Stop the client-side heartbeat timer */
  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const path = commandToPath(command);
      const token = getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      let method = 'POST';
      let url = `${baseUrl}${path}`;

      if (isGetCommand(command)) {
        method = 'GET';
      } else if (isDeleteCommand(command, args)) {
        method = 'DELETE';
        // delete_session 需要在 URL 中带 id
        url = `${baseUrl}/api/sessions/${encodeURIComponent((args as { sessionId: string }).sessionId)}`;
      } else if (command === 'get_session_history' && args?.sessionId) {
        method = 'GET';
        url = `${baseUrl}/api/chat/history/${encodeURIComponent(args.sessionId as string)}`;
      } else if (command === 'update_config') {
        method = 'PATCH';
      }

      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      };
      if (method !== 'GET' && method !== 'DELETE') {
        fetchOpts.body = JSON.stringify(args ?? {});
      }

      let res: Response;
      try {
        res = await fetch(url, fetchOpts);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'TimeoutError') {
          throw new Error(`Request timed out after ${HTTP_TIMEOUT_MS / 1000}s: ${method} ${path}`);
        }
        throw e;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error || `API error: ${res.status}`);
      }

      // 204 No Content
      if (res.status === 204) return undefined as T;

      return res.json() as Promise<T>;
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      await connectWs();

      const eventListeners = listeners.get(event);
      const wasEmpty = !eventListeners || eventListeners.size === 0;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler as (p: unknown) => void);

      // Subscribe on server when first handler for this event type is registered
      if (wasEmpty) {
        sendWsMsg({ type: 'subscribe', events: [event] });
      }

      return () => {
        const set = listeners.get(event);
        if (set) {
          set.delete(handler as (p: unknown) => void);
          // Optionally unsubscribe when no more handlers for this event type
          if (set.size === 0) {
            sendWsMsg({ type: 'unsubscribe', events: [event] });
          }
        }
      };
    },

    disconnect() {
      intentionalClose = true;
      stopHeartbeat();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}
