/**
 * pluginLifecycleSubscriber 单元测试（P0）
 *
 * 验收（plans/plugin-manage-hook-inject-v1.md §9）：
 * - plugin.lifecycle 事件到达 → loadPluginStates 刷新开关真相
 * - install/uninstall/update → 额外触发 discoverInstalledPlugins + replaceInstalled 重同步注册表
 * - state_changed → 仅刷新状态，不重发现
 * - cleanup 取消监听；cleanup 后事件不再处理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- mocks ---
// vitest hoist 约束：vi.mock 工厂被提升到 import 之前，不能访问顶层 const；
// 需用 vi.hoisted 提升共享 spy（其工厂内 vi 可用，vitest 官方标准模式）。
const mocks = vi.hoisted(() => ({
  mockListen: vi.fn(),
  mockLoadPluginStates: vi.fn(),
  mockDiscover: vi.fn(),
  mockReplaceInstalled: vi.fn(),
  mockWorkspacePath: { value: null as string | null },
}))

vi.mock('@/services/transport', () => ({
  listen: (...args: unknown[]) => mocks.mockListen(...args),
}))
vi.mock('@/stores/pluginStore', () => ({
  usePluginStore: {
    getState: () => ({
      loadPluginStates: mocks.mockLoadPluginStates,
    }),
  },
}))
vi.mock('@/services/pluginDiscoveryService', () => ({
  discoverInstalledPlugins: (...args: unknown[]) => mocks.mockDiscover(...args),
}))
vi.mock('@/plugin-system', () => ({
  pluginRegistry: {
    replaceInstalled: mocks.mockReplaceInstalled,
  },
}))
vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      getCurrentWorkspace: () =>
        mocks.mockWorkspacePath.value ? { path: mocks.mockWorkspacePath.value } : null,
    }),
  },
}))

// Import after mocking
import { initPluginLifecycleSubscriber, type PluginLifecycleEvent } from './pluginLifecycleSubscriber'

function captureHandler() {
  const listenArgs = mocks.mockListen.mock.calls[0]!
  return listenArgs[1] as (e: PluginLifecycleEvent) => void
}

function makeEvent(event: PluginLifecycleEvent['event'], pluginId = 'polaris.ask'): PluginLifecycleEvent {
  return { event, pluginId, installPath: 'C:/plugins/polaris.ask' }
}

describe('pluginLifecycleSubscriber (P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockListen.mockResolvedValue(() => {})
    mocks.mockLoadPluginStates.mockResolvedValue(undefined)
    mocks.mockDiscover.mockResolvedValue({ plugins: [{ id: 'discovered-1' }], errors: [] })
    mocks.mockReplaceInstalled.mockResolvedValue(undefined)
    mocks.mockWorkspacePath.value = 'C:/workspace'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('监听 plugin.lifecycle 事件', () => {
    initPluginLifecycleSubscriber()
    expect(mocks.mockListen.mock.calls[0]![0]).toBe('plugin.lifecycle')
  })

  it('任何事件 → 刷新插件状态（loadPluginStates）', async () => {
    initPluginLifecycleSubscriber()
    const handler = captureHandler()

    handler(makeEvent('state_changed'))
    handler(makeEvent('installed'))
    handler(makeEvent('uninstalled'))
    handler(makeEvent('updated'))

    await vi.waitFor(() => expect(mocks.mockLoadPluginStates).toHaveBeenCalledTimes(4))
  })

  it('installed → discover + replaceInstalled 重同步注册表（携带工作区路径）', async () => {
    initPluginLifecycleSubscriber()
    const handler = captureHandler()

    handler(makeEvent('installed'))

    await vi.waitFor(() => expect(mocks.mockDiscover).toHaveBeenCalledTimes(1))
    expect(mocks.mockDiscover).toHaveBeenCalledWith('C:/workspace')
    await vi.waitFor(() =>
      expect(mocks.mockReplaceInstalled).toHaveBeenCalledWith([{ id: 'discovered-1' }])
    )
  })

  it('uninstalled/updated 同样触发重发现', async () => {
    initPluginLifecycleSubscriber()
    const handler = captureHandler()

    handler(makeEvent('uninstalled'))
    await vi.waitFor(() => expect(mocks.mockDiscover).toHaveBeenCalledTimes(1))

    handler(makeEvent('updated'))
    await vi.waitFor(() => expect(mocks.mockDiscover).toHaveBeenCalledTimes(2))
  })

  it('state_changed → 不触发重发现', async () => {
    initPluginLifecycleSubscriber()
    const handler = captureHandler()

    handler(makeEvent('state_changed'))

    await vi.waitFor(() => expect(mocks.mockLoadPluginStates).toHaveBeenCalledTimes(1))
    expect(mocks.mockDiscover).not.toHaveBeenCalled()
    expect(mocks.mockReplaceInstalled).not.toHaveBeenCalled()
  })

  it('discover / replace 失败不抛异常（前端不炸）', async () => {
    mocks.mockDiscover.mockRejectedValue(new Error('discover boom'))

    initPluginLifecycleSubscriber()
    const handler = captureHandler()

    expect(() => handler(makeEvent('installed'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    expect(mocks.mockDiscover).toHaveBeenCalledTimes(1)
  })

  it('cleanup 取消监听（unlisten）', async () => {
    const mockUnlisten = vi.fn()
    mocks.mockListen.mockResolvedValue(mockUnlisten)

    const cleanup = initPluginLifecycleSubscriber()
    // listen resolve 是异步的（实现里 .then 后才设 unlisten），等它 settle
    await vi.waitFor(() => expect(mocks.mockListen).toHaveBeenCalledTimes(1))
    cleanup()

    expect(mockUnlisten).toHaveBeenCalledTimes(1)
  })

  it('cleanup 置 disposed 后 handler 幂等防泄漏（重复 cleanup 安全）', async () => {
    const mockUnlisten = vi.fn()
    mocks.mockListen.mockResolvedValue(mockUnlisten)

    const cleanup = initPluginLifecycleSubscriber()
    await vi.waitFor(() => expect(mocks.mockListen).toHaveBeenCalledTimes(1))

    cleanup()
    cleanup() // 幂等：unlisten 已置 null，重复调用不应二次触发

    expect(mockUnlisten).toHaveBeenCalledTimes(1)
  })
})