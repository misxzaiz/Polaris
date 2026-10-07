/**
 * cap.config — 配置读写能力
 *
 * 基于自产 cap.kv(domain="config") 实现,避免重复存储抽象.
 * 顶层对象 patch + passthrough 透传.
 *
 * 密钥脱敏: get 对非 admin 的 remote 来源遮蔽密钥类字段 (apiKey/token/secret/
 * password) 为 '••••••'; set/patch 收到遮蔽值时保留库中真实值 (前端整表保存
 * 不会误清密钥). bootstrap/plugin/本地开发视为可信, 返回真实值.
 */

import type { Capability, CallContext, Value } from '../contracts.ts';
import { db } from '../storage.ts';
import { isDevMode } from '../server/auth.ts';

const SECRET_KEY_RE = /api[_-]?key|token|secret|password|passwd/i;
export const SECRET_MASK = '••••••';

/** 内部直读 (无脱敏, 无权限): 供 AI 引擎等可信内部组件使用 */
export function readConfigRaw(): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM kv WHERE domain=? AND key=?').get('config', 'app') as
    | { value: string } | undefined;
  if (!row) return defaultConfig();
  try {
    const v = JSON.parse(row.value) as unknown;
    // 纵深防御: 存了字符串/数组等非对象 → 回退默认, 不让 AI 引擎崩在 undefined
    if (!v || typeof v !== 'object' || Array.isArray(v)) return defaultConfig();
    return v as Record<string, unknown>;
  } catch { return defaultConfig(); }
}

function isTrustedSource(ctx: CallContext): boolean {
  const s = ctx.source;
  if (s.kind === 'bootstrap' || s.kind === 'plugin') return true;
  return s.admin === true || isDevMode();
}

function maskTree(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskTree);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof val === 'string' && val ? SECRET_MASK : maskTree(val);
    }
    return out;
  }
  return v;
}

/** patch/set 中的密钥字段若为遮蔽值, 换回当前真实值 */
function unmaskTree(patch: unknown, cur: unknown): unknown {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out: Record<string, unknown> = {};
    const curObj = (cur && typeof cur === 'object' ? cur : {}) as Record<string, unknown>;
    for (const [k, val] of Object.entries(patch as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && val === SECRET_MASK) {
        out[k] = curObj[k] ?? '';
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        out[k] = unmaskTree(val, curObj[k]);
      } else {
        out[k] = val;
      }
    }
    return out;
  }
  return patch;
}

export const configCap: Capability = {
  id: 'cap.config',
  description: 'Read/update app config. Actions: get/set/patch. Stored via cap.kv(domain=config). ' +
    'Secret fields (apiKey/token/...) are masked as •••••• for non-admin remote callers; ' +
    'patching a masked value preserves the stored secret.',
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
        const cfg = ('notFound' in data && data.notFound)
          ? defaultConfig()
          : ((data as { ok: boolean; value?: Record<string, unknown> }).value ?? defaultConfig());
        return isTrustedSource(ctx) ? cfg : maskTree(cfg);
      }
      case 'set': {
        if (!p.value) throw new Error('value required for set');
        // 生产防御: 整个 config 必须是对象. 字符串(常见于 JSON.stringify 误传)
        // 会把顶层键变成字符下标, 直接打死 AI 配置 (实测事故).
        if (typeof p.value !== 'object' || Array.isArray(p.value)) {
          throw new Error('config value must be a plain object (got ' + typeof p.value + '); did you JSON.stringify by mistake?');
        }
        const cur = await readRaw();
        // 遮蔽值保护无条件生效: 任何来源发 '••••••' 都意味着"保留现值"
        const safe = unmaskTree(p.value, cur) as Record<string, unknown>;
        await ctx.dispatch('cap.kv', { action: 'set', domain: 'config', key: 'app', value: safe });
        return { ok: true };
      }
      case 'patch': {
        if (!p.value) throw new Error('value required for patch');
        if (typeof p.value !== 'object' || Array.isArray(p.value)) {
          throw new Error('config patch must be a plain object (got ' + typeof p.value + ')');
        }
        const cur = await readRaw();
        const safe = unmaskTree(p.value, cur) as Record<string, unknown>;
        const merged = deepMerge(cur, safe);
        await ctx.dispatch('cap.kv', { action: 'set', domain: 'config', key: 'app', value: merged });
        return { ok: true, config: isTrustedSource(ctx) ? merged : maskTree(merged) };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

async function readRaw(): Promise<Record<string, unknown>> {
  return readConfigRaw();
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
      authRequired: false,
    },
  };
}
