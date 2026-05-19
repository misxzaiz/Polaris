/**
 * 旧 view-store → 新 layout-store 迁移逻辑测试
 *
 * 覆盖:
 * 1. mapLegacyLeftPanelType: 各种输入到 ModuleId 的映射
 * 2. migrateLegacyViewPrefs: 纯函数表驱动 (空/部分/全字段)
 * 3. runLayoutStoreMigration: localStorage 完整流程,含 skip / fail-safe
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  mapLegacyLeftPanelType,
  migrateLegacyViewPrefs,
  runLayoutStoreMigration,
} from './layoutStoreMigration'
import { useLayoutStore, CUSTOM_PRESET_ID } from './layoutStore'
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

describe('mapLegacyLeftPanelType', () => {
  it('maps known module ids 1:1', () => {
    expect(mapLegacyLeftPanelType('files')).toBe('files')
    expect(mapLegacyLeftPanelType('git')).toBe('git')
    expect(mapLegacyLeftPanelType('todo')).toBe('todo')
    expect(mapLegacyLeftPanelType('terminal')).toBe('terminal')
  })

  it('maps legacy "tools" to "developer"', () => {
    expect(mapLegacyLeftPanelType('tools')).toBe('developer')
  })

  it('returns null for "none" sentinel', () => {
    expect(mapLegacyLeftPanelType('none')).toBeNull()
  })

  it('returns null for unknown / malformed inputs', () => {
    expect(mapLegacyLeftPanelType('garbage')).toBeNull()
    expect(mapLegacyLeftPanelType(null)).toBeNull()
    expect(mapLegacyLeftPanelType(undefined)).toBeNull()
    expect(mapLegacyLeftPanelType(42)).toBeNull()
    expect(mapLegacyLeftPanelType({ x: 1 })).toBeNull()
  })
})

describe('migrateLegacyViewPrefs', () => {
  it('returns developer preset when legacy is empty', () => {
    const out = migrateLegacyViewPrefs({})
    expect(out.activePresetId).toBe(DEFAULT_PRESET_ID)
    expect(out.activityBarPosition).toBe('left')
    expect(out.slots.left.activeModule).toBe('files')
    expect(out.slots.right.activeModule).toBe('chat')
  })

  it('translates leftPanelType = "git" to left.activeModule', () => {
    const out = migrateLegacyViewPrefs({ leftPanelType: 'git' })
    expect(out.slots.left.activeModule).toBe('git')
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('collapses left slot when leftPanelType = "none"', () => {
    const out = migrateLegacyViewPrefs({ leftPanelType: 'none' })
    expect(out.slots.left.activeModule).toBeNull()
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('appends unknown-but-mapped module into slot.modules', () => {
    const out = migrateLegacyViewPrefs({ leftPanelType: 'todo' })
    expect(out.slots.left.modules).toContain('todo')
    expect(out.slots.left.activeModule).toBe('todo')
  })

  it('keeps developer skeleton when leftPanelType is gibberish', () => {
    const out = migrateLegacyViewPrefs({ leftPanelType: 'flubber' })
    expect(out.slots.left.activeModule).toBe('files') // 保留 developer 默认
    expect(out.activePresetId).toBe(DEFAULT_PRESET_ID) // 没有改动 → 仍是预设
  })

  it('maps legacy "tools" to "developer" inside slot', () => {
    const out = migrateLegacyViewPrefs({ leftPanelType: 'tools' })
    expect(out.slots.left.activeModule).toBe('developer')
    expect(out.slots.left.modules).toContain('developer')
  })

  it('applies leftPanelWidth to left.size', () => {
    const out = migrateLegacyViewPrefs({ leftPanelWidth: 360 })
    expect(out.slots.left.size).toBe(360)
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('applies rightPanelWidth to right.size', () => {
    const out = migrateLegacyViewPrefs({ rightPanelWidth: 480 })
    expect(out.slots.right.size).toBe(480)
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('collapses right slot when rightPanelCollapsed=true', () => {
    const out = migrateLegacyViewPrefs({ rightPanelCollapsed: true })
    expect(out.slots.right.activeModule).toBeNull()
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('hides activity bar when activityBarCollapsed=true', () => {
    const out = migrateLegacyViewPrefs({ activityBarCollapsed: true })
    expect(out.activityBarPosition).toBe('hidden')
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('combines multiple legacy fields into one snapshot', () => {
    const out = migrateLegacyViewPrefs({
      leftPanelType: 'todo',
      leftPanelWidth: 300,
      rightPanelCollapsed: true,
      activityBarCollapsed: true,
    })
    expect(out.slots.left.activeModule).toBe('todo')
    expect(out.slots.left.size).toBe(300)
    expect(out.slots.right.activeModule).toBeNull()
    expect(out.activityBarPosition).toBe('hidden')
    expect(out.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('ignores non-finite numbers', () => {
    const out = migrateLegacyViewPrefs({ leftPanelWidth: Number.NaN, rightPanelWidth: Infinity })
    expect(out.slots.left.size).toBe(DEFAULT_LAYOUT_SNAPSHOT.slots.left.size)
    expect(out.slots.right.size).toBe(DEFAULT_LAYOUT_SNAPSHOT.slots.right.size)
  })
})

describe('runLayoutStoreMigration', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLayoutStore()
    // resetLayoutStore() 触发的 setState 会让 zustand-persist 立刻把 layout-store
    // 写回 localStorage,这会让 isLayoutStoreInitialized() 误判为 "已存在"。
    // 测试场景模拟的是 "全新升级用户:没有 layout-store, 但有 view-store",
    // 因此清掉 layout-store 即可还原该场景。
    localStorage.removeItem('layout-store')
  })

  afterEach(() => {
    localStorage.clear()
    resetLayoutStore()
  })

  it('skips when layout-store already exists', () => {
    // 模拟用户已经在新版本用过 (layout-store 已存在)
    localStorage.setItem(
      'layout-store',
      JSON.stringify({ state: { slots: {}, activityBarPosition: 'left' }, version: 1 })
    )
    localStorage.setItem(
      'view-store',
      JSON.stringify({ state: { leftPanelType: 'git' } })
    )
    expect(runLayoutStoreMigration()).toBe(false)
    // layoutStore 没被改
    expect(useLayoutStore.getState().slots.left.activeModule).toBe('files')
  })

  it('returns false when no legacy view-store present', () => {
    expect(runLayoutStoreMigration()).toBe(false)
  })

  it('returns false when view-store exists but has no layout fields', () => {
    localStorage.setItem(
      'view-store',
      JSON.stringify({ state: { multiSessionMode: true } })
    )
    expect(runLayoutStoreMigration()).toBe(false)
  })

  it('migrates legacy prefs when only view-store exists', () => {
    localStorage.setItem(
      'view-store',
      JSON.stringify({
        state: {
          leftPanelType: 'git',
          rightPanelCollapsed: true,
          activityBarCollapsed: true,
        },
      })
    )
    expect(runLayoutStoreMigration()).toBe(true)
    const state = useLayoutStore.getState()
    expect(state.slots.left.activeModule).toBe('git')
    expect(state.slots.right.activeModule).toBeNull()
    expect(state.activityBarPosition).toBe('hidden')
    expect(state.activePresetId).toBe(CUSTOM_PRESET_ID)
  })

  it('survives malformed view-store JSON', () => {
    localStorage.setItem('view-store', '{not json')
    // 不抛错,返回 false (不视为可迁移数据)
    expect(() => runLayoutStoreMigration()).not.toThrow()
    expect(runLayoutStoreMigration()).toBe(false)
  })

  it('survives view-store with wrong shape', () => {
    localStorage.setItem('view-store', JSON.stringify({ foo: 'bar' }))
    expect(runLayoutStoreMigration()).toBe(false)
  })

  it('survives view-store with leftPanelType but wrong type for other fields', () => {
    localStorage.setItem(
      'view-store',
      JSON.stringify({
        state: {
          leftPanelType: 'todo',
          leftPanelWidth: 'wide', // 错误类型, 应被忽略
          rightPanelCollapsed: 'yes', // 错误类型, 应被忽略
        },
      })
    )
    expect(runLayoutStoreMigration()).toBe(true)
    const state = useLayoutStore.getState()
    expect(state.slots.left.activeModule).toBe('todo')
    // leftPanelWidth='wide' 被忽略, 保持骨架的 280
    expect(state.slots.left.size).toBe(DEFAULT_LAYOUT_SNAPSHOT.slots.left.size)
    // rightPanelCollapsed='yes' 被忽略 (不是 boolean), chat 仍 active
    expect(state.slots.right.activeModule).toBe('chat')
  })

  it('does not throw when localStorage.getItem throws', () => {
    const original = localStorage.getItem
    Object.defineProperty(localStorage, 'getItem', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('quota / privacy mode')
      }),
    })
    try {
      expect(() => runLayoutStoreMigration()).not.toThrow()
      expect(runLayoutStoreMigration()).toBe(false)
    } finally {
      Object.defineProperty(localStorage, 'getItem', {
        configurable: true,
        value: original,
      })
    }
  })
})
