import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatGitTimestamp, formatGitTimeSimple } from './gitFormat'

describe('formatGitTimestamp', () => {
  const mockT = vi.fn((key: string, params?: Record<string, unknown>) => {
    if (params?.count !== undefined) {
      return `${key}:${params.count}`
    }
    return key
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-27 12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('应该返回"刚刚"当时间差小于 1 分钟', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30 // 30 秒前
    expect(formatGitTimestamp(timestamp, mockT)).toBe('history.justNow')
  })

  it('应该返回分钟数当时间差小于 60 分钟', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30 * 60 // 30 分钟前
    expect(formatGitTimestamp(timestamp, mockT)).toBe('history.minutesAgo:30')
  })

  it('应该返回小时数当时间差小于 24 小时', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 5 * 3600 // 5 小时前
    expect(formatGitTimestamp(timestamp, mockT)).toBe('history.hoursAgo:5')
  })

  it('应该返回天数当时间差小于 7 天', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 3 * 86400 // 3 天前
    expect(formatGitTimestamp(timestamp, mockT)).toBe('history.daysAgo:3')
  })

  it('应该返回日期字符串当时间差大于等于 7 天', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 10 * 86400 // 10 天前
    const result = formatGitTimestamp(timestamp, mockT)
    // 返回本地日期格式
    expect(result).toMatch(/\d+\/\d+\/\d+/)
  })
})

describe('formatGitTimeSimple', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-27 12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('应该返回"刚刚"当时间差小于 1 分钟', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30
    expect(formatGitTimeSimple(timestamp)).toBe('刚刚')
  })

  it('应该返回分钟数当时间差小于 60 分钟', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30 * 60
    expect(formatGitTimeSimple(timestamp)).toBe('30分钟前')
  })

  it('应该返回小时数当时间差小于 24 小时', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 5 * 3600
    expect(formatGitTimeSimple(timestamp)).toBe('5小时前')
  })

  it('应该返回天数当时间差小于 7 天', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 3 * 86400
    expect(formatGitTimeSimple(timestamp)).toBe('3天前')
  })

  it('应该返回日期字符串当时间差大于等于 7 天', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 10 * 86400
    const result = formatGitTimeSimple(timestamp)
    expect(result).toMatch(/\d+\/\d+\/\d+/)
  })
})
