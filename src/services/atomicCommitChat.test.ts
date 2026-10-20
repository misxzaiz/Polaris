/**
 * AI-2 原子提交 · AI 解释层会话测试
 *
 * 覆盖 spec §3 验收 2：
 * - buildAtomicCommitUserContent 只投喂低置信组（高置信组 diff 不出现在上下文）
 * - 无低置信组时返回"无需解释"占位
 * - 输入裁剪路径：低置信组 diff 走 formatGitDiffWithContent（预算裁剪，不推全量）
 */

import { describe, it, expect } from 'vitest'
import { buildAtomicCommitUserContent } from '@/services/atomicCommitChat'
import type { AtomicCommitGroup } from '@/services/gitAtomicGrouping'
import type { GitDiffEntry } from '@/types/git'

function makeGroup(overrides: Partial<AtomicCommitGroup>): AtomicCommitGroup {
  return {
    id: 'g1',
    message: 'fix(parser): 更新 2 个文件',
    files: [
      { path: 'src/parser/a.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      { path: 'src/parser/b.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
    ],
    reason: 'directory-cluster',
    confidence: 'high',
    changeType: 'modified',
    dir: 'src/parser',
    ...overrides,
  }
}

const diff = (path: string, content: string): GitDiffEntry => ({
  file_path: path,
  change_type: 'modified',
  new_content: content,
  is_binary: false,
  content_omitted: false,
  additions: content.length,
  deletions: 0,
})

describe('buildAtomicCommitUserContent', () => {
  it('无低置信组 → 无需 AI 解释', () => {
    const groups = [makeGroup({ confidence: 'high' })]
    const content = buildAtomicCommitUserContent(groups, [], true)
    expect(content).toContain('无需 AI 解释')
    // 高置信组不应进入 diff 注入（空 diffs 下 body 为空）
    expect(content).not.toContain('=== diff 内容 ===')
  })

  it('仅投喂低置信组 diff（高置信组不出现）', () => {
    const groups = [
      makeGroup({
        id: 'glow',
        confidence: 'low',
        message: 'chore: 通读后再拆分',
        files: [
          { path: 'a/x.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
        ],
        dir: '',
      }),
      makeGroup({
        id: 'ghigh',
        confidence: 'high',
        files: [
          { path: 'src/parser/h.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
        ],
      }),
    ]
    const diffs = [
      diff('a/x.ts', 'const x = 1\n'),
      diff('src/parser/h.ts', 'const h = 2\n'),
    ]
    const content = buildAtomicCommitUserContent(groups, diffs, true)

    // 低置信组 a/x.ts 出现
    expect(content).toContain('a/x.ts')
    expect(content).toContain('const x = 1')
    // 高置信组 src/parser/h.ts 的内容不出现（只可能在清单行）
    expect(content).not.toContain('const h = 2')
  })

  it('lowConfidenceOnly=false 时全部组 diff 注入', () => {
    const groups = [
      makeGroup({ id: 'g1', confidence: 'low', files: [
        { path: 'a.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      ] }),
      makeGroup({ id: 'g2', confidence: 'high', files: [
        { path: 'b.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
      ] }),
    ]
    const diffs = [
      diff('a.ts', 'content-a'),
      diff('b.ts', 'content-b'),
    ]
    const content = buildAtomicCommitUserContent(groups, diffs, false)
    expect(content).toContain('content-a')
    expect(content).toContain('content-b')
  })

  it('超预算 diff 被裁剪标注（复用 formatGitDiffWithContent）', () => {
    const bigContent = 'x'.repeat(2000)
    const groups = [makeGroup({ id: 'glow', confidence: 'low', files: [
      { path: 'big.ts', changeType: 'modified', fromWorktree: true, fromIndex: false },
    ] })]
    const diffs = [diff('big.ts', bigContent)]
    const content = buildAtomicCommitUserContent(groups, diffs, true)
    expect(content).toContain('截断')
    // 单文件预算 600 chars：2000 超出 → 标注省略
    expect(content).toContain('省略')
  })
})