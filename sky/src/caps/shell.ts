/**
 * cap.shell — Shell 管理(元 cap)
 *
 * 动作: list/info/notify/reload
 * 预览版: 只有 Web Shell, 元 cap 提供查询 + 通知能力
 */

import type { Capability, CallContext, Value } from '../contracts.ts';

export function createShellCap(): Capability {
  return {
    id: 'cap.shell',
    description: 'Shell manager. Actions: list/info/notify/reload. Lists connected shells.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'notify', 'reload'] },
        message: { type: 'string', description: 'Notification message (for notify)' },
      },
      required: ['action'],
    },
    async invoke(params: Value, ctx: CallContext) {
      const p = params as { action: 'list' | 'info' | 'notify' | 'reload'; message?: string };
      switch (p.action) {
        case 'list':
          return {
            ok: true,
            shells: [
              { type: 'web', url: `http://localhost:${process.env.SKY_PORT ?? 9825}`, connected: true },
            ],
          };
        case 'info':
          return { ok: true, shell: { type: 'web', connected: true } };
        case 'notify': {
          // 推送通知事件, 前端可监听
          ctx.emit({ type: 'shell.notify', data: { message: p.message ?? '' }, ts: Date.now() });
          return { ok: true, notified: true };
        }
        case 'reload': {
          // 通知前端重载
          ctx.emit({ type: 'shell.reload', data: {}, ts: Date.now() });
          return { ok: true, reload: true };
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
