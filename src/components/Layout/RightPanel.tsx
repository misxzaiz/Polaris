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
  /** 强制显示（小屏模式下忽略持久化的折叠状态，避免整页空白） */
  forceShow?: boolean
}

/**
 * 右侧面板组件
 * - fillRemaining=true: flex-1 自适应填充，无拖拽条（无编辑器时）
 * - fillRemaining=false: 固定宽度 + 拖拽条（有编辑器时）
 */
export function RightPanel({ children, fillRemaining = false, forceShow = false }: RightPanelProps) {
  const width = useViewStore((state) => state.rightPanelWidth)
  const setWidth = useViewStore((state) => state.setRightPanelWidth)
  const collapsed = useViewStore((state) => state.rightPanelCollapsed)

  // 拖拽处理 - 调整宽度
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(1200, width + delta))
    setWidth(newWidth)
  }

  // 折叠时 hidden 隐藏而非卸载：对话网格（MultiSessionGrid/Virtuoso 实例）保留，
  // 展开时不闪白、不丢滚动位置。App.tsx 门控已改为不卸载 RightPanel。
  const hidden = collapsed && !forceShow

  // 关键：fillRemaining 切换时保持同一 <aside> 根，只变 className/style/ResizeHandle，
  // 避免 React 因顶层类型/结构变化（Fragment vs aside）卸载整棵子树——
  // 否则多窗口格子内的 Virtuoso 会冷启动，视觉上"闪一下空白"。
  return (
    <>
      {!fillRemaining && !hidden && (
        <ResizeHandle direction="horizontal" position="left" onDrag={handleResize} />
      )}
      <aside
        data-theme-panel
        className={`flex flex-col bg-background-elevated border-l border-border relative transition-[width] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] ${hidden ? 'hidden' : ''} ${fillRemaining ? 'flex-1 min-w-[200px]' : 'shrink-0'}`}
        style={fillRemaining || hidden ? undefined : { width: `${width}px` }}
      >
        <QuickSwitchPanel />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
      </aside>
    </>
  )
}
