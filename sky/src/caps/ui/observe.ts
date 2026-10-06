/**
 * cap.ui.observe — 视觉反馈(AI 看见效果, 闭环演进)
 *
 * 动作: screenshot/inspect/metrics
 * 这类 cap 需要前端执行, 通过 WS 反向调用:
 *   AI dispatch cap.ui.observe screenshot → 后端经 WS 请求前端 → 前端执行 → 回填
 *
 * Shell 注册前端 cap 机制: Shell 连 WS 时声明自己提供哪些前端 cap,
 * 后端把这些 cap 的 dispatch 转发给 Shell 执行.
 */

import type { Capability, Value } from '../../contracts.ts';
import type { ShellRegistry } from './shell-registry.ts';

export function createUiObserveCap(shellReg: ShellRegistry): Capability {
  return {
    id: 'cap.ui.observe',
    description: 'Visual feedback. Actions: screenshot/inspect/metrics. Executed on Shell (frontend).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'inspect', 'metrics'] },
        selector: { type: 'string', description: 'Element selector (for inspect)' },
        fullPage: { type: 'boolean', description: 'Full page screenshot (for screenshot)' },
      },
      required: ['action'],
    },
    async invoke(params: Value) {
      const p = params as {
        action: 'screenshot' | 'inspect' | 'metrics';
        selector?: string; fullPage?: boolean;
      };
      // 经 Shell 执行
      const result = await shellReg.invokeOnShell('cap.ui.observe', {
        action: p.action, selector: p.selector, fullPage: p.fullPage,
      });
      return result;
    },
  };
}
