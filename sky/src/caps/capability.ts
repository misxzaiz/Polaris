/**
 * cap.capability — cap 自身管理(元 cap)
 *
 * 动作: list/get/register/unregister/schema
 * AI 可查询所有 cap 的 schema, 也可卸载 cap (动态架构)
 */

import type { Capability, CallContext, Value } from '../contracts.ts';
import type { Router } from '../server/router.ts';

export function createCapabilityCap(router: Router): Capability {
  return {
    id: 'cap.capability',
    description: 'Capability manager. Actions: list/get/unregister/schema. AI can inspect and manage all caps.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'unregister', 'schema', 'stats'] },
        cap: { type: 'string', description: 'Capability id' },
      },
      required: ['action'],
    },
    async invoke(params: Value, _ctx: CallContext) {
      const p = params as {
        action: 'list' | 'get' | 'unregister' | 'schema' | 'stats';
        cap?: string;
      };
      switch (p.action) {
        case 'list':
          return { ok: true, caps: router.list() };
        case 'get': {
          if (!p.cap) throw new Error('cap required for get');
          const all = router.list();
          const found = all.find(c => c.id === p.cap);
          if (!found) return { ok: false, notFound: true };
          return { ok: true, capability: found };
        }
        case 'schema': {
          if (!p.cap) throw new Error('cap required for schema');
          const all = router.list();
          const found = all.find(c => c.id === p.cap);
          if (!found) return { ok: false, notFound: true };
          return { ok: true, id: found.id, inputSchema: found.inputSchema, description: found.description, streaming: found.streaming };
        }
        case 'unregister': {
          if (!p.cap) throw new Error('cap required for unregister');
          router.unregister(p.cap);
          return { ok: true, unregistered: p.cap };
        }
        case 'stats': {
          const all = router.list();
          return {
            ok: true,
            total: all.length,
            streaming: all.filter(c => c.streaming).length,
            ids: all.map(c => c.id),
          };
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
