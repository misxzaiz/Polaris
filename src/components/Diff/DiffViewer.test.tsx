import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffViewer } from './DiffViewer'

describe('DiffViewer', () => {
  it('renders split diff with old and new columns', () => {
    render(
      <DiffViewer
        oldContent={'alpha\nold line\nomega\n'}
        newContent={'alpha\nnew line\nomega\nextra\n'}
        viewMode="split"
        showStatusHint={false}
      />
    )

    expect(screen.getByText('diff.oldVersion')).toBeInTheDocument()
    expect(screen.getByText('diff.newVersion')).toBeInTheDocument()
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
    expect(screen.getByText('extra')).toBeInTheDocument()
  })

  it('keeps unified diff as the default view', () => {
    render(
      <DiffViewer
        oldContent={'alpha\nold line\n'}
        newContent={'alpha\nnew line\n'}
        showStatusHint={false}
      />
    )

    expect(screen.queryByText('diff.oldVersion')).not.toBeInTheDocument()
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
  })
})
