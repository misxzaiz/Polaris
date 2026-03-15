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
}

/**
 * 左侧面板组件
 */
export function LeftPanel({ children, className = '' }: LeftPanelProps) {
  const width = useViewStore((state) => state.leftPanelWidth)
  const setWidth = useViewStore((state) => state.setLeftPanelWidth)

  // 拖拽处理
  const handleResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(600, width + delta))
    setWidth(newWidth)
  }

  return (
    <>
      {/* 面板容器 */}
      <aside
        className={`flex flex-col bg-background-elevated border-r border-border shrink-0 relative ${className}`}
        style={{ width: `${width}px` }}
      >
        {/* 面板内容 */}
        <div className="flex-1 overflow-hidden">{children}</div>

        {/* 关闭按钮 - 左上角 */}
        {/*<button*/}
        {/*  onClick={closeLeftPanel}*/}
        {/*  className="absolute top-2 left-2 p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all z-10"*/}
        {/*  title="隐藏面板"*/}
        {/*>*/}
        {/*  <X size={14} />*/}
        {/*</button>*/}
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
  currentType,
}: {
  filesContent: ReactNode
  gitContent: ReactNode
  todoContent: ReactNode
  translateContent?: ReactNode
  schedulerContent?: ReactNode
  terminalContent?: ReactNode
  currentType?: LeftPanelType
}) {
  const type = currentType ?? useViewStore((state) => state.leftPanelType)

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
  }

  return null
}
