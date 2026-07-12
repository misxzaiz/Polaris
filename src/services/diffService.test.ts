import { describe, it, expect } from 'vitest'
import { computeDiff } from './diffService'
import type { DiffLine } from './diffService'

/** 仅取一侧内容（old 侧排除 added，new 侧排除 removed），用于验证内容可完整重建 */
function rebuild(lines: DiffLine[], side: 'old' | 'new'): string {
  return lines
    .filter((l) => (side === 'old' ? l.type !== 'added' : l.type !== 'removed'))
    .map((l) => l.content)
    .join('\n')
}

describe('computeDiff', () => {
  it('精确路径：基本增删改与行号', () => {
    const d = computeDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(d.degraded).toBeFalsy()
    expect(d.addedCount).toBe(2) // B, d
    expect(d.removedCount).toBe(1) // b
    expect(rebuild(d.lines, 'old')).toBe('a\nb\nc')
    expect(rebuild(d.lines, 'new')).toBe('a\nB\nc\nd')
  })

  it('归一化 Windows CRLF（行内容不含 \\r）', () => {
    const d = computeDiff('a\r\nb\r\n', 'a\r\nB\r\n')
    expect(d.lines.every((l) => !l.content.includes('\r'))).toBe(true)
    expect(rebuild(d.lines, 'new')).toBe('a\nB')
  })

  it('无变化 / 空内容', () => {
    expect(computeDiff('', '').lines).toHaveLength(0)
    const same = computeDiff('x\ny\n', 'x\ny\n')
    expect(same.addedCount).toBe(0)
    expect(same.removedCount).toBe(0)
    expect(same.lines.every((l) => l.type === 'context')).toBe(true)
  })

  it('超大改动触发降级，但内容完整可重建', () => {
    const oldContent = Array.from({ length: 3000 }, (_, i) => 'old' + i).join('\n')
    const newContent = Array.from({ length: 3000 }, (_, i) => 'new' + i).join('\n')
    const d = computeDiff(oldContent, newContent)
    expect(d.degraded).toBe(true)
    // 关键：降级也不丢内容
    expect(rebuild(d.lines, 'old')).toBe(oldContent)
    expect(rebuild(d.lines, 'new')).toBe(newContent)
    expect(d.addedCount).toBe(3000)
    expect(d.removedCount).toBe(3000)
  }, 15000)

  it('降级保留公共前后缀为上下文', () => {
    const prefix = Array.from({ length: 5 }, (_, i) => 'p' + i)
    const suffix = Array.from({ length: 5 }, (_, i) => 's' + i)
    const oldMid = Array.from({ length: 3000 }, (_, i) => 'o' + i)
    const newMid = Array.from({ length: 3000 }, (_, i) => 'n' + i)
    const oldContent = [...prefix, ...oldMid, ...suffix].join('\n')
    const newContent = [...prefix, ...newMid, ...suffix].join('\n')
    const d = computeDiff(oldContent, newContent)
    expect(d.degraded).toBe(true)
    expect(d.lines.slice(0, 5).every((l) => l.type === 'context')).toBe(true)
    expect(d.lines.slice(-5).every((l) => l.type === 'context')).toBe(true)
    expect(rebuild(d.lines, 'old')).toBe(oldContent)
    expect(rebuild(d.lines, 'new')).toBe(newContent)
  }, 15000)
})
