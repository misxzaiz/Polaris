/** Sky 前端 API — 对 /api/dispatch 与 WS 的薄封装 */

import type { WsMessage, SkyEvent } from './types.ts';

const API = '/api/dispatch';

export interface DispatchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function dispatchApi(
  cap: string,
  params: unknown,
  token: string,
): Promise<DispatchResult> {
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ cap, params }),
    });
    if (resp.status === 401) return { ok: false, error: 'unauthorized: token required or invalid' };
    const json = await resp.json() as { result?: { ok: boolean; data?: unknown; error?: string } };
    const r = json.result;
    if (!r) return { ok: false, error: 'malformed reply' };
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** WS 连接 — 指数退避重连 */
export class SkyWs {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  onEvent: ((e: SkyEvent) => void) | null = null;
  onReply: ((reqId: string, reply: DispatchResult) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  private pendingReplies = new Map<string, (reply: DispatchResult) => void>();

  /** 注册一次性 reply 回调(按 reqId) */
  expectReply(reqId: string, cb: (reply: DispatchResult) => void): void {
    this.pendingReplies.set(reqId, cb);
  }

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  connect(): void {
    this.closed = false;
    const full = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url;
    try {
      this.ws = new WebSocket(full);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retry = 0;
      this.onOpen?.();
    };
    this.ws.onmessage = (ev) => this.handle(ev);
    this.ws.onclose = () => {
      this.onClose?.();
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => { /* onclose will follow */ };
  }

  private handle(ev: MessageEvent): void {
    let msg: WsMessage;
    try { msg = JSON.parse(ev.data as string) as WsMessage; } catch { return; }
    if (msg.type === 'event' && msg.event) this.onEvent?.(msg.event);
    else if (msg.type === 'reply' && msg.reqId) {
      const r = msg.reply as { result?: { ok: boolean; data?: unknown; error?: string }; ok?: boolean; data?: unknown; error?: string } | undefined;
      // 后端 WS reply 结构: { reply: { result: { ok, data, error } } }
      // 也兼容直接 { ok, data } 的简写
      const inner = r?.result ?? r;
      const result: DispatchResult = { ok: inner?.ok ?? false, data: inner?.data, error: inner?.error };
      const pending = this.pendingReplies.get(msg.reqId);
      if (pending) { this.pendingReplies.delete(msg.reqId); pending(result); }
      this.onReply?.(msg.reqId, result);
    }
  }

  sendDispatch(reqId: string, cap: string, params: unknown, stream = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'dispatch', reqId, cap, params, stream }));
  }

  sendStreamAbort(streamId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'stream.abort', streamId }));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry++;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
