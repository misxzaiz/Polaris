/**
 * parseConflictMarkers 单测（P3 冲突合并器）
 *
 * 覆盖：
 * - 无冲突（单侧修改各自归入 ours/theirs 区域）
 * - 经典冲突（双方同 base 不同改）
 * - 双侧一致改（自动降级 common）
 * - 单侧插入（base 零宽段）
 * - 单侧删除
 * - 尾部同时新增且不同（冲突）
 * - buildResult 按决策拼接
 * - 零宽推进（防御改写值）
 */

import { describe, it, expect } from 'vitest'
import { parseConflictMarkers, buildResult } from './parseConflictMarkers'

const BASE = ['a', 'b', 'c', 'd'].join('\n')
const OURS_TOPIC = ['a', 'B1', 'c', 'd'].join('\n')
const THEIRS_TOPIC = ['a', 'C1', 'c', 'd'].join('\n')

describe('parseConflictMarkers', () => {
  it('无修改：全部 common', () => {
    const { regions, conflicts } = parseConflictMarkers(BASE, BASE, BASE)
    expect(conflicts.length).toBe(0)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ kind: 'common', baseStart: 0, baseEnd: 4 })
  })

  it('单侧修改 ours：非冲突归入 ours 区域', () => {
    const { regions, conflicts } = parseConflictMarkers(BASE, OURS_TOPIC, BASE)
    expect(conflicts.length).toBe(0)
    const kinds = regions.map((r) => r.kind)
    expect(kinds).toEqual(['common', 'ours', 'common'])
  })

  it('单侧修改 theirs：非冲突归入 theirs 区域', () => {
    const { regions, conflicts } = parseConflictMarkers(BASE, BASE, THEIRS_TOPIC)
    expect(conflicts.length).toBe(0)
    const kinds = regions.map((r) => r.kind)
    expect(kinds).toEqual(['common', 'theirs', 'common'])
  })

  it('双方不同改：一个冲突块，三侧内容齐全', () => {
    const { regions, conflicts } = parseConflictMarkers(
      BASE,
      OURS_TOPIC,
      THEIRS_TOPIC,
    )
    expect(conflicts).toHaveLength(1)
    const hunk = conflicts[0]
    expect(hunk.baseStart).toBe(1)
    expect(hunk.baseEnd).toBe(2)
    expect(hunk.oursLines).toEqual(['B1'])
    expect(hunk.theirsLines).toEqual(['C1'])
    expect(hunk.baseLines).toEqual(['b'])
    // regions 里 conflict 也带三侧
    const c = regions.find((r) => r.kind === 'conflict')
    expect(c).toBeDefined()
    expect(c?.oursLines).toEqual(['B1'])
    expect(c?.theirsLines).toEqual(['C1'])
    expect(c?.baseLines).toEqual(['b'])
  })

  it('双方一致改：降级为 common，不算冲突', () => {
    const both = ['a', 'Z', 'c', 'd'].join('\n')
    const { conflicts, regions } = parseConflictMarkers(BASE, both, both)
    expect(conflicts).toHaveLength(0)
    // 单区域 common（全行一致）
    expect(regions.filter((r) => r.kind === 'common').length).toBeGreaterThan(0)
    expect(regions.filter((r) => r.kind === 'conflict')).toHaveLength(0)
  })

  it('同位置单侧插入（base 零宽段）', () => {
    const withExtra = ['pre', 'a', 'b', 'c', 'd'].join('\n')
    const { regions, conflicts } = parseConflictMarkers(BASE, withExtra, BASE)
    expect(conflicts).toHaveLength(0)
    const ours = regions.filter((r) => r.kind === 'ours')
    expect(ours).toHaveLength(1)
    expect(ours[0].baseStart).toBe(0)
    expect(ours[0].baseEnd).toBe(0) // 零宽
    expect(ours[0].lines).toEqual(['pre'])
  })

  it('单侧整块删除：ours 区域空行', () => {
    const removed = ['a', 'c', 'd'].join('\n')
    const { regions, conflicts } = parseConflictMarkers(BASE, removed, BASE)
    expect(conflicts).toHaveLength(0)
    const deleted = regions.find((r) => r.kind === 'ours')
    expect(deleted).toBeDefined()
    expect(deleted?.baseStart).toBe(1)
    expect(deleted?.baseEnd).toBe(2)
    expect(deleted?.lines).toEqual([])
  })

  it('尾部双方新增不同：尾部冲突块', () => {
    const oTail = BASE + '\ntail-ours'
    const tTail = BASE + '\ntail-theirs'
    const { conflicts } = parseConflictMarkers(BASE, oTail, tTail)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].baseLines).toEqual([])
    expect(conflicts[0].oursLines).toEqual(['tail-ours'])
    expect(conflicts[0].theirsLines).toEqual(['tail-theirs'])
  })

  it('null 输入：等价空文件，无冲突', () => {
    const { regions, conflicts } = parseConflictMarkers(null, null, null)
    expect(conflicts).toHaveLength(0)
    expect(regions).toHaveLength(0)
  })

  it('多个冲突块跨公共段分隔', () => {
    const ours2 = ['a', 'B1', 'c', 'D1'].join('\n')
    const theirs2 = ['a', 'C1', 'c', 'E1'].join('\n')
    const { conflicts, regions } = parseConflictMarkers(BASE, ours2, theirs2)
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((h) => h.baseStart)).toEqual([1, 3])
    // 公共段 a、c 保留（2 个 common 段）
    expect(regions.filter((r) => r.kind === 'common')).toHaveLength(2)
  })
})

describe('buildResult', () => {
  it('取 ours / theirs / base 决策拼接', () => {
    const { regions } = parseConflictMarkers(BASE, OURS_TOPIC, THEIRS_TOPIC)
    expect(buildResult(regions, {})).toBe(['a', 'B1', 'c', 'd', ''].join('\n'))
    expect(buildResult(regions, { 0: 'theirs' })).toBe(['a', 'C1', 'c', 'd', ''].join('\n'))
    expect(buildResult(regions, { 0: 'base' })).toBe(['a', 'b', 'c', 'd', ''].join('\n'))
  })

  it('未决策冲突默认取 ours', () => {
    const { regions } = parseConflictMarkers(BASE, OURS_TOPIC, THEIRS_TOPIC)
    expect(buildResult(regions, {})).toContain('B1')
  })
})