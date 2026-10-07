/**
 * cap.auth — 接口认证管理
 *
 * 动作: issue/list/revoke/verify
 * - token 原文只在 issue 返回一次, 库里只存 SHA-256 哈希 + 前 8 位前缀(供展示)
 * - master token (config server.token) 不入库, 校验时优先比对, 恒为 admin
 * - issue/revoke/list 需要 admin (master token 或本地开发模式);
 *   verify 无需权限(只验证不列举)
 *
 * 存储复用 kv 表 (domain="auth", key="tokens"), 与 cap.kv 同一物理存储.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Capability, CallContext, Value } from '../contracts.ts';
import { db } from '../storage.ts';

const DOMAIN = 'auth';
const KEY = 'tokens';

export interface AuthTokenRecord {
  id: string;
  name: string;
  role: 'admin' | 'user';
  tokenHash: string;
  /** 前 8 位原文, 供列表辨认 */
  prefix: string;
  createdAt: number;
  expiresAt?: number;
  revoked: boolean;
  lastUsedAt?: number;
}

interface TokenMap {
  [id: string]: AuthTokenRecord;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function loadTokens(): TokenMap {
  const row = db.prepare('SELECT value FROM kv WHERE domain=? AND key=?').get(DOMAIN, KEY) as
    | { value: string } | undefined;
  if (!row) return {};
  try { return JSON.parse(row.value) as TokenMap; } catch { return {}; }
}

function saveTokens(map: TokenMap): void {
  db.prepare('INSERT OR REPLACE INTO kv(domain, key, value, updated_at) VALUES(?, ?, ?, ?)')
    .run(DOMAIN, KEY, JSON.stringify(map), Date.now());
}

/** 生成 sk- 前缀随机 token */
export function generateToken(): string {
  return 'sk-' + randomBytes(24).toString('hex');
}

/**
 * 校验 presented token 是否为有效已签发 token.
 * 命中时更新 lastUsedAt (写穿). 返回身份; 未命中返回 null.
 * master token 不在此校验 (传输层优先比对 config).
 */
export function lookupIssuedToken(presented: string): {
  id: string; name: string; role: 'admin' | 'user'; admin: boolean;
} | null {
  const map = loadTokens();
  const hash = sha256(presented);
  for (const rec of Object.values(map)) {
    if (rec.tokenHash !== hash) continue;
    if (rec.revoked) return null;
    if (rec.expiresAt && rec.expiresAt < Date.now()) return null;
    rec.lastUsedAt = Date.now();
    saveTokens(map);
    return { id: rec.id, name: rec.name, role: rec.role, admin: rec.role === 'admin' };
  }
  return null;
}

/** 是否 admin 来源: master/已签发 admin 角色/本地开发宽松模式 */
export function isAdminSource(ctx: CallContext, devMode: boolean): boolean {
  const s = ctx.source;
  if (s.kind === 'bootstrap') return true;
  if (s.kind === 'plugin') return false;
  if (s.admin) return true;
  // 本地开发: 无强制认证且未呈现 token → 视为管理员 (与权限拦截器宽松模式一致)
  return devMode && !s.token;
}

export function createAuthCap(opts: { devMode: () => boolean }): Capability {
  return {
    id: 'cap.auth',
    description: 'API token auth management. Actions: issue/list/revoke/verify. ' +
      'issue 返回 token 原文(仅此一次), 库存 SHA-256. issue/revoke/list 需 admin; ' +
      'verify 只校验当前 token. token 形如 sk-<48hex>.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['issue', 'list', 'revoke', 'verify'] },
        name: { type: 'string', description: 'issue: token 名称(用途标记)' },
        role: { type: 'string', enum: ['admin', 'user'], description: 'issue: 角色, 默认 user' },
        expiresDays: { type: 'number', description: 'issue: 有效天数, 省略=永不过期' },
        expiresInSeconds: { type: 'number', description: 'issue: 有效秒数(测试用), 优先于 expiresDays' },
        id: { type: 'string', description: 'revoke: token id' },
      },
      required: ['action'],
    },
    async invoke(params: Value, ctx: CallContext) {
      const p = params as {
        action: 'issue' | 'list' | 'revoke' | 'verify';
        name?: string; role?: 'admin' | 'user';
        expiresDays?: number; expiresInSeconds?: number; id?: string;
      };
      const devMode = opts.devMode();
      switch (p.action) {
        case 'issue': {
          if (!isAdminSource(ctx, devMode)) throw new Error('admin required for issue');
          if (!p.name || typeof p.name !== 'string') throw new Error('name required for issue');
          const raw = generateToken();
          const rec: AuthTokenRecord = {
            id: 'tok_' + randomBytes(6).toString('hex'),
            name: p.name.slice(0, 64),
            role: p.role === 'admin' ? 'admin' : 'user',
            tokenHash: sha256(raw),
            prefix: raw.slice(0, 8),
            createdAt: Date.now(),
            revoked: false,
          };
          if (p.expiresInSeconds && p.expiresInSeconds > 0) rec.expiresAt = Date.now() + p.expiresInSeconds * 1000;
          else if (p.expiresDays && p.expiresDays > 0) rec.expiresAt = Date.now() + p.expiresDays * 86400_000;
          const map = loadTokens();
          map[rec.id] = rec;
          saveTokens(map);
          return { ok: true, id: rec.id, token: raw, name: rec.name, role: rec.role, expiresAt: rec.expiresAt ?? null };
        }
        case 'list': {
          if (!isAdminSource(ctx, devMode)) throw new Error('admin required for list');
          const map = loadTokens();
          const now = Date.now();
          const tokens = Object.values(map)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(r => ({
              id: r.id, name: r.name, role: r.role, prefix: r.prefix,
              createdAt: r.createdAt,
              expiresAt: r.expiresAt ?? null,
              expired: !!(r.expiresAt && r.expiresAt < now),
              revoked: r.revoked,
              lastUsedAt: r.lastUsedAt ?? null,
            }));
          return { ok: true, tokens };
        }
        case 'revoke': {
          if (!isAdminSource(ctx, devMode)) throw new Error('admin required for revoke');
          if (!p.id) throw new Error('id required for revoke');
          const map = loadTokens();
          const rec = map[p.id];
          if (!rec) throw new Error(`token not found: ${p.id}`);
          rec.revoked = true;
          map[p.id] = rec;
          saveTokens(map);
          return { ok: true, revoked: p.id };
        }
        case 'verify': {
          // 只验证调用者自己的 token, 无需 admin. 无 token 的来源返回未认证.
          const s = ctx.source;
          if (s.kind !== 'remote' || !s.token) return { ok: true, authed: false };
          const hit = lookupIssuedToken(s.token);
          if (hit) return { ok: true, authed: true, authId: hit.id, authName: hit.name, role: hit.role, admin: hit.admin };
          // master token 不经 lookup (无库记录); 传输层已注入 admin=true 时说明是 master
          if (s.admin) return { ok: true, authed: true, authId: 'master', authName: 'master', role: 'admin', admin: true };
          return { ok: true, authed: false };
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
