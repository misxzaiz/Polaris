/**
 * ModuleShell 四件套基础渲染测试.
 *
 * 这些组件本身没有业务逻辑, 主要是 props → DOM 的契约.
 * 测试目的: 后续模块迁移时如果改 props 接口能及时发现.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ModuleShell,
  ModuleHeader,
  ModuleToolbar,
  ModuleBody,
  ModuleFooter,
} from './index'

describe('ModuleShell', () => {
  it('renders children inside flex container', () => {
    render(
      <ModuleShell>
        <div data-testid="content">Hello</div>
      </ModuleShell>
    )
    const content = screen.getByTestId('content')
    expect(content).toBeDefined()
    const shell = content.parentElement
    expect(shell?.getAttribute('data-module-shell')).toBe('1')
  })

  it('forwards className', () => {
    render(
      <ModuleShell className="custom-class">
        <span data-testid="x" />
      </ModuleShell>
    )
    const shell = screen.getByTestId('x').parentElement
    expect(shell?.className).toContain('custom-class')
  })
})

describe('ModuleHeader', () => {
  it('renders title as h2', () => {
    render(<ModuleHeader title="Git" />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Git')
  })

  it('renders icon and subtitle', () => {
    render(
      <ModuleHeader
        title="Git"
        icon={<span data-testid="icon">⎇</span>}
        subtitle="main · 3"
      />
    )
    expect(screen.getByTestId('icon')).toBeDefined()
    expect(screen.getByText('main · 3')).toBeDefined()
  })

  it('renders actions on the right', () => {
    render(
      <ModuleHeader
        title="X"
        actions={<button data-testid="refresh">⟳</button>}
      />
    )
    expect(screen.getByTestId('refresh')).toBeDefined()
  })

  it('has role=banner for assistive tech', () => {
    render(<ModuleHeader title="X" />)
    expect(screen.getByRole('banner')).toBeDefined()
  })
})

describe('ModuleToolbar', () => {
  it('renders children with role=toolbar', () => {
    render(
      <ModuleToolbar>
        <button data-testid="seg">All</button>
      </ModuleToolbar>
    )
    expect(screen.getByRole('toolbar')).toBeDefined()
    expect(screen.getByTestId('seg')).toBeDefined()
  })

  it('flexible mode removes fixed height', () => {
    const { container } = render(
      <ModuleToolbar flexible>
        <div style={{ height: 80 }}>tall content</div>
      </ModuleToolbar>
    )
    const toolbar = container.querySelector('[role="toolbar"]') as HTMLElement
    // flexible 时 height inline style 应不存在 (只设 minHeight)
    expect(toolbar.style.height).toBe('')
    expect(toolbar.style.minHeight).toBe('var(--module-toolbar-h)')
  })
})

describe('ModuleBody', () => {
  it('renders children with role=region', () => {
    render(
      <ModuleBody ariaLabel="List">
        <div data-testid="x" />
      </ModuleBody>
    )
    const region = screen.getByRole('region')
    expect(region.getAttribute('aria-label')).toBe('List')
    expect(screen.getByTestId('x')).toBeDefined()
  })

  it('noPadding removes inline padding', () => {
    const { container } = render(
      <ModuleBody noPadding>
        <div />
      </ModuleBody>
    )
    const body = container.querySelector('[role="region"]') as HTMLElement
    expect(body.style.paddingLeft).toBe('')
    expect(body.style.paddingTop).toBe('')
  })

  it('noScroll removes overflow-auto class', () => {
    const { container } = render(
      <ModuleBody noScroll>
        <div />
      </ModuleBody>
    )
    const body = container.querySelector('[role="region"]') as HTMLElement
    expect(body.className).not.toContain('overflow-auto')
  })
})

describe('ModuleFooter', () => {
  it('renders children with role=contentinfo', () => {
    render(
      <ModuleFooter>
        <span data-testid="status">Ready</span>
      </ModuleFooter>
    )
    expect(screen.getByRole('contentinfo')).toBeDefined()
    expect(screen.getByTestId('status')).toBeDefined()
  })
})

describe('ModuleShell integration (4-piece composition)', () => {
  it('renders all four pieces in correct order', () => {
    const { container } = render(
      <ModuleShell>
        <ModuleHeader title="Git" />
        <ModuleToolbar>
          <span data-testid="tb-content">tb</span>
        </ModuleToolbar>
        <ModuleBody ariaLabel="commits">
          <span data-testid="body-content">body</span>
        </ModuleBody>
        <ModuleFooter>
          <span data-testid="fo-content">fo</span>
        </ModuleFooter>
      </ModuleShell>
    )
    const shell = container.querySelector('[data-module-shell="1"]') as HTMLElement
    expect(shell).toBeDefined()
    const roles = Array.from(shell.children).map((c) => c.getAttribute('role'))
    expect(roles).toEqual(['banner', 'toolbar', 'region', 'contentinfo'])
  })
})
