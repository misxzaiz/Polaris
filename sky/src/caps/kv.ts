/**
 * cap.kv — 键值存储能力(SQLite 持久化)
 *
 * 动作: set/get/delete/list
 * domain 隔离: 不同插件/会话用不同 domain,默认 "default"
 *
 * 使用 node:sqlite (DatabaseSync). prepare() 返回 StatementSync.
 * - stmt.run(...params) → { changes, lastInsertRowid }
 * - stmt.get(...params) → 行对象 | undefined
 * - stmt.all(...params) → 行对象[]
 */

import type { Capability, Value } from '../contracts.ts';
import { db } from '../storage.ts';

export const kvCap: Capability = {
  id: 'cap.kv',
  description: 'Persistent key-value store. Actions: set/get/delete/list. Domain-isolated.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'get', 'delete', 'list'] },
      domain: { type: 'string', description: 'Isolation domain, default "default"' },
      key: { type: 'string' },
      value: {},
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'set' | 'get' | 'delete' | 'list';
      domain?: string;
      key?: string;
      value?: unknown;
    };
    const domain = p.domain ?? 'default';
    switch (p.action) {
      case 'set': {
        if (!p.key) throw new Error('key required for set');
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO kv(domain, key, value, updated_at) VALUES(?, ?, ?, ?)',
        );
        stmt.run(domain, p.key, JSON.stringify(p.value ?? null), Date.now());
        return { ok: true, key: p.key };
      }
      case 'get': {
        if (!p.key) throw new Error('key required for get');
        const row = db.prepare('SELECT value FROM kv WHERE domain=? AND key=?').get(domain, p.key) as
          | { value: string } | undefined;
        if (!row) return { ok: false, notFound: true };
        return { ok: true, value: JSON.parse(row.value) };
      }
      case 'delete': {
        if (!p.key) throw new Error('key required for delete');
        db.prepare('DELETE FROM kv WHERE domain=? AND key=?').run(domain, p.key);
        return { ok: true };
      }
      case 'list': {
        const rows = db.prepare('SELECT key, value, updated_at FROM kv WHERE domain=? ORDER BY key').all(domain) as
          Array<{ key: string; value: string; updated_at: number }>;
        return {
          ok: true,
          items: rows.map(r => ({
            key: r.key,
            value: JSON.parse(r.value),
            updatedAt: r.updated_at,
          })),
        };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
