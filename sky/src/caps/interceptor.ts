/**
 * cap.interceptor — 拦截器链管理(元 cap, AI 可管理架构)
 *
 * 动作: list/register/unregister/reorder/enable/disable/stats
 * AI 可经此 cap 注册自定义拦截器(如限流/计费/灰度), 立即热生效.
 */

import type { Capability, CallContext, Value } from '../contracts.ts';
import type { Router } from '../server/router.ts';
import type { Interceptor, BeforeResult, AfterResult, DispatchContext } from '../contracts.ts';

export function createInterceptorCap(router: Router): Capability {
  return {
    id: 'cap.interceptor',
    description: 'Interceptor chain manager. Actions: list/register/unregister/reorder/enable/disable/stats. AI can manage architecture.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'register', 'unregister', 'reorder', 'enable', 'disable', 'stats'] },
        name: { type: 'string', description: 'Interceptor name' },
        priority: { type: 'number', description: 'Priority (lower=earlier, default 100)' },
        before: { type: 'string', description: 'Before logic name (for register, e.g. deny-if, log, rate-limit)' },
        after: { type: 'string', description: 'After logic name (for register)' },
        enabled: { type: 'boolean', description: 'Enable/disable toggle' },
      },
      required: ['action'],
    },
    async invoke(params: Value, _ctx: CallContext) {
      const p = params as {
        action: 'list' | 'register' | 'unregister' | 'reorder' | 'enable' | 'disable' | 'stats';
        name?: string;
        priority?: number;
        before?: string;
        after?: string;
        enabled?: boolean;
      };

      switch (p.action) {
        case 'list':
          return { ok: true, interceptors: router.listInterceptors() };

        case 'register': {
          if (!p.name) throw new Error('name required for register');
          // 内置拦截器工厂(简单 DSL)
          const itc = createBuiltinInterceptor(p.name, p.priority ?? 100, p.before, p.after);
          router.registerInterceptor(itc);
          return { ok: true, name: p.name, priority: p.priority ?? 100 };
        }

        case 'unregister': {
          if (!p.name) throw new Error('name required for unregister');
          router.unregisterInterceptor(p.name);
          return { ok: true, name: p.name };
        }

        case 'reorder': {
          // 简化: 重新设置 priority (需 unregister+register)
          if (!p.name) throw new Error('name required for reorder');
          const list = router.listInterceptors();
          const existing = list.find(i => i.name === p.name);
          if (!existing) return { ok: false, error: 'not found' };
          // 注: 真正 reorder 需要保留 before/after 实现, 这里返回提示
          return { ok: false, error: 'reorder via unregister+register with new priority' };
        }

        case 'enable':
        case 'disable': {
          // 简化: 通过 enabled 标记 (需要 Interceptor 支持 enabled, 当前未实现)
          return { ok: false, error: 'enable/disable not yet supported in preview (unregister to remove)' };
        }

        case 'stats': {
          const list = router.listInterceptors();
          return { ok: true, total: list.length, interceptors: list };
        }

        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}

/**
 * 内置拦截器工厂 — 提供常用拦截器模板
 * 预览版: 只支持几个内置模板, AI 可注册这些
 */
function createBuiltinInterceptor(
  name: string, priority: number,
  beforeKind?: string, afterKind?: string,
): Interceptor {
  const itc: Interceptor = { name, priority };

  if (beforeKind === 'rate-limit') {
    const counts = new Map<string, { count: number; windowStart: number }>();
    const WINDOW = 60000; // 1 min
    const MAX = 10;
    itc.before = async (ctx: DispatchContext): Promise<BeforeResult> => {
      const key = `${ctx.source.kind}:${ctx.capId}`;
      const now = Date.now();
      const entry = counts.get(key);
      if (!entry || now - entry.windowStart > WINDOW) {
        counts.set(key, { count: 1, windowStart: now });
      } else {
        entry.count++;
        if (entry.count > MAX) {
          return { kind: 'deny', error: `rate limit: ${ctx.capId} exceeds ${MAX}/min` };
        }
      }
      return { kind: 'continue' };
    };
  } else if (beforeKind === 'log') {
    itc.before = async (ctx: DispatchContext): Promise<BeforeResult> => {
      console.log(`[interceptor:${name}] before ${ctx.capId} src=${ctx.source.kind}`);
      return { kind: 'continue' };
    };
    if (afterKind) {
      itc.after = async (ctx: DispatchContext): Promise<AfterResult> => {
        console.log(`[interceptor:${name}] after ${ctx.capId} ok=${ctx.result?.ok}`);
        return { kind: 'continue' };
      };
    }
  } else if (beforeKind) {
    // 未知 before kind: 无操作拦截器(占位)
    itc.before = async () => ({ kind: 'continue' });
  }

  return itc;
}
