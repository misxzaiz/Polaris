/**
 * 移动端多会话 Runtime 类型
 *
 * 与桌面 sessionStoreManager 解耦，只保留 companion 所需字段。
 */

import type { ChatMessage, EngineId } from '@/types';

/** 会话运行状态（驱动 Tab 圆点 / Banner） */
export type MobileSessionStatus = 'idle' | 'running' | 'waiting' | 'error';

/** 当前待处理交互卡片 */
export interface PendingCard {
  type: 'question' | 'plan_approval_request' | 'permission_request';
  questionId?: string;
  planId?: string;
  questions?: Array<{
    question: string;
    options: Array<{ value: string; label?: string }>;
    multiSelect?: boolean;
    allowCustomInput?: boolean;
  }>;
  header?: string;
  options?: Array<{ value: string; label?: string }>;
  multiSelect?: boolean;
  allowCustomInput?: boolean;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  extra?: string;
}

/** 流式增量缓冲 */
export interface PartialBuffer {
  id: string;
  content: string;
}

/** 打开会话时的元信息（列表/历史加载结果） */
export interface MobileSessionMeta {
  id: string;
  title: string;
  engineId: EngineId;
  projectPath?: string;
  /** 首次打开时的历史消息；已存在 Runtime 时不会覆盖本地流 */
  messages?: ChatMessage[];
}

/** 单个会话的 Runtime 状态 */
export interface SessionRuntimeState {
  id: string;
  title: string;
  engineId: EngineId;
  projectPath?: string;
  messages: ChatMessage[];
  input: string;
  sending: boolean;
  status: MobileSessionStatus;
  error: string | null;
  pendingCard: PendingCard | null;
  partial: PartialBuffer | null;
  lastAccessedAt: number;
  lastEventAt: number;
}

export const MAX_MOBILE_TABS = 8;

export function createEmptySessionState(meta: MobileSessionMeta): SessionRuntimeState {
  const now = Date.now();
  return {
    id: meta.id,
    title: meta.title,
    engineId: meta.engineId,
    projectPath: meta.projectPath,
    messages: meta.messages ?? [],
    input: '',
    sending: false,
    status: 'idle',
    error: null,
    pendingCard: null,
    partial: null,
    lastAccessedAt: now,
    lastEventAt: now,
  };
}

/** contextId 约定：与发送端 options.contextId 一致 */
export function toMobileContextId(sessionId: string): string {
  return `mobile-${sessionId}`;
}

/** 从 contextId 解析前端 sessionId；非 mobile- 前缀返回 null */
export function fromMobileContextId(contextId: string | undefined | null): string | null {
  if (!contextId || !contextId.startsWith('mobile-')) return null;
  return contextId.slice('mobile-'.length) || null;
}

/** 根据 pending / sending / error 推导 status */
export function deriveStatus(state: Pick<SessionRuntimeState, 'pendingCard' | 'sending' | 'error'>): MobileSessionStatus {
  if (state.pendingCard) return 'waiting';
  if (state.error) return 'error';
  if (state.sending) return 'running';
  return 'idle';
}
