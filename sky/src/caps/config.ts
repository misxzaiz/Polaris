/**
 * cap.config — 配置读写能力
 *
 * 基于自产 cap.kv(domain="config") 实现,避免重复存储抽象.
 * 顶层对象 patch + passthrough 透传.
 */

import type { Capability, CallContext, Value } from '../contracts.ts';

export const configCap: Capability = {
  id: 'cap.config',
  description: 'Read/update app config. Actions: get/set/patch. Stored via cap.kv(domain=config).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'patch'] },
      value: { description: 'Full config object (set) or partial patch (patch)' },
    },
    required: ['action'],
  },
  async invoke(params: Value, ctx: CallContext) {
    const p = params as { action: 'get' | 'set' | 'patch'; value?: Record<string, unknown> };
    switch (p.action) {
      case 'get': {
        const r = await ctx.dispatch('cap.kv', { action: 'get', domain: 'config', key: 'app' });
        if (!r.result.ok) throw new Error(r.result.ok ? '' : r.result.error);
        const data = r.result.data as { ok: boolean; value?: Record<string, unknown> } | { ok: boolean; notFound?: boolean };
        if ('notFound' in data && data.notFound) return defaultConfig();
        return (data as { ok: boolean; value?: Record<string, unknown> }).value ?? defaultConfig();
      }
      case 'set': {
        if (!p.value) throw new Error('value required for set');
        await ctx.dispatch('cap.kv', { action: 'set', domain: 'config', key: 'app', value: p.value });
        return { ok: true };
      }
      case 'patch': {
        if (!p.value) throw new Error('value required for patch');
        const cur = (await invoke(ctx, 'get')) as Record<string, unknown>;
        const merged = deepMerge(cur, p.value);
        await ctx.dispatch('cap.kv', { action: 'set', domain: 'config', key: 'app', value: merged });
        return { ok: true, config: merged };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

async function invoke(ctx: CallContext, action: string): Promise<Value> {
  const r = await ctx.dispatch('cap.config', { action });
  if (!r.result.ok) throw new Error(r.result.error);
  return r.result.data;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function defaultConfig(): Record<string, unknown> {
  return {
    ai: {
      provider: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4o-mini',
      maxTokens: 4096,
    },
    server: {
      port: 9825,
      token: '',
    },
  };
}
