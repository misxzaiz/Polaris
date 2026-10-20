/**
 * replyError 单元测试（PR-2a C1：cap.git 结构化错误的前端拆包）
 *
 * - 有 errorDetail → GitCapError 携带 code/kind/stderrSnip
 * - 无 errorDetail（旧后端）→ detail undefined，message 不变（向后兼容）
 * - kind 便捷 getter：缺省 undefined（调用方自行按 'git' 兜底）
 */

import { describe, it, expect } from 'vitest'
import { GitCapError, parseReplyError } from './replyError'

describe('replyError（C1 结构化错误拆包）', () => {
  it('errorDetail 全量字段 → GitCapError 透传', () => {
    const err = parseReplyError('merge failed (Conflicted files: ["a.rs"])', {
      code: 'CONFLICTS_DETECTED',
      kind: 'conflict',
      stderrSnip: 'CONFLICT (content): Merge conflict in a.rs',
    })
    expect(err).toBeInstanceOf(GitCapError)
    expect(err.message).toContain('merge failed')
    expect(err.detail?.code).toBe('CONFLICTS_DETECTED')
    expect(err.detail?.kind).toBe('conflict')
    expect(err.detail?.stderrSnip).toContain('Merge conflict in a.rs')
    expect(err.kind).toBe('conflict')
  })

  it('旧后端无 errorDetail → detail undefined、message 原样（行为等价）', () => {
    const err = parseReplyError('cap.git status failed')
    expect(err.detail).toBeUndefined()
    expect(err.message).toBe('cap.git status failed')
    expect(err.kind).toBeUndefined()
  })

  it('errorDetail=null（后端显式无分类）→ 与 undefined 等价', () => {
    const err = parseReplyError('boom', null)
    expect(err.detail).toBeUndefined()
  })
})
