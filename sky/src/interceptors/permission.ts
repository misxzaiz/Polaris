/**
 * permission 拦截器 — 权限 gate(可插拔, 退化为 Interceptor)
 *
 * before 拦截: 检查 source 是否允许调 capId
 * - Bootstrap 全放行
 * - Remote: 默认放行所有已注册 cap (本地开发宽松)
 *   显式 deny 列表优先 (运行时可改)
 * - Plugin 沿袭
 *
 * deny 时直接记审计, verdict 写 ctx.state.
 */

import type { Interceptor, DispatchContext, BeforeResult, Source } from '../contracts.ts';
import { record } from '../caps/audit.ts';
import { getAuthRequired } from '../server/auth.ts';

interface PermissionConfig {
  // 显式拒绝列表 (优先级高于 allow-all)
  remoteDeny: string[];
  // 显式 allow 列表 (留空=允许全部, 配置后只允许列出的)
  remoteAllow: string[] | null;
}

let _config: PermissionConfig = { remoteDeny: [], remoteAllow: null };

export function setPermissionConfig(cfg: Partial<PermissionConfig>): void {
  _config = { ..._config, ...cfg };
}

export function getPermissionConfig(): PermissionConfig {
  return _config;
}

function checkSource(capId: string, source: Source): 'allow' | 'deny' {
  switch (source.kind) {
    case 'bootstrap': return 'allow';
    case 'remote':
      // 强制认证: 未认证一律 deny (传输层 401 之外的第二道防线)
      if (getAuthRequired() && !source.authed) return 'deny';
      // deny 列表优先
      if (_config.remoteDeny.includes(capId)) return 'deny';
      // allow 列表: 配置了就只放行列表内, 未配置放行全部
      if (_config.remoteAllow !== null && !_config.remoteAllow.includes(capId)) return 'deny';
      return 'allow';
    case 'plugin': return 'allow';
  }
}

export const permissionInterceptor: Interceptor = {
  name: 'permission',
  priority: 10,
  async before(ctx: DispatchContext): Promise<BeforeResult> {
    const verdict = checkSource(ctx.capId, ctx.source);
    ctx.state['permission.verdict'] = verdict;

    if (verdict === 'deny') {
      if (ctx.capId !== 'cap.audit' && ctx.capId !== 'cap.interceptor') {
        record({
          trace: ctx.trace, msgId: ctx.msgId,
          cap: ctx.capId, source: ctx.source.kind,
          params: ctx.params, result: { ok: false, error: 'permission denied' },
          durationMs: 0, kind: 'deny', ts: ctx.startTs,
        });
      }
      return { kind: 'deny', error: `permission denied: ${ctx.capId}` };
    }
    return { kind: 'continue' };
  },
};

