/**
 * 订阅指定会话 store 的 hook
 *
 * 关键：当 store 存在时，订阅 store 本身而不是 sessionStoreManager。
 * SessionMessagesView / SessionOperationBar / 灵动岛 per-session 组件共用，
 * 多窗口各自独立。
 */

import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import type { ConversationStoreInstance, ConversationState } from '@/stores/conversationStore/types';

export function useSessionStoreSubscription<T>(
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