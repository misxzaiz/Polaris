/**
 * LeftPanel - 左侧可切换面板组件
 *
 * 配合 ActivityBar 使用,移除了头部切换器和折叠按钮
 * 由 ActivityBar 控制面板的显示/隐藏和切换
 */

import { ReactNode, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useViewStore, LeftPanelType } from '@/stores/viewStore'
import { ResizeHandle } from '../Common'

interface LeftPanelProps {
  children?: ReactNode
  className?: string
}

/**
 * 左侧面板组件
 * 始终使用固定宽度 + 拖拽手柄，支持用户调整宽度
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
        // maxWidth 渲染层钳制：窄视口下保证 ActivityBar(48px) + 至少 220px 聊天区可见，
        // 持久化的 leftPanelWidth 不受影响
        style={{ width: `${width}px`, maxWidth: 'calc(100vw - 268px)' }}
      >
        {/* 面板内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>

      {/* 拖拽手柄 */}
      <ResizeHandle direction="horizontal" position="right" onDrag={handleResize} />
    </>
  )
}

interface LeftPanelDrawerProps {
  children?: ReactNode
  /** 关闭抽屉回调（点击遮罩 / 关闭按钮） */
  onClose: () => void
}

/**
 * 左侧面板抽屉（小屏模式）
 * compact 模式下以覆盖式抽屉渲染左侧面板内容：半透明遮罩 + 左侧滑入面板
 */
export function LeftPanelDrawer({ children, onClose }: LeftPanelDrawerProps) {
  const { t } = useTranslation('common')
  const drawerRef = useRef<HTMLElement>(null)

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 打开时将焦点移入抽屉
  useEffect(() => {
    drawerRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={t('buttons.close')}
    >
      {/* 遮罩：点击关闭 */}
      <div
        className="absolute inset-0 bg-black/50 animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* 抽屉面板 */}
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex flex-col bg-background-elevated border-r border-border shadow-xl animate-in slide-in-from-left duration-200 outline-none"
        style={{ width: 'min(85vw, 360px)' }}
      >
        {/* 顶部关闭栏 */}
        <div className="flex items-center justify-end h-9 px-2 border-b border-border shrink-0">
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
      aria-label="导航面板"
            title={t('buttons.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 面板内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>
    </div>
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
  requirementContent,
  terminalContent,
  toolsContent,
  developerContent,
  integrationContent,
  problemsContent,
  demoPluginContent,
  comicStudioContent,
  aiConsoleContent,
  currentType,
}: {
  filesContent: ReactNode
  gitContent: ReactNode
  todoContent: ReactNode
  translateContent?: ReactNode
  schedulerContent?: ReactNode
  requirementContent?: ReactNode
  terminalContent?: ReactNode
  toolsContent?: ReactNode
  developerContent?: ReactNode
  integrationContent?: ReactNode
  problemsContent?: ReactNode
  demoPluginContent?: ReactNode
  comicStudioContent?: ReactNode
  aiConsoleContent?: ReactNode
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
  } else if (type === 'requirement') {
    return <>{requirementContent}</>
  } else if (type === 'terminal') {
    return <>{terminalContent}</>
  } else if (type === 'tools') {
    return <>{toolsContent}</>
  } else if (type === 'developer') {
    return <>{developerContent}</>
  } else if (type === 'integration') {
    return <>{integrationContent}</>
  } else if (type === 'problems') {
    return <>{problemsContent}</>
  } else if (type === 'demoPlugin') {
    return <>{demoPluginContent}</>
  } else if (type === 'comicStudio') {
    return <>{comicStudioContent}</>
  } else if (type === 'aiConsole') {
    return <>{aiConsoleContent}</>
  }

  return null
}
