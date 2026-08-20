/**
 * 编辑器设置存储
 *
 * 管理编辑器视觉偏好设置，持久化到 localStorage
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createLogger } from '@/utils/logger'

const log = createLogger('EditorSettings')

export interface EditorSettingsState {
  /** 字体大小 (px) */
  fontSize: number
  /** 字体族 */
  fontFamily: string
  /** 保存时自动格式化（需要当前文件有可用的 LSP） */
  formatOnSave: boolean
  /**
   * LSP 跳转定义快捷键（CodeMirror keymap 字符串，如 "Mod-Alt-b"）。
   * Mod 在 macOS = Cmd，其它平台 = Ctrl。
   */
  lspKeyDefinition: string
  /** LSP 查找引用快捷键 */
  lspKeyReferences: string
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
  /** 切换保存时格式化 */
  setFormatOnSave: (enabled: boolean) => void
  /** 设置 LSP 快捷键 */
  setLspKey: (kind: 'definition' | 'references', key: string) => void
  /** 重置 LSP 快捷键为默认 */
  resetLspKeys: () => void
}

const DEFAULT_FONT_SIZE = 14
const DEFAULT_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, monospace"
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 32

/**
 * LSP 默认快捷键。避开 F12（Tauri DevTools 切换）与 CodeMirror defaultKeymap 已用键位。
 * - Mod-Alt-b：仿 IntelliJ "Go to Implementation"
 * - Alt-Shift-r：仿 IDEA/Sublime "Find Usages"
 */
export const DEFAULT_LSP_KEY_DEFINITION = 'Mod-Alt-b'
export const DEFAULT_LSP_KEY_REFERENCES = 'Alt-Shift-r'

export const useEditorSettingsStore = create<EditorSettingsState & EditorSettingsActions>()(
  persist(
    (set) => ({
      fontSize: DEFAULT_FONT_SIZE,
      fontFamily: DEFAULT_FONT_FAMILY,
      formatOnSave: false,
      lspKeyDefinition: DEFAULT_LSP_KEY_DEFINITION,
      lspKeyReferences: DEFAULT_LSP_KEY_REFERENCES,

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

      setFormatOnSave: (enabled: boolean) => {
        set({ formatOnSave: enabled })
        log.debug('formatOnSave 设置更新', { enabled })
      },

      setLspKey: (kind, key) => {
        if (kind === 'definition') {
          set({ lspKeyDefinition: key })
        } else {
          set({ lspKeyReferences: key })
        }
        log.debug('LSP 快捷键更新', { kind, key })
      },

      resetLspKeys: () => {
        set({
          lspKeyDefinition: DEFAULT_LSP_KEY_DEFINITION,
          lspKeyReferences: DEFAULT_LSP_KEY_REFERENCES,
        })
        log.debug('LSP 快捷键已重置')
      },
    }),
    {
      name: 'editor-settings',
    }
  )
)
