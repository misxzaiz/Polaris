/**
 * 一次性迁移: 旧 view-store (localStorage) 中的布局偏好 → layoutStore
 *
 * 背景:
 *   9.2.8 及更早版本将 leftPanelType / rightPanelCollapsed / activityBarCollapsed
 *   等布局相关字段存在 zustand-persist 的 `view-store` 中。9.2.9 起这些字段被
 *   迁移到新的 `layout-store`,但 zustand persist 是按 store name 隔离的,
 *   旧用户首次启动新版本会丢失偏好。
 *
 * 本模块在 App 顶层调用一次:
 *   - 仅在 layout-store 不存在(首次创建)且 view-store 存在旧字段时触发
 *   - 把旧字段映射成 LayoutSnapshot,叠加到 developer 预设之上写入 layout-store
 *   - 不删除旧的 view-store 数据(让 viewStore 自己负责后续清理)
 *   - 失败时静默 fallback 到 default,绝不抛错阻塞启动
 *
 * 设计要点:
 *   - 迁移函数本身为纯函数 (输入旧字段对象,输出 Partial<LayoutState>),便于单测
 *   - localStorage 读写在副作用函数中,带 SSR/无 storage 守卫
 */

import { useEffect, useRef } from 'react'
import { useLayoutStore } from './layoutStore'
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  DEFAULT_PRESET_ID,
} from '@/config/layoutPresets'
import { CUSTOM_PRESET_ID } from './layoutStore'
import type {
  ActivityBarPosition,
  LayoutSnapshot,
  ModuleId,
  SlotState,
} from '@/types/layout'
import { createLogger } from '@/utils/logger'

const log = createLogger('LayoutStoreMigration')

const LAYOUT_STORE_KEY = 'layout-store'
const VIEW_STORE_KEY = 'view-store'

/** 旧版本可识别的 LeftPanelType (从 9.2.8 viewStore 复制) */
const LEGACY_LEFT_PANEL_TYPES = new Set<string>([
  'files',
  'git',
  'todo',
  'translate',
  'scheduler',
  'longGoal',
  'requirement',
  'terminal',
  'tools', // 旧版 'tools' 概念已废弃,等同于 'developer'
  'developer',
  'integration',
  'problems',
  'demoPlugin',
  'none',
])

/** 旧字段子集 (其他字段不影响布局,忽略) */
export interface LegacyViewPrefs {
  leftPanelType?: string | null
  leftPanelWidth?: number
  rightPanelWidth?: number
  rightPanelCollapsed?: boolean
  activityBarCollapsed?: boolean
}

/**
 * 把旧 LeftPanelType 字符串映射到新 ModuleId.
 * - 'none' → null (无 active)
 * - 'tools' → 'developer' (旧概念合并)
 * - 未知值 → null (保守 fallback)
 */
export function mapLegacyLeftPanelType(value: unknown): ModuleId | null {
  if (typeof value !== 'string') return null
  if (!LEGACY_LEFT_PANEL_TYPES.has(value)) return null
  if (value === 'none') return null
  if (value === 'tools') return 'developer'
  return value as ModuleId
}

/**
 * 纯函数: 把旧 viewStore 偏好对象翻译为 layoutStore 的初始 state.
 * 以 developer 预设为骨架,逐字段覆盖.
 *
 * 注意: 此函数完全确定,无副作用,便于单测.
 */
export function migrateLegacyViewPrefs(legacy: LegacyViewPrefs): {
  slots: Record<string, SlotState>
  activityBarPosition: ActivityBarPosition
  activePresetId: string
} {
  // 1) 以 developer 预设作为骨架, 深拷贝避免污染常量
  const base: LayoutSnapshot = {
    slots: {
      left: {
        modules: [...DEFAULT_LAYOUT_SNAPSHOT.slots.left.modules],
        activeModule: DEFAULT_LAYOUT_SNAPSHOT.slots.left.activeModule,
        size: DEFAULT_LAYOUT_SNAPSHOT.slots.left.size,
      },
      right: {
        modules: [...DEFAULT_LAYOUT_SNAPSHOT.slots.right.modules],
        activeModule: DEFAULT_LAYOUT_SNAPSHOT.slots.right.activeModule,
        size: DEFAULT_LAYOUT_SNAPSHOT.slots.right.size,
      },
      center: {
        modules: [...DEFAULT_LAYOUT_SNAPSHOT.slots.center.modules],
        activeModule: DEFAULT_LAYOUT_SNAPSHOT.slots.center.activeModule,
        size: DEFAULT_LAYOUT_SNAPSHOT.slots.center.size,
      },
      bottom: {
        modules: [...DEFAULT_LAYOUT_SNAPSHOT.slots.bottom.modules],
        activeModule: DEFAULT_LAYOUT_SNAPSHOT.slots.bottom.activeModule,
        size: DEFAULT_LAYOUT_SNAPSHOT.slots.bottom.size,
      },
    },
    activityBarPosition: DEFAULT_LAYOUT_SNAPSHOT.activityBarPosition,
  }

  // 2) leftPanelType: 决定 left.activeModule
  //    - 若旧 type 不在 developer 预设的 left.modules 中,把它追加进去
  //    - 若旧 type = 'none' → left.activeModule=null (槽位折叠), modules 保持骨架
  const mappedLeft = mapLegacyLeftPanelType(legacy.leftPanelType)
  if (mappedLeft === null) {
    if (legacy.leftPanelType === 'none') {
      base.slots.left.activeModule = null
    }
    // 未知 leftPanelType: 保持 developer 默认 ('files'),不动
  } else {
    base.slots.left.activeModule = mappedLeft
    if (!base.slots.left.modules.includes(mappedLeft)) {
      base.slots.left.modules.push(mappedLeft)
    }
  }

  // 3) leftPanelWidth → left.size (走 layoutStore 的 clamp 范围)
  if (typeof legacy.leftPanelWidth === 'number' && Number.isFinite(legacy.leftPanelWidth)) {
    base.slots.left.size = legacy.leftPanelWidth
  }

  // 4) rightPanelWidth → right.size
  if (typeof legacy.rightPanelWidth === 'number' && Number.isFinite(legacy.rightPanelWidth)) {
    base.slots.right.size = legacy.rightPanelWidth
  }

  // 5) rightPanelCollapsed → right.activeModule null/'chat'
  if (legacy.rightPanelCollapsed === true) {
    base.slots.right.activeModule = null
  }

  // 6) activityBarCollapsed → activityBarPosition
  if (legacy.activityBarCollapsed === true) {
    base.activityBarPosition = 'hidden'
  }

  // 任何字段被改过 → 标记为 custom (不和任何预设完全一致)
  const isCustom =
    mappedLeft !== null ||
    legacy.leftPanelType === 'none' ||
    legacy.rightPanelCollapsed === true ||
    legacy.activityBarCollapsed === true ||
    typeof legacy.leftPanelWidth === 'number' ||
    typeof legacy.rightPanelWidth === 'number'

  return {
    slots: base.slots,
    activityBarPosition: base.activityBarPosition,
    activePresetId: isCustom ? CUSTOM_PRESET_ID : DEFAULT_PRESET_ID,
  }
}

/**
 * 从 localStorage 解析旧 view-store 数据.
 * 返回 null 表示无可用数据 (不存在 / 解析失败 / 格式不符).
 */
function readLegacyViewPrefs(): LegacyViewPrefs | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  let raw: string | null
  try {
    raw = window.localStorage.getItem(VIEW_STORE_KEY)
  } catch {
    return null // localStorage 被禁用或 quota 异常
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown } | null
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null
    const state = parsed.state as Record<string, unknown>
    // 至少有一个布局相关字段才认为是"有效旧数据"
    const hasLegacy =
      'leftPanelType' in state ||
      'leftPanelWidth' in state ||
      'rightPanelWidth' in state ||
      'rightPanelCollapsed' in state ||
      'activityBarCollapsed' in state
    if (!hasLegacy) return null
    return {
      leftPanelType: typeof state.leftPanelType === 'string' ? state.leftPanelType : undefined,
      leftPanelWidth: typeof state.leftPanelWidth === 'number' ? state.leftPanelWidth : undefined,
      rightPanelWidth: typeof state.rightPanelWidth === 'number' ? state.rightPanelWidth : undefined,
      rightPanelCollapsed:
        typeof state.rightPanelCollapsed === 'boolean' ? state.rightPanelCollapsed : undefined,
      activityBarCollapsed:
        typeof state.activityBarCollapsed === 'boolean' ? state.activityBarCollapsed : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 判断 layout-store 是否已存在 (避免覆盖用户已有偏好).
 */
function isLayoutStoreInitialized(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return true
  try {
    return window.localStorage.getItem(LAYOUT_STORE_KEY) !== null
  } catch {
    return true
  }
}

/**
 * 触发实际迁移. 暴露为独立函数便于在非 React 场景测试.
 * 返回 true 表示迁移了; false 表示无需迁移.
 */
export function runLayoutStoreMigration(): boolean {
  try {
    // 已经有 layout-store → 用户已经用过新版本,不要覆盖
    if (isLayoutStoreInitialized()) {
      log.debug('layout-store already exists, skip migration')
      return false
    }
    const legacy = readLegacyViewPrefs()
    if (!legacy) {
      log.debug('no legacy view-store layout prefs found')
      return false
    }
    const next = migrateLegacyViewPrefs(legacy)
    // 通过 setState + persist 触发写入 layout-store
    // 注意: setSlotSize 内置 clamp, 但我们直接 setState 跳过了 clamp,
    //       这是有意的 — 让用户的极端尺寸经过一次 setSlotSize 调整时自然 clamp
    useLayoutStore.setState({
      slots: next.slots as never,
      activityBarPosition: next.activityBarPosition,
      activePresetId: next.activePresetId,
    })
    log.info('Migrated legacy view-store layout prefs', { legacy, applied: next })
    return true
  } catch (err) {
    // 任何异常都静默吞下,绝不阻塞启动
    log.warn('Layout store migration failed, falling back to default', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * React Hook: 在 App 顶层调用一次,负责触发迁移.
 * useRef 保证即便组件 re-render 也只跑一次.
 */
export function useLayoutStoreMigration(): void {
  const didRunRef = useRef(false)
  useEffect(() => {
    if (didRunRef.current) return
    didRunRef.current = true
    runLayoutStoreMigration()
  }, [])
}
