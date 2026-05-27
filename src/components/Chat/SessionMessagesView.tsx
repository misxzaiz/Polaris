/**
 * SessionMessagesView - 多窗口专用的消息显示组件
 *
 * 直接使用 zustand store 订阅特定 session 的状态，避免复杂的 hook 链
 */

import { memo, useMemo, useRef, useCallback, useEffect, useSyncExternalStore } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { renderChatMessage } from './EnhancedChatMessages';
import type { MessageScrollActions } from './EnhancedChatMessages';
import type { ChatMessage, AssistantChatMessage } from '@/types/chat';
import type { ConversationStoreInstance, ConversationState } from '@/stores/conversationStore/types';

/** 空状态组件 */
const EmptyState = memo(function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-text-muted">
      <div className="text-center">
        <p className="text-sm">开始对话吧</p>
      </div>
    </div>
  );
});

interface SessionMessagesViewProps {
  sessionId: string;
}

/**
 * 直接订阅 session store 的 hook
 * 关键：当 store 存在时，订阅 store 本身而不是 sessionStoreManager
 */
function useSessionStoreSubscription<T>(
  sessionId: string,
  selector: (state: ConversationState) => T,
  defaultValue: T
): T {
  // 缓存 store 实例，避免频繁查找
  const storeRef = useRef<ConversationStoreInstance | null>(null);
  const cacheRef = useRef<T>(defaultValue);

  // 获取 store 实例
  const getStore = useCallback(() => {
    return sessionStoreManager.getState().stores.get(sessionId);
  }, [sessionId]);

  // 初始化/更新 store ref
  useEffect(() => {
    const store = getStore();
    if (store && storeRef.current !== store) {
      storeRef.current = store;
      cacheRef.current = defaultValue; // store 变化时重置缓存
    }
  }, [getStore, defaultValue]);

  // subscribe 函数：订阅正确的 store
  const subscribe = useCallback((onChange: () => void) => {
    const store = getStore();
    if (store) {
      // 直接订阅 session store
      return store.subscribe(onChange);
    } else {
      // store 不存在时，订阅 sessionStoreManager 等待 store 创建
      return sessionStoreManager.subscribe(onChange);
    }
  }, [getStore]);

  // getSnapshot：获取当前值
  const getSnapshot = useCallback(() => {
    const store = storeRef.current || getStore();
    if (!store) return defaultValue;

    const newValue = selector(store.getState());

    // 引用稳定性检查
    if (cacheRef.current === newValue) {
      return cacheRef.current;
    }

    cacheRef.current = newValue;
    return newValue;
  }, [getStore, selector, defaultValue]);

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const SessionMessagesView = memo(function SessionMessagesView({ sessionId }: SessionMessagesViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const autoScrollRef = useRef(true);

  // 直接订阅特定 session store 的状态
  const messages = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.messages, []),
    []
  );

  const currentMessage = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.currentMessage, []),
    null
  );

  const isStreaming = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.isStreaming, []),
    false
  );

  // 合并流式消息到消息列表
  const displayMessages = useMemo(() => {
    if (!currentMessage || !isStreaming) {
      return messages;
    }

    // 检查 currentMessage 是否已在 messages 中
    const existingIndex = messages.findIndex((m: ChatMessage) => m.id === currentMessage.id);

    if (existingIndex >= 0) {
      // 更新已存在的消息
      const updated: ChatMessage[] = [
        ...messages.slice(0, existingIndex),
        {
          ...messages[existingIndex],
          engineId: currentMessage.engineId,
          blocks: currentMessage.blocks,
          isStreaming: true,
        } as AssistantChatMessage,
        ...messages.slice(existingIndex + 1),
      ];
      return updated;
    } else {
      // 添加到末尾
      return [...messages, {
        id: currentMessage.id,
        type: 'assistant' as const,
        engineId: currentMessage.engineId,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
    }
  }, [messages, currentMessage, isStreaming]);

  const isEmpty = displayMessages.length === 0;

  // 自动滚动到底部
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    autoScrollRef.current = atBottom;
  }, []);

  // 滚动到指定消息
  const scrollToMessage = useCallback((index: number) => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);

  // 滚动到顶部
  const scrollToTop = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
  }, []);

  // 消息滚动操作集合
  const scrollActions = useMemo<MessageScrollActions>(() => ({
    scrollToMessage,
    scrollToTop,
    scrollToBottom,
  }), [scrollToMessage, scrollToTop, scrollToBottom]);

  // streaming 时自动滚动到底部
  useEffect(() => {
    if (isStreaming && autoScrollRef.current && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: displayMessages.length - 1,
        align: 'end',
        behavior: 'smooth',
      });
    }
  }, [isStreaming, displayMessages.length]);

  return (
    <div className="h-full w-full">
      {isEmpty ? (
        <EmptyState />
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          data={displayMessages}
          itemContent={(index, item) => {
            return renderChatMessage(item, index, scrollActions);
          }}
          components={{
            EmptyPlaceholder: () => null,
            Footer: () => <div style={{ height: '80px' }} />,
          }}
          followOutput={autoScrollRef.current ? (isStreaming ? true : 'smooth') : false}
          atBottomStateChange={handleAtBottomStateChange}
          atBottomThreshold={100}
          increaseViewportBy={{ top: 50, bottom: 100 }}
          initialTopMostItemIndex={displayMessages.length - 1}
        />
      )}
    </div>
  );
});
