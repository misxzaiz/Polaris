import type { LogEntryType } from '../types/scheduler';

/** 生成唯一 ID */
export function generateLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 解析 AI 事件为日志 */
export function parseEventToLog(event: Record<string, unknown>): {
  type: LogEntryType;
  content: string;
  metadata?: Record<string, unknown>;
} | null {
  const type = event.type as string | undefined;

  switch (type) {
    case 'session_start':
      return { type: 'session_start', content: '开始执行任务...' };

    case 'progress':
      return { type: 'message', content: (event.message as string) || '处理中...' };

    case 'thinking':
      return { type: 'thinking', content: (event.content as string) || '思考中...' };

    case 'assistant_message':
    case 'assistant':
      return { type: 'message', content: (event.content as string) || '' };

    case 'tool_call_start': {
      const toolName = (event.tool as string) || (event.toolName as string) || (event.name as string) || 'unknown';
      return {
        type: 'tool_call_start',
        content: `调用工具: ${toolName}`,
        metadata: { toolName, args: event.args },
      };
    }

    case 'tool_call_end': {
      const endToolName = (event.tool as string) || (event.toolName as string) || (event.name as string) || 'unknown';
      const success = event.success !== false;
      return {
        type: 'tool_call_end',
        content: success ? `${endToolName} 完成` : `${endToolName} 失败`,
        metadata: { toolName: endToolName, success },
      };
    }

    case 'session_end': {
      const reason = event.reason as string | undefined;
      if (reason === 'error' || reason === 'failed') {
        return {
          type: 'error',
          content: (event.error as string) || '执行失败',
        };
      }
      return { type: 'session_end', content: '任务执行完成', metadata: { success: true } };
    }

    case 'error':
      return { type: 'error', content: (event.error as string) || (event.message as string) || '未知错误' };

    default:
      return null;
  }
}
