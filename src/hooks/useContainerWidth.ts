import { useRef, useState, useEffect } from 'react'

/**
 * 监听容器元素宽度变化
 *
 * 使用 ResizeObserver 监听目标元素的 inline 尺寸变化，
 * 返回 ref（挂载到目标元素）和当前宽度（px）。
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)

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
