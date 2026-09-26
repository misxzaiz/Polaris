/**
 * RightPanel - 右侧 AI 对话面板组件
 */

import { ReactNode, useEffect, useState } from 'react'
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
 *
 * 折叠动画（保活）：
 * - 折叠：宽度收缩 + 内容淡出（260ms），过渡结束才真正 display:none，
 *   保证对话网格（MultiSessionGrid/Virtuoso）保持挂载，展开不闪白不丢滚动位置。
 * - 展开：先恢复 display，再补宽度 + 淡入。
 */
export function RightPanel({ children, fillRemaining = false, forceShow = false }: RightPanelProps) {
  const width = useViewStore((state) => state.rightPanelWidth)
  const setWidth = useViewStore((state) => state.setRightPanelWidth)
  const collapsed = useViewStore((state) => state.rightPanelCollapsed)

  // 折叠过渡状态：collapsed=false(展开) / collapsing(收起过渡) / hidden(已收起)
  const [phase, setPhase] = useState<'expanded' | 'collapsing' | 'hidden'>(() =>
    collapsed && !forceShow ? 'hidden' : 'expanded'
  )

  // 折叠状态变化驱动过渡
  useEffect(() => {
    if (forceShow) {
      setPhase((p) => (p === 'hidden' ? 'expanded' : p))
      return
    }
    if (collapsed) {
      // 展开 → 收起：先过渡，结束再隐藏
      setPhase('collapsing')
      const t = setTimeout(() => setPhase('hidden'), 300)
      return () => clearTimeout(t)
    } else {
      // 收起 → 展开：先显示，再进入过渡态（下一帧加回宽度）
      setPhase((p) => {
        if (p === 'hidden') {
          requestAnimationFrame(() => setPhase('expanded'))
          return 'expanded'
        }
        return 'expanded'
      })
    }
  }, [collapsed, forceShow])

  // 拖拽处理 - 调整宽度
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(1200, width + delta))
    setWidth(newWidth)
  }

  const hidden = phase === 'hidden' && !forceShow
  const collapsing = phase === 'collapsing'

  // 关键：fillRemaining 切换时保持同一 <aside> 根，只变 className/style/ResizeHandle，
  // 避免 React 因顶层类型/结构变化（Fragment vs aside）卸载整棵子树——
  // 否则多窗口格子内的 Virtuoso 会冷启动，视觉上"闪一下空白"。
  return (
    <>
      {!fillRemaining && !hidden && !collapsing && (
        <ResizeHandle direction="horizontal" position="left" onDrag={handleResize} />
      )}
      <aside
        data-theme-panel
        className={`flex flex-col bg-background-elevated border-l border-border relative ${
          fillRemaining ? 'flex-1 min-w-[200px]' : 'shrink-0'
        } ${
          collapsing
            ? 'transition-[width,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]'
            : 'transition-[width] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]'
        } ${hidden ? 'hidden' : ''} ${collapsing ? 'overflow-hidden' : ''}`}
        style={
          hidden || fillRemaining
            ? undefined
            : collapsing
              ? { width: '0px', opacity: 0 }
              : { width: `${width}px`, opacity: 1 }
        }
      >
        <QuickSwitchPanel />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
      </aside>
    </>
  )
}
