/**
 * commandRegistry 单元测试.
 *
 * 覆盖:
 *   - 注册 / 注销 / 重复注册覆盖
 *   - 批量注册 + 一键注销
 *   - 订阅通知
 *   - recent LRU 行为
 *   - matchScore 评分规则
 *   - filterAndRank 排序稳定性
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  commandRegistry,
  matchScore,
  filterAndRank,
  type Command,
} from './commandRegistry'

const makeCmd = (
  id: string,
  title: string,
  overrides: Partial<Command> = {}
): Command => ({
  id,
  title,
  category: 'action',
  perform: vi.fn(),
  ...overrides,
})

describe('commandRegistry', () => {
  beforeEach(() => {
    commandRegistry._clearForTest()
  })

  it('registers and lists a command', () => {
    commandRegistry.register(makeCmd('a.b', 'A B'))
    expect(commandRegistry.list()).toHaveLength(1)
    expect(commandRegistry.get('a.b')?.title).toBe('A B')
  })

  it('register returns unregister function', () => {
    const off = commandRegistry.register(makeCmd('x', 'X'))
    off()
    expect(commandRegistry.list()).toHaveLength(0)
  })

  it('registerAll batch unregister', () => {
    const off = commandRegistry.registerAll([
      makeCmd('a', 'A'),
      makeCmd('b', 'B'),
      makeCmd('c', 'C'),
    ])
    expect(commandRegistry.list()).toHaveLength(3)
    off()
    expect(commandRegistry.list()).toHaveLength(0)
  })

  it('overrides on duplicate id (with warning)', () => {
    commandRegistry.register(makeCmd('dup', 'First'))
    commandRegistry.register(makeCmd('dup', 'Second'))
    expect(commandRegistry.list()).toHaveLength(1)
    expect(commandRegistry.get('dup')?.title).toBe('Second')
  })

  it('execute invokes perform and bumps recent', async () => {
    const perform = vi.fn()
    commandRegistry.register(makeCmd('act', 'Act', { perform }))
    await commandRegistry.execute('act')
    expect(perform).toHaveBeenCalledOnce()
    expect(commandRegistry.recentIds()[0]).toBe('act')
  })

  it('execute throws if command does not exist (no-op silent)', async () => {
    // 不抛错, 仅 log.warn
    await expect(commandRegistry.execute('ghost')).resolves.toBeUndefined()
  })

  it('execute rethrows on perform failure', async () => {
    commandRegistry.register(
      makeCmd('bomb', 'Bomb', {
        perform: () => {
          throw new Error('boom')
        },
      })
    )
    await expect(commandRegistry.execute('bomb')).rejects.toThrow('boom')
  })

  it('recent caps at 5 entries (LRU)', async () => {
    for (let i = 0; i < 8; i++) {
      commandRegistry.register(makeCmd(`c${i}`, `C${i}`))
      await commandRegistry.execute(`c${i}`)
    }
    expect(commandRegistry.recentIds()).toHaveLength(5)
    // 最新的应该在前
    expect(commandRegistry.recentIds()[0]).toBe('c7')
  })

  it('recent dedupes on re-execute', async () => {
    commandRegistry.register(makeCmd('a', 'A'))
    commandRegistry.register(makeCmd('b', 'B'))
    await commandRegistry.execute('a')
    await commandRegistry.execute('b')
    await commandRegistry.execute('a')
    expect(commandRegistry.recentIds()).toEqual(['a', 'b'])
  })

  it('subscribe fires on register/unregister/execute', async () => {
    const listener = vi.fn()
    const off = commandRegistry.subscribe(listener)
    commandRegistry.register(makeCmd('a', 'A'))
    expect(listener).toHaveBeenCalledTimes(1)
    await commandRegistry.execute('a')
    expect(listener).toHaveBeenCalledTimes(2)
    commandRegistry.unregister('a')
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    commandRegistry.register(makeCmd('b', 'B'))
    expect(listener).toHaveBeenCalledTimes(3) // 未触发
  })

  it('unregister removes from recent', async () => {
    commandRegistry.register(makeCmd('a', 'A'))
    await commandRegistry.execute('a')
    commandRegistry.unregister('a')
    expect(commandRegistry.recentIds()).toEqual([])
  })
})

describe('matchScore', () => {
  const cmd = (overrides: Partial<Command> = {}): Command =>
    makeCmd('git.commit', 'Git: Commit Changes', {
      description: 'Stage and commit',
      keywords: ['提交', 'commit', 'save'],
      ...overrides,
    })

  it('empty query returns 1 (match all)', () => {
    expect(matchScore(cmd(), '')).toBe(1)
    expect(matchScore(cmd(), '   ')).toBe(1)
  })

  it('case insensitive title match', () => {
    expect(matchScore(cmd(), 'GIT')).toBeGreaterThan(0)
    expect(matchScore(cmd(), 'git')).toBeGreaterThan(0)
  })

  it('startsWith title gets bonus', () => {
    expect(matchScore(cmd(), 'git')).toBeGreaterThan(matchScore(cmd(), 'changes'))
  })

  it('keywords match', () => {
    expect(matchScore(cmd(), '提交')).toBeGreaterThan(0)
  })

  it('description match scores lower than title', () => {
    expect(matchScore(cmd(), 'stage')).toBeLessThan(matchScore(cmd(), 'commit'))
  })

  it('no match returns 0', () => {
    expect(matchScore(cmd(), 'xyzzy')).toBe(0)
  })
})

describe('filterAndRank', () => {
  it('orders by score desc, then by recent rank', () => {
    const cmds = [
      makeCmd('a', 'Alpha'),
      makeCmd('b', 'Beta'),
      makeCmd('g', 'Git Commit'),
    ]
    const ranked = filterAndRank(cmds, 'git', [])
    expect(ranked[0].id).toBe('g')
  })

  it('tie-break by recent ids', () => {
    const cmds = [
      makeCmd('a', 'Same Title'),
      makeCmd('b', 'Same Title'),
    ]
    // 同分 → 看 recent
    const ranked = filterAndRank(cmds, 'same', ['b', 'a'])
    expect(ranked[0].id).toBe('b')
  })

  it('empty query returns all in original order', () => {
    const cmds = [makeCmd('a', 'A'), makeCmd('b', 'B'), makeCmd('c', 'C')]
    const ranked = filterAndRank(cmds, '', [])
    expect(ranked.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops zero-score commands', () => {
    const cmds = [makeCmd('a', 'Apple'), makeCmd('b', 'Banana')]
    const ranked = filterAndRank(cmds, 'app', [])
    expect(ranked.map((c) => c.id)).toEqual(['a'])
  })
})
