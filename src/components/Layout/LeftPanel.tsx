/**
 * LeftPanel - 左侧可切换面板组件
 *
 * 配合 ActivityBar 使用,移除了头部切换器和折叠按钮
 * 由 ActivityBar 控制面板的显示/隐藏和切换
 */

import { ReactNode } from 'react'
import { useViewStore, LeftPanelType } from '@/stores/viewStore'
import { ResizeHandle } from '../Common'

interface LeftPanelProps {
  children?: ReactNode
  className?: string
  /** 是否填充剩余空间（当右侧没有其他面板时） */
  fillRemaining?: boolean
}

/**
 * 左侧面板组件
 * 当 fillRemaining 为 true 时，自动扩展填充剩余空间
 */
export function LeftPanel({ children, className = '', fillRemaining = false }: LeftPanelProps) {
  const width = useViewStore((state) => state.leftPanelWidth)
  const setWidth = useViewStore((state) => state.setLeftPanelWidth)

  // 拖拽处理
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(600, width + delta))
    setWidth(newWidth)
  }

  // 填充模式：使用 flex-1 自动扩展，不显示拖拽手柄
  if (fillRemaining) {
    return (
      <aside className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-background-elevated border-r border-border min-w-[200px] ${className}`}>
        {/* 面板内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>
    )
  }

  return (
    <>
      {/* 面板容器 */}
      <aside
        className={`flex flex-col bg-background-elevated border-r border-border shrink-0 relative ${className}`}
        style={{ width: `${width}px` }}
      >
        {/* 面板内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>

      {/* 拖拽手柄 */}
      <ResizeHandle direction="horizontal" position="right" onDrag={handleResize} />
    </>
  )
}

/**
 * 左侧面板内容包装器 - 根据类型渲染不同内容
 */
export function LeftPanelContent({
  filesContent,
  gitContent,
  todoContent,
  translateContent,
  schedulerContent,
  terminalContent,
  toolsContent,
  developerContent,
  currentType,
}: {
  filesContent: ReactNode
  gitContent: ReactNode
  todoContent: ReactNode
  translateContent?: ReactNode
  schedulerContent?: ReactNode
  terminalContent?: ReactNode
  toolsContent?: ReactNode
  developerContent?: ReactNode
  currentType?: LeftPanelType
}) {
  // Hook 必须在条件之外调用
  const storePanelType = useViewStore((state) => state.leftPanelType)
  const type = currentType ?? storePanelType

  if (type === 'files') {
    return <>{filesContent}</>
  } else if (type === 'git') {
    return <>{gitContent}</>
  } else if (type === 'todo') {
    return <>{todoContent}</>
  } else if (type === 'translate') {
    return <>{translateContent}</>
  } else if (type === 'scheduler') {
    return <>{schedulerContent}</>
  } else if (type === 'terminal') {
    return <>{terminalContent}</>
  } else if (type === 'tools') {
    return <>{toolsContent}</>
  } else if (type === 'developer') {
    return <>{developerContent}</>
  }

  return null
}
