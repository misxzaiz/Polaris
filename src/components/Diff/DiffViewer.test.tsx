import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffViewer } from './DiffViewer'

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
      </div>
    )

    expect(screen.getByText('diff.oldVersion')).toBeInTheDocument()
    expect(screen.getByText('diff.newVersion')).toBeInTheDocument()
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
    expect(screen.getByText('extra')).toBeInTheDocument()
  })

  it('keeps unified diff as the default view', () => {
    render(
      <div style={{ height: 600, width: 800 }}>
        <DiffViewer
          oldContent={'alpha\nold line\n'}
          newContent={'alpha\nnew line\n'}
          showStatusHint={false}
        />
      </div>
    )

    expect(screen.queryByText('diff.oldVersion')).not.toBeInTheDocument()
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
  })
})
