/**
 * 订阅事件处理器 Hook
 *
 * 监听 scheduler-subscription contextId 的 AI 事件，
 * 将事件转换为日志条目显示在订阅面板中
 */

import { useEffect, useRef } from 'react';
import { useSchedulerStore } from '../stores';
import { getEventRouter } from '../services/eventRouter';
import { isAIEvent } from '../ai-runtime';
import type { AIEvent } from '../ai-runtime';
import { createLogger } from '../utils/logger';

const log = createLogger('useSubscriptionEventHandler');

/** 订阅 contextId */
const SUBSCRIPTION_CONTEXT_ID = 'scheduler-subscription';

/**
 * 订阅事件处理器 Hook
 *
 * 注册 scheduler-subscription contextId 的事件处理器，
 * 将 AI 事件转换为日志并显示在订阅面板中
 */
export function useSubscriptionEventHandler() {
  const cleanupRef = useRef<(() => void) | null>(null);
  const {
    addSubscriptionLog,
    updateSubscriptionStatus,
  } = useSchedulerStore();

  useEffect(() => {
    const router = getEventRouter();

    // 初始化路由器
    router.initialize().then(() => {
      log.info('注册订阅事件处理器', { contextId: SUBSCRIPTION_CONTEXT_ID });

      // 注册订阅专用的事件处理器
      const unregister = router.register(SUBSCRIPTION_CONTEXT_ID, (payload: unknown) => {
        try {
          if (!isAIEvent(payload)) {
            log.warn('收到非 AIEvent 类型的事件', { payload });
            return;
          }

          const aiEvent = payload as AIEvent;
          log.debug('收到订阅事件', { type: aiEvent.type });

          // 获取当前活跃的订阅会话
          const activeSessionId = useSchedulerStore.getState().activeSubscriptionId;
          if (!activeSessionId) {
            log.warn('没有活跃的订阅会话，忽略事件');
            return;
          }

          // 根据事件类型添加日志
          handleAIEvent(aiEvent, activeSessionId, addSubscriptionLog, updateSubscriptionStatus);
        } catch (e) {
          log.error('处理订阅事件失败', e as Error);
        }
      });

      cleanupRef.current = unregister;
    });

    return () => {
      if (cleanupRef.current) {
        log.info('清理订阅事件处理器');
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [addSubscriptionLog, updateSubscriptionStatus]);
}

/**
 * 处理 AI 事件，转换为日志条目
 */
function handleAIEvent(
  event: AIEvent,
  taskId: string,
  addLog: (taskId: string, entry: {
    type: 'info' | 'tool' | 'thinking' | 'result' | 'error' | 'warning';
    content: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }) => void,
  updateStatus: (taskId: string, status: 'running' | 'completed' | 'failed' | 'cancelled') => void
) {
  switch (event.type) {
    case 'session_start':
      addLog(taskId, {
        type: 'info',
        content: '任务开始执行...',
      });
      break;

    case 'assistant_message':
      // 处理助手消息（文本内容）
      if (event.content) {
        addLog(taskId, {
          type: 'result',
          content: event.content.slice(0, 500), // 限制长度
        });
      }
      break;

    case 'tool_call_start':
      // 工具调用开始
      addLog(taskId, {
        type: 'tool',
        content: `调用工具: ${event.tool || 'unknown'}`,
        toolName: event.tool,
        toolInput: event.args,
      });
      break;

    case 'tool_call_end':
      // 工具调用结束
      {
        const toolNameEnd = event.tool || 'unknown';
        addLog(taskId, {
          type: event.success ? 'result' : 'error',
          content: event.success
            ? `${toolNameEnd} 完成`
            : `${toolNameEnd} 失败`,
          toolName: toolNameEnd,
        });
      }
      break;

    case 'thinking':
      // 思考过程
      if (event.content) {
        addLog(taskId, {
          type: 'thinking',
          content: event.content.slice(0, 300), // 限制长度
        });
      }
      break;

    case 'progress':
      // 进度消息
      if (event.message) {
        addLog(taskId, {
          type: 'info',
          content: event.message,
        });
      }
      break;

    case 'error':
      // 错误
      addLog(taskId, {
        type: 'error',
        content: event.error || '发生错误',
      });
      break;

    case 'session_end':
      // 会话结束
      updateStatus(taskId, 'completed');
      addLog(taskId, {
        type: 'info',
        content: '任务执行完成',
      });
      break;

    default:
      // 忽略其他事件类型
      break;
  }
}

export default useSubscriptionEventHandler;
