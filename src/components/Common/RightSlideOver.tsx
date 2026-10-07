/**
 * RightSlideOver - 右侧滑出浮层（会话历史 / 消息中心通用）
 *
 * - 进入：自右侧滑入（淡入 + 位移）
 * - 退出：滑出右侧，动画结束才卸载（OverlayGuard 计数随之释放）
 * - 使用 useTransitionState 三态状态机，与 LeftPanelDrawer 同范式
 * - 无遮罩：保持原「固定右侧面板」交互，不遮挡主界面点击
 *
 * 使用方式（父组件必须保持挂载直到退场结束）：
 *   const [kept, setKept] = useState(false)
 *   {show && (
 *     <RightSlideOver
 *       open={show || kept}
 *       exiting={!show && kept}
 *       onExited={() => setKept(false)}
 *     >
 *       ...children（内部关闭按钮调 onClose → 父组件置 show=false）
 *     </RightSlideOver>
 *   )}
 */
import { ReactNode, useEffect } from 'react'
import { OverlayGuard } from '@/components/Browser/OverlayGuard'

interface RightSlideOverProps {
  children: ReactNode
  /** 是否渲染面板本体（父组件 show || kept） */
  open: boolean
  /** 是否退场（父组件 !show && kept） */
  exiting?: boolean
  /** 退场动画结束回调（父组件据此清除 kept） */
  onExited?: () => void
  /** 面板宽度 */
  width?: string
  /** 顶部偏移（百分比串） */
  top?: string
  /** 高度（百分比串） */
  height?: string
}

export function RightSlideOver({
  children,
  open,
  exiting = false,
  onExited,
  width = 'min(400px, 90vw)',
  top = '10%',
  height = '80%',
}: RightSlideOverProps) {
  // 退场计时：exiting=true 后 260ms 回调 onExited（父组件清除 kept）
  useEffect(() => {
    if (!exiting) return
    const t = setTimeout(() => onExited?.(), 260)
    return () => clearTimeout(t)
  }, [exiting, onExited])

  if (!open) return null

  return (
    <OverlayGuard label="RightSlideOver">
      <div
        role="dialog"
        aria-modal="true"
        className={`fixed z-modal bg-background-elevated border border-border rounded-l-xl shadow-xl overflow-hidden ${
          exiting ? 'animate-drawer-out-right' : 'animate-drawer-in-right'
        }`}
        style={{ top, right: '0', height, width }}
      >
        {children}
      </div>
    </OverlayGuard>
  )
}