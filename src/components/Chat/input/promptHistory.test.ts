import { describe, expect, it } from 'vitest'
import {
  arePromptHistoryEntriesEqual,
  appendPromptHistoryEntry,
  navigatePromptHistory,
  normalizePromptHistoryEntries,
} from './promptHistory'

describe('appendPromptHistoryEntry', () => {
  it('追加并保持旧→新序', () => {
    expect(appendPromptHistoryEntry(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('trim 后为空不入史', () => {
    expect(appendPromptHistoryEntry(['a'], '  ')).toEqual(['a'])
    expect(appendPromptHistoryEntry([], '')).toEqual([])
  })

  it('连续重复（trim 后相等）去重', () => {
    expect(appendPromptHistoryEntry([' hi ', 'b'], 'b')).toEqual([' hi ', 'b'])
    expect(appendPromptHistoryEntry(['a'], '  a  ')).toEqual(['a'])
  })

  it('非连续重复保留（A,B,A 不被误删）', () => {
    expect(appendPromptHistoryEntry(['a', 'b'], 'a')).toEqual(['a', 'b', 'a'])
  })

  it('超过上限截断旧条目', () => {
    const filled = ['1', '2', '3', '4']
    expect(appendPromptHistoryEntry(filled, '5', 3)).toEqual(['3', '4', '5'])
  })

  it('limit 归一：非法上限按 1 处理', () => {
    expect(appendPromptHistoryEntry(['a', 'b'], 'c', 0)).toEqual(['c'])
    expect(appendPromptHistoryEntry(['a', 'b'], 'c', -5)).toEqual(['c'])
    expect(appendPromptHistoryEntry(['a', 'b'], 'c', 2.6)).toEqual(['b', 'c'])
  })
})

describe('navigatePromptHistory', () => {
  const entries = ['old1', 'old2', 'new3']

  it('空史不接管', () => {
    expect(navigatePromptHistory([], null, 'up')).toEqual({
      nextIndex: null,
      nextValue: '',
      shouldHandle: false,
    })
    expect(navigatePromptHistory([], null, 'down').shouldHandle).toBe(false)
  })

  it('up：从未进入浏览态 → 最新一条', () => {
    expect(navigatePromptHistory(entries, null, 'up')).toEqual({
      nextIndex: 2,
      nextValue: 'new3',
      shouldHandle: true,
    })
  })

  it('up：逐级向旧翻，到最旧后 clamp 停住', () => {
    expect(navigatePromptHistory(entries, 2, 'up')).toEqual({ nextIndex: 1, nextValue: 'old2', shouldHandle: true })
    expect(navigatePromptHistory(entries, 1, 'up')).toEqual({ nextIndex: 0, nextValue: 'old1', shouldHandle: true })
    expect(navigatePromptHistory(entries, 0, 'up')).toEqual({ nextIndex: 0, nextValue: 'old1', shouldHandle: true })
  })

  it('down：未进入浏览态 → 最新一条（与 ZCode 一致）', () => {
    expect(navigatePromptHistory(entries, null, 'down')).toEqual({
      nextIndex: 2,
      nextValue: 'new3',
      shouldHandle: true,
    })
  })

  it('down：逐级向新翻，翻尽退出浏览态并清空', () => {
    expect(navigatePromptHistory(entries, 0, 'down')).toEqual({ nextIndex: 1, nextValue: 'old2', shouldHandle: true })
    expect(navigatePromptHistory(entries, 1, 'down')).toEqual({ nextIndex: 2, nextValue: 'new3', shouldHandle: true })
    expect(navigatePromptHistory(entries, 2, 'down')).toEqual({ nextIndex: null, nextValue: '', shouldHandle: true })
  })

  it('浏览态下标越界按未进入浏览态处理', () => {
    expect(navigatePromptHistory(entries, 9, 'up')).toEqual({ nextIndex: 2, nextValue: 'new3', shouldHandle: true })
    expect(navigatePromptHistory(entries, 9, 'down')).toEqual({ nextIndex: 2, nextValue: 'new3', shouldHandle: true })
  })

  it('历史被截短为空后不再接管', () => {
    expect(navigatePromptHistory([], 0, 'up').shouldHandle).toBe(false)
  })
})

describe('normalizePromptHistoryEntries', () => {
  it('过滤非字符串与空串、trim、截断上限', () => {
    const junk: unknown[] = [' keep ', 1, null, '', '  ', 'x']
    expect(normalizePromptHistoryEntries(junk)).toEqual(['keep', 'x'])
  })

  it('超过上限保留最新段', () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`)
    const out = normalizePromptHistoryEntries(many)
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('p10')
    expect(out.at(-1)).toBe('p39')
  })
})

describe('arePromptHistoryEntriesEqual', () => {
  it('内容级比较（引用不同但内容相同视为相等）', () => {
    expect(arePromptHistoryEntriesEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(arePromptHistoryEntriesEqual(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(arePromptHistoryEntriesEqual(['a'], ['a', 'a'])).toBe(false)
  })
})
