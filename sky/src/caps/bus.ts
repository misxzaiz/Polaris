/**
 * cap.bus — 事件总线管理(元 cap)
 *
 * 动作: info/recent/subscribers/clear
 * 预览版: 内存 EventBus, 元 cap 提供查询
 */

import type { Capability, Value } from '../contracts.ts';
import type { EventBus } from '../server/eventbus.ts';

export function createBusCap(bus: EventBus): Capability {
  return {
    id: 'cap.bus',
    description: 'Event bus manager. Actions: info/recent/subscribers/clear. Manages event stream.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'recent', 'subscribers', 'clear'] },
        since: { type: 'number', description: 'For recent: seq offset' },
        limit: { type: 'number', description: 'For recent: max events, default 50' },
      },
      required: ['action'],
    },
    async invoke(params: Value) {
      const p = params as { action: 'info' | 'recent' | 'subscribers' | 'clear'; since?: number; limit?: number };
      switch (p.action) {
        case 'info':
          return {
            ok: true,
            type: 'memory',
            historySize: bus.length,
            maxHistory: 1000,
          };
        case 'recent': {
          const since = p.since ?? 0;
          const limit = p.limit ?? 50;
          const events = bus.since(since).slice(0, limit);
          return { ok: true, events, count: events.length };
        }
        case 'subscribers':
          return { ok: true, count: bus.subscriberCount };
        case 'clear':
          bus.clear();
          return { ok: true, cleared: true };
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
