/**
 * Modal - 统一模态对话框原语
 *
 * 封装所有 Modal 重复的样板：
 *   - OverlayGuard（自动管理 overlayStore 计数器，触发 BrowserPanel 隐藏 WebView）
 *   - Portal 到 body（脱离父级 stacking context，避免被 z-index 反压）
 *   - backdrop（z-modal + bg-black/50 + click-to-close + ESC）
 *   - 三态动画（useTransitionState + animate-mask-in/out + animate-dialog-in/out）
 *   - 退场期间背景与自身 inert（防止"幽灵 DOM"捕获交互）
 *   - autofocus 内部第一个可聚焦元素
 *
 * 使用方式：
 *   <Modal open={show} onClose={() => setShow(false)} title="标题">
 *     ...内容...
 *   </Modal>
 *
 * 设计原则：
 *   - 不破坏现有 OverlayGuard/useTransitionState/ConfirmDialog 范式，是它们的收口
 *   - 25+ 处 `fixed inset-0 z-modal bg-black/50` 收敛到这一个组件
 *   - 子内容自由：仅提供外壳与交互契约，内容布局由调用方决定
 */

import { ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OverlayGuard } from '@/components/Browser/OverlayGuard'
import { useTransitionState } from '@/hooks/useTransitionState'
import { clsx } from 'clsx'

export interface ModalProps {
  /** 是否打开（受控） */
  open: boolean
  /** 关闭回调（ESC / backdrop click / 关闭按钮触发） */
  onClose: () => void
  children: ReactNode
  /** backdrop 不透明度变体：default=0.5 / light=0.3 / strong=0.6 */
  backdrop?: 'default' | 'light' | 'strong'
  /** 是否禁用 backdrop 点击关闭（如表单未保存时） */
  disableBackdropClose?: boolean
  /** 是否禁用 ESC 关闭 */
  disableEscape?: boolean
  /** 内容对齐方式 */
  align?: 'center' | 'start'
  /** 顶部偏移（align='start' 时生效，百分比串如 '12vh'） */
  top?: string
  /** 退场动画时长（ms），默认与 tailwind animation dialog-out 140ms 对齐 */
  exitDuration?: number
  /** 调试标签（透传给 OverlayGuard） */
  label?: string
  /** 自定义 className（追加到内容容器，用于宽度/最大高度等） */
  className?: string
  /** 自定义 backdrop className */
  backdropClassName?: string
}

const BACKDROP_BG: Record<NonNullable<ModalProps['backdrop']>, string> = {
  default: 'bg-black/50',
  light: 'bg-black/30',
  strong: 'bg-black/60',
}

export function Modal({
  open,
  onClose,
  children,
  backdrop = 'default',
  disableBackdropClose = false,
  disableEscape = false,
  align = 'center',
  top = '12vh',
  exitDuration = 260,
  label,
  className,
  backdropClassName,
}: ModalProps) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 三态：open=true 时挂载并播入场；open=false 时播退场，结束后卸载
  const { mounted, phase, exit } = useTransitionState({
    duration: exitDuration,
    onExited: () => {
      // 退场动画结束，状态由调用方 open=false 控制；无需额外回调
    },
    // open=false 时立即触发退场
  })

  // open 翻转：true→entering（已由 useTransitionState 默认挂载处理）；
  // false→调用 exit() 触发退场
  useEffect(() => {
    if (!open && phase !== 'exiting' && mounted) {
      exit()
    }
    // open=true 且已 unmounted（被外部强制关闭后又打开）→ useTransitionState 重新挂载
    // 此场景由 key 重置处理，此处不干预
  }, [open, phase, mounted, exit])

  // ESC 关闭（绑在 backdrop 容器，聚焦时生效）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !disableEscape) {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
  }

  // backdrop 点击关闭（仅当点击的是 backdrop 本身，非冒泡自内容）
  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (disableBackdropClose) return
    if (e.target === e.currentTarget) {
      onCloseRef.current()
    }
  }

  // autofocus 内部第一个可聚焦元素
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (mounted && phase !== 'exiting' && contentRef.current) {
      const focusable = contentRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    }
  }, [mounted, phase])

  if (!mounted) return null

  const exiting = phase === 'exiting'
  const backdropClass = clsx(
    'fixed inset-0 z-modal flex',
    align === 'center' ? 'items-center justify-center' : 'items-start justify-center',
    BACKDROP_BG[backdrop],
    exiting ? 'animate-mask-out' : 'animate-mask-in',
    backdropClassName,
  )
  const contentClass = clsx(
    exiting ? 'animate-dialog-out' : 'animate-dialog-in',
    className,
  )

  return createPortal(
    <OverlayGuard label={label ?? 'Modal'}>
      <div
        className={backdropClass}
        style={align === 'start' ? { paddingTop: top } : undefined}
        onMouseDown={handleBackdropMouseDown}
        onKeyDown={handleKeyDown}
        // 退场期间 backdrop 仍可点击关闭（视觉淡出 + 行为立即响应），
        // 但内容自身在退场中不再捕获交互（inert）
        tabIndex={-1}
      >
        <div
          ref={contentRef}
          className={contentClass}
          // 退场期间内容 inert，避免退场中的表单/按钮仍响应
          inert={exiting}
          // 阻止内容点击冒泡到 backdrop（避免误关）
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </OverlayGuard>,
    document.body,
  )
}
