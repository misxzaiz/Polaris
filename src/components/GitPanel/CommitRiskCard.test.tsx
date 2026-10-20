/**
 * CommitRiskCard 单元测试（P3 AI-3：提交前 Review 门）
 *
 * - 发现风险 → 渲染摘要 + 明细（secret/marker/large 类别）
 * - 干净 → clean 文案
 * - 达上限 → truncated 提示 + 明细截断到 8 条 + more 计数
 * - 扫描失败静默（不渲染错误，卡片仍在）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommitRiskCard } from './CommitRiskCard'
import { useGitStore } from '@/stores/gitStore'
import type { GitCommitRiskReport } from '@/types/git'

function report(findings: GitCommitRiskReport['findings'], truncated = false): GitCommitRiskReport {
  return { findings, truncated }
}

/** 让 mock 动作写回 store（对齐真实 slice 行为：结果入 riskScanByWs） */
function mockScan(rpt: GitCommitRiskReport, scanFn: ReturnType<typeof vi.fn>, ws = 'D:/repo') {
  scanFn.mockImplementation(async (path: string) => {
    useGitStore.setState((state) => ({
      riskScanByWs: { ...(state.riskScanByWs ?? {}), [path || ws]: rpt },
    }))
    return rpt
  })
}

describe('CommitRiskCard', () => {
  const scanFn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useGitStore.setState({
      scanCommitRisk: scanFn,
      riskScanByWs: {},
    } as unknown as Partial<ReturnType<typeof useGitStore.getState>>)
  })

  it('挂载即扫描一次；发现秘密与 marker → 摘要与明细行', async () => {
    const rpt = report([
      { file: 'config.ts', line: 12, category: 'secret', pattern: 'aws-access-key', excerpt: 'AKIA…' },
      { file: 'src/a.ts', line: 3, category: 'conflict-marker', excerpt: '<<<<<<< HEAD' },
    ])
    mockScan(rpt, scanFn)

    render(<CommitRiskCard workspacePath="D:/repo" />)

    expect(scanFn).toHaveBeenCalledWith('D:/repo')
    expect(await screen.findByText('config.ts:12')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts:3')).toBeInTheDocument()
    expect(screen.getByText(/riskScan\.summarySecret/)).toBeInTheDocument()
    expect(screen.getByText(/riskScan\.summaryMarker/)).toBeInTheDocument()
  })

  it('干净报告 → clean 文案', async () => {
    mockScan(report([]), scanFn)

    render(<CommitRiskCard workspacePath="D:/repo" />)

    expect(await screen.findByText(/riskScan\.clean/)).toBeInTheDocument()
  })

  it('>8 条 → 明细截 8 + more 计数；truncated 标注', async () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i + 1,
      category: 'secret',
      pattern: 'openai-key',
      excerpt: 'sk-…',
    }))
    mockScan(report(findings, true), scanFn)

    render(<CommitRiskCard workspacePath="D:/repo" />)

    await screen.findByText('f0.ts:1')
    expect(screen.queryByText('f9.ts:10')).not.toBeInTheDocument()
    expect(screen.getByText(/riskScan\.more/)).toBeInTheDocument()
    expect(screen.getByText(/riskScan\.truncated/)).toBeInTheDocument()
  })

  it('手动重新扫描按钮 → 触发第二次 scan', async () => {
    mockScan(report([]), scanFn)

    render(<CommitRiskCard workspacePath="D:/repo" />)
    await screen.findByText(/riskScan\.clean/)

    fireEvent.click(screen.getByTitle(/riskScan\.rescan/))
    expect(scanFn).toHaveBeenCalledTimes(2)
  })

  it('A2 明细跳转：未传 onOpenFileDiff 条目不可点；传入后点击回调该文件', async () => {
    const rpt = report([
      { file: 'secret.env', line: 2, category: 'secret', pattern: 'kv-secret', excerpt: 'x' },
    ])
    mockScan(rpt, scanFn)

    const { rerender } = render(<CommitRiskCard workspacePath="D:/repo" />)
    const item = await screen.findByTestId('risk-finding-item')
    expect(item.getAttribute('tabindex')).toBeNull()

    const onOpenFileDiff = vi.fn()
    rerender(<CommitRiskCard workspacePath="D:/repo" onOpenFileDiff={onOpenFileDiff} />)

    const clickable = screen.getByTestId('risk-finding-item')
    expect(clickable.getAttribute('tabindex')).toBe('0')
    fireEvent.click(clickable)
    expect(onOpenFileDiff).toHaveBeenCalledWith('secret.env')
  })
})
