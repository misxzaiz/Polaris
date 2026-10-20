/**
 * AI-1 加固单测：双档 diff 注入 + 裁剪预算（master-plan C12）
 *
 * - 非 agentic 引擎：注入裁剪 diff 正文，**不得**出现跑命令指令（幻觉路径防线）
 * - agentic 引擎：保持清单 + `git diff --cached` 自取路径
 * - 单文件/总量预算截断与标注
 */

import { describe, it, expect } from 'vitest'
import { formatGitDiffWithContent } from './gitContextService'
import { buildCommitMessageUserContent, isAgenticEngine } from './commitMessageChat'
import type { GitDiffEntry } from '@/types/git'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import type { EngineMetadata } from '@/types/engineMetadata'

const entry = (partial: Partial<GitDiffEntry>): GitDiffEntry => ({
  file_path: 'a.rs',
  change_type: 'modified',
  is_binary: false,
  ...partial,
})

describe('formatGitDiffWithContent 裁剪', () => {
  it('单文件超出预算时截断并标注省略量', () => {
    const long = 'x'.repeat(2000)
    const out = formatGitDiffWithContent([entry({ file_path: 'a.rs', new_content: long })])

    expect(out).toContain('M  a.rs')
    expect(out).toContain('…[截断，省略')
    expect(out.length).toBeLessThan(2200)
  })

  it('总量超预算时从大块开始省略正文，但保留清单行', () => {
    const blobs: GitDiffEntry[] = Array.from({ length: 40 }, (_, i) =>
      entry({
        file_path: `f${i}.rs`,
        new_content: 'y'.repeat(900),
      })
    )
    const out = formatGitDiffWithContent(blobs)

    // 总预算 12k，40 个 900-char 块必超 → 大部分正文被省略标注
    expect(out.split('[正文因总预算省略]').length).toBeGreaterThan(10)
    // 但每个文件的清单 head 都应保留（AI 至少知道有哪些文件）
    for (let i = 0; i < 40; i++) {
      expect(out).toContain(`f${i}.rs`)
    }
  })

  it('binary 与 content_omitted 明确标注', () => {
    const out = formatGitDiffWithContent([
      entry({ file_path: 'img.png', is_binary: true }),
      entry({ file_path: 'big.rs', content_omitted: true }),
      entry({ file_path: 'empty.rs', new_content: undefined }),
    ])

    expect(out).toContain('[binary file — no text content]')
    expect(out).toContain('[content omitted — file too large]')
  })

  it('deleted 条目取 old_content', () => {
    const out = formatGitDiffWithContent([
      entry({ file_path: 'gone.rs', change_type: 'deleted', old_content: 'deleted body' }),
    ])
    expect(out).toContain('deleted body')
  })
})

describe('buildCommitMessageUserContent 双档注入', () => {
  const fakeEngine = (tools: boolean): EngineMetadata =>
    ({
      id: 'engine-x',
      name: 'Engine X',
      distribution: { type: 'builtin' },
      capabilities: {
        tools,
        imageInput: false,
        streaming: true,
        interrupt: true,
        resume: true,
        stdinInput: false,
        forkSession: false,
      },
      envKeys: { baseUrl: '', apiKey: '', model: '' },
      supportsModelProvider: false,
    }) as unknown as EngineMetadata

  it('非 agentic：不出现命令指令；出现 diff 正文与防编造约束', () => {
    useEngineMetadataStore.setState({ metadatas: [fakeEngine(false)] })
    const out = buildCommitMessageUserContent(
      [entry({ file_path: 'a.rs', new_content: 'fn main() {}' })],
      'engine-x'
    )

    expect(out).not.toContain('git diff --cached')
    expect(out).toContain('fn main() {}')
    expect(out).toContain('不要编造')
  })

  it('agentic：保持清单 + git diff --cached 指令', () => {
    useEngineMetadataStore.setState({ metadatas: [fakeEngine(true)] })
    const out = buildCommitMessageUserContent(
      [entry({ file_path: 'a.rs', new_content: 'fn main() {}' })],
      'engine-x'
    )

    expect(out).toContain('git diff --cached')
    // agentic 档不给正文，保持轻量引用
    expect(out).not.toContain('=== diff 内容 ===')
  })

  it('未知引擎（元数据缺失）安全降级为非 agentic', () => {
    useEngineMetadataStore.setState({ metadatas: [fakeEngine(false)] })
    expect(isAgenticEngine('engine-unknown')).toBe(false)
    const out = buildCommitMessageUserContent(
      [entry({ file_path: 'a.rs', new_content: 'fn main() {}' })],
      'engine-unknown'
    )
    expect(out).not.toContain('git diff --cached')
  })
})
