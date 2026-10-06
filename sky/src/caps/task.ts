/**
 * cap.task — 任务管理能力(复用 bash 任务系统)
 *
 * 动作: list/get/kill/wait/clear
 * 任务来源: cap.bash run 启动的后台 shell 任务
 * 让 AI 能查/管理正在运行的任务(跨会话)
 */

import type { Capability, Value } from '../contracts.ts';

// 复用 bash.ts 内部 tasks map (通过 cap.bash action=list 调用)
export const taskCap: Capability = {
  id: 'cap.task',
  description: 'Task manager. Actions: list/get/kill/wait/clear. Tasks from cap.bash.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'kill', 'wait', 'clear'] },
      taskId: { type: 'string' },
      timeout: { type: 'number', description: 'ms, for wait' },
    },
    required: ['action'],
  },
  async invoke(params: Value, ctx) {
    const p = params as {
      action: 'list' | 'get' | 'kill' | 'wait' | 'clear';
      taskId?: string;
      timeout?: number;
    };
    // 复用 cap.bash 的 status/log/wait/kill/list
    switch (p.action) {
      case 'list': {
        const r = await ctx.dispatch('cap.bash', { action: 'list' });
        return r.result;
      }
      case 'get': {
        if (!p.taskId) throw new Error('taskId required');
        const r = await ctx.dispatch('cap.bash', { action: 'status', taskId: p.taskId });
        return r.result;
      }
      case 'kill': {
        if (!p.taskId) throw new Error('taskId required');
        const r = await ctx.dispatch('cap.bash', { action: 'kill', taskId: p.taskId });
        return r.result;
      }
      case 'wait': {
        if (!p.taskId) throw new Error('taskId required');
        const r = await ctx.dispatch('cap.bash', { action: 'wait', taskId: p.taskId, timeout: p.timeout ?? 30000 });
        return r.result;
      }
      case 'clear': {
        // 清理已完成任务: list 后过滤已结束的
        const r = await ctx.dispatch('cap.bash', { action: 'list' });
        if (!r.result.ok) return r.result;
        const data = r.result.data as { tasks: Array<{ id: string; status: string }> };
        const active = (data.tasks || []).filter(t => t.status === 'running');
        return { ok: true, cleared: (data.tasks?.length ?? 0) - active.length, remaining: active.length };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
