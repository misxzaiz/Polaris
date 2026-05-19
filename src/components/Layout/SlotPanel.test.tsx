/**
 * SlotPanel 组件测试
 *
 * 测试核心行为:
 * - 折叠态 / 空槽位返回 null
 * - 单模块不渲染 ModuleTabBar
 * - 多模块渲染 ModuleTabBar
 * - 仅渲染 active 模块 (非 keep-alive — 切换 Tab 会 unmount)
 * - bareRender 模式跳过 ModuleTabBar
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SlotPanel } from './SlotPanel'
import { useLayoutStore } from '@/stores/layoutStore'
import { DEFAULT_LAYOUT_SNAPSHOT, DEFAULT_PRESET_ID } from '@/config/layoutPresets'

// Mock ModuleRenderer 以避免引入真实模块的复杂依赖
vi.mock('./ModuleRenderer', () => ({
  ModuleRenderer: ({ moduleId }: { moduleId: string }) => (
    <div data-testid={`mod-${moduleId}`}>Module: {moduleId}</div>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k }),
}))

vi.mock('@/plugin-system', async () => {
  const actual = await vi.importActual<typeof import('@/plugin-system')>('@/plugin-system')
  return {
    ...actual,
    pluginRegistry: {
      listViewContributions: () => [
        {
          id: 'files.panel',
          pluginId: 'core',
          area: 'activityBar',
          moduleId: 'files',
          icon: 'Files',
          labelKey: 'labels.files',
          labelDefault: 'Files',
          order: 10,
        },
        {
          id: 'git.panel',
          pluginId: 'core',
          area: 'activityBar',
          moduleId: 'git',
          icon: 'GitPullRequest',
          labelKey: 'labels.git',
          labelDefault: 'Git',
          order: 20,
        },
        {
          id: 'chat.panel',
          pluginId: 'core',
          area: 'activityBar',
          moduleId: 'chat',
          icon: 'Bot',
          labelKey: 'labels.chat',
          labelDefault: 'Chat',
          order: 5,
          bareRender: true,
        },
        {
          id: 'terminal.panel',
          pluginId: 'core',
          area: 'activityBar',
          moduleId: 'terminal',
          icon: 'Terminal',
          labelKey: 'labels.terminal',
          labelDefault: 'Terminal',
          order: 70,
          keepAlive: true,
        },
        {
          id: 'problems.panel',
          pluginId: 'core',
          area: 'activityBar',
          moduleId: 'problems',
          icon: 'AlertCircle',
          labelKey: 'labels.problems',
          labelDefault: 'Problems',
          order: 110,
        },
      ],
    },
    pluginIconMap: {
      Files: () => <span data-testid="icon-files" />,
      GitPullRequest: () => <span data-testid="icon-git" />,
      Bot: () => <span data-testid="icon-bot" />,
      Terminal: () => <span data-testid="icon-terminal" />,
      AlertCircle: () => <span data-testid="icon-alert" />,
    },
  }
})

function resetLayoutStore() {
  act(() => {
    useLayoutStore.setState({
      slots: structuredClone(DEFAULT_LAYOUT_SNAPSHOT.slots),
      activityBarPosition: DEFAULT_LAYOUT_SNAPSHOT.activityBarPosition,
      activePresetId: DEFAULT_PRESET_ID,
      customLayouts: [],
      seenModules: [],
    })
  })
}

/** 包裹 store 写入,避免 React 19 测试在 render 前修改订阅 store 报 act 警告 */
function setSlots(updater: (slots: typeof DEFAULT_LAYOUT_SNAPSHOT.slots) => typeof DEFAULT_LAYOUT_SNAPSHOT.slots) {
  act(() => {
    useLayoutStore.setState((s) => ({ slots: updater(s.slots) }))
  })
}

describe('SlotPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLayoutStore()
  })

  afterEach(() => {
    resetLayoutStore()
  })

  it('returns null when slot has no modules', () => {
    setSlots((s) => ({ ...s, right: { modules: [], activeModule: null, size: 200 } }))
    const { container } = render(<SlotPanel slot="right" />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when slot is collapsed (activeModule=null)', () => {
    setSlots((s) => ({ ...s, left: { modules: ['files'], activeModule: null, size: 280 } }))
    const { container } = render(<SlotPanel slot="left" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a single module without a tab bar', () => {
    setSlots((s) => ({ ...s, left: { modules: ['files'], activeModule: 'files', size: 280 } }))
    render(<SlotPanel slot="left" />)
    expect(screen.getByTestId('mod-files')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
  })

  it('renders a tab bar when slot has multiple modules', () => {
    setSlots((s) => ({ ...s, left: { modules: ['files', 'git'], activeModule: 'files', size: 280 } }))
    render(<SlotPanel slot="left" />)
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Git/ })).toBeInTheDocument()
  })

  it('only mounts the active module (no keep-alive)', () => {
    setSlots((s) => ({ ...s, left: { modules: ['files', 'git'], activeModule: 'files', size: 280 } }))
    render(<SlotPanel slot="left" />)
    expect(screen.getByTestId('mod-files')).toBeInTheDocument()
    expect(screen.queryByTestId('mod-git')).toBeNull()
  })

  it('keeps keepAlive modules mounted (with display:none) when not active', () => {
    // bottom 槽位有 terminal (keepAlive=true) 和 problems (keepAlive=false)
    // active = problems → terminal 应该被 mount 但 display:none, problems 渲染
    setSlots((s) => ({
      ...s,
      bottom: {
        modules: ['terminal', 'problems'],
        activeModule: 'problems',
        size: 200,
      },
    }))
    const { container } = render(<SlotPanel slot="bottom" />)
    // 两个模块都 mount
    expect(screen.getByTestId('mod-terminal')).toBeInTheDocument()
    expect(screen.getByTestId('mod-problems')).toBeInTheDocument()
    // terminal (非 active) display:none, problems (active) display:flex
    const terminalWrapper = container.querySelector('[data-module-id="terminal"]') as HTMLElement
    const problemsWrapper = container.querySelector('[data-module-id="problems"]') as HTMLElement
    expect(terminalWrapper.style.display).toBe('none')
    expect(problemsWrapper.style.display).toBe('flex')
    expect(terminalWrapper.getAttribute('aria-hidden')).toBe('true')
    expect(problemsWrapper.getAttribute('aria-hidden')).toBe('false')
    expect(terminalWrapper.dataset.keepAlive).toBe('1')
  })

  it('does NOT mount non-keepAlive modules when not active', () => {
    // problems 非 keepAlive: 切走时应不渲染
    setSlots((s) => ({
      ...s,
      bottom: {
        modules: ['terminal', 'problems'],
        activeModule: 'terminal',
        size: 200,
      },
    }))
    render(<SlotPanel slot="bottom" />)
    expect(screen.getByTestId('mod-terminal')).toBeInTheDocument()
    expect(screen.queryByTestId('mod-problems')).toBeNull()
  })

  it('skips tab bar in bareRender mode even with multiple modules', () => {
    setSlots((s) => ({
      ...s,
      right: { modules: ['chat', 'files'], activeModule: 'chat', size: 400 },
    }))
    render(<SlotPanel slot="right" />)
    // chat 是 bareRender=true,Tab Bar 不应渲染
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Chat/ })).toBeNull()
  })

  it('applies horizontal size for left slot', () => {
    setSlots((s) => ({ ...s, left: { modules: ['files'], activeModule: 'files', size: 250 } }))
    const { container } = render(<SlotPanel slot="left" />)
    const aside = container.querySelector('aside')
    expect(aside?.style.width).toBe('250px')
  })

  it('applies vertical size for bottom slot', () => {
    setSlots((s) => ({
      ...s,
      bottom: { modules: ['terminal'], activeModule: 'terminal', size: 180 },
    }))
    const { container } = render(<SlotPanel slot="bottom" />)
    const aside = container.querySelector('aside')
    expect(aside?.style.height).toBe('180px')
  })
})
