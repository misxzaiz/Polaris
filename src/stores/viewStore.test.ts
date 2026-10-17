/**
 * viewStore —— 左侧面板 tab strip 新状态/actions 单测
 *
 * 覆盖 spec `plans/sidebar-keepalive-a2-spec.md` 的验收第 7 条：
 * - activeLeftPanelType：关闭后记忆激活面板（close 不丢、toggle 更新）
 * - openMruTab：MRU 追加 + 去重 + 上限 + 自动展开
 * - closeMruTab：移除 MRU tab、不触碰 leftPanelType
 * - toggleLeftPanel/switchToLeftPanel 联动 activeLeftPanelType
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useViewStore } from './viewStore'

describe('viewStore 左侧面板 tab strip 状态', () => {
  beforeEach(() => {
    // 重置到初始态（persist 不参与单测，直接 set 全字段）
    useViewStore.setState({
      leftPanelType: 'none',
      activeLeftPanelType: 'files',
      leftPanelMru: [],
    })
  })

  describe('activeLeftPanelType（面板激活记忆）', () => {
    it('初始默认 files', () => {
      expect(useViewStore.getState().activeLeftPanelType).toBe('files')
    })

    it('closeLeftPanel 保留记忆（不重置为 none）', () => {
      useViewStore.getState().toggleLeftPanel('git') // 显示 git
      expect(useViewStore.getState().leftPanelType).toBe('git')
      useViewStore.getState().closeLeftPanel()
      expect(useViewStore.getState().leftPanelType).toBe('none')
      // 关键：close 后记忆仍为 git（strip 高亮 / 重新展开恢复）
      expect(useViewStore.getState().activeLeftPanelType).toBe('git')
    })

    it('toggle 同类型即隐藏时也更新记忆', () => {
      useViewStore.getState().toggleLeftPanel('files')
      expect(useViewStore.getState().leftPanelType).toBe('files')
      useViewStore.getState().toggleLeftPanel('files') // 再点折叠
      expect(useViewStore.getState().leftPanelType).toBe('none')
      expect(useViewStore.getState().activeLeftPanelType).toBe('files')
    })
  })

  describe('openMruTab（从 ⋯ 打开 MRU 追加 tab）', () => {
    it('追加到 MRU 并自动展开/激活', () => {
      useViewStore.getState().openMruTab('requirement')
      const s = useViewStore.getState()
      expect(s.leftPanelMru).toEqual(['requirement'])
      expect(s.leftPanelType).toBe('requirement')
      expect(s.activeLeftPanelType).toBe('requirement')
    })

    it('重复打开移到末端（MRU 语义）', () => {
      useViewStore.getState().openMruTab('requirement')
      useViewStore.getState().openMruTab('tools')
      useViewStore.getState().openMruTab('requirement')
      expect(useViewStore.getState().leftPanelMru).toEqual(['tools', 'requirement'])
    })

    it('超过 MAX_TABS=5 时裁剪最旧', () => {
      for (const p of ['a', 'b', 'c', 'd', 'e', 'f']) useViewStore.getState().openMruTab(p)
      expect(useViewStore.getState().leftPanelMru).toEqual(['b', 'c', 'd', 'e', 'f'])
    })
  })

  describe('closeMruTab（关闭 MRU tab）', () => {
    it('从 MRU 移除且不触碰 leftPanelType', () => {
      useViewStore.getState().openMruTab('requirement')
      useViewStore.getState().openMruTab('tools')
      useViewStore.getState().closeMruTab('requirement')
      const s = useViewStore.getState()
      expect(s.leftPanelMru).toEqual(['tools'])
      // 关闭非激活 tab：leftPanelType 不变
      expect(s.leftPanelType).toBe('tools')
    })

    it('关闭不存在的 tab 为空操作', () => {
      useViewStore.getState().closeMruTab('nope')
      expect(useViewStore.getState().leftPanelMru).toEqual([])
    })
  })

  describe('legacy actions 联动 activeLeftPanelType', () => {
    it('switchToLeftPanel 更新记忆', () => {
      useViewStore.getState().switchToLeftPanel('terminal')
      expect(useViewStore.getState().activeLeftPanelType).toBe('terminal')
    })

    it('setLeftPanelType 更新记忆', () => {
      useViewStore.getState().setLeftPanelType('browser')
      expect(useViewStore.getState().activeLeftPanelType).toBe('browser')
    })
  })
})