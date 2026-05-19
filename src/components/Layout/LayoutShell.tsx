/**
 * LayoutShell - 顶层布局容器
 *
 * 替换原 App.tsx 中硬编码的 ActivityBar + LeftPanel + CenterStage + RightPanel 结构,
 * 由 layoutStore 驱动:
 * - activityBarPosition: 决定 ActivityBar 在最左/最右/隐藏
 * - slots.left/right/bottom: 由 SlotPanel 通用容器渲染
 * - slots.center: 由 CenterStage (有 Tab) 或 ChatModule (任务驾驶舱预设) 渲染
 *
 * 小屏模式 (isCompactMode) 强制走 CompactSingleSlot 分支,仅渲染 Chat,
 * 不参与槽位系统;布局偏好不会覆盖这一行为。
 *
 * 注意: LayoutShell 不自带 TopMenuBar / Modals / Overlays — 那些保留在 App.tsx
 * 顶层,因为它们是全局级 UI 而非布局槽位的一部分。
 */

import { useLayoutStore } from '@/stores/layoutStore'
import { ChatModule } from '@/components/Chat/ChatModule'
import { CenterStage } from './CenterStage'
import { SlotPanel } from './SlotPanel'
import { ModuleRenderer } from './ModuleRenderer'
import { ModuleTabBar } from './ModuleTabBar'
import { LayoutDndProvider } from './LayoutDndProvider'

interface LayoutShellProps {
  /** 小屏模式下强制单栏 chat,不参与槽位编排 */
  isCompactMode?: boolean
  /** ActivityBar 节点 (左右位置由 layoutStore 决定,LayoutShell 仅负责放置) */
  activityBar?: React.ReactNode
}

export function LayoutShell({ isCompactMode = false, activityBar }: LayoutShellProps) {
  const activityBarPosition = useLayoutStore((s) => s.activityBarPosition)
  const centerSlot = useLayoutStore((s) => s.slots.center)

  // 小屏: 强制单栏 Chat,但保留 ActivityBar (forceCollapsed=true) 让用户通过悬浮球访问模块
  if (isCompactMode) {
    return (
      <div className="flex flex-1 overflow-hidden">
        {activityBar}
        <ChatModule />
      </div>
    )
  }

  const showActivityBar = activityBarPosition !== 'hidden' && activityBar !== undefined
  const activityBarOnLeft = showActivityBar && activityBarPosition === 'left'
  const activityBarOnRight = showActivityBar && activityBarPosition === 'right'

  // center 槽位特化:
  // - 未绑定任何模块 (modules=[] 或 activeModule=null) → 渲染 CenterStage (tabStore 驱动的编辑器 Tab)
  // - 绑定 1 个模块 → 头部不画 ModuleTabBar, 直接渲染该模块
  // - 绑定 ≥2 个模块 → 顶部画 ModuleTabBar (除非 active 模块是 bareRender)
  // - chat 模块走 ChatModule (bareRender 自带 input/status bar), 其他走 ModuleRenderer
  //
  // Center 不复用 SlotPanel:
  //   SlotPanel 的尺寸控制是固定 width/height (适合 left/right/bottom 这种被夹在 flex 容器中
  //   的次要槽位), 而 center 需要 flex-1 占满剩余空间. 因此 center 独立编排.
  const renderCenter = () => {
    const { modules, activeModule } = centerSlot
    if (modules.length === 0 || activeModule === null) {
      return <CenterStage />
    }

    const content =
      activeModule === 'chat' ? (
        <ChatModule />
      ) : (
        <ModuleRenderer moduleId={activeModule} />
      )

    // bareRender 模块(如 chat)自带容器结构与 footer, 不应被多余的 Tab 头部分散其布局.
    // 这与 SlotPanel 的 bareRender 处理保持一致.
    const hasMultipleTabs = modules.length > 1
    const showTabs = hasMultipleTabs && activeModule !== 'chat'

    return (
      <main className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {showTabs && <ModuleTabBar slot="center" />}
        <div className="flex flex-1 min-h-0 flex-col">{content}</div>
      </main>
    )
  }

  return (
    <LayoutDndProvider>
      <div className="flex flex-1 overflow-hidden">
        {activityBarOnLeft && activityBar}
        <SlotPanel slot="left" />

        <div className="flex flex-col flex-1 min-w-0">
          {renderCenter()}
          <SlotPanel slot="bottom" />
        </div>

        <SlotPanel slot="right" />
        {activityBarOnRight && activityBar}
      </div>
    </LayoutDndProvider>
  )
}
