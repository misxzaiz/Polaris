/**
 * HTTP + WebSocket 传输适配器 — Web 端通过 HTTP API + WS 事件流通信
 *
 * invoke → HTTP POST
 * listen → WebSocket 消息分发（按 event type 路由到 handler）
 */

import type { TransportAdapter } from './types';
import { createLogger } from '@/utils/logger';
import { getTokenMd5, storeTokenMd5 } from './auth';

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

/** Tauri 命令名 → HTTP 路由映射 (module-level constant, avoids repeated allocation) */
const COMMAND_ROUTE_MAP: Record<string, string> = {
  // Chat
  start_chat: '/api/chat/send',
  continue_chat: '/api/chat/send',
  interrupt_chat: '/api/chat/interrupt',
  get_session_history: '/api/chat/history',
  answer_question: '/api/chat/answer-question',
  approve_plan: '/api/chat/approve-plan',
  reject_plan: '/api/chat/reject-plan',
  // Legacy Claude Code session history commands — dedicated endpoints returning flat arrays
  get_claude_code_session_history: '/api/claude-sessions',
  list_claude_code_sessions: '/api/claude-sessions',
  // Sessions (paginated)
  list_sessions: '/api/sessions',
  create_session: '/api/sessions',
  delete_session: '/api/sessions',
  // Settings
  get_config: '/api/settings',
  update_config: '/api/settings',
  update_config_patch: '/api/settings',
  // Auth
  health_check: '/api/health',
};

/**
 * GET-only commands — dispatched to their mapped path with args serialized as a query string.
 *
 * IMPORTANT: do NOT add `get_claude_code_session_history` here. It shares the
 * `/api/claude-sessions` base path with `list_claude_code_sessions`, but fetching a
 * session's *messages* requires the dedicated `/api/claude-sessions/{sessionId}/history`
 * sub-path (handled by an explicit branch in `invoke`). Routing it through this generic
 * GET branch would emit `/api/claude-sessions?sessionId=...`, colliding with the
 * "list sessions" endpoint and returning session metadata instead of messages — which
 * silently breaks session restore in Web mode.
 */
const GET_COMMANDS: ReadonlySet<string> = new Set(['get_config', 'list_sessions', 'health_check', 'list_claude_code_sessions']);

function commandToPath(command: string): string {
  if (command in COMMAND_ROUTE_MAP) {
    return COMMAND_ROUTE_MAP[command];
  }

  log.debug(`Routing command "${command}" through IPC bridge: /api/${command.replace(/_/g, '-')}`);
  const kebab = command.replace(/_/g, '-');
  return `/api/${kebab}`;
}

function bearerTokenFromMd5(tokenMd5: string): string {
  return `Bearer ${tokenMd5}`;
}

/** 判断命令是否使用 GET（只读操作，无 URL 参数） */
function isGetCommand(command: string): boolean {
  return GET_COMMANDS.has(command);
}

/** 判断命令是否使用 DELETE */
function isDeleteCommand(command: string, args?: Record<string, unknown>): boolean {
  return command === 'delete_session' && !!args?.sessionId;
}

function serializeRequestBody(command: string, args?: Record<string, unknown>): string {
  const payload = command === 'update_config'
    && args
    && Object.prototype.hasOwnProperty.call(args, 'config')
    && args.config !== undefined
    ? args.config
    : command === 'update_config_patch'
      && args
      && Object.prototype.hasOwnProperty.call(args, 'patch')
      && args.patch !== undefined
      ? args.patch
    : (args ?? {});

  return JSON.stringify(payload);
}

/** Compute backoff delay with exponential increase and jitter */
function backoffDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  const jitter = base * RECONNECT_JITTER * Math.random();
  return base + jitter;
}

/** Connection status reported by the transport layer */
export type ConnectionStatus = 'connected' | 'disconnected' | 'failed';

export interface HttpTransportOptions {
  /** Called when WebSocket connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
  /**
   * Called when the server reports a replay gap on resume —
   * events were missed beyond the server buffer and a full state
   * resync (e.g. re-fetching session history) is required.
   */
  onResumeGap?: () => void;
}

/** How long to wait for any server frame after a liveness probe before force-closing (ms). */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 创建 HTTP 传输适配器
 *
 * @param baseUrl 服务器地址（如 http://192.168.1.100:9800）
 * @param options 可选配置（连接状态回调等）
 */
export function createHttpTransport(
  baseUrl: string,
  options?: HttpTransportOptions,
): TransportAdapter {
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  let wsConnecting: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Highest event seq received from the server — basis for resume + dedupe. */
  let lastSeq = 0;
  /** Liveness probe timer — armed on wake-up when the socket looks open. */
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
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
      options?.onStatusChange?.('failed');
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

  /** Build the WebSocket URL, including token as query param for auth */
  function buildWsUrl(): string {
    const tokenMd5 = getTokenMd5();
    if (tokenMd5) {
      const sep = wsUrl.includes('?') ? '&' : '?';
      return `${wsUrl}/api/ws${sep}token=${encodeURIComponent(tokenMd5)}`;
    }
    return `${wsUrl}/api/ws`;
  }

  /** Establish WebSocket connection and wire up event handlers */
  function connectWs(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (wsConnecting) return wsConnecting;

    wsConnecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(buildWsUrl());

      const openHandler = () => {
        socket.removeEventListener('open', openHandler);
        socket.removeEventListener('error', errorHandler);
        ws = socket;
        wsConnecting = null;
        reconnectAttempt = 0;
        options?.onStatusChange?.('connected');
        // Start client-side heartbeat
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          sendWsMsg({ type: 'ping' });
        }, CLIENT_HEARTBEAT_MS);
        // Re-sync subscriptions after (re)connect — must happen BEFORE resume
        // so the server applies the subscription filter to replayed events.
        syncSubscriptions();
        // Resume: ask the server to replay events missed while disconnected.
        // lastSeq === 0 means fresh page load — nothing to resume.
        if (lastSeq > 0) {
          log.info(`Requesting event resume from seq ${lastSeq}`);
          sendWsMsg({ type: 'resume', lastSeq });
        }
        resolve();
      };

      const errorHandler = (_ev: Event) => {
        socket.removeEventListener('open', openHandler);
        socket.removeEventListener('error', errorHandler);
        ws = null;
        wsConnecting = null;
        options?.onStatusChange?.('disconnected');
        // Prevent close handler from also scheduling a reconnect
        socket.onclose = null;
        reject(new Error('WebSocket connection failed'));
      };

      socket.addEventListener('open', openHandler);
      socket.addEventListener('error', errorHandler);

      socket.addEventListener('message', (msg) => {
        // Any inbound frame proves the socket is alive — cancel the liveness probe.
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
          // Resume protocol control messages
          if (data.type === 'resume-complete') {
            const latest = typeof data.latestSeq === 'number' ? data.latestSeq : null;
            // Server restart resets seq to 0 — a latestSeq below our lastSeq
            // means a different event epoch: everything in between is lost.
            const serverRestarted = latest !== null && latest < lastSeq;
            if (latest !== null) {
              lastSeq = latest;
            }
            if (data.gap || serverRestarted) {
              log.warn(
                serverRestarted
                  ? 'Server seq rolled back (backend restarted) — full resync required'
                  : 'Resume gap detected — server buffer did not cover the disconnect window, full resync required'
              );
              options?.onResumeGap?.();
            } else {
              log.info('Resume replay complete');
            }
            return;
          }
          // Skip server pong/control messages — they have no 'event' field
          if (!data.event) return;
          // Seq-based dedupe: replayed events may overlap with queued live events.
          if (typeof data.seq === 'number') {
            if (data.seq <= lastSeq) return;
            lastSeq = data.seq;
          }
          listeners.get(data.event)?.forEach((cb) => cb(data.payload));
        } catch {
          const preview = typeof msg.data === 'string' ? msg.data.slice(0, 200) : '(non-string)';
          log.warn(`Failed to parse WS message: ${preview}`);
        }
      });

      socket.addEventListener('close', () => {
        ws = null;
        wsConnecting = null;
        stopHeartbeat();
        clearProbe();
        options?.onStatusChange?.('disconnected');
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

  /** Cancel a pending liveness probe */
  function clearProbe(): void {
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  /**
   * Wake-up handler for visibilitychange / online / focus.
   *
   * Mobile browsers freeze JS timers when the screen is locked or the tab is
   * backgrounded, so the exponential-backoff reconnect timer never fires and
   * the page appears permanently disconnected after unlock. This handler:
   * - reconnects immediately (bypassing the backoff) if the socket is closed;
   * - probes a seemingly-open socket with a ping, force-closing it if the
   *   server doesn't respond in time (half-open connection after sleep).
   */
  function wakeUp(): void {
    if (intentionalClose) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      // Socket claims to be open, but after device sleep it may be half-dead.
      // Probe it: any inbound frame clears the timer; silence force-closes.
      if (probeTimer === null) {
        sendWsMsg({ type: 'ping' });
        probeTimer = setTimeout(() => {
          probeTimer = null;
          log.warn('Liveness probe timed out after wake-up, force-closing stale socket');
          reconnectAttempt = 0;
          ws?.close();
        }, PROBE_TIMEOUT_MS);
      }
      return;
    }

    if (wsConnecting) return;

    // Socket is closed — reconnect right now, bypassing any frozen backoff timer.
    log.info('Page became visible/online with closed socket, reconnecting immediately');
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    connectWs().catch(() => { /* scheduleReconnect called on close */ });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wakeUp();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wakeUp);
    window.addEventListener('focus', wakeUp);
  }

  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const path = commandToPath(command);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const tokenMd5 = getTokenMd5();
      if (tokenMd5) {
        headers.Authorization = bearerTokenFromMd5(tokenMd5);
      }

      let method = 'POST';
      let url = `${baseUrl}${path}`;

      if (isGetCommand(command)) {
        method = 'GET';
        // Append args as URL query parameters for GET requests
        if (args && typeof args === 'object' && Object.keys(args).length > 0) {
          const params = new URLSearchParams();
          for (const [key, val] of Object.entries(args)) {
            if (val != null && val !== '') {
              params.set(key, String(val));
            }
          }
          const qs = params.toString();
          if (qs) url = `${url}?${qs}`;
        }
      } else if (isDeleteCommand(command, args)) {
        method = 'DELETE';
        // delete_session 需要在 URL 中带 id，可选 engine_id
        const sessionId = encodeURIComponent((args as { sessionId: string }).sessionId);
        const engineId = (args as { engineId?: string })?.engineId;
        const queryStr = engineId ? `?engineId=${encodeURIComponent(engineId)}` : '';
        url = `${baseUrl}/api/sessions/${sessionId}${queryStr}`;
      } else if (command === 'get_claude_code_session_history' && args?.sessionId) {
        // Legacy endpoint: returns flat array (not PagedResult)
        method = 'GET';
        url = `${baseUrl}/api/claude-sessions/${encodeURIComponent(args.sessionId as string)}/history`;
      } else if (command === 'get_session_history' && args?.sessionId) {
        method = 'GET';
        const params = new URLSearchParams();
        for (const [key, val] of Object.entries(args)) {
          if (key !== 'sessionId' && val != null && val !== '') {
            params.set(key, String(val));
          }
        }
        const qs = params.toString();
        url = `${baseUrl}/api/chat/history/${encodeURIComponent(args.sessionId as string)}${qs ? `?${qs}` : ''}`;
      } else if (command === 'update_config' || command === 'update_config_patch') {
        method = 'PATCH';
      }

      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      };
      if (method !== 'GET' && method !== 'DELETE') {
        fetchOpts.body = serializeRequestBody(command, args);
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
        const status = res.status;
        if ((status === 401 || status === 403)) {
          // Clear stale token so next attempt won't reuse it
          if (getTokenMd5()) {
            storeTokenMd5('');
          }
          // Throw a structured error that the app layer can identify and handle
          const errBody = await res.json().catch(() => ({ error: res.statusText }));
          const authError = new Error((errBody as { error?: string }).error || `HTTP ${status}`);
          (authError as unknown as { status: number }).status = status;
          (authError as unknown as { isAuthError: boolean }).isAuthError = true;
          throw authError;
        }
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
      clearProbe();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    manualReconnect(): Promise<void> {
      log.info('Manual reconnect triggered');
      // Reset reconnect attempt counter
      reconnectAttempt = 0;
      // Ensure intentionalClose is false to allow reconnection
      intentionalClose = false;
      // Cancel any pending reconnect timer
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Immediately attempt to reconnect
      return connectWs();
    },
  };
}
