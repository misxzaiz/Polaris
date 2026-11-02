/**
 * 应用自动更新（cap.app.update）前端服务
 *
 * 触发即自更新（plans/auto-update-plan.md）：run 触发后电脑端自动
 * 「检查 → 下载 → 安装 → 重启」，全程无二次确认；进度经
 * update.progress / update.completed 事件广播（Tauri emit + WS 双通道）。
 *
 * 仿 autolaunchService 范式：dispatch 走 router_dispatch（桌面 Bootstrap /
 * Web Remote 已认证），事件经现有事件监听通道订阅。
 */

import { invoke, listen } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('AppUpdateService')

/** cap.app.update status 返回 */
export interface AppUpdateStatus {
  currentVersion: string
  source: {
    sourceType: 'github' | 'local' | 'custom'
    repo: string
    localManifestPath?: string | null
    manifestUrl?: string | null
    checkOnStartup: boolean
  }
  latestVersion: string | null
  updateAvailable: boolean
}

/** update.progress / update.completed 事件载荷 */
export interface UpdateProgressEvent {
  stage: 'checking' | 'downloading' | 'installing' | 'completed'
  percent: number
  version?: string
}

export interface UpdateCompletedEvent {
  updated: boolean
  reason?: 'up-to-date' | 'no-update' | 'error'
  error?: string
  currentVersion?: string
}

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 经 RouterBus dispatch 调用 cap.app.update */
async function dispatchUpdate(action: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.app.update',
      payload: { action, ...extra },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.app.update ${action} 失败`)
  }
  return res.result || {}
}

/** 查询更新状态（当前版本 + 源配置回显；零网络，稳定快）。
 *  web 端或旧宿主（cap 不存在）dispatch 报错 → 兜底 unsupported=false。 */
export async function getUpdateStatus(): Promise<(AppUpdateStatus & { supported: boolean }) | { supported: false }> {
  try {
    const r = await dispatchUpdate('status')
    return {
      supported: true,
      currentVersion: (r.currentVersion as string) ?? 'unknown',
      source: (r.source as AppUpdateStatus['source']) ?? {
        sourceType: 'github',
        repo: 'misxzaiz/Polaris',
        checkOnStartup: false,
      },
      latestVersion: (r.latestVersion as string | null) ?? null,
      updateAvailable: r.updateAvailable === true,
    }
  } catch (e) {
    log.debug('cap.app.update status 不可用（web 端或旧宿主）', { error: String(e) })
    return { supported: false }
  }
}

/** 触发自更新（触发即跑到底，无二次确认）。宿主重启后本调用方连接断开属预期。 */
export async function runAutoUpdate(force = false): Promise<{ started: boolean }> {
  const r = await dispatchUpdate('run', { force })
  return { started: r.started === true }
}

/** 订阅更新进度事件（返回退订函数） */
export function listenUpdateProgress(handler: (p: UpdateProgressEvent) => void): Promise<() => void> {
  return listen<UpdateProgressEvent>('update.progress', (p) => {
    if (isUpdateProgressEvent(p)) handler(p)
  })
}

/** 订阅更新完成事件（返回退订函数） */
export function listenUpdateCompleted(handler: (p: UpdateCompletedEvent) => void): Promise<() => void> {
  return listen<UpdateCompletedEvent>('update.completed', (p) => {
    if (isUpdateCompletedEvent(p)) handler(p)
  })
}

/** 订阅更新事件（Tauri listen / Web WS 由各自通道注册；这里只做载荷类型守卫） */
export function isUpdateProgressEvent(payload: unknown): payload is UpdateProgressEvent {
  const p = payload as UpdateProgressEvent
  return typeof p?.stage === 'string' && typeof p?.percent === 'number'
}

export function isUpdateCompletedEvent(payload: unknown): payload is UpdateCompletedEvent {
  const p = payload as UpdateCompletedEvent
  return typeof p?.updated === 'boolean'
}
