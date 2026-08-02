import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DiffViewer } from './DiffViewer'

// 短内容走全量渲染路径，不会用到 Virtuoso；保留一个无害 mock 以防大文件用例引入。
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ totalCount, itemContent }: { totalCount: number; itemContent: (index: number) => React.ReactNode }) => (
    <div data-testid="virtuoso-list">
      {Array.from({ length: totalCount }, (_, i) => (
        <div key={i}>{itemContent(i)}</div>
      ))}
    </div>
  ),
  VirtuosoHandle: undefined,
}))

describe('DiffViewer', () => {
  it('renders split diff with old and new columns', () => {
    render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\nomega\n'}
          newContent={'alpha\nnew line\nomega\nextra\n'}
          viewMode="split"
          showStatusHint={false}
        />
      </div>,
    )

    expect(screen.getByText('diff.oldVersion')).toBeInTheDocument()
    expect(screen.getByText('diff.newVersion')).toBeInTheDocument()
    // 纯新增行与上下文行整行渲染，文本可直接命中
    expect(screen.getByText('extra')).toBeInTheDocument()
    expect(screen.getAllByText('omega').length).toBeGreaterThan(0)
  })

  it('highlights word-level changes in split modified rows', () => {
    const { container } = render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\nomega\n'}
          newContent={'alpha\nnew line\nomega\n'}
          viewMode="split"
          showStatusHint={false}
        />
      </div>,
    )

    // 修改行对「old line」→「new line」应产生词级高亮：删除 old / 新增 new
    const removed = container.querySelector('.diff-word-removed')
    const added = container.querySelector('.diff-word-added')
    expect(removed?.textContent).toBe('old')
    expect(added?.textContent).toBe('new')
  })

  it('renders split as two independently scrollable columns with a resize divider', () => {
    const { container } = render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\nomega\n'}
          newContent={'alpha\nnew line\nomega\n'}
          viewMode="split"
          showStatusHint={false}
        />
      </div>,
    )

    // 可拖拽分隔条存在
    expect(container.querySelector('.cursor-col-resize')).not.toBeNull()
    // 两列独立滚动容器（各含行）
    const cols = container.querySelectorAll('.overflow-auto')
    expect(cols.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps unified diff as the default view', () => {
    render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\n'}
          newContent={'alpha\nnew line\n'}
          showStatusHint={false}
        />
      </div>,
    )

    expect(screen.queryByText('diff.oldVersion')).not.toBeInTheDocument()
    // unified 视图逐行渲染，整行文本可命中
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
  })

  it('computes change focus in unified view (j/k navigation enabled)', () => {
    const { container } = render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\nomega\n'}
          newContent={'alpha\nnew line\nomega\n'}
          showStatusHint={false}
        />
      </div>,
    )

    // 修复前 unified 下 changeIndices 恒为空 → 无聚焦高亮；修复后首个变更块应高亮
    expect(container.querySelector('[class*="ring-primary"]')).not.toBeNull()
  })

  it('renders short diffs without virtualization (no height collapse)', () => {
    render(
      <DiffViewer
        oldContent={'a\nb\n'}
        newContent={'a\nc\n'}
        maxHeight="300px"
        showStatusHint={false}
      />,
    )

    // 内嵌/短内容走全量渲染，不应使用 Virtuoso（避免高度塌缩）
    expect(screen.queryByTestId('virtuoso-list')).not.toBeInTheDocument()
  })
})
