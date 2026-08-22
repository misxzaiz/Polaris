/**
 * useCompanionInit — AI 陪伴助手初始化与事件订阅
 *
 * 职责：
 * 1. 应用启动后初始化 companionStore
 * 2. 监听用户活动事件 → 记录到 memory（构建/编辑/会话）
 * 3. 启动定时触发轮询（每 30 分钟评估一次是否主动发起）
 * 4. 事件驱动触发（session_end / file 等）
 *    - session_end：记录活动 + 触发 evaluateTrigger({ eventSource: 'build_event' })
 *    - file:opened / editor:closed：记录活动
 *
 * 疲劳抑制层在 evaluateTrigger 内部，保证不打扰。
 */

import { useEffect, useRef } from 'react';
import { useCompanionStore } from '@/stores/companionStore';
import { getEventBus } from '@/ai-runtime/event-bus';
import { listen } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('useCompanionInit');

/** 评估间隔（30 分钟） */
const EVALUATE_INTERVAL_MS = 30 * 60 * 1000;

export function useCompanionInit() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // 1. 初始化 store
    const store = useCompanionStore.getState();
    store.initialize();
    log.info('Companion 初始化 hook 已挂载');

    // 2. 定时评估触发
    const intervalId = window.setInterval(() => {
      const s = useCompanionStore.getState();
      if (!s.enabled) return;
      void s.evaluateTrigger().catch(err => {
        log.warn('定时评估失败', { error: (err as Error).message });
      });
    }, EVALUATE_INTERVAL_MS);

    // 3. 订阅 AI 事件（session_end → 记录活动）
    const eventBus = getEventBus();
    const unsubSessionEnd = eventBus.on('session_end', () => {
      const s = useCompanionStore.getState();
      if (!s.enabled) return;
      s.recordActivity({ type: 'session', engineId: 'event' });

      // 会话结束 → 事件驱动触发评估（build_event 可豁免冷却/频率限制）
      setTimeout(() => {
        void s.evaluateTrigger({ eventSource: 'build_event' as const }).catch(() => {});
      }, 500);
    });

    // 4. 监听编辑器打开事件
    const unlistenFileOpenedPromise = listen<{ path: string; name: string }>('file:opened', (payload) => {
      const s = useCompanionStore.getState();
      if (!s.enabled) return;
      s.recordActivity({ type: 'edit', file: payload.path });
    });

    // 5. 监听编辑器关闭事件
    const unlistenEditorClosedPromise = listen('editor:closed', () => {
      const s = useCompanionStore.getState();
      if (!s.enabled) return;
      // editor 关闭算一次编辑活动（表示用户处理了一个文件）
      s.recordActivity({ type: 'edit', file: 'editor:closed' });
    });

    return () => {
      window.clearInterval(intervalId);
      unsubSessionEnd();
      unlistenFileOpenedPromise.then(u => u());
      unlistenEditorClosedPromise.then(u => u());
    };
  }, []);
}