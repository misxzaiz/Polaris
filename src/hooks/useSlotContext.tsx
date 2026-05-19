/**
 * useSlotContext — V2 模块感知所在槽位的 hook
 *
 * 模块通过这个 hook 拿到当前槽位的 {slotId, width, height, orientation},
 * 自行决定按 compact/standard/wide 哪种变体渲染.
 *
 * Provider 由 SlotPanel / LayoutShell 在 ModuleRenderer 外层包裹.
 * ResizeObserver 监测槽位元素尺寸, 实时更新 context value.
 *
 * 设计要点:
 *   - 仅在槽位内消费时返回真实值, 否则返回 null (允许模块独立测试或浮窗使用)
 *   - 默认按 width 推断 orientation, 但 slotId='bottom' 强制 horizontal
 *   - rAF 节流以避免高频 resize 引发 re-render 风暴
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode, RefObject } from 'react'
import type { SlotId } from '@/types/layout'

export type SlotOrientation = 'vertical' | 'horizontal'

export interface SlotContextValue {
  /** 槽位 id; null 表示模块不在槽位内 (如浮动窗口/独立测试) */
  slotId: SlotId | null
  /** 实测槽位内容区宽度 (px) */
  width: number
  /** 实测槽位内容区高度 (px) */
  height: number
  /**
   * 朝向 — 表示槽位是"窄竖条"还是"矮横条":
   *  - vertical: left/right/center 槽位 (高度 >> 宽度)
   *  - horizontal: bottom 槽位 (宽度 >> 高度)
   * 模块可据此切换主轴 (Tab 列表横向 vs 纵向, 等).
   */
  orientation: SlotOrientation
  /** width 落到哪个常见断点 */
  variant: 'compact' | 'standard' | 'wide'
}

const DEFAULT: SlotContextValue = {
  slotId: null,
  width: 0,
  height: 0,
  orientation: 'vertical',
  variant: 'standard',
}

const SlotContext = createContext<SlotContextValue>(DEFAULT)

export interface SlotContextProviderProps {
  slotId: SlotId
  /** 槽位内容区 DOM ref; ResizeObserver 监测之 */
  containerRef: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * width → variant 断点:
 *  - compact:  < 320
 *  - standard: 320 ~ 480
 *  - wide:     >= 480
 * (bottom 槽位的高度也按这套断点判定 wide=横向更宽)
 */
function classifyWidth(width: number): 'compact' | 'standard' | 'wide' {
  if (width < 320) return 'compact'
  if (width < 480) return 'standard'
  return 'wide'
}

export function SlotContextProvider({
  slotId,
  containerRef,
  children,
}: SlotContextProviderProps) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      // rAF 节流: 避免高频 resize 抢主线程
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setSize((prev) =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h }
        )
      })
    })
    ro.observe(el)
    // 首次同步读取一次, 避免 mount 后第一帧 size=0 的闪烁
    const rect = el.getBoundingClientRect()
    setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    return () => {
      ro.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [containerRef])

  const value = useMemo<SlotContextValue>(() => {
    const orientation: SlotOrientation = slotId === 'bottom' ? 'horizontal' : 'vertical'
    // bottom 槽位 variant 基于 width (因为 bottom 是宽矮容器, 决定模块横向布局是否够展开)
    // 其他槽位也基于 width
    const variant = classifyWidth(size.width)
    return {
      slotId,
      width: size.width,
      height: size.height,
      orientation,
      variant,
    }
  }, [slotId, size.width, size.height])

  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>
}

/**
 * 在 SlotContextProvider 外消费时返回默认值 (slotId=null, width=0).
 * 模块应优先检查 slotId 是否为 null, 决定 fallback 渲染.
 */
export function useSlotContext(): SlotContextValue {
  return useContext(SlotContext)
}
