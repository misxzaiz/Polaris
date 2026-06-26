/**
 * Split 视图左右列宽比例：拖拽调整 + localStorage 持久化
 *
 * ratio 表示左列占比（0~1），限制在 [MIN, MAX]。提供分隔条的 pointer 事件处理与双击复位。
 */

import { useCallback, useRef, useState } from 'react'

const STORAGE_KEY = 'polaris.diff.split.ratio'
const MIN = 0.15
const MAX = 0.85
const DEFAULT = 0.5

const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v))

function readInitial(): number {
  try {
    const raw = parseFloat(localStorage.getItem(STORAGE_KEY) ?? '')
    return raw >= MIN && raw <= MAX ? raw : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function useSplitRatio(gridRef: React.RefObject<HTMLDivElement | null>) {
  const [ratio, setRatioState] = useState<number>(readInitial)
  const dragging = useRef(false)

  const setRatio = useCallback((v: number) => {
    const next = clamp(v)
    setRatioState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next.toFixed(3))
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !gridRef.current) return
    const rect = gridRef.current.getBoundingClientRect()
    if (rect.width === 0) return
    setRatio((e.clientX - rect.left) / rect.width)
  }, [gridRef, setRatio])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  const reset = useCallback(() => setRatio(DEFAULT), [setRatio])

  return { ratio, setRatio, dividerHandlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick: reset } }
}
