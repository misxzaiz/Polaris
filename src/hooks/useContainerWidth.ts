import { useRef, useState, useEffect } from 'react'

/**
 * 监听容器元素宽度变化
 *
 * 使用 ResizeObserver 监听目标元素的 inline 尺寸变化，
 * 返回 ref（挂载到目标元素）和当前宽度（px）。
 *
 * initialWidth：首帧初值。挂载后 ResizeObserver 会以实测值立即接管，
 * 该初值仅用于避免"首帧按 0 宽度渲染一次再跳变"的闪烁
 * （典型用法：传入 window.innerWidth 作为近似值）。
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(initialWidth = 0) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initialWidth)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        setWidth(Math.round(w))
      }
    })

    observer.observe(el)
    // 立即读取初始宽度
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [])

  return { ref, width }
}
