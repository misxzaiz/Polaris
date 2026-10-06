/**
 * Router — 统一转发总线
 *
 * 职责:
 * 1. 注册/查找能力句柄(唯一注册表,插件加载后能力即注册)
 * 2. dispatch: 权限 gate → 找句柄 → invoke → 审计
 * 3. dispatch_stream: 流式分支,立即返回 StreamAck,事件经 EventBus
 *
 * 设计取舍:
 * - resolveHandle 保持模块私有,防插件旁路直调
 * - 权限 gate 是 dispatch 唯一入口,无 invoke 旁路
 * - 审计: deny/allow 均记录(开发态 console,发行版接 AuditSink)
 */

import type {
  Capability, CapabilityId, CallContext,
  Envelope, MsgId, PermissionPolicy, Reply, Source, StreamingCapability,
  TraceId, Value,
} from '../contracts.ts';
import type { EventBus } from './eventbus.ts';
import { record, setAuditEmitter, type AuditRecord } from '../caps/audit.ts';

export class Router {
  private caps = new Map<CapabilityId, Capability>();
  private streaming = new Map<CapabilityId, StreamingCapability>();
  private handleSeq = 1n;

  constructor(
    private policy: PermissionPolicy,
    private bus: EventBus,
  ) {}

  /** 注册能力(插件加载后调用) */
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

  /** 注销能力(插件卸载时) */
  unregister(capId: CapabilityId): void {
    this.caps.delete(capId);
    this.streaming.delete(capId);
  }

  /** 列出所有能力(供前端/AI 发现) */
  list(): Array<{ id: CapabilityId; description: string; streaming: boolean; inputSchema: Record<string, unknown> }> {
    return [...this.caps.values()].map(c => ({
      id: c.id,
      description: c.description,
      streaming: this.streaming.has(c.id),
      inputSchema: c.inputSchema,
    }));
  }

  /** 同步 dispatch: 权限 → invoke → 审计 */
  async dispatch(
    capId: CapabilityId,
    payload: Value,
    source: Source,
  ): Promise<Reply> {
    const trace = newTrace();
    const msgId = newMsgId();
    return this.dispatchTraced(capId, payload, source, trace, msgId);
  }

  /** 带 trace 的 dispatch(供内部贯通) */
  async dispatchTraced(
    capId: CapabilityId,
    payload: Value,
    source: Source,
    trace: TraceId,
    msgId: MsgId,
  ): Promise<Reply> {
    const startTs = Date.now();
    const sourceKind = source.kind;
    // 审计开关: cap.audit 自身不审计(避免循环)
    const shouldAudit = capId !== 'cap.audit';

    // 1. 权限 gate
    const verdict = this.policy.check(capId, source);
    if (verdict === 'deny') {
      if (shouldAudit) record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { error: 'permission denied' }, 0, 'deny', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error: `permission denied: ${capId}` } };
    }
    if (verdict === 'prompt') {
      if (shouldAudit) record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { error: 'prompt unavailable' }, 0, 'prompt-deny', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error: 'interactive permission not available' } };
    }

    // 2. 找句柄
    const cap = this.caps.get(capId);
    if (!cap) {
      if (shouldAudit) record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { error: 'capability not found' }, 0, 'deny', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error: `capability not found: ${capId}` } };
    }

    // 3. invoke
    const ctx: CallContext = {
      source,
      trace,
      dispatch: (id, p) => this.dispatchTraced(id, p, source, trace, newMsgId()),
      emit: (e) => this.bus.emit({ ...e, trace }),
    };

    try {
      const data = await cap.invoke(payload, ctx);
      const durationMs = Date.now() - startTs;
      if (shouldAudit) record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { ok: true, data }, durationMs, 'allow', startTs));
      return { msg_id: msgId, trace, result: { ok: true, data } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTs;
      if (shouldAudit) record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { ok: false, error }, durationMs, 'allow-error', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error } };
    }
  }

  /** 流式 dispatch: 立即返回 streamId, 事件流经 EventBus */
  async dispatchStream(
    capId: CapabilityId,
    payload: Value,
    source: Source,
  ): Promise<Reply> {
    const trace = newTrace();
    const msgId = newMsgId();
    const startTs = Date.now();
    const sourceKind = source.kind;

    const verdict = this.policy.check(capId, source);
    if (verdict !== 'allow') {
      record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { error: 'permission denied' }, 0, 'deny', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error: `permission denied: ${capId}` } };
    }
    const cap = this.streaming.get(capId);
    if (!cap) {
      record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { error: 'streaming capability not found' }, 0, 'deny', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error: `streaming capability not found: ${capId}` } };
    }
    const ctx: CallContext = {
      source,
      trace,
      dispatch: (id, p) => this.dispatchTraced(id, p, source, trace, newMsgId()),
      emit: (e) => this.bus.emit({ ...e, trace }),
    };
    try {
      const { streamId } = await cap.stream(payload, ctx);
      const durationMs = Date.now() - startTs;
      record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { ok: true, streamId }, durationMs, 'stream-start', startTs));
      return { msg_id: msgId, trace, result: { ok: true, data: { stream: true, streamId } } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTs;
      record(this.makeRecord(trace, msgId, capId, sourceKind, payload, { ok: false, error }, durationMs, 'stream-error', startTs));
      return { msg_id: msgId, trace, result: { ok: false, error } };
    }
  }

  /** 构造审计记录 */
  private makeRecord(
    trace: TraceId, msgId: MsgId, capId: CapabilityId, source: string,
    params: Value, result: Value, durationMs: number, kind: string, ts: number,
  ): AuditRecord {
    return { trace, msgId, cap: capId, source, params, result, durationMs, kind, ts };
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
