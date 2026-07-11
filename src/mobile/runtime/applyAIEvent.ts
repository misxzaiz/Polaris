/**
 * 纯函数：将 AIEvent 归约到 SessionRuntimeState
 *
 * 可单测、无副作用。Runtime store 在拿到路由目标后调用本函数。
 */

import type { AIEvent } from '@/ai-runtime/event';
import type { ChatMessage } from '@/types';
import type { PartialBuffer, SessionRuntimeState } from './types';
import { deriveStatus } from './types';

export interface ApplyAIEventOptions {
  /** result 时是否标记需要刷新历史（由 Runtime 异步执行） */
  markHistoryRefresh?: boolean;
}

export interface ApplyAIEventResult {
  state: SessionRuntimeState;
  /** 是否需要拉取完整历史（result 后） */
  shouldRefreshHistory: boolean;
}

function withStatus(state: SessionRuntimeState): SessionRuntimeState {
  return {
    ...state,
    status: deriveStatus(state),
    lastEventAt: Date.now(),
  };
}

function appendAssistant(
  messages: ChatMessage[],
  partial: PartialBuffer,
): ChatMessage[] {
  return [
    ...messages,
    {
      id: partial.id,
      type: 'assistant',
      content: partial.content,
      blocks: [{ type: 'text', content: partial.content }],
      timestamp: new Date().toISOString(),
      isStreaming: true,
    },
  ];
}

function updateLastAssistant(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  const updated = [...messages];
  const lastIdx = updated.length - 1;
  if (lastIdx >= 0 && updated[lastIdx]?.type === 'assistant') {
    const last = updated[lastIdx];
    if (last.type === 'assistant') {
      updated[lastIdx] = {
        ...last,
        content,
        blocks: [{ type: 'text', content }],
        isStreaming: true,
      };
    }
  }
  return updated;
}

/**
 * 处理单个 AIEvent，返回新状态（不可变）。
 */
export function applyAIEvent(
  prev: SessionRuntimeState,
  event: AIEvent,
  _options?: ApplyAIEventOptions,
): ApplyAIEventResult {
  let shouldRefreshHistory = false;

  switch (event.type) {
    case 'assistant_message': {
      const content = event.content ?? '';
      const isDelta = event.isDelta === true;
      const current = prev.partial;

      if (isDelta && current) {
        const nextPartial = { ...current, content: current.content + content };
        return {
          state: withStatus({
            ...prev,
            partial: nextPartial,
            sending: true,
            error: null,
            messages: updateLastAssistant(prev.messages, nextPartial.content),
          }),
          shouldRefreshHistory: false,
        };
      }

      const partial: PartialBuffer = {
        id: `msg-${Date.now()}`,
        content,
      };
      return {
        state: withStatus({
          ...prev,
          partial,
          sending: true,
          error: null,
          messages: appendAssistant(prev.messages, partial),
        }),
        shouldRefreshHistory: false,
      };
    }

    case 'result': {
      shouldRefreshHistory = true;
      const messages = prev.messages.map((m) =>
        m.type === 'assistant' && m.isStreaming
          ? { ...m, isStreaming: false }
          : m,
      );
      return {
        state: withStatus({
          ...prev,
          messages,
          partial: null,
          sending: false,
          // result 不清 pendingCard：question 可能仍挂起
        }),
        shouldRefreshHistory,
      };
    }

    case 'error':
      return {
        state: withStatus({
          ...prev,
          error: event.error || '会话出错',
          sending: false,
          partial: null,
        }),
        shouldRefreshHistory: false,
      };

    case 'session_end':
      return {
        state: withStatus({
          ...prev,
          sending: false,
          partial: null,
          messages: prev.messages.map((m) =>
            m.type === 'assistant' && m.isStreaming
              ? { ...m, isStreaming: false }
              : m,
          ),
        }),
        shouldRefreshHistory: false,
      };

    case 'session_start':
      return {
        state: withStatus({
          ...prev,
          sending: true,
          error: null,
        }),
        shouldRefreshHistory: false,
      };

    case 'question':
      return {
        state: withStatus({
          ...prev,
          pendingCard: {
            type: 'question',
            questionId: event.questionId,
            questions: event.questions?.map((q) => ({
              question: q.question,
              options: q.options,
              multiSelect: q.multiSelect,
              allowCustomInput: q.allowCustomInput,
            })),
            header: event.header,
            options: event.options,
            multiSelect: event.multiSelect,
            allowCustomInput: event.allowCustomInput,
          },
          sending: true,
        }),
        shouldRefreshHistory: false,
      };

    case 'question_answered':
      return {
        state: withStatus({
          ...prev,
          pendingCard: null,
          sending: false,
        }),
        shouldRefreshHistory: false,
      };

    case 'plan_approval_request':
      return {
        state: withStatus({
          ...prev,
          pendingCard: {
            type: 'plan_approval_request',
            planId: event.planId,
            message: event.message,
          },
          sending: true,
        }),
        shouldRefreshHistory: false,
      };

    case 'plan_approval_result':
    case 'plan_end':
      return {
        state: withStatus({
          ...prev,
          pendingCard: null,
          sending: false,
        }),
        shouldRefreshHistory: false,
      };

    case 'permission_request':
      return {
        state: withStatus({
          ...prev,
          pendingCard: {
            type: 'permission_request',
            toolName: event.denials?.[0]?.toolName,
            toolUseId: event.denials?.[0]?.toolUseId,
            extra:
              event.denials?.[0]?.reason
              ?? (event.denials?.[0]?.toolInput
                ? JSON.stringify(event.denials[0].toolInput)
                : ''),
          },
          sending: true,
        }),
        shouldRefreshHistory: false,
      };

    default:
      // token / thinking / tool_call_* 等 Phase 1 不渲染，但标记活跃
      if (prev.sending || prev.partial) {
        return {
          state: withStatus({ ...prev, lastEventAt: Date.now() }),
          shouldRefreshHistory: false,
        };
      }
      return { state: prev, shouldRefreshHistory: false };
  }
}
