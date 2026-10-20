/**
 * ConflictMergerDialog 组件测试（P3 FR-P3-1：文件级取舍对话框）
 *
 * 覆盖（spec 验收点 5）：
 * - 文件列表渲染（kind 徽章 + Accept Yours/Theirs + Resolve Manually）
 * - Accept Yours/Theirs → git_resolve_conflict_file 对应侧内容
 * - Resolve All Simple：非 Text 自动取 ours，剩余 Text 进编辑器
 * - Resolve Manually → 打开 ThreeWayMergeEditor（仅 Text）
 * - 空冲突 → noConflicts 空态
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConflictMergerDialog } from './ConflictMergerDialog'
import { useGitStore } from '@/stores/gitStore'
import type { GitSequenceState, GitConflictEntry } from '@/types/git'

const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
}))

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}
vi.mock('@/stores/toastStore', () => ({
  useToastStore: () => mockToast,
}))

// i18n mock（t(key) 返回 key）由 src/test/setup.ts 提供

function textConf(): GitConflictEntry {
  return {
    path: 'src/a.ts',
    kind: 'text',
    base: 'a\nb\nc\n',
    ours: 'a\nB1\nc\n',
    theirs: 'a\nC1\nc\n',
  }
}

function binaryConf(): GitConflictEntry {
  return { path: 'img/icon.png', kind: 'binary', base: null, ours: 'PNG', theirs: 'PNG' }
}

function sequence(
  confs: GitConflictEntry[],
  partial: Partial<GitSequenceState> = {},
): GitSequenceState {
  return {
    kind: 'merge',
    hasConflicts: confs.length > 0,
    conflicts: confs,
    currentStep: null,
    totalSteps: null,
    ...partial,
  }
}

function renderDialog(seq: GitSequenceState) {
  const onClose = vi.fn()
  const onRefresh = vi.fn()
  render(
    <ConflictMergerDialog
      workspacePath="D:/repo"
      sequence={seq}
      onClose={onClose}
      onRefresh={onRefresh}
    />,
  )
  return { onClose, onRefresh }
}

describe('ConflictMergerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockReset()
    // 默认：get_conflict_state 返回带初始冲突的 sequence；resolve 什么都不做
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'git_get_conflict_state') {
        return Promise.resolve(sequence([textConf(), binaryConf()]))
      }
      return Promise.resolve(undefined)
    })
    useGitStore.setState({})
  })

  it('渲染文件列表：Text/Binary 徽章 + per-file 控件', () => {
    renderDialog(sequence([textConf(), binaryConf()]))
    expect(screen.getByText('conflict.dialogTitle')).toBeInTheDocument()
    expect(screen.getAllByTestId('conflict-row')).toHaveLength(2)
    expect(screen.getByText('conflict.kind.text')).toBeInTheDocument()
    expect(screen.getByText('conflict.kind.binary')).toBeInTheDocument()
    // text 文件有 Resolve Manually；binary 没有
    expect(screen.getByTestId('resolve-manually-src/a.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('resolve-manually-img/icon.png')).not.toBeInTheDocument()
  })

  it('deleted_by_them（对方删·本地改）：ours=还原本方 stage / theirs=接受删除', async () => {
    renderDialog(sequence([{ path: 'f.ts', kind: 'deleted_by_them', ours: 'local\n' }]))
    // 首次解决后有 busy 窗口（防并发），等按钮恢复可点再点第二个
    const clickWhenEnabled = async (testid: string) => {
      await vi.waitFor(() => expect(screen.getByTestId(testid)).not.toBeDisabled())
      fireEvent.click(screen.getByTestId(testid))
    }
    fireEvent.click(screen.getByTestId('resolve-ours-f.ts'))
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'f.ts',
        side: 'ours',
      })
    })
    await clickWhenEnabled('resolve-theirs-f.ts')
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'f.ts',
        remove: true,
      })
    })
  })

  it('deleted_by_us（本地删·对方改）：ours=接受删除 / theirs=还原对方 stage', async () => {
    renderDialog(sequence([{ path: 'g.ts', kind: 'deleted_by_us', theirs: 'remote\n' }]))
    const clickWhenEnabled = async (testid: string) => {
      await vi.waitFor(() => expect(screen.getByTestId(testid)).not.toBeDisabled())
      fireEvent.click(screen.getByTestId(testid))
    }
    fireEvent.click(screen.getByTestId('resolve-ours-g.ts'))
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'g.ts',
        remove: true,
      })
    })
    await clickWhenEnabled('resolve-theirs-g.ts')
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'g.ts',
        side: 'theirs',
      })
    })
  })

  it('Resolve All Simple：非 Text 取本方（binary=side ours / 删类=remove），剩余 Text 进编辑器', async () => {
    renderDialog(sequence([textConf(), binaryConf()]))
    fireEvent.click(screen.getByTestId('resolve-all-simple'))
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('git_resolve_conflict_file', {
        workspacePath: 'D:/repo',
        filePath: 'img/icon.png',
        side: 'ours',
      })
    })
    // 编辑器打开（首个 Text 进编辑器）
    await vi.waitFor(() => expect(screen.getByText('conflict.editorTitle')).toBeInTheDocument())
    expect(screen.getByTestId('three-way-editor')).toBeInTheDocument()
  })

  it('Resolve Manually → 打开 ThreeWayMergeEditor（per-hunk 控件）', () => {
    renderDialog(sequence([textConf(), binaryConf()]))
    fireEvent.click(screen.getByTestId('resolve-manually-src/a.ts'))
    expect(screen.getByText('conflict.editorTitle')).toBeInTheDocument()
    expect(screen.getByTestId('three-way-editor')).toBeInTheDocument()
    expect(screen.getByTestId('accept-ours-0')).toBeInTheDocument()
  })

  it('空冲突 → noConflicts 空态', () => {
    renderDialog(sequence([]))
    expect(screen.getByText('conflict.noConflicts')).toBeInTheDocument()
  })
})