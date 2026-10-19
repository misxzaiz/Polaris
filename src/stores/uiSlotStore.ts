/**
 * 插槽式 UI 改造 Store（cap.self.mutate 的状态真相）
 *
 * 让 AI（经 bus_dispatch → cap.self.mutate）在运行时改造自身 UI：
 * - 在白名单具名插槽（input-extra / app-badge / message-extra）内放置/替换/移除
 *   白名单组件（status-badge / tooltip-label / quick-action）
 *
 * 设计要点：
 * - Zustand + localStorage 持久化；插槽配置由 AI 即时写入，重启保留。
 * - 状态真相在此 store；cap.self.mutate 后端只校验 + 审计 + 转发。
 * - 插槽是白名单具名挂载点 —— 禁止任意 HTML/脚本，组件种类同样白名单。
 *   安全边界已在后端（SLOT_IDS / SLOT_KINDS / PROPS_KEYS）与前端（下方注册表）双校验。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createLogger } from '@/utils/logger'

const log = createLogger('UiSlotStore')

/** 合法的具名插槽挂载点（与后端 SLOT_IDS 对齐） */
export const SLOT_IDS = ['input-extra', 'app-badge', 'message-extra'] as const
export type SlotId = (typeof SLOT_IDS)[number]

/** 合法的组件种类（与后端 SLOT_KINDS 对齐） */
export const SLOT_KINDS = ['status-badge', 'tooltip-label', 'quick-action'] as const
export type SlotKind = (typeof SLOT_KINDS)[number]

/** 单个插槽的填充状态 */
export interface SlotFill {
  kind: SlotKind
  /** 组件 props（key 白名单由后端 PROPS_KEYS 校验） */
  props?: Record<string, unknown>
  /** 填充时间戳（ISO） */
  ts: string
}

/** 插槽表：slotId → 当前填充（null = 空/未注入） */
export interface SlotState {
  slots: Partial<Record<SlotId, SlotFill | null>>

  // ===== Actions =====
  /** 在插槽放置/替换组件 */
  setSlot: (slotId: string, fill: SlotFill | null) => void
  /** 移除插槽组件（回落空） */
  clearSlot: (slotId: string) => void
  /** 恢复全部插槽为空 */
  reset: () => void
}

export const DEFAULT_SLOTS: Partial<Record<SlotId, SlotFill | null>> = {}

function isSlotId(v: string): v is SlotId {
  return (SLOT_IDS as readonly string[]).includes(v)
}

export const useUiSlotStore = create<SlotState>()(
  persist(
    (set) => ({
      slots: { ...DEFAULT_SLOTS },

      setSlot: (slotId, fill) =>
        set((state) => {
          if (!isSlotId(slotId)) {
            log.warn('setSlot: 非法插槽', { slotId })
            return {}
          }
          return {
            slots: {
              ...state.slots,
              [slotId]: fill,
            },
          }
        }),

      clearSlot: (slotId) =>
        set((state) => {
          if (!isSlotId(slotId)) {
            log.warn('clearSlot: 非法插槽', { slotId })
            return {}
          }
          return {
            slots: {
              ...state.slots,
              [slotId]: null,
            },
          }
        }),

      reset: () =>
        set(() => ({
          slots: { ...DEFAULT_SLOTS },
        })),
    }),
    {
      name: 'polaris.ui-slots',
      version: 1,
      partialize: (state) => ({ slots: state.slots }),
    },
  ),
)

// ===== helpers =====

/** 从插槽表取某插槽的当前填充（无则为 null） */
export function selectSlotFill(slots: Partial<Record<SlotId, SlotFill | null>>, slotId: string): SlotFill | null {
  if (!isSlotId(slotId)) return null
  return slots[slotId] ?? null
}

/** 快捷：AI 应用 cap.self.mutate 的 setSlot/clearSlot → uiSlotStore */
export function applySelfMutateAction(
  action: string,
  payload: Record<string, unknown>,
): { ok: boolean; message: string } {
  try {
    const store = useUiSlotStore.getState()
    switch (action) {
      case 'listSlots': {
        const slots = SLOT_IDS.map((id) => ({
          id,
          current: store.slots[id] ?? null,
        }))
        return {
          ok: true,
          message: JSON.stringify({ slots }),
        }
      }
      case 'setSlot': {
        const slotId = String(payload.slotId ?? '')
        const kind = String(payload.kind ?? '')
        if (!isSlotId(slotId)) return { ok: false, message: `非法插槽: ${slotId}` }
        if (!(SLOT_KINDS as readonly string[]).includes(kind)) {
          return { ok: false, message: `非法组件种类: ${kind}` }
        }
        const props = payload.props && typeof payload.props === 'object'
          ? payload.props as Record<string, unknown>
          : undefined
        store.setSlot(slotId, {
          kind: kind as SlotKind,
          props,
          ts: new Date().toISOString(),
        })
        return { ok: true, message: `插槽 ${slotId} 已注入 ${kind}` }
      }
      case 'clearSlot': {
        const slotId = String(payload.slotId ?? '')
        if (!isSlotId(slotId)) return { ok: false, message: `非法插槽: ${slotId}` }
        store.clearSlot(slotId)
        return { ok: true, message: `插槽 ${slotId} 已清空` }
      }
      default:
        return { ok: false, message: `cap.self.mutate 未知动作: ${action}` }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('applySelfMutateAction failed', err, { action: String(action) })
    return { ok: false, message: `应用改造失败: ${err.message}` }
  }
}