/**
 * animationChain 纯函数测试。
 * 规格：plans/pet-overlay-r2-spec.md §4.1（必拆为纯函数，可加 vitest）。
 */
import { describe, it, expect } from 'vitest'
import { pick, rollChain } from './animationChain'
import { IDLE, TURN, CATEGORIES } from './constants'

describe('pick', () => {
  it('单元素数组直接返回该元素', () => {
    expect(pick(['唯一'])).toBe('唯一')
  })

  it('多元素数组返回其中之一', () => {
    const arr = ['a', 'b', 'c']
    expect(arr).toContain(pick(arr))
  })

  it('avoid 参数排除指定值', () => {
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 50; i++) {
      expect(pick(arr, 'a')).not.toBe('a')
    }
  })

  it('avoid 排除后池空时回退原数组', () => {
    // 单元素数组 + avoid 该元素 → 池空 → 回退原数组返回该元素
    expect(pick(['唯一'], '唯一')).toBe('唯一')
  })
})

describe('rollChain', () => {
  it('返回合法的 ChainRoll 结构', () => {
    const r = rollChain('待机呼吸休闲')
    expect(typeof r.anim).toBe('string')
    expect(typeof r.once).toBe('boolean')
    expect(typeof r.move).toBe('boolean')
  })

  it('move 命中时 anim 为空字符串、once 为 false', () => {
    // 统计采样：move 权重 5 / 总权重，万次采样应能命中
    let hitMove = false
    for (let i = 0; i < 10000; i++) {
      const r = rollChain('待机呼吸休闲')
      if (r.move) {
        expect(r.anim).toBe('')
        expect(r.once).toBe(false)
        hitMove = true
        break
      }
    }
    expect(hitMove).toBe(true)
  })

  it('once 命中时 anim 必属于某 CATEGORIES.actions', () => {
    const allActions = CATEGORIES.flatMap((c) => c.actions)
    let hitOnce = false
    for (let i = 0; i < 10000; i++) {
      const r = rollChain('待机呼吸休闲')
      if (r.once) {
        expect(allActions).toContain(r.anim)
        expect(r.move).toBe(false)
        hitOnce = true
        break
      }
    }
    expect(hitOnce).toBe(true)
  })

  it('循环段（once=false, move=false）anim 必属于 IDLE 或 TURN', () => {
    const loops = [...IDLE, ...TURN]
    let hitLoop = false
    for (let i = 0; i < 10000; i++) {
      const r = rollChain('待机呼吸休闲')
      if (!r.once && !r.move) {
        expect(loops).toContain(r.anim)
        hitLoop = true
        break
      }
    }
    expect(hitLoop).toBe(true)
  })

  it('权重分布：三类（循环段 / once / move）在大量采样下均出现', () => {
    const counts = { loop: 0, once: 0, move: 0 }
    for (let i = 0; i < 100000; i++) {
      const r = rollChain('待机呼吸休闲')
      if (r.move) counts.move++
      else if (r.once) counts.once++
      else counts.loop++
    }
    // 总权重 IDLE10+TURN5+MOVE5+CATS(20+20+16+14+10=80) = 100
    // 循环段 15%、once 80%、move 5% —— 容差 ±5%
    expect(counts.loop).toBeGreaterThan(10000)   // ~15%
    expect(counts.once).toBeGreaterThan(70000)   // ~80%
    expect(counts.move).toBeGreaterThan(3000)    // ~5%
  })
})
