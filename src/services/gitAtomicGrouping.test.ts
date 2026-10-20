/**
 * AI-2 原子提交 · 本地分组预检测试
 *
 * 覆盖 spec §3 验收 1：
 * - 同目录 3 文件 → 1 组 high
 * - 跨 2 目录 + 混合 change_type → 目录聚类 + change_type 拆分
 * - 单文件孤目录 → 1 组 high，message 含正确 type/scope
 * - mergeChangeViews 合并 worktree + index
 * - 纯函数，无 IO（不依赖 git 后端）
 */

import { describe, it, expect } from 'vitest'
import {
  mergeChangeViews,
  groupChangesForAtomicCommit,
  dirnameOf,
  type AtomicChangeFile,
} from '@/services/gitAtomicGrouping'
import type { GitFileChange } from '@/types/git'

const fc = (path: string, status: GitFileChange['status']): GitFileChange => ({
  path,
  status,
})

function groupSummary(groups: ReturnType<typeof groupChangesForAtomicCommit>) {
  return groups.map((g) => ({
    message: g.message,
    confidence: g.confidence,
    count: g.files.length,
    files: g.files.map((f) => f.path).sort(),
  }))
}

describe('dirnameOf', () => {
  it('根目录文件 → 空串', () => {
    expect(dirnameOf('README.md')).toBe('')
    expect(dirnameOf('/abs/README.md')).toBe('/abs')
    expect(dirnameOf('src/App.tsx')).toBe('src')
    expect(dirnameOf('a/b/c.ts')).toBe('a/b')
  })

  it('Windows 反斜杠归一化为正斜杠', () => {
    expect(dirnameOf('src\\App.tsx')).toBe('src')
  })
})

describe('mergeChangeViews', () => {
  it('合并 index + worktree 同 path 取优先类型', () => {
    const result = mergeChangeViews(
      [fc('src/a.ts', 'added')],
      [fc('src/a.ts', 'modified')],
      [],
    )
    expect(result).toHaveLength(1)
    // index 的 added 优先级 > worktree 的 modified
    expect(result[0].changeType).toBe('added')
    expect(result[0].fromIndex).toBe(true)
    expect(result[0].fromWorktree).toBe(true)
  })

  it('untracked 补入 worktree 缺失文件', () => {
    const result = mergeChangeViews(
      [],
      [fc('src/a.ts', 'modified')],
      ['notes/x.md'],
    )
    expect(result.map((r) => r.path).sort()).toEqual(['notes/x.md', 'src/a.ts'])
  })

  it('只读视角：两种视图都保留', () => {
    const result = mergeChangeViews(
      [fc('a.ts', 'modified')],
      [fc('b.ts', 'modified')],
      [],
    )
    expect(result).toHaveLength(2)
  })
})

describe('groupChangesForAtomicCommit', () => {
  it('同目录 3 文件 → 1 组 high', () => {
    const changes: AtomicChangeFile[] = [
      { path: 'src/parser/a.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'src/parser/b.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'src/parser/c.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
    ]
    const groups = groupChangesForAtomicCommit(changes)
    expect(groups).toHaveLength(1)
    expect(groups[0].confidence).toBe('high')
    expect(groups[0].files).toHaveLength(3)
    expect(groups[0].message).toContain('fix')
  })

  it('跨 2 目录混合 change_type → 目录聚类 + change_type 拆分', () => {
    const changes: AtomicChangeFile[] = [
      // src/parser：2 modified + 1 added
      { path: 'src/parser/p.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'src/parser/q.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'src/parser/new.ts', changeType: 'added', fromWorktree: true, fromIndex: false },
      // docs：1 modified
      { path: 'docs/readme.md', changeType: 'modified', fromWorktree: true, fromIndex: false },
    ]
    const groups = groupChangesForAtomicCommit(changes)
    const summary = groupSummary(groups)
    // src/parser 拆 modified / added 两组；docs 一组
    expect(summary).toContainEqual({ message: 'fix(parser): 更新 2 个文件', confidence: 'high', count: 2, files: ['src/parser/p.ts', 'src/parser/q.ts'] })
    expect(summary.some((g) => g.message.includes('feat(parser)') && g.count === 1)).toBe(true)
    expect(summary.some((g) => g.message.includes('docs'))).toBe(true)
  })

  it('单文件孤目录 → 1 组 high，message 含正确 scope', () => {
    const changes: AtomicChangeFile[] = [
      { path: 'conflictParser.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'mergeCounts.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
    ]
    const groups = groupChangesForAtomicCommit(changes)
    const summary = groupSummary(groups)
    expect(summary).toHaveLength(1)
    expect(summary[0].confidence).toBe('high')
    expect(summary[0].count).toBe(2)
    expect(groups[0].message).toMatch(/^fix\(root\)/)
  })

  it('跨 >2 目录且 ≥6 文件 → 追加低置信合并组候选', () => {
    const paths = [
      'a/x1.ts', 'a/x2.ts',
      'b/y1.ts', 'b/y2.ts',
      'c/z1.ts', 'c/z2.ts',
    ]
    const changes: AtomicChangeFile[] = paths.map((path) => ({
      path,
      changeType: 'modified',
      fromWorktree: true,
      fromIndex: false,
    }))
    const groups = groupChangesForAtomicCommit(changes)
    const low = groups.filter((g) => g.confidence === 'low')
    expect(low).toHaveLength(1)
    expect(low[0].files).toHaveLength(6)
    expect(low[0].reason).toContain('跨目录多 hunk')
  })

  it('空输入 → 空数组', () => {
    expect(groupChangesForAtomicCommit([])).toEqual([])
  })
})