/**
 * useMobileSession — 单个会话的响应式状态 hook
 *
 * 设计目标：
 * - 把 MobileChatSession 的本地 state（messages / sending / error / pendingCard / input）
 *   抽到 hook，便于多 Tab 切换时复用。
 * - 模块级 `sessionStateCache: Map<sessionId, SessionState>` 缓存状态：
 *   Tab 切换导致组件卸载时，状态保留在缓存中；重挂载时从缓存恢复。
 *   这样多个会话 Tab 之间切换不会丢失各自的对话流与输入草稿。
 *
 * 注意：WS 监听器仍由 MobileChatSession 在挂载时建立（见 useEffect），
 * 通过 hook 暴露的 setMessages / setSending 等 setter 写入缓存。
 * 这里不引入桌面端 sessionStoreManager / EventRouter 全局链路，
 * 保持移动端轻量、独立。
 */

import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '@/types';
import type { AIEvent } from '@/ai-runtime/event';

/** 当前待处理交互卡片 */
export interface PendingCard {
  type: 'question' | 'plan_approval_request' | 'permission_request';
  questionId?: string;
  planId?: string;
  questions?: Array<{ question: string; options: Array<{ value: string; label?: string }>; multiSelect?: boolean; allowCustomInput?: boolean }>;
  header?: string;
  options?: Array<{ value: string; label?: string }>;
  multiSelect?: boolean;
  allowCustomInput?: boolean;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  extra?: string;
}

/** 流式增量缓冲：assistant_message 增量片段累积，result 时落盘 */
export interface PartialBuffer {
  id: string;
  content: string;
}

/** 会话状态（持久化在模块缓存中，Tab 切换不丢） */
export interface SessionState {
  messages: ChatMessage[];
  input: string;
  sending: boolean;
  error: string | null;
  pendingCard: PendingCard | null;
  partial: PartialBuffer | null;
}

/** 模块级缓存：sessionId → SessionState */
const sessionStateCache = new Map<string, SessionState>();

/** 取缓存的初始状态，无则用默认值 */
function getInitial(sessionId: string, fallbackMessages: ChatMessage[]): SessionState {
  const cached = sessionStateCache.get(sessionId);
  if (cached) return cached;
  const fresh: SessionState = {
    messages: fallbackMessages,
    input: '',
    sending: false,
    error: null,
    pendingCard: null,
    partial: null,
  };
  sessionStateCache.set(sessionId, fresh);
  return fresh;
}

/**
 * @param sessionId 会话 ID（前端生成，作为缓存 key）
 * @param fallbackMessages 兜底历史消息（仅首次创建缓存时使用）
 */
export function useMobileSession(sessionId: string, fallbackMessages: ChatMessage[]) {
  const initial = getInitial(sessionId, fallbackMessages);

  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [input, setInput] = useState(initial.input);
  const [sending, setSending] = useState(initial.sending);
  const [error, setError] = useState<string | null>(initial.error);
  const [pendingCard, setPendingCard] = useState<PendingCard | null>(initial.pendingCard);

  // partial buffer 用 ref：不触发重渲染，通过 setMessages 显式刷新
  const partialRef = useRef<PartialBuffer | null>(initial.partial);

  /** 把当前所有响应式状态写回缓存（供 Tab 切换后恢复） */
  const persistToCache = useCallback(() => {
    sessionStateCache.set(sessionId, {
      messages,
      input,
      sending,
      error,
      pendingCard,
      partial: partialRef.current,
    });
  }, [sessionId, messages, input, sending, error, pendingCard]);

  /** 更新 partial buffer（同步 ref + 持久化） */
  const setPartial = useCallback((next: PartialBuffer | null) => {
    partialRef.current = next;
    persistToCache();
  }, [persistToCache]);

  /** 直接读取当前 partial（事件处理需要读取累积内容） */
  const getPartial = useCallback(() => partialRef.current, []);

  return {
    messages,
    input,
    sending,
    error,
    pendingCard,
    partialRef,
    setMessages,
    setInput,
    setSending,
    setError,
    setPendingCard,
    setPartial,
    getPartial,
    persistToCache,
  };
}

/**
 * 处理单个 AIEvent，更新会话状态。
 * 抽成纯函数便于测试与复用，调用方在 WS listen 回调里 dispatch。
 */
export function dispatchAIEvent(
  event: AIEvent,
  ctx: {
    sessionId: string;
    getPartial: () => PartialBuffer | null;
    setPartial: (next: PartialBuffer | null) => void;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setSending: (v: boolean) => void;
    setError: (v: string | null) => void;
    setPendingCard: (v: PendingCard | null) => void;
    onResult?: () => void; // result 事件触发后的回调（用于刷新历史）
  },
) {
  switch (event.type) {
    case 'assistant_message': {
      const content = event.content ?? '';
      const isDelta = event.isDelta === true;
      const current = ctx.getPartial();
      if (isDelta && current) {
        current.content += content;
        ctx.setPartial(current);
        ctx.setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.type === 'assistant') {
            updated[lastIdx] = { ...updated[lastIdx], content: current.content };
          }
          return updated;
        });
      } else {
        const partial = { id: `msg-${Date.now()}`, content };
        ctx.setPartial(partial);
        ctx.setMessages(prev => [
          ...prev,
          {
            id: partial.id,
            type: 'assistant',
            content: partial.content,
            blocks: [{ type: 'text', content }],
            timestamp: new Date().toISOString(),
          } as ChatMessage,
        ]);
      }
      break;
    }
    case 'result':
      ctx.setPartial(null);
      ctx.setSending(false);
      ctx.onResult?.();
      break;
    case 'error':
      ctx.setError(event.error || '会话出错');
      ctx.setSending(false);
      ctx.setPartial(null);
      break;
    case 'session_end':
      ctx.setSending(false);
      ctx.setPartial(null);
      break;
    case 'question':
      ctx.setPendingCard({
        type: 'question',
        questionId: event.questionId,
        questions: event.questions,
        header: event.header,
        options: event.options,
        multiSelect: event.multiSelect,
        allowCustomInput: event.allowCustomInput,
      });
      break;
    case 'question_answered':
      ctx.setPendingCard(null);
      ctx.setSending(false);
      break;
    case 'plan_approval_request':
      ctx.setPendingCard({
        type: 'plan_approval_request',
        planId: event.planId,
        message: event.message,
      });
      break;
    case 'plan_approval_result':
    case 'plan_end':
      ctx.setPendingCard(null);
      ctx.setSending(false);
      break;
    case 'permission_request':
      ctx.setPendingCard({
        type: 'permission_request',
        toolName: event.denials?.[0]?.toolName,
        toolUseId: event.denials?.[0]?.toolUseId,
        extra: event.denials?.[0]?.reason ?? (event.denials?.[0]?.toolInput ? JSON.stringify(event.denials[0].toolInput) : ''),
      });
      break;
    default:
      // token / thinking / tool_call_start 等实时事件暂不渲染
      break;
  }
}

/** 清理指定会话的缓存（会话被移出 Tab 条时调用） */
export function disposeSessionState(sessionId: string) {
  sessionStateCache.delete(sessionId);
}

/** 判断某会话是否已有缓存状态（用于 Tab 切换时区分"恢复"与"首次打开"） */
export function hasSessionState(sessionId: string): boolean {
  return sessionStateCache.has(sessionId);
}
