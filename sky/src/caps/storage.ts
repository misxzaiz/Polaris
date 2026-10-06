/**
 * cap.storage — 存储适配器管理(元 cap)
 *
 * 动作: list/backups/info/vacuum
 * 预览版: 只有 SQLite, 元 cap 提供查询 + 维护
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, Value } from '../contracts.ts';
import { db, dataRoot } from '../storage.ts';

export function createStorageCap(): Capability {
  return {
    id: 'cap.storage',
    description: 'Storage manager. Actions: list/backups/info/vacuum. Manages storage backends.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'vacuum'] },
      },
      required: ['action'],
    },
    async invoke(params: Value) {
      const p = params as { action: 'list' | 'info' | 'vacuum' };
      switch (p.action) {
        case 'list':
          return {
            ok: true,
            backends: [
              { name: 'sqlite', type: 'kv+audit', running: true, path: join(dataRoot, 'sky.db') },
              { name: 'jsonl', type: 'history', running: true, path: join(dataRoot, 'history') },
            ],
          };
        case 'info': {
          const dbPath = join(dataRoot, 'sky.db');
          let size = 0;
          try { size = statSync(dbPath).size; } catch { /* ignore */ }
          // 表统计
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
          const counts: Record<string, number> = {};
          for (const t of tables) {
            try {
              const c = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as { c: number };
              counts[t.name] = c.c;
            } catch { /* ignore */ }
          }
          return { ok: true, backend: 'sqlite', path: dbPath, size, tables: counts };
        }
        case 'vacuum': {
          db.exec('VACUUM');
          return { ok: true, vacuumed: true };
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
