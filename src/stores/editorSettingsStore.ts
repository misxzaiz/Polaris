/**
 * 编辑器设置存储
 *
 * 管理编辑器视觉偏好设置，持久化到 localStorage
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createLogger } from '../utils/logger'

const log = createLogger('EditorSettings')

export interface EditorSettingsState {
  /** 字体大小 (px) */
  fontSize: number
  /** 字体族 */
  fontFamily: string
}

interface EditorSettingsActions {
  /** 增大字体 */
  increaseFontSize: () => void
  /** 减小字体 */
  decreaseFontSize: () => void
  /** 重置字体大小 */
  resetFontSize: () => void
  /** 设置字体族 */
  setFontFamily: (family: string) => void
}

const DEFAULT_FONT_SIZE = 14
const DEFAULT_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, monospace"
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 32

export const useEditorSettingsStore = create<EditorSettingsState & EditorSettingsActions>()(
  persist(
    (set) => ({
      fontSize: DEFAULT_FONT_SIZE,
      fontFamily: DEFAULT_FONT_FAMILY,

      increaseFontSize: () => {
        set((state) => {
          const next = Math.min(state.fontSize + 1, MAX_FONT_SIZE)
          if (next !== state.fontSize) {
            log.debug('字体增大', { from: state.fontSize, to: next })
          }
          return { fontSize: next }
        })
      },

      decreaseFontSize: () => {
        set((state) => {
          const next = Math.max(state.fontSize - 1, MIN_FONT_SIZE)
          if (next !== state.fontSize) {
            log.debug('字体减小', { from: state.fontSize, to: next })
          }
          return { fontSize: next }
        })
      },

      resetFontSize: () => {
        set({ fontSize: DEFAULT_FONT_SIZE })
        log.debug('字体重置', { to: DEFAULT_FONT_SIZE })
      },

      setFontFamily: (family: string) => {
        set({ fontFamily: family })
      },
    }),
    {
      name: 'editor-settings',
    }
  )
)
