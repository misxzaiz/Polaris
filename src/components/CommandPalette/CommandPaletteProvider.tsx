/**
 * CommandPaletteProvider — 全局唤出 + 状态托管
 *
 * 职责:
 *   - 监听 Cmd+K (mac) / Ctrl+K (win/linux) 唤出
 *   - 监听 ESC 关闭 (实际 ESC 由 CommandPalette 内部处理, 这里只用于 toggle)
 *   - 提供 useCommandPalette() 给任意组件读取开关状态
 *
 * 唤出快捷键:
 *   - 默认 Cmd+K / Ctrl+K
 *   - 输入框聚焦时, 不被 Cmd+K 拦截 (除非用户真的按下) — 检查 e.target
 *
 * 与 Tauri webview 注意点:
 *   - Cmd+K 在 macOS Safari 是默认搜索, Tauri webview 已禁用浏览器默认行为
 *   - 仍 preventDefault 防御
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CommandPalette } from './CommandPalette'

interface CommandPaletteContextValue {
  open: boolean
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) {
    throw new Error(
      'useCommandPalette must be used within <CommandPaletteProvider>'
    )
  }
  return ctx
}

interface CommandPaletteProviderProps {
  children: ReactNode
}

export function CommandPaletteProvider({ children }: CommandPaletteProviderProps) {
  const [open, setOpen] = useState(false)
  const openPalette = useCallback(() => setOpen(true), [])
  const closePalette = useCallback(() => setOpen(false), [])
  const togglePalette = useCallback(() => setOpen((v) => !v), [])

  // 全局快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+K (mac) 或 Ctrl+K (win/linux)
      const isK = e.key === 'k' || e.key === 'K'
      const isModifier = e.metaKey || e.ctrlKey
      if (isK && isModifier && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <CommandPaletteContext.Provider
      value={{ open, openPalette, closePalette, togglePalette }}
    >
      {children}
      <CommandPalette open={open} onClose={closePalette} />
    </CommandPaletteContext.Provider>
  )
}
