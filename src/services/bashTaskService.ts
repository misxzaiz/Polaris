/**
 * cap.bash 总线能力（宿主级 shell 命令执行，经 router_dispatch 统一转发）
 *
 * 提供 run / status / log / wait / kill / list 六动作的前端封装，
 * 供 BashTaskPanel（任务管理面板）与聊天工具块（taskId 关联）使用。
 */

import { invoke } from '@/services/transport';

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface BashDispatchResponse {
  msgId: string;
  ok: boolean;
  result: unknown;
  error: string | null;
  trace: string;
}

/** cap.bash 任务状态 */
export type BashTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timeout';

/** cap.bash 任务条目（list 返回） */
export interface BashTaskItem {
  taskId: string;
  status: BashTaskStatus;
  command: string;
  pid: number;
  sessionId?: string | null;
  onSessionEnd: string;
  startedAt: number;
  finishedAt?: number | null;
  logLines: number;
}

/** cap.bash 任务详情（status/log 返回的公共字段） */
export interface BashTaskDetail {
  taskId: string;
  status: BashTaskStatus;
  pid?: number;
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number | null;
}

/** log 返回 */
export interface BashTaskLog {
  taskId: string;
  offset: number;
  total: number;
  lines: string[];
}

/** 经统一总线调用 cap.bash */
async function bashDispatch<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await invoke<BashDispatchResponse>('router_dispatch', {
    req: { target: 'cap.bash', payload: { action, ...payload } },
  });
  if (!res.ok) {
    throw new Error(res.error || ('cap.bash ' + action + ' 失败'));
  }
  return res.result as T;
}

/** 列出任务（可按 sessionId / status 过滤） */
export async function bashList(params: { sessionId?: string; status?: BashTaskStatus } = {}): Promise<BashTaskItem[]> {
  const res = await bashDispatch<{ tasks: BashTaskItem[] }>('list', params);
  return res.tasks;
}

/** 查询单个任务状态 */
export async function bashStatus(taskId: string): Promise<BashTaskDetail> {
  return bashDispatch<BashTaskDetail>('status', { taskId });
}

/** 读取任务日志（offset 分页） */
export async function bashLog(taskId: string, offset = 0, limit = 0): Promise<BashTaskLog> {
  return bashDispatch<BashTaskLog>('log', { taskId, offset, limit });
}

/** 等待任务完成（timeoutMs 内阻塞轮询；超时返回 running） */
export async function bashWait(taskId: string, timeoutMs = 30_000): Promise<BashTaskDetail> {
  return bashDispatch<BashTaskDetail>('wait', { taskId, timeoutMs });
}

/** 终止任务（Windows 杀进程树） */
export async function bashKill(taskId: string): Promise<{ taskId: string; killed: boolean; status: BashTaskStatus }> {
  return bashDispatch<{ taskId: string; killed: boolean; status: BashTaskStatus }>('kill', { taskId });
}

/** 启动后台任务（宿主级，跨会话存活） */
export async function bashRun(params: {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  async?: boolean;
  onSessionEnd?: 'keep' | 'kill';
}): Promise<{ taskId: string; pid: number; status: BashTaskStatus; exitCode?: number; output?: string }> {
  return bashDispatch<{ taskId: string; pid: number; status: BashTaskStatus; exitCode?: number; output?: string }>(
    'run',
    params,
  );
}
