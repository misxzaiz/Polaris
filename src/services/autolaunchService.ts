/**
 * 开机自启（OS 登录自启宿主）服务
 *
 * 意图（Config.autoLaunch）走设置保存流（SettingsPage buildPatch → cap.config
 * 顶层透传），本服务只与 cap.app.autolaunch 交互：
 * - status：supported 判定（隔离环境/web 端 → false，前端据此隐藏开关）+ OS 事实
 * - apply：读 config 意图 → ensure OS 事实（幂等；configStore 保存成功后调用）
 *
 * 见 plans/autostart-boot-launch-spec.md。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('AutolaunchService')

/** cap.app.autolaunch status 返回 */
export interface AutolaunchStatus {
  supported: boolean
  /** OS 启动项事实；supported=false 时为 null */
  enabled: boolean | null
  /** config 意图（autoLaunch） */
  configured: boolean
  reason?: string
}

/** cap.app.autolaunch apply 返回 */
export interface AutolaunchApplyResult {
  supported: boolean
  configured: boolean
  enabled: boolean
  /** 本次是否执行了纠偏写（false = 事实已与意图一致） */
  changed: boolean
}

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 经 RouterBus dispatch 调用 cap.app.autolaunch */
async function dispatchAutolaunch(action: string): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.app.autolaunch',
      payload: { action },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.app.autolaunch ${action} 失败`)
  }
  return res.result || {}
}

/** 查询 supported / OS 事实 / config 意图。
 *  web 端或旧宿主（cap 不存在）dispatch 报错 → 兜底 supported=false（开关隐藏）。 */
export async function getAutolaunchStatus(): Promise<AutolaunchStatus> {
  try {
    const r = await dispatchAutolaunch('status')
    return {
      supported: r.supported === true,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : null,
      configured: r.configured === true,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    }
  } catch (e) {
    log.debug('cap.app.autolaunch status 不可用（web 端或旧宿主），开关隐藏', { error: String(e) })
    return { supported: false, enabled: null, configured: false, reason: 'capability unavailable' }
  }
}

/** 对账：读 config 意图 → ensure OS 事实（幂等）。
 *  调用时机：configStore 保存 autoLaunch 成功后；失败不阻塞保存（启动 reconcile 兜底）。 */
export async function applyAutolaunch(): Promise<AutolaunchApplyResult> {
  const r = await dispatchAutolaunch('apply')
  return {
    supported: r.supported === true,
    configured: r.configured === true,
    enabled: r.enabled === true,
    changed: r.changed === true,
  }
}
