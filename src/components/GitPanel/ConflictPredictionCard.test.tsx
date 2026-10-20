/**
 * ConflictPredictionCard 单元测试
 *
 * 测试冲突预测卡片（FR-P2-AI4）：
 * - 有风险 → 渲染风险文件 + commitOrStash 建议
 * - 无风险 → 渲染 none 建议
 * - 无上游 → 渲染 noUpstream
 * - 无预测（null）→ 不渲染
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConflictPredictionCard } from './ConflictPredictionCard'
import { useGitStore } from '@/stores/gitStore'
import type { GitConflictPrediction } from '@/types/git'

// i18n mock 由 src/test/setup.ts 提供：t(key) 返回 key 本身

function prediction(partial: Partial<GitConflictPrediction> = {}): GitConflictPrediction {
  return {
    branch: 'main',
    upstream: 'origin/main',
    behind: 1,
    incoming: [{ sha: '514d4f24', shortSha: '514d4f24', summary: 'c2 remote only (a.txt)' }],
    localModified: ['a.txt', 'b.txt'],
    incomingFiles: ['a.txt'],
    riskFiles: ['a.txt'],
    advice: 'commitOrStash',
    ...partial,
  }
}

describe('ConflictPredictionCard', () => {
  beforeEach(() => {
    useGitStore.setState({ conflictPrediction: null, conflictPredictionsByWs: {} })
  })

  it('无预测结果时不渲染', () => {
    const { container } = render(<ConflictPredictionCard workspacePath="D:/repo" />)
    expect(container.innerHTML).toBe('')
  })

  it('渲染有风险预测：风险文件 + commitOrStash 建议 + incoming 预览', () => {
    const p = prediction()
    useGitStore.setState({ conflictPredictionsByWs: { 'D:/repo': p } })

    render(<ConflictPredictionCard workspacePath="D:/repo" />)

    // 标题（带 ✦ 前缀，用正则匹配）
    expect(screen.getByText(/conflictPredict\.title/)).toBeInTheDocument()
    // 风险文件（mono 行：前缀 ▸）
    expect(screen.getByText('▸ a.txt')).toBeInTheDocument()
    // 建议条
    expect(screen.getByText('conflictPredict.advice.commitOrStash')).toBeInTheDocument()
    // incoming 预览 shortSha
    expect(screen.getByText('514d4f24')).toBeInTheDocument()
    // 不应渲染安全建议
    expect(screen.queryByText('conflictPredict.advice.none')).not.toBeInTheDocument()
  })

  it('无风险时渲染安全建议，不渲染风险文件行', () => {
    const p = prediction({ riskFiles: [], advice: 'none', behind: 0, incoming: [] })
    useGitStore.setState({ conflictPredictionsByWs: { 'D:/repo': p } })

    render(<ConflictPredictionCard workspacePath="D:/repo" />)

    expect(screen.getByText('conflictPredict.advice.none')).toBeInTheDocument()
    expect(screen.queryByText('conflictPredict.advice.commitOrStash')).not.toBeInTheDocument()
    // 无 ▸ 风险文件行
    expect(screen.queryByText(/▸/)).not.toBeInTheDocument()
  })

  it('无上游分支时渲染 noUpstream 空态', () => {
    const p = prediction({ upstream: null, behind: 0, riskFiles: [], advice: 'none' })
    useGitStore.setState({ conflictPredictionsByWs: { 'D:/repo': p } })

    render(<ConflictPredictionCard workspacePath="D:/repo" />)

    expect(screen.getByText('conflictPredict.noUpstream')).toBeInTheDocument()
  })
})