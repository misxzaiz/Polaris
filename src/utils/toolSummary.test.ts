import { describe, it, expect } from 'vitest'
import {
  formatDuration,
  calculateDuration,
  stripAnsiCodes,
  escapeRegExp,
  calculateToolGroupStatus,
  parseGrepMatches,
} from './toolSummary'

describe('formatDuration', () => {
  it('应该格式化毫秒', () => {
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('应该格式化秒', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(59000)).toBe('59.0s')
  })

  it('应该格式化分钟', () => {
    expect(formatDuration(60000)).toBe('1m0s')
    expect(formatDuration(90000)).toBe('1m30s')
    expect(formatDuration(125000)).toBe('2m5s')
  })
})

describe('calculateDuration', () => {
  it('应该计算时间差', () => {
    const start = '2026-05-27T10:00:00Z'
    const end = '2026-05-27T10:00:05Z'
    expect(calculateDuration(start, end)).toBe(5000)
  })

  it('应该返回 undefined 当没有完成时间', () => {
    expect(calculateDuration('2026-05-27T10:00:00Z')).toBeUndefined()
  })
})

describe('stripAnsiCodes', () => {
  it('应该移除 ANSI 颜色代码', () => {
    expect(stripAnsiCodes('\x1b[31mError\x1b[0m')).toBe('Error')
  })

  it('应该移除多个 ANSI 代码', () => {
    expect(stripAnsiCodes('\x1b[1m\x1b[32mSuccess\x1b[0m')).toBe('Success')
  })

  it('应该保留普通文本', () => {
    expect(stripAnsiCodes('Hello World')).toBe('Hello World')
  })

  it('应该处理空字符串', () => {
    expect(stripAnsiCodes('')).toBe('')
  })
})

describe('escapeRegExp', () => {
  it('应该转义特殊字符', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })

  it('应该保留普通字符', () => {
    expect(escapeRegExp('hello')).toBe('hello')
  })

  it('应该处理空字符串', () => {
    expect(escapeRegExp('')).toBe('')
  })
})

describe('calculateToolGroupStatus', () => {
  it('应该返回 running 当所有工具都在运行', () => {
    const tools = [{ status: 'running' as const }, { status: 'running' as const }]
    expect(calculateToolGroupStatus(tools)).toBe('running')
  })

  it('应该返回 completed 当所有工具都完成', () => {
    const tools = [{ status: 'completed' as const }, { status: 'completed' as const }]
    expect(calculateToolGroupStatus(tools)).toBe('completed')
  })

  it('应该返回 failed 当有失败且无完成', () => {
    const tools = [{ status: 'failed' as const }, { status: 'running' as const }]
    expect(calculateToolGroupStatus(tools)).toBe('failed')
  })

  it('应该返回 partial 当有失败也有完成', () => {
    const tools = [{ status: 'failed' as const }, { status: 'completed' as const }]
    expect(calculateToolGroupStatus(tools)).toBe('partial')
  })

  it('应该返回 running 当列表为空', () => {
    expect(calculateToolGroupStatus([])).toBe('running')
  })

  it('应该返回 partial 当混合状态', () => {
    const tools = [{ status: 'completed' as const }, { status: 'running' as const }]
    expect(calculateToolGroupStatus(tools)).toBe('partial')
  })
})

describe('parseGrepMatches', () => {
  it('应该解析 grep 输出', () => {
    const output = 'file.ts:10:const x = 1\nfile.ts:20:const y = 2'
    const result = parseGrepMatches(output)
    expect(result).not.toBeNull()
    expect(result!.matches).toHaveLength(2)
    expect(result!.matches[0].file).toBe('file.ts')
    expect(result!.matches[0].line).toBe(10)
    expect(result!.matches[0].content).toBe('const x = 1')
  })

  it('应该返回 null 当没有匹配', () => {
    expect(parseGrepMatches('')).toBeNull()
  })

  it('应该处理带列号的输出', () => {
    const output = 'file.ts:10:5:const x = 1'
    const result = parseGrepMatches(output)
    expect(result).not.toBeNull()
    expect(result!.matches[0].line).toBe(10)
  })
})
