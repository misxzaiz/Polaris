/**
 * 认证状态 — 传输层(http.ts)与权限拦截器(permission.ts)共享
 *
 * - masterToken: config server.token, 呈现即 admin
 * - authRequired: true 时未认证请求在传输层 401 + 拦截器 deny (双保险)
 * - devMode: 未配 master token 且未开启强制认证 → 本地开发宽松(无 token 的
 *   remote 视为 admin, 便于从 Shell 签发第一批 token)
 */

import { lookupIssuedToken } from '../caps/auth.ts';

export interface AuthIdentity {
  authed: boolean;
  authId?: string;
  authName?: string;
  admin?: boolean;
}

let _masterToken: string | undefined;
let _authRequired = false;

export function setAuthState(masterToken: string | undefined, authRequired: boolean): void {
  _masterToken = masterToken || undefined;
  _authRequired = !!authRequired;
}

export function getAuthRequired(): boolean {
  return _authRequired;
}

export function getMasterToken(): string | undefined {
  return _masterToken;
}

export function isDevMode(): boolean {
  return !_masterToken && !_authRequired;
}

/**
 * 校验呈现的 token → 身份.
 * 优先 master (admin), 再查已签发库, 都不中 → 未认证.
 */
export function validatePresentedToken(presented: string | null): AuthIdentity {
  if (!presented) return { authed: false };
  if (_masterToken && presented === _masterToken) {
    return { authed: true, authId: 'master', authName: 'master', admin: true };
  }
  const hit = lookupIssuedToken(presented);
  if (hit) {
    return { authed: true, authId: hit.id, authName: hit.name, admin: hit.admin };
  }
  return { authed: false };
}
