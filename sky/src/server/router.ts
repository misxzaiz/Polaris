/**
 * Router — 统一转发总线(链调度版)
 *
 * 职责:
 * 1. 注册/查找能力(唯一注册表)
 * 2. dispatch: before链 → invoke → after链
 * 3. dispatchStream: 流式分支,立即返回 StreamAck,事件经 EventBus
 *
 * 设计:
 * - 无硬编码关卡(permission/audit 都退化为 Interceptor 插件)
 * - resolveHandle 保持私有,防旁路直调
 * - 拦截器经 registerInterceptor 注册, 按 priority 排序
 */

import type {
  Capability, CapabilityId, CallContext, DispatchContext,
  Interceptor, MsgId, Reply, Source, StreamingCapability, TraceId, Value,
} from '../contracts.ts';
import type { EventBus } from './eventbus.ts';

export class Router {
  private caps = new Map<CapabilityId, Capability>();
  private streaming = new Map<CapabilityId, StreamingCapability>();
  private interceptors: Interceptor[] = [];

  constructor(private bus: EventBus) {}

  // ===========================================================================
  // Capability 注册
  // ===========================================================================

  register(cap: Capability): void {
    if (this.caps.has(cap.id)) {
      throw new Error(`capability already registered: ${cap.id}`);
    }
    this.caps.set(cap.id, cap);
    if (typeof (cap as StreamingCapability).stream === 'function') {
      this.streaming.set(cap.id, cap as StreamingCapability);
    }
    console.log(`[router] +cap ${cap.id}`);
  }

  unregister(capId: CapabilityId): void {
    this.caps.delete(capId);
    this.streaming.delete(capId);
    console.log(`[router] -cap ${capId}`);
  }

  list(): Array<{ id: CapabilityId; description: string; streaming: boolean; inputSchema: Record<string, unknown> }> {
    return [...this.caps.values()].map(c => ({
      id: c.id,
      description: c.description,
      streaming: this.streaming.has(c.id),
      inputSchema: c.inputSchema,
    }));
  }

  // ===========================================================================
  // Interceptor 注册
  // ===========================================================================

  registerInterceptor(itc: Interceptor): void {
    if (this.interceptors.some(i => i.name === itc.name)) {
      throw new Error(`interceptor already registered: ${itc.name}`);
    }
    this.interceptors.push(itc);
    // 按 priority 升序(before 链执行顺序)
    this.interceptors.sort((a, b) => a.priority - b.priority);
    console.log(`[router] +interceptor ${itc.name} (priority ${itc.priority})`);
  }

  unregisterInterceptor(name: string): void {
    const before = this.interceptors.length;
    this.interceptors = this.interceptors.filter(i => i.name !== name);
    if (this.interceptors.length < before) {
      console.log(`[router] -interceptor ${name}`);
    }
  }

  listInterceptors(): Array<{ name: string; priority: number; hasBefore: boolean; hasAfter: boolean }> {
    return this.interceptors.map(i => ({
      name: i.name,
      priority: i.priority,
      hasBefore: !!i.before,
      hasAfter: !!i.after,
    }));
  }

  // ===========================================================================
  // dispatch (链调度)
  // ===========================================================================

  async dispatch(capId: CapabilityId, payload: Value, source: Source): Promise<Reply> {
    const trace = newTrace();
    const msgId = newMsgId();
    return this.dispatchTraced(capId, payload, source, trace, msgId);
  }

  async dispatchTraced(
    capId: CapabilityId, payload: Value, source: Source,
    trace: TraceId, msgId: MsgId,
  ): Promise<Reply> {
    const ctx: DispatchContext = {
      trace, msgId, capId, params: payload, source,
      state: {}, startTs: Date.now(),
    };

    // 1. before 链(按 priority 升序)
    for (const itc of this.interceptors) {
      if (!itc.before) continue;
      let res;
      try {
        res = await itc.before(ctx);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { msg_id: msgId, trace, result: { ok: false, error: `interceptor ${itc.name} failed: ${error}` } };
      }
      switch (res.kind) {
        case 'continue':
          if ('params' in res) ctx.params = res.params;
          break;
        case 'deny':
          return { msg_id: msgId, trace, result: { ok: false, error: res.error } };
        case 'shortCircuit':
          return { msg_id: msgId, trace, result: { ok: true, data: res.result } };
      }
    }

    // 2. 找句柄
    const cap = this.caps.get(capId);
    if (!cap) {
      return { msg_id: msgId, trace, result: { ok: false, error: `capability not found: ${capId}` } };
    }

    // 3. invoke
    const callCtx: CallContext = {
      source, trace,
      dispatch: (id, p) => this.dispatchTraced(id, p, source, trace, newMsgId()),
      emit: (e) => this.bus.emit({ ...e, trace }),
    };

    let result: { ok: true; data: Value } | { ok: false; error: string };
    try {
      const data = await cap.invoke(ctx.params, callCtx);
      result = { ok: true, data };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result = { ok: false, error };
    }
    ctx.result = result;

    // 4. after 链(按 priority 升序, 但语义上是逆序收尾; 此处仍升序遍历)
    for (const itc of this.interceptors) {
      if (!itc.after) continue;
      let res;
      try {
        res = await itc.after(ctx);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // after 失败不阻断, 记录但不改结果
        console.error(`[router] interceptor ${itc.name} after failed: ${error}`);
        continue;
      }
      if (res.kind === 'continue' && 'result' in res) {
        ctx.result = res.result;
      }
    }

    return { msg_id: msgId, trace, result: ctx.result };
  }

  // ===========================================================================
  // dispatchStream (流式分支)
  // ===========================================================================

  async dispatchStream(capId: CapabilityId, payload: Value, source: Source): Promise<Reply> {
    const trace = newTrace();
    const msgId = newMsgId();
    const ctx: DispatchContext = {
      trace, msgId, capId, params: payload, source,
      state: {}, startTs: Date.now(),
    };

    // before 链(流式也走拦截器)
    for (const itc of this.interceptors) {
      if (!itc.before) continue;
      let res;
      try { res = await itc.before(ctx); } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { msg_id: msgId, trace, result: { ok: false, error: `interceptor ${itc.name} failed: ${error}` } };
      }
      switch (res.kind) {
        case 'continue':
          if ('params' in res) ctx.params = res.params;
          break;
        case 'deny':
          return { msg_id: msgId, trace, result: { ok: false, error: res.error } };
        case 'shortCircuit':
          return { msg_id: msgId, trace, result: { ok: true, data: res.result } };
      }
    }

    const cap = this.streaming.get(capId);
    if (!cap) {
      return { msg_id: msgId, trace, result: { ok: false, error: `streaming capability not found: ${capId}` } };
    }
    const callCtx: CallContext = {
      source, trace,
      dispatch: (id, p) => this.dispatchTraced(id, p, source, trace, newMsgId()),
      emit: (e) => this.bus.emit({ ...e, trace }),
    };
    try {
      const { streamId } = await cap.stream(ctx.params, callCtx);
      ctx.result = { ok: true, data: { stream: true, streamId } };
      // after 链
      for (const itc of this.interceptors) {
        if (!itc.after) continue;
        try {
          const res = await itc.after(ctx);
          if (res.kind === 'continue' && 'result' in res) ctx.result = res.result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[router] interceptor ${itc.name} after failed: ${error}`);
        }
      }
      return { msg_id: msgId, trace, result: ctx.result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { msg_id: msgId, trace, result: { ok: false, error } };
    }
  }
}

// ============================================================================
// ID 生成
// ============================================================================

function newTrace(): TraceId {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newMsgId(): MsgId {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
