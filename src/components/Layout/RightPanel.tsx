/**
 * RightPanel - 右侧 AI 对话面板组件
 */

import { ReactNode } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { ResizeHandle } from '../Common'
import { QuickSwitchPanel } from '../QuickSwitchPanel'

interface RightPanelProps {
  children: ReactNode
  /** 是否填充剩余空间（无编辑器时自适应，不显示拖拽条） */
  fillRemaining?: boolean
}

/**
 * 右侧面板组件
 * - fillRemaining=true: flex-1 自适应填充，无拖拽条（无编辑器时）
 * - fillRemaining=false: 固定宽度 + 拖拽条（有编辑器时）
 */
export function RightPanel({ children, fillRemaining = false }: RightPanelProps) {
  const width = useViewStore((state) => state.rightPanelWidth)
  const setWidth = useViewStore((state) => state.setRightPanelWidth)
  const collapsed = useViewStore((state) => state.rightPanelCollapsed)

  // 折叠状态：不渲染面板
  if (collapsed) {
    return null
  }

  // 拖拽处理 - 调整宽度
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(1200, width + delta))
    setWidth(newWidth)
  }

  // 填充模式：flex-1 自适应，无拖拽条
  if (fillRemaining) {
    return (
      <aside className="flex flex-col bg-background-elevated border-l border-border relative flex-1 min-w-[200px]">
        <QuickSwitchPanel />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
      </aside>
    )
  }

  // 固定宽度模式：有拖拽条
  return (
    <>
      <ResizeHandle direction="horizontal" position="left" onDrag={handleResize} />
      <aside
        className="flex flex-col bg-background-elevated border-l border-border shrink-0 relative"
        style={{ width: `${width}px` }}
      >
        <QuickSwitchPanel />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
      </aside>
    </>
  )
}
