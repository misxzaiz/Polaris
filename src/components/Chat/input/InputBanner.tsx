/**
 * 输入区动态横幅（AI 经 cap.ui.input 注入）
 *
 * 渲染在输入容器上方：文案 + 可选动作按钮。点击按钮执行 banner 里声明的
 * dispatch（cap_dispatch 任意能力）。显示「清除」按钮供用户主动关闭。
 * 背景色按 tone 分级，遵循主题 token（不硬编码颜色）。
 */
import { X } from 'lucide-react'
import { useInputUIStore, type InputBanner as InputBannerType } from '@/stores/inputUIStore'

const TONE_CLASSES: Record<InputBannerType['tone'], string> = {
  info: 'bg-primary/10 border-primary/20 text-primary',
  warn: 'bg-warning/10 border-warning/30 text-warning',
  success: 'bg-success/10 border-success/20 text-success',
  danger: 'bg-danger/10 border-danger/20 text-danger',
}

export function InputBanner() {
  const banner = useInputUIStore((s) => s.banner)
  const setBanner = useInputUIStore((s) => s.setBanner)
  const dispatchBannerAction = useInputUIStore((s) => s.dispatchBannerAction)

  if (!banner) return null

  const action = banner.action
  const toneClass = TONE_CLASSES[banner.tone] ?? TONE_CLASSES.info

  return (
    <div className="px-2 sm:px-3 pt-2">
      <div
        className={`flex items-center gap-1.5 max-w-full px-2.5 py-1.5 rounded-lg border text-xs ${toneClass}`}
        role="status"
      >
        <span className="flex-1 min-w-0 line-clamp-2 break-words">{banner.text}</span>
        {action && (
          <button
            onClick={() => dispatchBannerAction(action)}
            className="shrink-0 px-2 py-0.5 rounded-md bg-background-elevated border border-border text-text-primary hover:bg-background-hover transition-colors"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={() => setBanner(null)}
          className="shrink-0 p-0.5 rounded hover:bg-background-hover/60 transition-colors"
          title="清除横幅"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}