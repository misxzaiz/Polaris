/**
 * 插件用量观测服务（宿主自有，面板打开自动记账）
 *
 * 见 plans/plugin-usage-observation.md。宿主在权威观测点
 * （PluginPanelHost 面板模块加载成功）记录"用户打开了某插件的面板"，
 * 落 cap.kv 宿主自有键空间 `plugin.usage.<pluginId>`，供守望台（watchtower）
 * 等运营插件读时合并——宿主不写插件私有键（watchtower.usage.* 等）。
 *
 * 写入路径唯一：本服务 read-merge-write；经 router_dispatch → cap.kv 走统一
 * 权限 gate + 审计。面板打开是人工频率（每会话每面板首次挂载 1 次），毫秒级
 * 丢更新窗口只影响观测量计数，不引入锁或新能力。
 *
 * 失败语义：观测是纯增量信号，任何失败静默降级（debug 日志），绝不阻塞面板加载。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginUsageObserver')

/** 观测记录保留的日趋势窗口（天）；count/firstUsed/lastUsed 累计语义不随裁剪丢失 */
const OBSERVATION_DAY_WINDOW = 90

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** plugin.usage.<pluginId> 落盘形态 */
export interface HostUsageObservation {
  v: 1
  pluginId: string
  /** 累计面板打开次数（跨会话累计，days 裁剪不影响本字段） */
  count: number
  firstUsed: number
  lastUsed: number
  /** 'YYYY-MM-DD' → 当日打开次数（只保留近 OBSERVATION_DAY_WINDOW 天） */
  days: Record<string, number>
}

const PREFIX = 'plugin.usage.'

function observationKey(pluginId: string): string {
  return `${PREFIX}${pluginId}`
}

function dayString(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function capKv<T>(payload: Record<string, unknown>): Promise<T | null> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: { target: 'cap.kv', payload },
  })
  if (!res?.ok) throw new Error(res?.error || 'cap.kv dispatch 失败')
  return (res.result ?? null) as T | null
}

/**
 * 纯合并函数（单测覆盖）：把"一次面板打开"并入既有观测。
 * 90 天窗口裁剪只作用于 days；count/firstUsed/lastUsed 保持累计语义。
 */
export function mergePanelOpen(
  prev: HostUsageObservation | null,
  pluginId: string,
  now: number,
): HostUsageObservation {
  const base: HostUsageObservation = prev && prev.v === 1 && prev.pluginId === pluginId
    ? prev
    : { v: 1, pluginId, count: 0, firstUsed: now, lastUsed: now, days: {} }
  const day = dayString(now)
  const cutoff = now - OBSERVATION_DAY_WINDOW * 24 * 60 * 60 * 1000
  const days: Record<string, number> = {}
  for (const [d, n] of Object.entries(base.days)) {
    // 裁剪按"天字符串"比较（当日 0 点 >= cutoff），避免时区边界误删
    const [y, m, dd] = d.split('-').map(Number)
    if (new Date(y, m - 1, dd).getTime() >= cutoff) days[d] = n
  }
  days[day] = (days[day] ?? 0) + 1
  return {
    v: 1,
    pluginId,
    count: base.count + 1,
    firstUsed: Math.min(base.firstUsed || now, now),
    lastUsed: now,
    days,
  }
}

/**
 * 记一次插件面板打开（fire-and-forget）。失败静默：观测不成立时
 * 只影响统计完整性，不允许影响面板加载主链路。
 */
export function notePluginPanelOpen(pluginId: string): void {
  if (!pluginId) return
  const now = Date.now()
  void (async () => {
    try {
      const key = observationKey(pluginId)
      const prev = await capKv<{ value?: HostUsageObservation | null }>({
        action: 'get',
        key,
      })
      const next = mergePanelOpen(prev?.value ?? null, pluginId, now)
      await capKv({ action: 'set', key, value: next })
    } catch (e) {
      log.debug(`记录插件面板打开失败（静默降级）: ${pluginId} ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}
