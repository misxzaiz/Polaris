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
  /** 桌面形态顶栏（高密度 tab strip）；渲染于 panel-content 前，抽屉形态不渲染 */
  topBar?: ReactNode
}

/**
 * 左侧面板组件
 * - fullscreen: flex-1 撑满除 ActivityBar 外全部横向空间，无拖拽条（终端全屏）
 * - fillRemaining: flex-1 自适应填充，无拖拽条（终端激活且无编辑器时）
 * - 默认: 固定宽度 + 拖拽条
 * - leaving: 关闭退场时淡出（父组件负责延迟卸载）
 * - compact: 抽屉覆盖形态（窄窗口），children 仍保活
 */
export function LeftPanel({ children, className = '', fillRemaining = false, fullscreen = false, leaving = false, compact = false, onClose, topBar }: LeftPanelProps) {
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

  // 抽屉下的操作栏（展开/关闭按钮）。
  // 形态：compact 时作为 aside 内文档流首行（与旧 LeftPanelDrawer 一致），
  // 不用 fixed 悬浮 —— 悬浮层在遮罩降级 z-popover 后会被 aside（DOM 序靠后）
  // 盖住，按钮点不到。content 容器带稳定 key，工具栏条件插入不会重挂载 children。
  const drawerToolbar = compact && panelVisible && (
    <div className="flex items-center justify-end gap-1 h-9 px-2 border-b border-border shrink-0 bg-background-elevated">
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

  // 抽屉遮罩（独立 sibling，位于 aside 之前）。入场淡入；退场由 aside 的
  // leaving 淡出承接（App.tsx 在 hasLeftPanel true→false 时 leftPanelKept=true，
  // 150ms 后清）。
  // 层级：与抽屉同为 z-overlay（--z-overlay: 40），靠 DOM 序让 aside 覆盖在
  // 遮罩之上——遮罩仅拦截抽屉外区域，抽屉内可正常点击。
  // 不可用 z-modal（70 > 40）或 z-popover（50 > 40）：
  //   - z-modal：遮罩盖住抽屉 → 任意点击触发 handleClose，面板"一点就自动关闭"
  //     （回归来源 412c607c 保活合并时旧 LeftPanelDrawer 容器 z-50 同层语义
  //     被误写成 z-modal，上轮已修）
  //   - z-popover：抽屉盖住窄窗口编辑器覆盖层 NarrowTabOverlay（z-overlay），
  //     打开文件后编辑器被抽屉压住，须先关文件浏览器才能看（本轮修复）
  // 抽屉本质是覆盖层（fixed 遮罩 + 左侧浮出），归 z-overlay 家族；
  // 编辑器覆盖层在 App.tsx 中渲染于 LeftPanel 之后，同层按 DOM 序自然压上。
  const drawerMask = compact && panelVisible && (
    <div
      className={`fixed inset-0 z-overlay bg-black/50 ${leaving ? 'opacity-0' : 'animate-mask-in'}`}
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
      <aside
        ref={drawerRef}
        data-theme-panel
        tabIndex={compact ? -1 : undefined}
        className={`flex flex-col bg-background-elevated border-r border-border min-h-0 ${compact
          ? 'fixed inset-y-0 left-0 z-overlay shadow-xl overflow-hidden'
          : 'relative'
        } transition-[width,opacity] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] ${leaving ? 'opacity-0 pointer-events-none' : 'opacity-100'} ${!panelVisible ? 'hidden' : ''} ${!compact && isFlexible ? 'flex-1 min-w-[200px]' : ''} ${!compact && !isFlexible ? 'shrink-0' : ''} ${className}`}
        style={asideStyle}
      >
        {/* 抽屉形态下显示操作栏；桌面停靠形态不渲染。key 保证 children
            （FileExplorer 等保活内容）位置稳定，工具栏条件插入不触发重挂载。 */}
        {compact && panelVisible && drawerToolbar}
        {!compact && topBar}
        <div key="panel-content" className="flex-1 min-h-0 overflow-hidden">{children}</div>
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
 * 左侧面板内容容器 —— 多面板常驻挂载（保活核心）。
 *
 * 旧版按当前类型单面板 dispatch（切走卸载 → 切换回来重建，Git 面板
 * activeTab/勾选/滚动等组件本地态全被重置）。本版改为：已访问过的面板
 * 全部渲染进容器，各自包一层显隐切换的 wrapper；切换仅改 display，
 * 不卸载重建 —— VSCode view-container 保活模型。
 *
 * 懒挂载：未访问过的面板不渲染（冷启动不挂载全部 12+ 内建/插件面板），
 * 首次激活某 pane 才挂载，此后常驻。mountedSet 用 ref 缓存（非持久化）。
 */
type LeftPanelContentProps = {
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
  /** 当前激活面板类型（关闭后依旧传递上次激活值，用于 strip/外壳高亮与保活判定），默认取 store.activeLeftPanelType */
  currentType?: LeftPanelType
  /** 面板激活态入口（平衡 tab strip 与 legacy ActivityBar 的权威切换） */
  activePanelType?: LeftPanelType
}

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
  activePanelType,
}: LeftPanelContentProps) {
  // Hook 必须在条件之外调用
  const storePanelType = useViewStore((state) => state.leftPanelType)
  const storeActiveType = useViewStore((state) => state.activeLeftPanelType)
  const type = currentType ?? storePanelType

  // 内建面板查表（新增内建面板在此加一行即可）
  const builtinPanels: Record<string, ReactNode> = {
    files: filesContent,
    git: gitContent,
    browser: browserContent,
    todo: todoContent,
    translate: translateContent,
    requirement: requirementContent,
    terminal: terminalContent,
    tools: toolsContent,
    developer: developerContent,
    integration: integrationContent,
    demoPlugin: demoPluginContent,
    aiConsole: aiConsoleContent,
  }

  // 激活面板：优先外部传入的 activePanelType（tab strip 已归一化），
  // 其次取 store 记忆的激活类型（切换/关闭不丢），兜底用当前打开的类型。
  const active = activePanelType
    ?? (storeActiveType in builtinPanels || pluginPanelRegistry.has(storeActiveType) ? storeActiveType : type)
    ?? (type in builtinPanels || pluginPanelRegistry.has(type) ? type : 'none')

  // 懒挂载集合：已访问过的面板常驻，未访问过的不渲染。
  // 用 ref 而非 state：挂载集合只增不减，不需要触发重渲染（激活切换已由 store 驱动）。
  // 初始 `files` 常挂（默认面板，首屏即见）。useState 惰性初始化保证每次渲染引用一致。
  const mountedRef = useRef<Set<string>>(new Set(['files']))
  const mounted = mountedRef.current
  if (active !== 'none') {
    mounted.add(active)
  }

  // 渲染所有已挂载面板，各包一个显隐 wrapper：切换只切 display，不卸载。
  // wrapper 显隐：active 面板 h-full 撑满，其余 display:none（保活常驻 DOM）。
  const panels: ReactNode[] = []
  const panelTypes = [...Object.keys(builtinPanels), ...pluginPanelRegistry.listPanelTypes()]
  const seen = new Set<string>()
  for (const p of panelTypes) {
    if (seen.has(p)) continue // 内建与插件重复类型只渲染一次
    seen.add(p)
    if (!mounted.has(p)) continue // 懒挂载
    const isActive = p === active
    const isBuiltin = p in builtinPanels
    panels.push(
      <div key={p} className={isActive ? 'flex-1 min-w-0 min-h-0' : 'hidden'}>
        {isBuiltin ? builtinPanels[p] : <PluginPanelHost panelType={p} />}
      </div>
    )
  }

  return <div className="flex h-full min-h-0 w-full">{panels}</div>
}