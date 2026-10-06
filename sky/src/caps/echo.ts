/**
 * cap.echo — demo 能力,原样返回输入
 *
 * 用途: 验证 dispatch 闭环 + 权限 gate + 事件推送
 */

import type { Capability, Value } from '../contracts.ts';

export const echoCap: Capability = {
  id: 'cap.echo',
  description: 'Echo back the input. Demo capability for dispatch loop verification.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
      delay: { type: 'number', description: 'Optional delay in ms (test async)' },
    },
    required: ['message'],
  },
  async invoke(params: Value) {
    const p = params as { message?: string; delay?: number };
    if (p.delay && p.delay > 0) await new Promise(r => setTimeout(r, p.delay));
    return { echoed: p.message ?? '(empty)' };
  },
};
