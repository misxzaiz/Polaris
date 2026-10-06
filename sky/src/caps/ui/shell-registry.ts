/**
 * ShellRegistry — 管理连入的 Shell, 支持前端 cap 反向调用
 *
 * Shell 连 WS 时声明提供的前端 cap (如 cap.ui.observe).
 * 后端 dispatch 这些 cap 时, 经 WS 转发给 Shell 执行, 等待回填.
 *
 * 请求-响应模式: 后端生成 reqId → 发给 Shell → Shell 执行 → 回复 reqId 结果
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

interface ShellSession {
  id: string;
  ws: WebSocket;
  caps: string[];       // 该 Shell 提供的前端 cap
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

class ShellRegistryImpl {
  private shells = new Map<string, ShellSession>();

  register(id: string, ws: WebSocket, caps: string[]): void {
    this.shells.set(id, { id, ws, caps, pending: new Map() });
    console.log(`[shell-registry] +shell ${id} caps: ${caps.join(', ') || '(none)'}`);
  }

  unregister(id: string): void {
    const s = this.shells.get(id);
    if (s) {
      for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error('shell disconnected')); }
      this.shells.delete(id);
      console.log(`[shell-registry] -shell ${id}`);
    }
  }

  /** 找到提供某 cap 的 Shell */
  findShellForCap(capId: string): ShellSession | null {
    for (const s of this.shells.values()) {
      if (s.caps.includes(capId)) return s;
    }
    return null;
  }

  /** 经 Shell 执行 (反向调用) */
  async invokeOnShell(capId: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    const s = this.findShellForCap(capId);
    if (!s) {
      return { ok: false, error: `no shell provides cap: ${capId}` };
    }
    if (s.ws.readyState !== s.ws.OPEN) {
      return { ok: false, error: 'shell disconnected' };
    }
    const reqId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        s.pending.delete(reqId);
        resolve({ ok: false, error: `shell invoke timeout (${timeoutMs}ms)` });
      }, timeoutMs);
      s.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); },
        timer,
      });
      s.ws.send(JSON.stringify({
        type: 'shell-invoke', reqId, cap: capId, params,
      }));
    });
  }

  /** Shell 回填结果 */
  resolveShellInvoke(shellId: string, reqId: string, result: unknown): void {
    const s = this.shells.get(shellId);
    if (!s) return;
    const p = s.pending.get(reqId);
    if (!p) return;
    s.pending.delete(reqId);
    p.resolve(result);
  }

  list(): Array<{ id: string; caps: string[] }> {
    return [...this.shells.values()].map(s => ({ id: s.id, caps: s.caps }));
  }
}

export const shellRegistry = new ShellRegistryImpl();
export type ShellRegistry = ShellRegistryImpl;
