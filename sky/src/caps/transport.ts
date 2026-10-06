/**
 * cap.transport — 传输层管理(元 cap)
 *
 * 动作: list/status/config
 * 预览版: 只有 HTTP/WS 传输, 元 cap 提供查询接口
 */

import type { Capability, Value } from '../contracts.ts';

export function createTransportCap(): Capability {
  return {
    id: 'cap.transport',
    description: 'Transport manager. Actions: list/status. Lists available transports (HTTP/WS).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status'] },
      },
      required: ['action'],
    },
    async invoke(params: Value) {
      const p = params as { action: 'list' | 'status' };
      switch (p.action) {
        case 'list':
          return {
            ok: true,
            transports: [
              { name: 'http', type: 'HTTP/WS', running: true },
            ],
          };
        case 'status':
          return {
            ok: true,
            http: { running: true, port: process.env.SKY_PORT ?? 9825 },
          };
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
