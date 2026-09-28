/**
 * session-v2 统一导出
 *
 * 分层：
 * - core/：地基（MessageLog / SessionRegistry / StateAuthority 类型 + 验证实现）
 * - kernel/：内核接口（阶段 0：能力接口 + 可执行状态机）
 */

// ============================================================================
// core — 地基类型与验证实现
// ============================================================================

export type {
  MessageRole,
  MessageContent,
  MessageEntry,
  ReadOptions,
  MessageLogStorage,
  SessionRecord,
  SessionRegistry,
  SessionEventType,
  SessionEventEntry,
  SessionStatus,
  SessionEventLog,
  StateArbiter,
  ReconcileResult,
  LoadPhase,
  BeforeCreateSessionHook,
  BeforeAppendMessageHook,
  OnSessionStatusChangeHook,
  BeforeRequestStartHook,
  SessionPlugin,
  PluginContext,
  PluginHost,
} from './core/types'

export { InMemoryMessageLog } from './core/in-memory-log'
export { V2MessageLog } from './core/v2-message-log'
export { InMemorySessionEventLog, InMemoryStateArbiter } from './core/in-memory-state'
export { V2SessionEventLog, V2StateArbiter } from './core/v2-session-event-log'
export { reconcile } from './core/reconcile'
export { InMemoryPluginHost } from './core/plugin-host'

// ============================================================================
// kernel — 内核接口（阶段 0）
// ============================================================================

export type {
  MessageStateName,
  MessageStateTransition,
  SessionRuntimeState,
  SessionStateTransition,
  SyncState,
  ResyncStrategy,
  SendMessageInput,
  SendResult,
  ContinueOptions,
  SessionSnapshot,
  SessionSnapshotMetadata,
  SessionState,
  StateChangeHandler,
  KernelEvent,
} from './kernel/types'

export {
  MESSAGE_STATE_TRANSITIONS,
  SESSION_STATE_TRANSITIONS,
  MessageStateMachine,
  SessionStateMachine,
} from './kernel/types'

export type {
  MessageSendCapability,
  SessionLifecycleCapability,
  CreateSessionOptions,
  SessionHandle,
  StateQueryCapability,
  EventHandlingCapability,
  RecoveryCapability,
  ArbitrationCapability,
  SessionKernel,
} from './kernel/capabilities'

// ============================================================================
// kernel — 阶段 6：V2SessionKernel（后端权威，唯一实现）+ 注册中心
// 阶段 6：LegacySessionKernel 已彻底移除（文件删除），仅保留 V2。
// ============================================================================

export {
  V2SessionKernel,
  createV2SessionKernel,
} from './kernel/v2-kernel'
export type {
  V2SessionKernelDeps,
  V2HistoryServiceLike,
  V2StateQueryLike,
  V2EventDispatcherLike,
  V2SessionManagerLike,
  V2SnapshotSourceLike,
} from './kernel/v2-kernel'

export { getKernel, resetKernel } from './kernel/registry'
