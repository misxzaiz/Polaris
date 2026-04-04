/**
 * RightPanel - 右侧 AI 对话面板组件
 */

import { ReactNode } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { ResizeHandle } from '../Common'
import { SessionIsland } from '../Session'

interface RightPanelProps {
  children: ReactNode
  /** 是否填充剩余空间（当中间区域为空时） */
  fillRemaining?: boolean
}

/**
 * 右侧面板组件
 * 支持折叠（完全隐藏）和任意宽度调整
 * 当 fillRemaining 为 true 时，自动扩展填充剩余空间
 */
export function RightPanel({ children, fillRemaining = false }: RightPanelProps) {
  const width = useViewStore((state) => state.rightPanelWidth)
  const setWidth = useViewStore((state) => state.setRightPanelWidth)
  const collapsed = useViewStore((state) => state.rightPanelCollapsed)

  // 折叠状态：不渲染面板
  if (collapsed) {
    return null
  }

  // 拖拽处理 - 调整宽度，支持更灵活的范围
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(1200, width + delta))
    setWidth(newWidth)
  }

  // 填充模式：使用 flex-1 自动扩展，不显示拖拽手柄
  if (fillRemaining) {
    return (
      <aside className="flex flex-col flex-1 bg-background-elevated border-l border-border min-w-[200px] relative">
        {/* 悬浮岛 */}
        <SessionIsland />
        {/* 内容区域 - 添加 padding-top 为悬浮岛预留空间 */}
        <div className="flex-1 flex flex-col pt-14">
          {children}
        </div>
      </aside>
    )
  }

  return (
    <>
      {/* 拖拽手柄 */}
      <ResizeHandle direction="horizontal" position="left" onDrag={handleResize} />

      {/* 面板容器 - 使用固定宽度 */}
      <aside
        className="flex flex-col bg-background-elevated border-l border-border shrink-0 relative"
        style={{ width: `${width}px` }}
      >
        {/* 悬浮岛 */}
        <SessionIsland />
        {/* 内容区域 - 添加 padding-top 为悬浮岛预留空间 */}
        <div className="flex-1 flex flex-col pt-14">
          {children}
        </div>
      </aside>
    </>
  )
}
