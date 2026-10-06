/**
 * cap.time — 时间能力
 *
 * 动作: now/format/sleep/timestamp
 * AI 能获取当前时间、格式化、延时等待
 */

import type { Capability, Value } from '../contracts.ts';

export const timeCap: Capability = {
  id: 'cap.time',
  description: 'Time utilities. Actions: now/format/sleep/timestamp. Helps AI reason about time.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['now', 'format', 'sleep', 'timestamp'] },
      ms: { type: 'number', description: 'Milliseconds to sleep (for sleep)' },
      ts: { type: 'number', description: 'Timestamp ms (for format)' },
      format: { type: 'string', description: 'Format string (for format), e.g. YYYY-MM-DD HH:mm:ss' },
      locale: { type: 'string', description: 'Locale, default zh-CN' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'now' | 'format' | 'sleep' | 'timestamp';
      ms?: number;
      ts?: number;
      format?: string;
      locale?: string;
    };
    switch (p.action) {
      case 'now': {
        const ts = Date.now();
        const d = new Date(ts);
        return {
          ok: true,
          timestamp: ts,
          iso: d.toISOString(),
          local: d.toLocaleString(p.locale ?? 'zh-CN'),
        };
      }
      case 'format': {
        const ts = p.ts ?? Date.now();
        const d = new Date(ts);
        const fmt = p.format ?? 'YYYY-MM-DD HH:mm:ss';
        const replacements: Record<string, string> = {
          'YYYY': String(d.getFullYear()),
          'MM': String(d.getMonth() + 1).padStart(2, '0'),
          'DD': String(d.getDate()).padStart(2, '0'),
          'HH': String(d.getHours()).padStart(2, '0'),
          'mm': String(d.getMinutes()).padStart(2, '0'),
          'ss': String(d.getSeconds()).padStart(2, '0'),
          'SSS': String(d.getMilliseconds()).padStart(3, '0'),
        };
        let result = fmt;
        for (const [k, v] of Object.entries(replacements)) {
          result = result.replace(k, v);
        }
        return { ok: true, formatted: result, timestamp: ts };
      }
      case 'sleep': {
        const ms = Math.min(p.ms ?? 1000, 60000); // 上限 60s
        await new Promise(r => setTimeout(r, ms));
        return { ok: true, slept: ms, woke: Date.now() };
      }
      case 'timestamp': {
        return { ok: true, timestamp: Date.now() };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
