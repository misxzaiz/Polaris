/**
 * sweepPluginDefaultSlots 冒烟测试
 *
 * 真实读 pluginRegistry 中已注册的内置插件 contribution,验证 sweep:
 * - 首次调用时把没在任何 slot 的 module 安置到 defaultSlot
 * - 第二次调用是 no-op (seenModules 已标)
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { sweepPluginDefaultSlots } from './pluginDefaultSlots'
import { useLayoutStore } from './layoutStore'
import { DEFAULT_LAYOUT_SNAPSHOT, DEFAULT_PRESET_ID } from '@/config/layoutPresets'

function resetLayoutStore() {
  useLayoutStore.setState({
    slots: structuredClone(DEFAULT_LAYOUT_SNAPSHOT.slots),
    activityBarPosition: DEFAULT_LAYOUT_SNAPSHOT.activityBarPosition,
    activePresetId: DEFAULT_PRESET_ID,
    customLayouts: [],
    seenModules: [],
  })
}

describe('sweepPluginDefaultSlots', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLayoutStore()
  })

  afterEach(() => {
    localStorage.clear()
    resetLayoutStore()
  })

  it('is idempotent: second call returns empty', () => {
    sweepPluginDefaultSlots() // 首次
    const second = sweepPluginDefaultSlots()
    expect(second).toEqual([])
  })

  it('marks all builtin module ids as seen after first sweep', () => {
    sweepPluginDefaultSlots()
    const seen = useLayoutStore.getState().seenModules
    // 至少 chat / files / git 等 core 模块被标
    expect(seen).toEqual(expect.arrayContaining(['chat', 'files', 'git', 'terminal']))
  })

  it('does not duplicate modules already present in developer preset', () => {
    // developer 默认 left=[files, git] right=[chat] bottom=[terminal, problems]
    sweepPluginDefaultSlots()
    const state = useLayoutStore.getState()
    // 不应有重复
    const countFiles = (
      state.slots.left.modules.filter((m) => m === 'files').length +
      state.slots.right.modules.filter((m) => m === 'files').length +
      state.slots.bottom.modules.filter((m) => m === 'files').length
    )
    expect(countFiles).toBe(1)
  })
})
