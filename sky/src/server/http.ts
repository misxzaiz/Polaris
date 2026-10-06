/**
 * HTTP + WebSocket server
 *
 * HTTP:
 * - POST /api/dispatch          { cap, params, stream?: bool } → Reply
 * - GET  /api/caps              列出所有能力(供前端/AI 发现工具)
 * - GET  /api/health            健康检查
 * - POST /api/config            便捷: 写配置(=dispatch cap.config set)
 * - GET  /api/config            便捷: 读配置
 *
 * WebSocket /ws:
 * - 客户端发: { type: 'dispatch', cap, params, stream? }
 * - 服务端推: { type: 'reply', ...reply }
 * - 服务端推: { type: 'event', event }   — 实时事件(stream.chunk/stream.end/bash.chunk 等)
 * - 客户端发: { type: 'subscribe' }      — 订阅事件(连接即订阅)
 *
 * 鉴权: token(可选). 配置 server.token 后, query ?token= 或 Authorization Bearer.
 */

import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Router } from './router.ts';
import type { EventBus } from './eventbus.ts';
import type { Source } from '../contracts.ts';
import { SHELL_HTML } from '../web/shell.ts';
import { shellRegistry } from '../caps/ui/shell-registry.ts';
import { setUiEmitter, getUiState } from '../caps/ui/state.ts';

export interface ServerOptions {
  port: number;
  token?: string;
}

export function startServer(
  router: Router,
  bus: EventBus,
  opts: ServerOptions,
): void {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url ?? '/';
    const source = resolveSource(req, opts.token);

    try {
      // GET /api/health
      if (url === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, uptime: process.uptime(), caps: router.list().length });
      }
      // GET /api/caps
      if (url === '/api/caps' && req.method === 'GET') {
        return json(res, 200, { caps: router.list() });
      }
      // GET /api/ui-state — UI State 初始同步
      if (url === '/api/ui-state' && req.method === 'GET') {
        return json(res, 200, getUiState());
      }
      // GET /api/config
      if (url === '/api/config' && req.method === 'GET') {
        const reply = await router.dispatch('cap.config', { action: 'get' }, source);
        return json(res, 200, reply);
      }
      // POST /api/config
      if (url === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const reply = await router.dispatch('cap.config', { action: 'patch', value: body }, source);
        return json(res, 200, reply);
      }
      // POST /api/dispatch
      if (url === '/api/dispatch' && req.method === 'POST') {
        const body = await readBody(req) as { cap?: string; params?: unknown; stream?: boolean };
        if (!body.cap) return json(res, 400, { error: 'cap required' });
        if (body.stream) {
          const reply = await router.dispatchStream(body.cap, body.params ?? {}, source);
          return json(res, 200, reply);
        }
        const reply = await router.dispatch(body.cap, body.params ?? {}, source);
        return json(res, 200, reply);
      }
      // 静态 Web Shell(根路径返回 HTML)
      if ((url === '/' || url === '/index.html') && req.method === 'GET') {
        return serveShell(res);
      }

      return json(res, 404, { error: 'not found', url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }
  });

  // WebSocket
  const wss = new WebSocketServer({ server, path: '/ws' });
  // UI State 变化 → 推给所有连着的 Shell
  setUiEmitter((state) => {
    for (const info of shellRegistry.list()) {
      // 推送经 bus 统一走, 这里直接对每个 shell 的 ws 发 ui.update
    }
    bus.emit({ type: 'ui.update', data: state, ts: Date.now() });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const source = resolveSource(req, opts.token);
    if (source.kind === 'remote' && !(source as { token: string }).token) {
      ws.close(4001, 'token required');
      return;
    }
    const subId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let shellId: string | null = null;
    const unsub = bus.subscribe(subId, (event) => {
      send(ws, { type: 'event', event });
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'dispatch') {
          const reply = msg.stream
            ? await router.dispatchStream(msg.cap, msg.params ?? {}, source)
            : await router.dispatch(msg.cap, msg.params ?? {}, source);
          send(ws, { type: 'reply', reqId: msg.reqId, reply });
        } else if (msg.type === 'shell-register') {
          // Shell 声明自己提供的前端 cap
          shellId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          shellRegistry.register(shellId, ws, msg.caps ?? []);
          // 立即推当前 UI State (新连上的 Shell 同步状态)
          send(ws, { type: 'event', event: { type: 'ui.update', data: getUiState(), ts: Date.now() } });
        } else if (msg.type === 'shell-invoke-result') {
          // Shell 回填执行结果
          if (shellId) shellRegistry.resolveShellInvoke(shellId, msg.reqId, msg.result);
        } else if (msg.type === 'ping') {
          send(ws, { type: 'pong' });
        }
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        send(ws, { type: 'error', error: e });
      }
    });

    ws.on('close', () => {
      unsub();
      if (shellId) shellRegistry.unregister(shellId);
    });
  });

  server.listen(opts.port, () => {
    console.log(`\n  ┌─────────────────────────────────────────────┐`);
    console.log(`  │  Sky preview running                        │`);
    console.log(`  │  Web Shell:  http://localhost:${opts.port}            │`);
    console.log(`  │  WS:         ws://localhost:${opts.port}/ws            │`);
    console.log(`  │  Caps:       ${router.list().length}                              │`);
    console.log(`  │  Token:      ${opts.token ? 'enabled' : 'disabled (local)'}                       │`);
    console.log(`  └─────────────────────────────────────────────┘\n`);
  });
}

// ============================================================================
// Helpers
// ============================================================================

function resolveSource(req: IncomingMessage, token?: string): Source {
  const url = req.url ?? '';
  const q = new URL(url, 'http://localhost').searchParams;
  const tokenParam = q.get('token');
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const presented = tokenParam ?? bearerToken;

  if (token) {
    if (presented === token) return { kind: 'remote', token: presented };
    // 无 token 或 token 错 → 视为无 token remote(权限 gate 会 deny)
    return { kind: 'remote', token: presented ?? '' };
  }
  // 未配置 token(本地开发)→ 全放行
  return { kind: 'remote', token: 'local-dev' };
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function serveShell(res: any): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(SHELL_HTML);
}
