/**
 * Sky 契约层 — 语言无关的类型与接口定义
 *
 * 设计原则:
 * - 所有类型可直接 JSON 序列化,跨进程/WASM 边界无损失
 * - Capability 接口是 Core 唯一扩展点:一切能力(含 AI)都是 cap
 * - 调用统一走 dispatch(capId, params, ctx),无 invoke 旁路
 * - Source 由传输层注入,调用方不可自填(权限基石)
 *
 * 双面契约: TS interface = 宿主内契约(本预览版); 发行版可等价映射到 Rust trait / WIT
 */

// ============================================================================
// 基础类型(全部 JSON-serializable,无函数/循环引用/Symbol)
// ============================================================================

/** 能力唯一标识(路由键,非插件名). 形如 "cap.echo" "cap.bash" "cap.ai.chat" */
export type CapabilityId = string;

/** 插件唯一标识. 形如 "plugin.shell" "plugin.ai" */
export type PluginId = string;

/** 消息唯一标识(用于 trace 贯通) */
export type MsgId = string;

/** 追踪标识(全链路可追溯) */
export type TraceId = string;

/** 通用值类型 */
export type Value = unknown;

/** 能力句柄(u64 在 TS 用 number 上限 2^53; 跨 WASM 边界可传) */
export type CapabilityHandle = number;

// ============================================================================
// 来源与权限
// ============================================================================

/**
 * 请求来源(由传输层注入,调用方不可自填)
 *
 * 铁律: 无任何 Shell 请求路径获得 Source.Local.
 * - HTTP/WS adapter → Remote
 * - in-proc 内部 → Bootstrap
 * - 插件间调用 → Plugin(caller_id 由 ctx 注入)
 */
export type Source =
  | { kind: 'bootstrap' }
  | { kind: 'remote'; token: string }
  | { kind: 'plugin'; caller: PluginId };

/** 权限裁决结果 */
export type PermissionVerdict = 'allow' | 'deny' | 'prompt';

// ============================================================================
// 信封与事件
// ============================================================================

/** 统一信封(所有来源标准化成此结构) */
export interface Envelope {
  id: MsgId;
  source: Source;
  target: CapabilityId;
  payload: Value;
  trace: TraceId;
}

/** 路由回复 */
export interface Reply {
  msg_id: MsgId;
  result: { ok: true; data: Value } | { ok: false; error: string };
  trace: TraceId;
}

/** 流式应答(dispatch_stream 立即返回; 事件流经 EventBus 推送) */
export interface StreamAck {
  msg_id: MsgId;
  trace: TraceId;
  stream: true;
  stream_id: string;
}

// ============================================================================
// 调用上下文
// ============================================================================

/**
 * 调用上下文 — 由 Router 注入,能力不可自造
 *
 * capability 拿到 ctx 后可以:
 * - 经 ctx.dispatch 调用其他能力(权限沿袭)
 * - 经 ctx.emit 推送事件(给前端/订阅者)
 * - 读取 source 判断来源
 */
export interface CallContext {
  source: Source;
  trace: TraceId;
  /** 能力经此调用其他能力(权限 gate 同样适用) */
  dispatch: (capId: CapabilityId, payload: Value) => Promise<Reply>;
  /** 推送事件(流式/通知) */
  emit: (event: CapabilityEvent) => void;
}

// ============================================================================
// Capability trait(核心扩展点)
// ============================================================================

/**
 * Capability — 一切能力的统一接口
 *
 * 实现者只需要给 invoke. 流式能力额外实现 StreamingCapability.
 * metadata 描述能力,供 AI/前端发现.
 */
export interface Capability {
  readonly id: CapabilityId;
  readonly description: string;
  /** JSON Schema 描述 params,供 AI 工具调用与前端表单生成 */
  readonly inputSchema: Record<string, unknown>;
  invoke(params: Value, ctx: CallContext): Promise<Value>;
}

/**
 * 流式能力 — 长任务/AI 流式应答
 *
 * dispatch_stream 立即返回 StreamAck, 事件流经 ctx.emit 推送:
 * - stream.chunk { stream_id, chunk }
 * - stream.end   { stream_id, ok, error? }
 */
export interface StreamingCapability extends Capability {
  stream(params: Value, ctx: CallContext): Promise<{ streamId: string }>;
}

// ============================================================================
// 事件
// ============================================================================

/** 能力事件(经 EventBus 广播到所有订阅者) */
export interface CapabilityEvent {
  type: string;
  stream_id?: string;
  data?: Value;
  trace?: TraceId;
  ts: number;
}

// ============================================================================
// 权限策略
// ============================================================================

/**
 * PermissionPolicy — dispatch 唯一权限 gate
 *
 * 返回 'allow' | 'deny' | 'prompt'. prompt 推送到 Shell 等用户决定.
 */
export interface PermissionPolicy {
  check(capId: CapabilityId, source: Source): PermissionVerdict;
}

/** 默认策略: Bootstrap 全放行; Remote 默认 deny(显式 allow 列表); Plugin 沿袭 */
export class DefaultPermission implements PermissionPolicy {
  constructor(private remoteAllow: CapabilityId[] = []) {}
  check(capId: CapabilityId, source: Source): PermissionVerdict {
    switch (source.kind) {
      case 'bootstrap':
        return 'allow';
      case 'remote':
        return this.remoteAllow.includes(capId) ? 'allow' : 'deny';
      case 'plugin':
        return 'allow'; // 插件间调用沿袭(已在注册时校验)
    }
  }
}

// ============================================================================
// Interceptor — 拦截器(可插拔链, before/after 双向)
// ============================================================================

/**
 * Dispatch 上下文 — 拦截器与能力共享的状态对象
 *
 * 拦截器间经 ctx.state 横向通信(如 permission 写 verdict, audit 读 verdict).
 * result 在 after 链时填充(invoke 后).
 */
export interface DispatchContext {
  trace: TraceId;
  msgId: MsgId;
  capId: CapabilityId;
  params: Value;
  source: Source;
  /** 拦截器间共享状态 */
  state: Record<string, Value>;
  /** invoke 后的结果(after 链可用) */
  result?: { ok: true; data: Value } | { ok: false; error: string };
  startTs: number;
}

/** before 拦截器返回值 */
export type BeforeResult =
  | { kind: 'continue' }
  | { kind: 'continue'; params: Value }   // 改写参数后继续
  | { kind: 'deny'; error: string }       // 终止链, 返回错误
  | { kind: 'shortCircuit'; result: Value }; // 终止链, 直接返回此结果(如缓存命中)

/** after 拦截器返回值 */
export type AfterResult =
  | { kind: 'continue' }
  | { kind: 'continue'; result: { ok: true; data: Value } | { ok: false; error: string } };

/**
 * Interceptor — 拦截器接口
 *
 * 注册时指定 priority(before 升序, after 逆序). 同 priority 按注册顺序.
 * permission/audit/rateLimit 等都实现此接口, 经 cap.interceptor 注册.
 */
export interface Interceptor {
  name: string;
  priority: number; // 默认 100, 越小越先执行
  before?(ctx: DispatchContext): Promise<BeforeResult>;
  after?(ctx: DispatchContext): Promise<AfterResult>;
}
