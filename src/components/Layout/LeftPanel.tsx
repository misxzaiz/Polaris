/**
 * LeftPanel - 左侧可切换面板组件
 *
 * 配合 ActivityBar 使用,移除了头部切换器和折叠按钮
 * 由 ActivityBar 控制面板的显示/隐藏和切换
 */

import { ReactNode, useEffect, useRef, useState } from 'react'
import { X, Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useViewStore, LeftPanelType } from '@/stores/viewStore'
import { pluginPanelRegistry } from '@/plugin-system/panelRegistry'
import { PluginPanelHost } from '../Plugins/PluginPanelHost'
import { ResizeHandle } from '../Common'

interface LeftPanelProps {
  children?: ReactNode
  className?: string
  /** 是否填充剩余空间（激活且无编辑器时自适应撑满，不显示拖拽条） */
  fillRemaining?: boolean
  /** 是否全屏（撑满除 ActivityBar 外全部横向空间，不显示拖拽条） */
  fullscreen?: boolean
}

/**
 * 左侧面板组件
 * - fullscreen: flex-1 撑满除 ActivityBar 外全部横向空间，无拖拽条（终端全屏）
 * - fillRemaining: flex-1 自适应填充，无拖拽条（终端激活且无编辑器时）
 * - 默认: 固定宽度 + 拖拽条
 */
export function LeftPanel({ children, className = '', fillRemaining = false, fullscreen = false }: LeftPanelProps) {
  const width = useViewStore((state) => state.leftPanelWidth)
  const setWidth = useViewStore((state) => state.setLeftPanelWidth)

  // 拖拽处理（无限制）
  const handleResize = (delta: number) => {
    setWidth(width + delta)
  }

  // 全屏 / 填充模式：flex-1 自适应，无拖拽条
  if (fullscreen || fillRemaining) {
    return (
      <aside data-theme-panel
        className={`flex flex-col bg-background-elevated border-r border-border relative flex-1 min-w-[200px] ${className}`}
      >
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>
    )
  }

  // 固定宽度模式：有拖拽条
  return (
    <>
      {/* 面板容器 */}
      <aside data-theme-panel
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
  const [expanded, setExpanded] = useState(false)

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 优先退出全屏展开态，再次 Escape 才关闭抽屉
        if (expanded) {
          setExpanded(false)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, expanded])

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

      {/* 抽屉面板
          默认 min(85vw, 360px)，可全屏展开至 100vw —— 文件树半遮挡够用，
          Git 历史/Diff/终端等宽内容面板需要全屏。展开态 width 过渡 0.3s。 */}
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex flex-col bg-background-elevated border-r border-border shadow-xl animate-in slide-in-from-left duration-200 outline-none transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ width: expanded ? '100%' : 'min(85vw, 360px)' }}
      >
        {/* 顶部操作栏：展开/还原 + 关闭 */}
        <div className="flex items-center justify-end gap-1 h-9 px-2 border-b border-border shrink-0">
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
            aria-label={expanded ? t('buttons.restore', { defaultValue: '还原' }) : t('buttons.expand', { defaultValue: '全屏展开' })}
            title={expanded ? t('buttons.restore', { defaultValue: '还原' }) : t('buttons.expand', { defaultValue: '全屏展开' })}
          >
            {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
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
  browserContent,
  todoContent,
  translateContent,
  requirementContent,
  terminalContent,
  toolsContent,
  developerContent,
  integrationContent,
  demoPluginContent,
  aiConsoleContent,
  currentType,
}: {
  filesContent: ReactNode
  gitContent: ReactNode
  browserContent?: ReactNode
  todoContent: ReactNode
  translateContent?: ReactNode
  requirementContent?: ReactNode
  terminalContent?: ReactNode
  toolsContent?: ReactNode
  developerContent?: ReactNode
  integrationContent?: ReactNode
  demoPluginContent?: ReactNode
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
  } else if (type === 'browser') {
    return <>{browserContent}</>
  } else if (type === 'todo') {
    return <>{todoContent}</>
  } else if (type === 'translate') {
    return <>{translateContent}</>
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
  } else if (type === 'demoPlugin') {
    return <>{demoPluginContent}</>
  } else if (type === 'aiConsole') {
    return <>{aiConsoleContent}</>
  } else if (pluginPanelRegistry.has(type)) {
    return <PluginPanelHost panelType={type} />
  }

  return null
}
