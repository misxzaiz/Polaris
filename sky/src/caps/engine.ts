/**
 * cap.engine — AI 引擎管理(元 cap)
 *
 * 动作: list/models/health/switch
 * 预览版: 通过 cap.config 读写 ai 配置, 元 cap 提供查询
 */

import type { Capability, CallContext, Value } from '../contracts.ts';

export function createEngineCap(): Capability {
  return {
    id: 'cap.engine',
    description: 'AI engine manager. Actions: list/models/health/switch. Manages AI backends.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'models', 'health', 'switch'] },
        baseUrl: { type: 'string', description: 'For switch: new base URL' },
        apiKey: { type: 'string', description: 'For switch: new API key' },
        model: { type: 'string', description: 'For switch: new model' },
      },
      required: ['action'],
    },
    async invoke(params: Value, ctx: CallContext) {
      const p = params as {
        action: 'list' | 'models' | 'health' | 'switch';
        baseUrl?: string; apiKey?: string; model?: string;
      };
      switch (p.action) {
        case 'list': {
          const cfgR = await ctx.dispatch('cap.config', { action: 'get' });
          if (!cfgR.result.ok) throw new Error(cfgR.result.error);
          const ai = (cfgR.result.data as { ai: Record<string, unknown> }).ai;
          return {
            ok: true,
            current: { baseUrl: ai.baseUrl, model: ai.model, provider: 'openai-compatible' },
            supported: ['openai-compatible', 'anthropic', 'ollama'],
          };
        }
        case 'models': {
          // 列出当前 provider 支持的模型 (静态提示)
          return {
            ok: true,
            models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat', 'llama3'],
            note: 'use cap.config patch ai.model to switch',
          };
        }
        case 'health': {
          const cfgR = await ctx.dispatch('cap.config', { action: 'get' });
          if (!cfgR.result.ok) throw new Error(cfgR.result.error);
          const ai = (cfgR.result.data as { ai: { baseUrl?: string; apiKey?: string } }).ai;
          const configured = !!(ai.baseUrl && ai.apiKey);
          return { ok: true, configured, baseUrl: ai.baseUrl };
        }
        case 'switch': {
          // 经 cap.config patch 切换引擎配置
          const patch: Record<string, unknown> = {};
          if (p.baseUrl !== undefined) patch.baseUrl = p.baseUrl;
          if (p.apiKey !== undefined) patch.apiKey = p.apiKey;
          if (p.model !== undefined) patch.model = p.model;
          const r = await ctx.dispatch('cap.config', { action: 'patch', value: { ai: patch } });
          return r.result;
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
