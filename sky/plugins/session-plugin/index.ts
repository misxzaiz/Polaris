/**
 * session-plugin.ts
 *
 * A `cap.session` plugin that wraps `cap.history` (JSONL message log) and
 * `cap.kv` (persistent meta: title / createdAt / lastActive) to expose a
 * unified session-management surface.
 *
 * Registered actions (via dispatch):
 *   - list        -> list sessions with meta, sorted by lastActive desc
 *   - create      -> create a new session with an optional title
 *   - rename      -> update a session's title
 *   - delete      -> remove session meta AND its history
 *   - switch      -> mark a session as the current one
 *   - getCurrent  -> return the currently active session's meta + history
 *
 * Storage layout (all under cap.kv domain "session"):
 *   - key: "<sessionId>"      -> SessionMeta { id, title, createdAt, lastActive }
 *   - key: "__current__"      -> sessionId (string)
 *
 * History layout: delegated to cap.history (JSONL, one file per session).
 */

import type { Capability, CallContext, CapabilityId, Value } from '../../src/contracts.ts';
import type { Router } from '../../src/server/router.ts';

const KV_DOMAIN = 'session';
const CURRENT_KEY = '__current__';

type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  lastActive: number;
};

type SessionCapParams = {
  action: 'list' | 'create' | 'rename' | 'delete' | 'switch' | 'getCurrent';
  sessionId?: string;
  title?: string;
  limit?: number;
};

// -------- tiny helpers --------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  const t = nowMs().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `s_${t}${r}`;
}

function unwrapReply(reply: unknown): Value | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as { result?: { ok?: boolean; data?: Value } };
  if (!r.result || r.result.ok !== true) return null;
  return r.result.data ?? null;
}

// -------- main capability -----------------------------------------------------

const sessionCap: Capability = {
  id: 'cap.session',
  description:
    'Session manager. Wraps cap.history + cap.kv to expose list/create/rename/delete/switch/getCurrent with meta (title/createdAt/lastActive).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'rename', 'delete', 'switch', 'getCurrent'],
      },
      sessionId: { type: 'string', description: 'Session id (required for rename/delete/switch)' },
      title: {
        type: 'string',
        description: 'Session title (for create/rename; auto-generated if omitted on create)',
      },
      limit: {
        type: 'number',
        description: 'Max items returned by list, default 50',
      },
    },
    required: ['action'],
  },
  async invoke(params: Value, ctx: CallContext) {
    const p = (params ?? {}) as SessionCapParams;

    const call = async (capId: CapabilityId, payload: Value): Promise<Value | null> => {
      const reply = await ctx.dispatch(capId, payload);
      return unwrapReply(reply);
    };

    try {
      switch (p.action) {
        case 'list':
          return await listSessions(p.limit ?? 50, call);
        case 'create':
          return await createSession(p.title, call);
        case 'rename':
          return await renameSession(p.sessionId, p.title, call);
        case 'delete':
          return await deleteSession(p.sessionId, call);
        case 'switch':
          return await switchSession(p.sessionId, call);
        case 'getCurrent':
          return await getCurrentSession(call);
        default:
          return { error: `unsupported action: ${p.action}` };
      }
    } catch (err) {
      return { error: `internal error: ${(err as Error)?.message ?? String(err)}` };
    }
  },
};

// -------- internal implementations -------------------------------------------

type Caller = (capId: CapabilityId, payload: Value) => Promise<Value | null>;

async function metaGet(id: string, call: Caller): Promise<SessionMeta | null> {
  const r = await call('cap.kv', { action: 'get', domain: KV_DOMAIN, key: id });
  if (!r) return null;
  const meta = (r as { value?: unknown }).value;
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Partial<SessionMeta>;
  if (typeof m.id !== 'string') return null;
  return {
    id: m.id,
    title: typeof m.title === 'string' ? m.title : m.id,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : nowMs(),
    lastActive: typeof m.lastActive === 'number' ? m.lastActive : (m.createdAt ?? nowMs()),
  };
}

async function metaSet(meta: SessionMeta, call: Caller): Promise<void> {
  await call('cap.kv', { action: 'set', domain: KV_DOMAIN, key: meta.id, value: meta });
}

async function currentId(call: Caller): Promise<string | null> {
  const r = await call('cap.kv', { action: 'get', domain: KV_DOMAIN, key: CURRENT_KEY });
  if (!r) return null;
  const v = (r as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

async function setCurrent(id: string, call: Caller): Promise<void> {
  await call('cap.kv', { action: 'set', domain: KV_DOMAIN, key: CURRENT_KEY, value: id });
}

async function clearCurrent(call: Caller): Promise<void> {
  await call('cap.kv', { action: 'delete', domain: KV_DOMAIN, key: CURRENT_KEY });
}

async function loadMessages(sessionId: string, call: Caller): Promise<unknown[]> {
  const r = await call('cap.history', { action: 'get', sessionId });
  if (!r) return [];
  const arr = (r as { messages?: unknown }).messages;
  return Array.isArray(arr) ? arr : [];
}

async function listSessions(limit: number, call: Caller) {
  const r = await call('cap.kv', { action: 'list', domain: KV_DOMAIN });
  // cap.kv list 返回 { items: [{ key, value }] } — 不是 keys 数组
  const items = ((r as { items?: Array<{ key: string }> } | null)?.items ?? []) as Array<{ key: string }>;
  const ids = items.map((it) => it.key).filter((k) => k !== CURRENT_KEY);

  const metas = (
    await Promise.all(ids.map((k) => metaGet(k, call)))
  ).filter((m): m is SessionMeta => !!m);

  metas.sort((a, b) => b.lastActive - a.lastActive);
  const slice = metas.slice(0, Math.max(1, Math.floor(limit) || 50));

  const withCounts = await Promise.all(
    slice.map(async (m) => ({
      ...m,
      messages: (await loadMessages(m.id, call)).length,
    })),
  );

  const cur = await currentId(call);
  return { sessions: withCounts, currentId: cur };
}

async function createSession(title: string | undefined, call: Caller) {
  const id = newId();
  const t = nowMs();
  const autoTitle =
    title && title.trim()
      ? title.trim()
      : `Session ${new Date(t).toISOString().slice(0, 19).replace('T', ' ')}`;
  const meta: SessionMeta = { id, title: autoTitle, createdAt: t, lastActive: t };
  await metaSet(meta, call);
  // default: make new session current
  await setCurrent(id, call);
  return { ok: true, ...meta, currentId: id };
}

async function renameSession(sessionId: string | undefined, title: string | undefined, call: Caller) {
  if (!sessionId) return { error: 'sessionId required' };
  if (!title || !title.trim()) return { error: 'title required' };
  const meta = await metaGet(sessionId, call);
  if (!meta) return { error: `session not found: ${sessionId}`, id: sessionId };
  meta.title = title.trim();
  meta.lastActive = nowMs();
  await metaSet(meta, call);
  return { ok: true, ...meta };
}

async function deleteSession(sessionId: string | undefined, call: Caller) {
  if (!sessionId) return { error: 'sessionId required' };
  const meta = await metaGet(sessionId, call);
  if (!meta) return { error: `session not found: ${sessionId}`, id: sessionId };

  await call('cap.history', { action: 'clear', sessionId });
  await call('cap.kv', { action: 'delete', domain: KV_DOMAIN, key: sessionId });

  const cur = await currentId(call);
  if (cur === sessionId) await clearCurrent(call);

  return { ok: true, id: sessionId, wasCurrent: cur === sessionId };
}

async function switchSession(sessionId: string | undefined, call: Caller) {
  if (!sessionId) return { error: 'sessionId required' };
  const meta = await metaGet(sessionId, call);
  if (!meta) return { error: `session not found: ${sessionId}`, id: sessionId };
  meta.lastActive = nowMs();
  await metaSet(meta, call);
  await setCurrent(sessionId, call);
  return { ok: true, ...meta, currentId: sessionId };
}

async function getCurrentSession(call: Caller) {
  const id = await currentId(call);
  if (!id) return { sessionId: null, currentId: null };
  const meta = await metaGet(id, call);
  if (!meta) return { sessionId: id, currentId: id, meta: null, error: 'meta missing' };
  const messages = await loadMessages(id, call);
  return { sessionId: id, currentId: id, meta, messages };
}

// -------- plugin lifecycle ----------------------------------------------------

export default function setup(router: Router) {
  router.register(sessionCap);
}

export async function teardown(router: Router) {
  router.unregister('cap.session');
}
