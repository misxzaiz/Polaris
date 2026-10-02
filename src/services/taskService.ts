/**
 * 后台任务服务 — bash(background:true) 的管理面板数据源
 *
 * 后端 TaskRegistry 统一管理：task_list / task_kill / task_read_log 三个 Tauri command。
 * 本服务封装轮询与类型，供 BackgroundTasksPanel 消费。
 */

import { invoke } from '@/services/transport'

/** 与 Rust TaskInfo 对齐（camelCase） */
export interface BackgroundTaskInfo {
  taskId: string
  sessionId: string
  command: string
  pid: number
  status: 'running' | 'done' | 'failed' | 'killed' | 'timeout'
  startedAtMs: number
  exitCode?: number | null
  endedAtMs?: number | null
  logPath: string
  logTail: string
  elapsedMs: number
}

export const taskList = (sessionId?: string, status?: string): Promise<BackgroundTaskInfo[]> =>
  invoke<BackgroundTaskInfo[]>('task_list', { sessionId, status })

export const taskKill = (taskId: string): Promise<boolean> =>
  invoke<boolean>('task_kill', { taskId })

export const taskReadLog = (taskId: string, maxLines?: number): Promise<string> =>
  invoke<string>('task_read_log', { taskId, maxLines })
