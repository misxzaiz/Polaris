/**
 * HTTP + WebSocket server
 *
 * HTTP:
 * - POST /api/dispatch          { cap, params, stream?: bool } → Reply
 * - GET  /api/caps              列出所有能力(供前端/AI 发现工具)
 * - GET  /api/health            健康检查
 * - POST /api/config            便捷: 写配置(=dispatch cap.config set)
 * - GET  /api/config            便捷: 读配置
 * - GET  /                      — 无头占位提示页(前端待重新设计)
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
import { setUiEmitter, getUiState } from '../caps/ui/state.ts';
import { abortAiStream } from '../caps/ai.ts';
import { validatePresentedToken, getAuthRequired, getMasterToken } from './auth.ts';

export interface ServerOptions {
  port: number;
  token?: string;
  authRequired?: boolean;
}

/** 无需认证即可访问的路径 (认证开启时) */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/verify']);

type RemoteSource = Extract<Source, { kind: 'remote' }>;

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
    const pathname = url.split('?')[0];
    const source = resolveSource(req);

    try {
      // 强制认证: 未认证 → 401 (根路径占位页除外, 它承载前端接入说明)
      if (getAuthRequired() && !source.authed && !PUBLIC_PATHS.has(pathname) && pathname !== '/') {
        return json(res, 401, { error: 'unauthorized: valid token required (Authorization: Bearer sk-...)' });
      }

      // GET /api/health
      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, uptime: process.uptime(), caps: router.list().length, authRequired: getAuthRequired(), authed: source.authed === true });
      }
      // GET /api/auth/verify — 前端接入时校验持有的 token
      if (pathname === '/api/auth/verify') {
        const identity = source.authed
          ? { ok: true, authRequired: getAuthRequired(), authed: true, authId: source.authId, authName: source.authName, admin: source.admin === true }
          : { ok: true, authRequired: getAuthRequired(), authed: false };
        return json(res, 200, identity);
      }
      // GET /api/caps
      if (pathname === '/api/caps' && req.method === 'GET') {
        return json(res, 200, { caps: router.list() });
      }
      // GET /api/ui-state — UI State 初始同步
      if (pathname === '/api/ui-state' && req.method === 'GET') {
        return json(res, 200, getUiState());
      }
      // GET /api/config
      if (pathname === '/api/config' && req.method === 'GET') {
        const reply = await router.dispatch('cap.config', { action: 'get' }, source);
        return json(res, 200, reply);
      }
      // POST /api/config
      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const reply = await router.dispatch('cap.config', { action: 'patch', value: body }, source);
        return json(res, 200, reply);
      }
      // POST /api/dispatch
      if (pathname === '/api/dispatch' && req.method === 'POST') {
        const body = await readBody(req) as { cap?: string; params?: unknown; stream?: boolean };
        if (!body.cap) return json(res, 400, { error: 'cap required' });
        if (body.stream) {
          const reply = await router.dispatchStream(body.cap, body.params ?? {}, source);
          return json(res, 200, reply);
        }
        const reply = await router.dispatch(body.cap, body.params ?? {}, source);
        return json(res, 200, reply);
      }
      // 无头占位提示页(前端待重新设计)
      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        return servePlaceholder(res, { authRequired: getAuthRequired(), authed: source.authed === true, caps: router.list().length });
      }

      return json(res, 404, { error: 'not found', url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }
  });

  // WebSocket — upgrade 阶段即拒绝未认证连接 (101 之前, 客户端不会收到 open)
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const source = resolveSource(req);
    if (getAuthRequired() && !source.authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  // UI State 变化 → 推送 (前端经 WS 事件订阅)
  setUiEmitter((state) => {
    bus.emit({ type: 'ui.update', data: state, ts: Date.now() });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const source = resolveSource(req);
    if (getAuthRequired() && !source.authed) {
      ws.close(4001, 'unauthorized: valid token required');
      return;
    }
    const subId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
        } else if (msg.type === 'stream.abort') {
          // 停止生成: 中断对应流的 AI fetch; 结果经 stream.end(aborted) 事件回传
          abortAiStream(String(msg.streamId || ''));
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
    });
  });

  server.listen(opts.port, () => {
    console.log(`\n  ┌─────────────────────────────────────────────┐`);
    console.log(`  │  Sky preview running                        │`);
    console.log(`  │  WS:         ws://localhost:${opts.port}/ws            │`);
    console.log(`  │  Caps:       ${router.list().length}                              │`);
    console.log(`  │  Auth:       ${getAuthRequired() ? 'REQUIRED' : (getMasterToken() ? 'optional (master token set)' : 'disabled (local dev)')}`.padEnd(49) + '│');
    console.log(`  └─────────────────────────────────────────────┘\n`);
  });
}

// ============================================================================
// Helpers
// ============================================================================

function resolveSource(req: IncomingMessage): RemoteSource {
  const url = req.url ?? '';
  const q = new URL(url, 'http://localhost').searchParams;
  const tokenParam = q.get('token');
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const presented = tokenParam ?? bearerToken;

  // 身份校验: master token → admin; 已签发 token → 按角色; 其余 → 未认证
  const identity = validatePresentedToken(presented);
  return { kind: 'remote', token: presented ?? '', ...identity };
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

function servePlaceholder(res: any, info: { authRequired: boolean; authed: boolean; caps: number }): void {
  const authLabel = info.authRequired
    ? (info.authed ? 'required · authenticated' : 'required · unauthenticated')
    : 'disabled (local dev)';
  const html = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sky — frontend pending</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0d1117; color: #c9d1d9; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .card { max-width: 560px; padding: 32px 40px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
  h1 { font-size: 16px; margin: 0 0 8px; color: #58a6ff; }
  p { margin: 8px 0; }
  code { background: #21262d; padding: 1px 6px; border-radius: 4px; font-size: 12px; color: #79c0ff; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid #30363d; }
  dt { color: #8b949e; }
  dd { margin: 0; }
</style>
</head><body>
  <div class="card">
    <h1>Sky — Capability OS</h1>
    <p>前端已被移除，待重新设计。后端 Core 仍在运行，所有 <code>/api/*</code> 与 <code>ws://</code> 接口照常可用。</p>
    <dl>
      <dt>Core</dt><dd>running</dd>
      <dt>Caps</dt><dd>${info.caps}</dd>
      <dt>Auth</dt><dd>${authLabel}</dd>
      <dt>Health</dt><dd><code>GET /api/health</code></dd>
      <dt>Caps list</dt><dd><code>GET /api/caps</code></dd>
    </dl>
  </div>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
