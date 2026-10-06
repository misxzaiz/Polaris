/**
 * cap.bash — shell 任务能力(后台任务 + 轮询)
 *
 * 动作:
 * - run: 启动命令(默认异步,返回 taskId; async=false 同步等完成)
 * - status: 查任务状态
 * - log: 拿输出
 * - wait: 等待完成(可中断)
 * - kill: 终止任务
 *
 * 设计: 任务宿主级,跨会话可查(对齐 Polaris cap.bash 理念)
 */

import { spawn } from 'node:child_process';
import type { Capability, CallContext, Value } from '../contracts.ts';

interface Task {
  id: string;
  cmd: string;
  status: 'running' | 'done' | 'killed' | 'error';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  proc: ReturnType<typeof spawn> | null;
  chunks: Array<{ ts: number; stream: 'stdout' | 'stderr'; data: string }>;
}

const tasks = new Map<string, Task>();

export const bashCap: Capability = {
  id: 'cap.bash',
  description: 'Shell command runner. Actions: run/status/log/wait/kill. Default async (returns taskId).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['run', 'status', 'log', 'wait', 'kill', 'list'] },
      command: { type: 'string', description: 'Command to run (for action=run)' },
      taskId: { type: 'string', description: 'Task id (for status/log/wait/kill)' },
      async: { type: 'boolean', description: 'Default true. False = wait for completion' },
      cwd: { type: 'string' },
      timeout: { type: 'number', description: 'ms, only for async=false' },
    },
    required: ['action'],
  },
  async invoke(params: Value, ctx: CallContext) {
    const p = params as {
      action: 'run' | 'status' | 'log' | 'wait' | 'kill' | 'list';
      command?: string;
      taskId?: string;
      async?: boolean;
      cwd?: string;
      timeout?: number;
    };

    switch (p.action) {
      case 'run':
        return runCommand(p, ctx);
      case 'status':
        return taskStatus(p.taskId);
      case 'log':
        return taskLog(p.taskId);
      case 'wait':
        return await taskWait(p.taskId, p.timeout ?? 30000);
      case 'kill':
        return taskKill(p.taskId);
      case 'list':
        return {
          tasks: [...tasks.values()].map(t => ({
            id: t.id, cmd: t.cmd, status: t.status,
            exitCode: t.exitCode, startedAt: t.startedAt, endedAt: t.endedAt,
          })),
        };
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

function runCommand(
  p: { command?: string; async?: boolean; cwd?: string; timeout?: number },
  ctx: CallContext,
): Value {
  if (!p.command) throw new Error('command required for run');
  const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const isAsync = p.async !== false;

  const task: Task = {
    id: taskId, cmd: p.command, status: 'running',
    stdout: '', stderr: '', exitCode: null,
    startedAt: Date.now(), endedAt: null,
    proc: null, chunks: [],
  };
  tasks.set(taskId, task);

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const proc = spawn(shell, [shellFlag, p.command], {
    cwd: p.cwd,
    env: process.env,
    windowsHide: true,
  });
  task.proc = proc;

  proc.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    task.stdout += s;
    task.chunks.push({ ts: Date.now(), stream: 'stdout', data: s });
    ctx.emit({
      type: 'bash.chunk', stream_id: taskId, data: { stream: 'stdout', data: s },
      ts: Date.now(),
    });
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    task.stderr += s;
    task.chunks.push({ ts: Date.now(), stream: 'stderr', data: s });
    ctx.emit({
      type: 'bash.chunk', stream_id: taskId, data: { stream: 'stderr', data: s },
      ts: Date.now(),
    });
  });
  proc.on('close', (code: number) => {
    task.exitCode = code;
    task.status = code === 0 ? 'done' : 'error';
    task.endedAt = Date.now();
    task.proc = null;
    ctx.emit({
      type: 'bash.end', stream_id: taskId,
      data: { exitCode: code, status: task.status },
      ts: Date.now(),
    });
  });
  proc.on('error', (err: Error) => {
    task.status = 'error';
    task.stderr += err.message;
    task.endedAt = Date.now();
    task.proc = null;
    ctx.emit({
      type: 'bash.end', stream_id: taskId,
      data: { error: err.message, status: 'error' },
      ts: Date.now(),
    });
  });

  if (isAsync) {
    return { taskId, async: true, status: 'running' };
  }

  // 同步模式: 等待完成
  return new Promise((resolve) => {
    const timeout = p.timeout ?? 30000;
    const timer = setTimeout(() => {
      if (task.status === 'running') {
        proc.kill('SIGTERM');
        task.status = 'killed';
      }
    }, timeout);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve({
        taskId, status: task.status, exitCode: task.exitCode,
        stdout: task.stdout, stderr: task.stderr,
      });
    });
  });
}

function taskStatus(taskId?: string): Value {
  if (!taskId) throw new Error('taskId required');
  const t = tasks.get(taskId);
  if (!t) return { ok: false, error: 'task not found' };
  return {
    taskId: t.id, cmd: t.cmd, status: t.status,
    exitCode: t.exitCode, startedAt: t.startedAt, endedAt: t.endedAt,
    stdoutLen: t.stdout.length, stderrLen: t.stderr.length,
  };
}

function taskLog(taskId?: string): Value {
  if (!taskId) throw new Error('taskId required');
  const t = tasks.get(taskId);
  if (!t) return { ok: false, error: 'task not found' };
  return {
    taskId: t.id, stdout: t.stdout, stderr: t.stderr,
    chunks: t.chunks, status: t.status, exitCode: t.exitCode,
  };
}

function taskWait(taskId?: string, timeout = 30000): Promise<Value> {
  if (!taskId) throw new Error('taskId required');
  const t = tasks.get(taskId);
  if (!t) return Promise.resolve({ ok: false, error: 'task not found' });
  if (t.status !== 'running') {
    return Promise.resolve({
      taskId: t.id, status: t.status, exitCode: t.exitCode,
      stdout: t.stdout, stderr: t.stderr,
    });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'wait timeout' }), timeout);
    const check = () => {
      if (t.status !== 'running') {
        clearTimeout(timer);
        resolve({
          taskId: t.id, status: t.status, exitCode: t.exitCode,
          stdout: t.stdout, stderr: t.stderr,
        });
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

function taskKill(taskId?: string): Value {
  if (!taskId) throw new Error('taskId required');
  const t = tasks.get(taskId);
  if (!t) return { ok: false, error: 'task not found' };
  if (t.proc && t.status === 'running') {
    try { t.proc.kill('SIGTERM'); } catch { /* ignore */ }
    t.status = 'killed';
    t.endedAt = Date.now();
  }
  return { ok: true, taskId: t.id, status: t.status };
}
