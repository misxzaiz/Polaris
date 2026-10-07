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
      // 强制认证: 未认证 → 401 (静态 Shell 页除外, 它承载登录界面)
      if (getAuthRequired() && !source.authed && !PUBLIC_PATHS.has(pathname) && pathname !== '/') {
        return json(res, 401, { error: 'unauthorized: valid token required (Authorization: Bearer sk-...)' });
      }

      // GET /api/health
      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, uptime: process.uptime(), caps: router.list().length, authRequired: getAuthRequired(), authed: source.authed === true });
      }
      // GET /api/auth/verify — Shell 启动时校验本地存储的 token
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
      // 静态 Web Shell(根路径返回 HTML)
      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        return serveShell(res);
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
  // UI State 变化 → 推给所有连着的 Shell
  setUiEmitter((state) => {
    for (const info of shellRegistry.list()) {
      // 推送经 bus 统一走, 这里直接对每个 shell 的 ws 发 ui.update
    }
    bus.emit({ type: 'ui.update', data: state, ts: Date.now() });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const source = resolveSource(req);
    if (getAuthRequired() && !source.authed) {
      ws.close(4001, 'unauthorized: valid token required');
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

function serveShell(res: any): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(SHELL_HTML);
}
