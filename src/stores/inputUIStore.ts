/**
 * 输入区即时调节 Store（cap.ui.input 的状态真相）
 *
 * 让 AI（经 bus_dispatch → cap.ui.input）在运行时即时调节输入区 UI：
 * - 悬浮层参数（发送按钮上浮窗的开合/高度/间距）
 * - 上下文用量条可见性
 * - 动态横幅（输入区上方注入一条带文案 + 可选动作的条）
 *
 * 设计要点：
 * - Zustand + localStorage 持久化（persist(config / banner)）；
 *   悬浮层参数与横幅由 AI 即时写入，重启保留。
 * - 状态真相在此 store；cap.ui.input 后端只校验 + 审计 + 转发。
 * - 默认值与 ChatInput 现有渲染一致（AI patch 前无感知差异）。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createLogger } from '@/utils/logger'
import { dispatchCapUiAction } from '@/services/uiDispatchService'

const log = createLogger('InputUIStore')

/** 输入区悬浮浮窗配置 */
export interface InputFloatingConfig {
  /** 是否显示发送按钮上方的悬浮浮窗（如 / 建议、@ 提及） */
  enabled: boolean
  /** 悬浮浮窗最大高度（px） */
  height: number
  /** 悬浮浮窗与输入框的间距 */
  gap: string
}

/** 动态横幅动作（点击横幅执行 dispatch） */
export interface BannerAction {
  label: string
  dispatch?: {
    target: string
    payload?: Record<string, unknown>
  }
}

/** 输入区动态横幅 */
export interface InputBanner {
  id: string
  text: string
  tone: 'info' | 'warn' | 'success' | 'danger'
  action?: BannerAction
}

/** 输入区 UI 状态 */
export interface InputUIState {
  /** 悬浮浮窗配置 */
  floating: InputFloatingConfig
  /** 上下文用量条是否可见 */
  showContextMeter: boolean
  /** 当前动态横幅（null = 无） */
  banner: InputBanner | null

  // ===== Actions =====
  /** 应用 cap.ui.input patch 的 config */
  applyConfigPatch: (patch: Partial<{
    floating: Partial<InputFloatingConfig>
    showContextMeter: boolean
  }>) => void
  /** 设置或清除动态横幅（AI 注入） */
  setBanner: (banner: InputBanner | null) => void
  /** 恢复默认（清横幅 + 复原悬浮层与上下文条） */
  reset: () => void
  /** 横幅动作点击回调（执行 dispatch） */
  dispatchBannerAction: (action: BannerAction) => void
}

export const DEFAULT_INPUT_UI: Pick<InputUIState, 'floating' | 'showContextMeter' | 'banner'> = {
  floating: { enabled: true, height: 320, gap: '0.5rem' },
  showContextMeter: true,
  banner: null,
}

export function normalizeInputUI(
  partial?: Partial<Pick<InputUIState, 'floating' | 'showContextMeter' | 'banner'>> | null,
): Pick<InputUIState, 'floating' | 'showContextMeter' | 'banner'> {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_INPUT_UI }
  const floating = {
    enabled: typeof partial.floating?.enabled === 'boolean' ? partial.floating.enabled : DEFAULT_INPUT_UI.floating.enabled,
    height: typeof partial.floating?.height === 'number' && partial.floating.height > 0
      ? partial.floating.height
      : DEFAULT_INPUT_UI.floating.height,
    gap: typeof partial.floating?.gap === 'string' && partial.floating.gap
      ? partial.floating.gap
      : DEFAULT_INPUT_UI.floating.gap,
  }
  return {
    floating,
    showContextMeter: typeof partial.showContextMeter === 'boolean'
      ? partial.showContextMeter
      : DEFAULT_INPUT_UI.showContextMeter,
    banner: partial.banner && typeof partial.banner === 'object'
      ? partial.banner
      : null,
  }
}

export const useInputUIStore = create<InputUIState>()(
  persist(
    (set) => ({
      ...DEFAULT_INPUT_UI,

      applyConfigPatch: (patch) =>
        set((state) => {
          const floating = {
            ...state.floating,
            ...(patch.floating ?? {}),
          }
          return {
            floating,
            showContextMeter:
              typeof patch.showContextMeter === 'boolean'
                ? patch.showContextMeter
                : state.showContextMeter,
          }
        }),

      setBanner: (banner) =>
        set(() => ({
          banner: banner
            ? { ...banner, id: banner.id || `banner-${Date.now()}` }
            : null,
        })),

      reset: () =>
        set(() => ({
          ...DEFAULT_INPUT_UI,
        })),

      dispatchBannerAction: (action) => {
        if (!action.dispatch) {
          log.warn('Banner action 无 dispatch', { label: action.label })
          return
        }
        const { target, payload } = action.dispatch
        void dispatchCapUiAction(target, payload ?? {})
      },
    }),
    {
      name: 'polaris.input-ui',
      version: 1,
      partialize: (state) => ({
        floating: state.floating,
        showContextMeter: state.showContextMeter,
        banner: state.banner,
      }),
    },
  ),
)

// ===== helpers =====

/** 快捷：AI 应用 cap.ui.input 的 config → inputUIStore */
export function applyInputUiConfig(
  action: string,
  payload: Record<string, unknown>,
): { ok: boolean; message: string } {
  try {
    const store = useInputUIStore.getState()
    switch (action) {
      case 'get': {
        return {
          ok: true,
          message: JSON.stringify({
            floating: store.floating,
            showContextMeter: store.showContextMeter,
            banner: store.banner,
          }),
        }
      }
      case 'patch': {
        const config = (payload.config ?? {}) as Record<string, unknown>
        const keys = Object.keys(config)
        if (keys.length === 0) return { ok: false, message: 'config 为空' }
        store.applyConfigPatch(config as never)
        return { ok: true, message: `已更新输入区 UI: ${keys.join(', ')}` }
      }
      case 'banner': {
        const banner = payload.banner as InputBanner | null | undefined
        if (banner === null || false) {
          store.setBanner(null)
          return { ok: true, message: '已清除输入区横幅' }
        }
        if (!banner || typeof banner !== 'object' || !banner.text) {
          return { ok: false, message: 'banner 格式错误（需 text）' }
        }
        store.setBanner(banner)
        return { ok: true, message: `已注入横幅: ${banner.text}` }
      }
      case 'reset': {
        store.reset()
        return { ok: true, message: '已重置输入区 UI' }
      }
      default:
        return { ok: false, message: `cap.ui.input 未知动作: ${action}` }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('applyInputUiConfig failed', err, { action: String(action) })
    return { ok: false, message: `应用输入区 UI 失败: ${err.message}` }
  }
}