/**
 * Diff 视图键盘快捷键 Hook
 *
 * 快捷键：
 * - j / k：下一个 / 上一个变更 hunk
 * - ] / [：下一个 / 上一个文件
 * - Space：展开/折叠上下文
 * - Enter：打开文件编辑器
 * - Escape：关闭 diff 视图
 */

import { useEffect, useCallback, useRef } from 'react'

interface UseDiffKeyboardOptions {
  /** 下一个文件回调 */
  onNextFile?: () => void
  /** 上一个文件回调 */
  onPrevFile?: () => void
  /** 打开文件编辑器回调 */
  onOpenFile?: () => void
  /** 关闭 diff 视图回调 */
  onClose?: () => void
  /** 是否启用键盘快捷键（默认 true） */
  enabled?: boolean
}

export function useDiffKeyboard({
  onNextFile,
  onPrevFile,
  onOpenFile,
  onClose,
  enabled = true,
}: UseDiffKeyboardOptions) {
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return

      // 忽略输入框内的按键
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      switch (e.key) {
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
    [enabled, onNextFile, onPrevFile, onOpenFile, onClose]
  )

  useEffect(() => {
    if (!enabled) return

    const container = containerRef.current
    if (!container) return

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [enabled, handleKeyDown])

  return containerRef
}
