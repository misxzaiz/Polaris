/**
 * 纯函数：将 PocketAIEvent 归约到 SessionRuntimeState
 *
 * 从 polaris-mobile applyAIEvent.ts 精简，适配 Pocket 类型。
 * 可单测、无副作用。
 */
import type { ChatMessage, PartialBuffer, SessionRuntimeState, PocketAIEvent } from './types';
import { deriveStatus } from './types';

export interface ApplyAIEventResult {
  state: SessionRuntimeState;
  shouldRefreshHistory: boolean;
}

function withStatus(state: SessionRuntimeState): SessionRuntimeState {
  return {
    ...state,
    status: deriveStatus(state),
    lastEventAt: Date.now(),
  };
}

function appendAssistant(messages: ChatMessage[], partial: PartialBuffer): ChatMessage[] {
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

function updateLastAssistant(messages: ChatMessage[], content: string): ChatMessage[] {
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

export function applyAIEvent(
  prev: SessionRuntimeState,
  event: PocketAIEvent,
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
        m.type === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m,
      );
      return {
        state: withStatus({
          ...prev,
          messages,
          partial: null,
          sending: false,
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
            m.type === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m,
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
              event.denials?.[0]?.reason ??
              (event.denials?.[0]?.toolInput
                ? JSON.stringify(event.denials[0].toolInput)
                : ''),
          },
          sending: true,
        }),
        shouldRefreshHistory: false,
      };

    default:
      if (prev.sending || prev.partial) {
        return {
          state: withStatus({ ...prev, lastEventAt: Date.now() }),
          shouldRefreshHistory: false,
        };
      }
      return { state: prev, shouldRefreshHistory: false };
  }
}