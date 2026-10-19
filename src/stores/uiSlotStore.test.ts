import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SLOTS,
  SLOT_IDS,
  SLOT_KINDS,
  applySelfMutateAction,
  selectSlotFill,
  useUiSlotStore,
} from './uiSlotStore'

// Mock logger：避免测试噪音。
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('uiSlotStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiSlotStore.setState({ slots: { ...DEFAULT_SLOTS } })
  })

  describe('setSlot', () => {
    it('往合法插槽放置填充', () => {
      const fill = { kind: 'status-badge' as const, props: { text: '你好' }, ts: '2026-10-19T00:00:00.000Z' }
      useUiSlotStore.getState().setSlot('input-extra', fill)
      expect(useUiSlotStore.getState().slots['input-extra']).toEqual(fill)
    })

    it('非法插槽拒绝写入', () => {
      const fill = { kind: 'quick-action' as const, props: {}, ts: '2026-10-19T00:00:00.000Z' }
      useUiSlotStore.getState().setSlot('evil-slot', fill)
      expect(useUiSlotStore.getState().slots['evil-slot']).toBeUndefined()
    })

    it('传 null 清空插槽', () => {
      useUiSlotStore.getState().setSlot('app-badge', { kind: 'tooltip-label' as const, ts: '2026-10-19T00:00:00.000Z' })
      useUiSlotStore.getState().setSlot('app-badge', null)
      expect(useUiSlotStore.getState().slots['app-badge']).toBeNull()
    })
  })

  describe('clearSlot / reset', () => {
    it('clearSlot 移除插槽填充', () => {
      useUiSlotStore.getState().setSlot('message-extra', { kind: 'status-badge' as const, ts: 'x' })
      useUiSlotStore.getState().clearSlot('message-extra')
      expect(useUiSlotStore.getState().slots['message-extra']).toBeNull()
    })

    it('reset 恢复全部为空', () => {
      useUiSlotStore.getState().setSlot('input-extra', { kind: 'quick-action' as const, ts: 'x' })
      useUiSlotStore.getState().reset()
      expect(useUiSlotStore.getState().slots).toEqual(DEFAULT_SLOTS)
    })
  })

  describe('selectSlotFill', () => {
    it('无填充返回 null，必非法插槽返回 null', () => {
      expect(selectSlotFill({}, 'input-extra')).toBeNull()
      expect(selectSlotFill({}, 'nope')).toBeNull()
    })
  })

  describe('applySelfMutateAction（AI 工具动作入口）', () => {
    it('listSlots 返回全部插槽与当前填充', () => {
      useUiSlotStore.getState().setSlot('input-extra', { kind: 'status-badge' as const, ts: '2026-10-19T00:00:00.000Z' })
      const r = applySelfMutateAction('listSlots', {})
      expect(r.ok).toBe(true)
      const parsed = JSON.parse(r.message) as { slots: Array<{ id: string; current: unknown }> }
      expect(parsed.slots).toHaveLength(SLOT_IDS.length)
      expect(parsed.slots.find(s => s.id === 'input-extra')?.current).toMatchObject({ kind: 'status-badge' })
      expect(parsed.slots.find(s => s.id === 'app-badge')?.current).toBeNull()
    })

    it('setSlot 注入到 store（含 props）', () => {
      const r = applySelfMutateAction('setSlot', {
        slotId: 'input-extra',
        kind: 'status-badge',
        props: { text: 'AI 已生效', tone: 'success' },
      })
      expect(r.ok).toBe(true)
      const fill = useUiSlotStore.getState().slots['input-extra']
      expect(fill?.kind).toBe('status-badge')
      expect(fill?.props).toMatchObject({ text: 'AI 已生效', tone: 'success' })
      expect(fill?.ts).toBeTruthy()
    })

    it('setSlot 非法插槽拒绝', () => {
      const r = applySelfMutateAction('setSlot', { slotId: 'evil', kind: 'status-badge' })
      expect(r.ok).toBe(false)
      expect(useUiSlotStore.getState().slots['evil']).toBeUndefined()
    })

    it('setSlot 非法 kind 拒绝', () => {
      const r = applySelfMutateAction('setSlot', { slotId: 'input-extra', kind: '<script>' })
      expect(r.ok).toBe(false)
      expect(useUiSlotStore.getState().slots['input-extra']).toBeUndefined()
    })

    it('clearSlot 清空指定插槽', () => {
      applySelfMutateAction('setSlot', { slotId: 'app-badge', kind: 'tooltip-label' })
      const r = applySelfMutateAction('clearSlot', { slotId: 'app-badge' })
      expect(r.ok).toBe(true)
      expect(useUiSlotStore.getState().slots['app-badge']).toBeNull()
    })

    it('未知动作返回错误', () => {
      const r = applySelfMutateAction('evil', {})
      expect(r.ok).toBe(false)
    })
  })

  describe('白名单对齐（后端 SLOT_IDS / SLOT_KINDS 一致）', () => {
    it('SLOT_KINDS 仅含白名单组件', () => {
      expect(SLOT_KINDS).toEqual(['status-badge', 'tooltip-label', 'quick-action'])
    })
  })
})