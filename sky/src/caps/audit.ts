/**
 * cap.audit — 审计/事件流能力
 *
 * 两面:
 * 1. 内部 record() — Router.dispatch 前后直接调用, 写入 SQLite (不经 dispatch, 避免循环)
 * 2. invoke() — 暴露查询能力给 AI/前端: list/get/byTrace/byCap/recent/stats/clear
 *
 * 记录内容: trace, msgId, cap, source, params, result, durationMs, kind, ts
 * - kind: allow/deny/error/stream-start/stream-end
 *
 * 同时每次 record 都推送 audit.event 到 EventBus (前端实时可观察).
 * cap.audit 自身的查询 invoke 不被 audit (避免无限循环).
 */

import type { Capability, CallContext, Value } from '../contracts.ts';
import { db } from '../storage.ts';

// ============================================================================
// Schema (idempotent)
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace TEXT NOT NULL,
    msg_id TEXT,
    cap TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    params TEXT,
    result TEXT,
    duration_ms INTEGER,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit(trace);');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_cap ON audit(cap);');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);');

// ============================================================================
// AuditRecord (内部用)
// ============================================================================

export interface AuditRecord {
  trace: string;
  msgId?: string;
  cap: string;
  source: string;
  params?: Value;
  result?: Value;
  durationMs?: number;
  kind: string;
  ts: number;
}

// ============================================================================
// 内部 record (Router 直接调用, 不经 dispatch)
// ============================================================================

let _emit: ((e: { type: string; data: Value; ts: number }) => void) | null = null;

/** 注入事件推送函数 (Router 启动时调用) */
export function setAuditEmitter(fn: (e: { type: string; data: Value; ts: number }) => void): void {
  _emit = fn;
}

const _insertStmt = db.prepare(
  `INSERT INTO audit(trace, msg_id, cap, source_kind, params, result, duration_ms, kind, ts)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function record(r: AuditRecord): void {
  try {
    _insertStmt.run(
      r.trace,
      r.msgId ?? null,
      r.cap,
      r.source,
      r.params === undefined ? null : JSON.stringify(r.params),
      r.result === undefined ? null : JSON.stringify(r.result),
      r.durationMs ?? null,
      r.kind,
      r.ts,
    );
  } catch (e) {
    // 审计失败不应阻断主流程
    console.error('[audit] record failed:', e);
  }
  // 推送事件流 (前端实时观察)
  if (_emit) {
    try {
      _emit({ type: 'audit.event', data: { ...r, params: r.params, result: r.result }, ts: r.ts });
    } catch { /* ignore */ }
  }
}

// ============================================================================
// Capability (查询面, 给 AI/前端)
// ============================================================================

export const auditCap: Capability = {
  id: 'cap.audit',
  description: 'Audit/event stream. Records all dispatch requests/responses. Actions: list/get/byTrace/byCap/recent/stats/clear.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'byTrace', 'byCap', 'recent', 'stats', 'clear'],
      },
      id: { type: 'number', description: 'Record id (for get)' },
      trace: { type: 'string', description: 'Trace id (for byTrace)' },
      cap: { type: 'string', description: 'Capability id (for byCap)' },
      limit: { type: 'number', description: 'Max records, default 50' },
      since: { type: 'number', description: 'Timestamp ms (for recent, records after this)' },
    },
    required: ['action'],
  },
  async invoke(params: Value, _ctx: CallContext) {
    const p = params as {
      action: 'list' | 'get' | 'byTrace' | 'byCap' | 'recent' | 'stats' | 'clear';
      id?: number;
      trace?: string;
      cap?: string;
      limit?: number;
      since?: number;
    };
    const limit = Math.min(p.limit ?? 50, 500);

    switch (p.action) {
      case 'list': {
        const rows = db.prepare(
          `SELECT id, trace, msg_id, cap, source_kind, params, result, duration_ms, kind, ts
           FROM audit ORDER BY id DESC LIMIT ?`,
        ).all(limit) as unknown as AuditRow[];
        return { ok: true, records: rows.map(parseRow), count: rows.length };
      }
      case 'get': {
        if (!p.id) throw new Error('id required for get');
        const row = db.prepare('SELECT * FROM audit WHERE id=?').get(p.id) as unknown as AuditRow | undefined;
        if (!row) return { ok: false, notFound: true };
        return { ok: true, record: parseRow(row) };
      }
      case 'byTrace': {
        if (!p.trace) throw new Error('trace required for byTrace');
        const rows = db.prepare(
          'SELECT * FROM audit WHERE trace=? ORDER BY id ASC LIMIT ?',
        ).all(p.trace, limit) as unknown as AuditRow[];
        return { ok: true, trace: p.trace, records: rows.map(parseRow), count: rows.length };
      }
      case 'byCap': {
        if (!p.cap) throw new Error('cap required for byCap');
        const rows = db.prepare(
          'SELECT * FROM audit WHERE cap=? ORDER BY id DESC LIMIT ?',
        ).all(p.cap, limit) as unknown as AuditRow[];
        return { ok: true, cap: p.cap, records: rows.map(parseRow), count: rows.length };
      }
      case 'recent': {
        const since = p.since ?? 0;
        const rows = db.prepare(
          'SELECT * FROM audit WHERE ts>? ORDER BY id DESC LIMIT ?',
        ).all(since, limit) as unknown as AuditRow[];
        return { ok: true, since, records: rows.map(parseRow), count: rows.length };
      }
      case 'stats': {
        const total = (db.prepare('SELECT COUNT(*) as c FROM audit').get() as { c: number }).c;
        const byCap = db.prepare(
          'SELECT cap, COUNT(*) as c FROM audit GROUP BY cap ORDER BY c DESC',
        ).all() as Array<{ cap: string; c: number }>;
        const byKind = db.prepare(
          'SELECT kind, COUNT(*) as c FROM audit GROUP BY kind ORDER BY c DESC',
        ).all() as Array<{ kind: string; c: number }>;
        const lastTs = (db.prepare('SELECT MAX(ts) as t FROM audit').get() as { t: number | null }).t;
        return { ok: true, total, byCap, byKind, lastTs };
      }
      case 'clear': {
        const before = (db.prepare('SELECT COUNT(*) as c FROM audit').get() as { c: number }).c;
        db.exec('DELETE FROM audit');
        return { ok: true, cleared: before };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

// ============================================================================
// Row parser
// ============================================================================

interface AuditRow {
  id: number;
  trace: string;
  msg_id: string | null;
  cap: string;
  source_kind: string;
  params: string | null;
  result: string | null;
  duration_ms: number | null;
  kind: string;
  ts: number;
}

function parseRow(r: AuditRow): Record<string, unknown> {
  return {
    id: r.id,
    trace: r.trace,
    msgId: r.msg_id,
    cap: r.cap,
    source: r.source_kind,
    params: r.params ? safeJsonParse(r.params) : null,
    result: r.result ? safeJsonParse(r.result) : null,
    durationMs: r.duration_ms,
    kind: r.kind,
    ts: r.ts,
  };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
