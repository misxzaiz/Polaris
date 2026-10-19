import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INPUT_UI, applyInputUiConfig, useInputUIStore } from './inputUIStore'

// Mock uiDispatchService：banner 动作点击会调 router_dispatch，测试中不应真实 invoke。
vi.mock('@/services/uiDispatchService', () => ({
  dispatchCapUiAction: vi.fn().mockResolvedValue({}),
  applyInputUiConfig: vi.fn(),
}))

describe('inputUIStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useInputUIStore.setState({ ...DEFAULT_INPUT_UI })
  })

  describe('applyConfigPatch', () => {
    it('部分更新悬浮层参数且保留其余默认值', () => {
      useInputUIStore.getState().applyConfigPatch({ floating: { height: 480 } })
      const state = useInputUIStore.getState()
      expect(state.floating.height).toBe(480)
      expect(state.floating.enabled).toBe(true)
      expect(state.floating.gap).toBe('0.5rem')
      expect(state.showContextMeter).toBe(true)
    })

    it('支持切换 showContextMeter', () => {
      useInputUIStore.getState().applyConfigPatch({ showContextMeter: false })
      expect(useInputUIStore.getState().showContextMeter).toBe(false)
    })
  })

  describe('setBanner', () => {
    it('设置横幅时自动补 id（无 id 入参）', () => {
      useInputUIStore.getState().setBanner({ text: '你好', tone: 'info' })
      const banner = useInputUIStore.getState().banner
      expect(banner).not.toBeNull()
      expect(banner!.text).toBe('你好')
      expect(banner!.tone).toBe('info')
      expect(banner!.id).toBeTruthy()
    })

    it('保留显式 id 并支持动作', () => {
      useInputUIStore.getState().setBanner({
        id: 'custom-id',
        text: '待办未完成',
        tone: 'warn',
        action: { label: '查看', dispatch: { target: 'cap.todo' } },
      })
      const banner = useInputUIStore.getState().banner
      expect(banner!.id).toBe('custom-id')
      expect(banner!.action?.dispatch?.target).toBe('cap.todo')
    })

    it('传入 null 清除横幅', () => {
      useInputUIStore.getState().setBanner({ text: 'x', tone: 'info' })
      expect(useInputUIStore.getState().banner).not.toBeNull()
      useInputUIStore.getState().setBanner(null)
      expect(useInputUIStore.getState().banner).toBeNull()
    })
  })

  describe('reset', () => {
    it('恢复全部默认值并清横幅', () => {
      useInputUIStore.getState().applyConfigPatch({ floating: { height: 100, enabled: false }, showContextMeter: false })
      useInputUIStore.getState().setBanner({ text: 'x', tone: 'danger' })
      useInputUIStore.getState().reset()
      expect(useInputUIStore.getState()).toMatchObject(DEFAULT_INPUT_UI)
    })
  })

  describe('applyInputUiConfig（AI 工具动作入口）', () => {
    it('patch 破路径拒绝', () => {
      const r = applyInputUiConfig('patch', {})
      expect(r.ok).toBe(false)
    })

    it('patch 应用到 store', () => {
      const r = applyInputUiConfig('patch', { config: { floating: { height: 360 } } })
      expect(r.ok).toBe(true)
      expect(useInputUIStore.getState().floating.height).toBe(360)
    })

    it('banner 注入横幅', () => {
      const r = applyInputUiConfig('banner', { banner: { text: '提示', tone: 'info' } })
      expect(r.ok).toBe(true)
      expect(useInputUIStore.getState().banner?.text).toBe('提示')
    })

    it('banner 传 null 清除', () => {
      useInputUIStore.getState().setBanner({ text: '旧', tone: 'info' })
      const r = applyInputUiConfig('banner', { banner: null })
      expect(r.ok).toBe(true)
      expect(useInputUIStore.getState().banner).toBeNull()
    })

    it('banner 缺 text 拒绝', () => {
      const r = applyInputUiConfig('banner', { banner: { tone: 'info' } })
      expect(r.ok).toBe(false)
    })

    it('reset 恢复默认', () => {
      useInputUIStore.getState().applyConfigPatch({ floating: { height: 200 } })
      applyInputUiConfig('reset', {})
      expect(useInputUIStore.getState().floating.height).toBe(DEFAULT_INPUT_UI.floating.height)
    })

    it('未知动作返回错误', () => {
      const r = applyInputUiConfig('evil', {})
      expect(r.ok).toBe(false)
    })
  })
})