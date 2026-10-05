/**
 * LeftPanel - 左侧可切换面板组件（保活版）
 *
 * 配合 ActivityBar 使用，移除了头部切换器和折叠按钮
 * 由 ActivityBar 控制面板的显示/隐藏和切换
 *
 * 保活设计：
 * - children（面板内容组件）始终挂载在同一个 <aside> 根内，永不因布局切换
 *   卸载重建——与 RightPanel/AI 对话的常驻体验一致，避免文件树/终端等
 *   重挂载导致"刷新"。
 * - compact 双形态通过切换同一个 <aside> 的定位样式实现：
 *   桌面停靠（relative，参与 flex 流布局）↔ 抽屉覆盖（fixed 覆盖层）。
 *   遮罩与顶部操作栏作为独立 sibling 条件渲染，不进入 aside、不触发 children 卸载。
 * - leaving：关闭时外壳淡出，children 仍挂载，重新打开立即显示。
 * - panelVisible=false（leftPanelType=none）：aside 加 hidden 隐藏，children 仍挂载。
 */

import { ReactNode, useEffect, useRef, useState, useCallback } from 'react'
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
  /** 是否正在退场（关闭时淡出动画，由父组件延迟卸载） */
  leaving?: boolean
  /** 小屏模式：以抽屉覆盖层渲染（原 LeftPanelDrawer 形态），children 仍保活挂载 */
  compact?: boolean
  /** 抽屉形态的关闭回调（点击遮罩 / 关闭按钮） */
  onClose?: () => void
}

/**
 * 左侧面板组件
 * - fullscreen: flex-1 撑满除 ActivityBar 外全部横向空间，无拖拽条（终端全屏）
 * - fillRemaining: flex-1 自适应填充，无拖拽条（终端激活且无编辑器时）
 * - 默认: 固定宽度 + 拖拽条
 * - leaving: 关闭退场时淡出（父组件负责延迟卸载）
 * - compact: 抽屉覆盖形态（窄窗口），children 仍保活
 */
export function LeftPanel({ children, className = '', fillRemaining = false, fullscreen = false, leaving = false, compact = false, onClose }: LeftPanelProps) {
  const { t } = useTranslation('common')
  const width = useViewStore((state) => state.leftPanelWidth)
  const setWidth = useViewStore((state) => state.setLeftPanelWidth)
  // 面板是否可见（type 非 none）。children 保活：不可见时外壳隐藏，内容仍挂载
  const panelVisible = useViewStore((state) => state.leftPanelType !== 'none')

  // 拖拽处理（无限制）
  const handleResize = (delta: number) => {
    setWidth(width + delta)
  }

  // 抽屉形态：全屏展开态 + Escape 关闭
  const [expanded, setExpanded] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  // 关闭：同步执行 onClose（→ closeLeftPanel 立即置 leftPanelType='none'）。
  // 不再用 useTransitionState：LeftPanel 保活常驻挂载，其 phase 会粘滞在
  // 'exiting'（exit() 同值 setPhase 幂等 bail out），导致再次打开后遮罩卡
  // 'animate-mask-out'（无 forwards，播完 opacity 回 1 → 全黑），且 × 关不掉。
  // 退场淡出由 App.tsx 的 leftPanelKept/leaving（150ms）承接。
  const handleClose = useCallback(() => {
    onClose?.()
  }, [onClose])

  // Escape 键关闭（抽屉形态）
  useEffect(() => {
    if (!compact) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 优先退出全屏展开态，再次 Escape 才关闭抽屉
        if (expanded) {
          setExpanded(false)
        } else {
          handleClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [compact, expanded, handleClose])

  // 抽屉打开时将焦点移入
  useEffect(() => {
    if (compact && panelVisible) {
      drawerRef.current?.focus()
    }
  }, [compact, panelVisible])

  // 抽屉下的操作栏（独立 sibling，不进 aside，不触发 children 卸载）
  const drawerToolbar = compact && panelVisible && (
    <div className="fixed top-0 left-0 flex items-center justify-end gap-1 h-9 px-2 border-b border-border shrink-0 bg-background-elevated z-[51]" style={{ width: expanded ? '100%' : 'min(85vw, 360px)', right: expanded ? 0 : undefined }}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
        aria-label={expanded ? t('buttons.restore', { defaultValue: '还原' }) : t('buttons.expand', { defaultValue: '全屏展开' })}
        title={expanded ? t('buttons.restore', { defaultValue: '还原' }) : t('buttons.expand', { defaultValue: '全屏展开' })}
      >
        {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
      </button>
      <button
        onClick={handleClose}
        className="w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
        aria-label="导航面板"
        title={t('buttons.close')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )

  // 抽屉遮罩（独立 sibling）。入场淡入；退场由 aside 的 leaving 淡出承接
  // （App.tsx 在 hasLeftPanel true→false 时 leftPanelKept=true，150ms 后清）
  const drawerMask = compact && panelVisible && (
    <div
      className={`fixed inset-0 z-50 bg-black/50 ${leaving ? 'opacity-0' : 'animate-mask-in'}`}
      onClick={handleClose}
    />
  )

  // 抽屉下的 ResizeHandle（只在桌面形态显示）
  const isFlexible = fullscreen || fillRemaining
  const desktopResizeHandle = !compact && !isFlexible && (
    <ResizeHandle direction="horizontal" position="right" onDrag={handleResize} />
  )

  // 关键：compact 双形态切换时保持同一 <aside> 根，children 永不动位。
  // 只切换 aside 的定位 className：
  // - 桌面: relative，参与 flex 流布局（停靠）
  // - 抽屉: fixed 覆盖层 + shadow + 更高 z
  // 遮罩/操作栏作为独立 sibling 渲染，不进入 aside，避免卸载 children。
  const asideStyle: React.CSSProperties | undefined = compact
    ? { width: expanded ? '100%' : 'min(85vw, 360px)' }
    : isFlexible
      ? undefined
      : { width: `${width}px` }

  return (
    <>
      {drawerMask}
      {drawerToolbar}
      <aside
        ref={drawerRef}
        data-theme-panel
        tabIndex={compact ? -1 : undefined}
        className={`flex flex-col bg-background-elevated border-r border-border min-h-0 ${compact
          ? 'fixed inset-y-0 left-0 z-50 shadow-xl overflow-hidden'
          : 'relative'
        } transition-[width,opacity] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] ${leaving ? 'opacity-0 pointer-events-none' : 'opacity-100'} ${!panelVisible ? 'hidden' : ''} ${!compact && isFlexible ? 'flex-1 min-w-[200px]' : ''} ${!compact && !isFlexible ? 'shrink-0' : ''} ${className}`}
        style={asideStyle}
      >
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>
      {desktopResizeHandle}
    </>
  )
}

/**
 * 左侧面板抽屉（小屏模式）——兼容导出
 * 保活改造后由 LeftPanel 的 compact 形态承接，本组件保留导出以防外部引用。
 * children 仍保活挂载。
 */
export function LeftPanelDrawer({ children, onClose }: { children?: ReactNode; onClose?: () => void }) {
  return (
    <LeftPanel compact onClose={onClose}>
      {children}
    </LeftPanel>
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
  bashTaskContent,
  toolsContent,
  developerContent,
  integrationContent,
  demoPluginContent,
  aiConsoleContent,
  pluginPreviewContent,
  currentType,
}: {
  filesContent: ReactNode
  gitContent: ReactNode
  browserContent?: ReactNode
  todoContent: ReactNode
  translateContent?: ReactNode
  requirementContent?: ReactNode
  terminalContent?: ReactNode
  bashTaskContent?: ReactNode
  toolsContent?: ReactNode
  developerContent?: ReactNode
  integrationContent?: ReactNode
  demoPluginContent?: ReactNode
  aiConsoleContent?: ReactNode
  pluginPreviewContent?: ReactNode
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
  } else if (type === 'bashTask') {
    return <>{bashTaskContent}</>
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
  } else if (type === 'pluginPreview') {
    return <>{pluginPreviewContent}</>
  } else if (pluginPanelRegistry.has(type)) {
    return <PluginPanelHost panelType={type} />
  }

  return null
}