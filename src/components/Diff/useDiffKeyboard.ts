/**
 * Diff 视图键盘快捷键 Hook
 *
 * 快捷键：
 * - j / k：下一个 / 上一个变更位置
 * - ] / [：下一个 / 上一个文件
 * - Enter：打开文件编辑器
 * - Escape：关闭 diff 视图
 */

import { useEffect, useCallback, useRef } from 'react'

interface UseDiffKeyboardOptions {
  onNextFile?: () => void
  onPrevFile?: () => void
  onOpenFile?: () => void
  onClose?: () => void
  onNextChange?: () => void
  onPrevChange?: () => void
  enabled?: boolean
  /** 挂载后自动聚焦容器（仅全屏/主视图场景使用，内嵌场景不应抢焦） */
  autoFocus?: boolean
}

export function useDiffKeyboard({
  onNextFile,
  onPrevFile,
  onOpenFile,
  onClose,
  onNextChange,
  onPrevChange,
  enabled = true,
  autoFocus = false,
}: UseDiffKeyboardOptions) {
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return

      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      switch (e.key) {
        case 'j':
          e.preventDefault()
          onNextChange?.()
          break
        case 'k':
          e.preventDefault()
          onPrevChange?.()
          break
        case ']':
          e.preventDefault()
          onNextFile?.()
          break
        case '[':
          e.preventDefault()
          onPrevFile?.()
          break
        case 'Enter':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            onOpenFile?.()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose?.()
          break
      }
    },
    [enabled, onNextFile, onPrevFile, onOpenFile, onClose, onNextChange, onPrevChange]
  )

  useEffect(() => {
    if (!enabled) return

    const container = containerRef.current
    if (!container) return

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [enabled, handleKeyDown])

  // 点击 diff 区域内任意位置即聚焦容器，确保 j/k 等快捷键无需额外操作即可生效
  useEffect(() => {
    if (!enabled) return

    const container = containerRef.current
    if (!container) return

    const focusSelf = () => container.focus({ preventScroll: true })
    container.addEventListener('mousedown', focusSelf)
    return () => container.removeEventListener('mousedown', focusSelf)
  }, [enabled])

  // 全屏/主视图场景：挂载后自动聚焦，进入即可用键盘导航
  useEffect(() => {
    if (!enabled || !autoFocus) return
    containerRef.current?.focus({ preventScroll: true })
  }, [enabled, autoFocus])

  return containerRef
}
