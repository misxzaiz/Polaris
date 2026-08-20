/**
 * 聊天相关 Hook
 */

import { useEffect } from 'react';
import type { AIEvent } from '@/ai-runtime';
import { getEventRouter } from '@/services/eventRouter';
import { createLogger } from '@/utils/logger';

const log = createLogger('ChatHook');

/** 监听聊天流式事件（后端已转换为 AIEvent） */
export function useChatEvent(
  onEvent: (event: AIEvent) => void,
  onError?: (error: string) => void
) {
  useEffect(() => {
    const router = getEventRouter();

    const setupListener = async () => {
      await router.initialize();

      const unregister = router.register('main', (payload: unknown) => {
        try {
          const aiEvent = payload as AIEvent;
          onEvent(aiEvent);
        } catch (e) {
          log.error('Failed to process AIEvent', e instanceof Error ? e : new Error(String(e)));
          onError?.(e instanceof Error ? e.message : '处理事件失败');
        }
      });

      return unregister;
    };

    let cleanup: (() => void) | null = null;
    setupListener().then((unregister) => {
      cleanup = unregister;
    });

    return () => {
      cleanup?.();
    };
  }, [onEvent, onError]);
}
