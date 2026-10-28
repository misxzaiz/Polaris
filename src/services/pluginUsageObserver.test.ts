/**
 * pluginUsageObserver 纯合并逻辑单测（plans/plugin-usage-observation.md §4）
 *
 * IO（cap.kv dispatch）不在覆盖范围：观测失败静默降级是契约，
 * 这里只锁定 read-merge-write 的账目语义。
 */
import { describe, expect, it } from 'vitest'
import { mergePanelOpen, type HostUsageObservation } from './pluginUsageObserver'

const DAY = 24 * 60 * 60 * 1000
// 固定"今天"，避免用例随真实时钟漂移
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime() // 2026-10-29 12:00 本地

describe('mergePanelOpen', () => {
  it('首次观测：count=1，first/last=now，days 记当日', () => {
    const obs = mergePanelOpen(null, 'lingxi', NOW)
    expect(obs).toEqual({
      v: 1,
      pluginId: 'lingxi',
      count: 1,
      firstUsed: NOW,
      lastUsed: NOW,
      days: { '2026-10-29': 1 },
    })
  })

  it('同日多次打开：count 累加、days[当日] 累加', () => {
    let obs = mergePanelOpen(null, 'lingxi', NOW)
    obs = mergePanelOpen(obs, 'lingxi', NOW + 60_000)
    expect(obs.count).toBe(2)
    expect(obs.days['2026-10-29']).toBe(2)
    expect(obs.firstUsed).toBe(NOW)
    expect(obs.lastUsed).toBe(NOW + 60_000)
  })

  it('跨日打开：各自记账，firstUsed 保留最早', () => {
    let obs = mergePanelOpen(null, 'amber', NOW)
    obs = mergePanelOpen(obs, 'amber', NOW + DAY)
    expect(obs.days['2026-10-29']).toBe(1)
    expect(obs.days['2026-10-30']).toBe(1)
    expect(obs.firstUsed).toBe(NOW)
  })

  it('90 天窗口裁剪：超窗 days 删除，count/firstUsed 保留累计语义', () => {
    const oldDay = '2026-05-01'
    const prev: HostUsageObservation = {
      v: 1,
      pluginId: 'old-plugin',
      count: 42,
      firstUsed: NOW - 200 * DAY,
      lastUsed: NOW - 200 * DAY,
      days: { [oldDay]: 40, '2026-10-28': 2 },
    }
    const obs = mergePanelOpen(prev, 'old-plugin', NOW)
    expect(obs.count).toBe(43) // 累计不丢
    expect(obs.firstUsed).toBe(NOW - 200 * DAY) // 最早使用时间不丢
    expect(obs.days[oldDay]).toBeUndefined() // 超窗趋势裁剪
    expect(obs.days['2026-10-28']).toBe(2)
    expect(obs.days['2026-10-29']).toBe(1)
  })

  it('异构/损坏的 prev（版本不符或 pluginId 不符）按全新账本重开', () => {
    const corrupt = { v: 2, pluginId: 'other', count: 99, days: { x: 1 } } as unknown as HostUsageObservation
    const obs = mergePanelOpen(corrupt, 'lingxi', NOW)
    expect(obs.count).toBe(1)
    expect(obs.pluginId).toBe('lingxi')
    expect(obs.days).toEqual({ '2026-10-29': 1 })
  })
})
