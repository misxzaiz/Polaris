/**
 * FocusOverlay - 全局阅读聚焦模式渲染层
 *
 * 作用：
 *   - L1（语义）：在 body 加 `focus-mode` 类，CSS :hover 级联高亮当前消息块/段落
 *   - L2（聚光灯）：在 L1 之上渲染全屏 pointer-events:none 遮罩，鼠标处挖高亮圆
 *
 * 层级协调：
 *   - 挂载/卸载由 focusModeStore.level 驱动
 *   - overlayStore 计数已在 store 内同步（increment/decrement）
 *   - z-index: 20（低于 modal 类 30+，避免遮挡设置/弹窗）
 *
 * 性能：
 *   - L1 无 mousemove 监听
 *   - L2 mousemove 走 requestAnimationFrame 节流，圆心用 CSS 变量更新，不触发 React 重渲染
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusModeStore } from '@/stores/focusModeStore'

export function FocusOverlay() {
  const level = useFocusModeStore(s => s.level)
  const spotClearRadius = useFocusModeStore(s => s.spotClearRadius)
  const spotBlur = useFocusModeStore(s => s.spotBlur)
  const dimOpacity = useFocusModeStore(s => s.dimOpacity)
  const dimBrightness = useFocusModeStore(s => s.dimBrightness)

  const spotRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const mouseRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })

  // L1：body 类名联动（语义聚焦级联由 CSS 处理）
  useEffect(() => {
    const root = document.documentElement
    if (level >= 1) {
      root.classList.add('focus-mode')
      // 注入强度变量（供 CSS 级联消费）
      root.style.setProperty('--focus-dim-opacity', String(dimOpacity))
      root.style.setProperty('--focus-dim-brightness', String(dimBrightness))
    } else {
      root.classList.remove('focus-mode')
      root.style.removeProperty('--focus-dim-opacity')
      root.style.removeProperty('--focus-dim-brightness')
    }
    return () => {
      root.classList.remove('focus-mode')
      root.style.removeProperty('--focus-dim-opacity')
      root.style.removeProperty('--focus-dim-brightness')
    }
  }, [level, dimOpacity, dimBrightness])

  // L2：聚光灯 mousemove（仅 level===2 时挂载）
  useEffect(() => {
    if (level !== 2) return

    const update = () => {
      const el = spotRef.current
      if (el) {
        el.style.setProperty('--mx', `${mouseRef.current.x}px`)
        el.style.setProperty('--my', `${mouseRef.current.y}px`)
      }
      rafRef.current = 0
    }

    const onMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX
      mouseRef.current.y = e.clientY
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(update)
      }
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    // 首次定位
    update()
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [level])

  // 关闭或仅 L1（语义聚焦）：不渲染聚光灯遮罩，L1 完全靠 body 类 + CSS :hover 级联
  if (level !== 2) return null

  return createPortal(
    <div
      ref={spotRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        pointerEvents: 'none',
        // 聚光灯：径向渐变，圆内透明、圆外暗化
        background: `radial-gradient(circle ${spotClearRadius}px at var(--mx, 50%) var(--my, 50%), transparent 0%, transparent 55%, rgba(8,10,16,.82) 100%)`,
        backdropFilter: spotBlur > 0 ? `blur(${spotBlur}px)` : 'none',
        WebkitBackdropFilter: spotBlur > 0 ? `blur(${spotBlur}px)` : 'none',
        transition: 'background .08s linear',
      }}
    />,
    document.body,
  )
}
