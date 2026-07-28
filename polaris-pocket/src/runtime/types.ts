/**
 * Pocket 桌面会话运行时类型
 *
 * 从 @/ai-runtime/event.ts 和 @/mobile/runtime/types.ts 精简，
 * 只保留 Pocket 实际需要处理的 WS 事件类型。
 */

// ============================================================================
// AIEvent 子集（仅 Pocket 消费的类型）
// ============================================================================

export interface AssistantMessageEvent {
  type: 'assistant_message';
  sessionId: string;
  content: string;
  isDelta: boolean;
}

export interface ResultEvent {
  type: 'result';
  sessionId: string;
  output: unknown;
}

export interface ErrorEvent {
  type: 'error';
  sessionId: string;
  error: string;
  code?: string;
}

export interface SessionStartEvent {
  type: 'session_start';
  sessionId: string;
}

export interface SessionEndEvent {
  type: 'session_end';
  sessionId: string;
  reason?: 'completed' | 'aborted' | 'error';
}

export interface QuestionOption {
  value: string;
  label?: string;
}

export interface QuestionItemData {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustomInput?: boolean;
}

export interface QuestionEvent {
  type: 'question';
  sessionId: string;
  questionId: string;
  questions?: QuestionItemData[];
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustomInput?: boolean;
}

export interface QuestionAnsweredEvent {
  type: 'question_answered';
  sessionId: string;
  questionId: string;
  declined?: boolean;
}

export interface PlanApprovalRequestEvent {
  type: 'plan_approval_request';
  sessionId: string;
  planId: string;
  message?: string;
}

export interface PlanApprovalResultEvent {
  type: 'plan_approval_result';
  sessionId: string;
  planId: string;
  approved: boolean;
}

export interface PlanEndEvent {
  type: 'plan_end';
  sessionId: string;
  planId: string;
  status: 'completed' | 'canceled' | 'rejected';
}

export interface PermissionDenial {
  toolName: string;
  reason: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}

export interface PermissionRequestEvent {
  type: 'permission_request';
  sessionId: string;
  denials: PermissionDenial[];
}

export type PocketAIEvent =
  | AssistantMessageEvent
  | ResultEvent
  | ErrorEvent
  | SessionStartEvent
  | SessionEndEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | PlanApprovalRequestEvent
  | PlanApprovalResultEvent
  | PlanEndEvent
  | PermissionRequestEvent;

export function isPocketAIEvent(value: unknown): value is PocketAIEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, string>;
  return typeof event.type === 'string' && !!event.type;
}

// ============================================================================
// 会话运行时状态
// ============================================================================

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface PartialBuffer {
  id: string;
  content: string;
}

export interface PendingCard {
  type: 'question' | 'plan_approval_request' | 'permission_request';
  questionId?: string;
  planId?: string;
  questions?: QuestionItemData[];
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  allowCustomInput?: boolean;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  extra?: string;
}

export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  blocks?: Array<{ type: string; content: string }>;
  isStreaming?: boolean;
}

export interface SessionRuntimeState {
  id: string;
  title: string;
  engineId: string;
  projectPath?: string;
  messages: ChatMessage[];
  input: string;
  sending: boolean;
  status: SessionStatus;
  error: string | null;
  pendingCard: PendingCard | null;
  partial: PartialBuffer | null;
  lastAccessedAt: number;
  lastEventAt: number;
}

export const MAX_POCKET_TABS = 6;

export function createEmptySessionState(meta: {
  id: string;
  title: string;
  engineId: string;
  projectPath?: string;
  messages?: ChatMessage[];
}): SessionRuntimeState {
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

export function deriveStatus(state: Pick<SessionRuntimeState, 'pendingCard' | 'sending' | 'error'>): SessionStatus {
  if (state.pendingCard) return 'waiting';
  if (state.error) return 'error';
  if (state.sending) return 'running';
  return 'idle';
}

export function toPocketContextId(sessionId: string): string {
  return `pocket-${sessionId}`;
}

export function fromPocketContextId(contextId: string | undefined | null): string | null {
  if (!contextId || !contextId.startsWith('pocket-')) return null;
  return contextId.slice('pocket-'.length) || null;
}