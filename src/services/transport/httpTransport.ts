/**
 * HTTP + WebSocket 传输适配器 — Web 端通过 HTTP API + WS 事件流通信
 *
 * invoke → HTTP POST（带 Bearer token）
 * listen → WebSocket 消息分发（按 event type 路由到 handler）
 */

import type { TransportAdapter } from './types';
import { createLogger } from '../../utils/logger';

const log = createLogger('HttpTransport');

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

  /** 懒初始化 WebSocket 连接 */
  function ensureWs(): Promise<void> {
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
      });
    });

    return wsConnecting;
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
        url = `${baseUrl}/api/sessions/${encodeURIComponent(args!.sessionId as string)}`;
      } else if (command === 'get_session_history' && args?.sessionId) {
        method = 'GET';
        url = `${baseUrl}/api/chat/history/${encodeURIComponent(args.sessionId as string)}`;
      } else if (command === 'update_config') {
        method = 'PATCH';
      }

      const fetchOpts: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'DELETE') {
        fetchOpts.body = JSON.stringify(args ?? {});
      }

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error((err as { message?: string }).message || `API error: ${res.status}`);
      }

      // 204 No Content
      if (res.status === 204) return undefined as T;

      return res.json() as Promise<T>;
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      await ensureWs();

      const wasEmpty = !listeners.has(event) || listeners.get(event)!.size === 0;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler as (p: unknown) => void);

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
  };
}
