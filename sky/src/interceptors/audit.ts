/**
 * audit 拦截器 — 审计/事件流(可插拔, 退化为 Interceptor)
 *
 * before: 无操作(deny 路径的审计由 permission 拦截器自己记)
 * after:  记录响应(含结果+耗时)
 *
 * cap.audit / cap.interceptor 自身的调用不被审计(避免循环).
 */

import type { Interceptor, DispatchContext, BeforeResult, AfterResult } from '../contracts.ts';
import { record } from '../caps/audit.ts';

// 不审计的元 cap (避免循环)
const NO_AUDIT = new Set(['cap.audit', 'cap.interceptor', 'cap.capability']);

function isStreamStart(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { ok?: boolean; data?: { streamId?: unknown } };
  return r.ok === true && !!r.data?.streamId;
}

export const auditInterceptor: Interceptor = {
  name: 'audit',
  priority: 20,
  async before(_ctx: DispatchContext): Promise<BeforeResult> {
    return { kind: 'continue' };
  },
  async after(ctx: DispatchContext): Promise<AfterResult> {
    if (NO_AUDIT.has(ctx.capId)) {
      return { kind: 'continue' };
    }
    const durationMs = Date.now() - ctx.startTs;
    const kind = isStreamStart(ctx.result) ? 'stream-start'
      : ctx.result?.ok ? 'allow' : 'allow-error';
    record({
      trace: ctx.trace, msgId: ctx.msgId,
      cap: ctx.capId, source: ctx.source.kind,
      params: ctx.params, result: ctx.result,
      durationMs, kind, ts: ctx.startTs,
    });
    return { kind: 'continue' };
  },
};
