/**
 * 悬浮窗状态管理 Store
 */

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { createLogger } from '../utils/logger'

const log = createLogger('FloatingWindowStore')

interface FloatingWindowState {
  /** 是否处于悬浮模式 */
  isFloatingMode: boolean
  /** 悬浮窗是否可见 */
  isVisible: boolean
  /** 悬浮窗位置 */
  position: { x: number; y: number } | null

  /** 切换悬浮模式 */
  toggleFloatingMode: () => Promise<void>
  /** 显示悬浮窗 */
  showFloatingWindow: () => Promise<void>
  /** 显示主窗口 */
  showMainWindow: () => Promise<void>
  /** 检查悬浮窗是否可见 */
  checkVisible: () => Promise<void>
  /** 设置悬浮窗位置 */
  setPosition: (x: number, y: number) => Promise<void>
  /** 获取悬浮窗位置 */
  getPosition: () => Promise<void>
}

export const useFloatingWindowStore = create<FloatingWindowState>((set) => ({
  isFloatingMode: false,
  isVisible: false,
  position: null,

  toggleFloatingMode: async () => {
    try {
      const isFloating = await invoke<boolean>('toggle_floating_window')
      set({ isFloatingMode: isFloating, isVisible: isFloating })
    } catch (e) {
      log.error('切换悬浮窗失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  showFloatingWindow: async () => {
    try {
      await invoke('show_floating_window')
      set({ isFloatingMode: true, isVisible: true })
    } catch (e) {
      log.error('显示悬浮窗失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  showMainWindow: async () => {
    try {
      await invoke('show_main_window')
      set({ isFloatingMode: false, isVisible: false })
    } catch (e) {
      log.error('显示主窗口失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  checkVisible: async () => {
    try {
      const visible = await invoke<boolean>('is_floating_window_visible')
      set({ isVisible: visible, isFloatingMode: visible })
    } catch (e) {
      log.error('检查悬浮窗可见性失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  setPosition: async (x, y) => {
    try {
      await invoke('set_floating_window_position', { x, y })
      set({ position: { x, y } })
    } catch (e) {
      log.error('设置悬浮窗位置失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  getPosition: async () => {
    try {
      const pos = await invoke<{ x: number; y: number } | null>('get_floating_window_position')
      set({ position: pos })
    } catch (e) {
      log.error('获取悬浮窗位置失败', e instanceof Error ? e : new Error(String(e)))
    }
  },
}))
