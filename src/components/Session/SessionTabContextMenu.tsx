/**
 * SessionTabContextMenu - 会话标签右键菜单
 *
 * 当前提供「续接到新会话」：导出当前会话内容为文件，并开启一个
 * 通过 @ 引用了解此前进展的新会话。按鼠标坐标定位，点击外部 / Esc 关闭。
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranchPlus } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getHandoffEligibility } from '@/services/sessionHandoff'

interface SessionTabContextMenuProps {
  visible: boolean
  x: number
  y: number
  sessionId: string
  onClose: () => void
  onHandoff: () => void
}

export function SessionTabContextMenu({
  visible,
  x,
  y,
  sessionId,
  onClose,
  onHandoff,
}: SessionTabContextMenuProps) {
  const { t } = useTranslation('chat')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [visible, onClose])

  if (!visible) return null

  const eligibility = getHandoffEligibility(sessionId)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[200px] bg-background-elevated border border-border rounded-md shadow-lg py-1"
      style={{ left: `${x}px`, top: `${y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={() => {
          if (!eligibility.enabled) return
          onHandoff()
          onClose()
        }}
        disabled={!eligibility.enabled}
        title={eligibility.reasonKey ? t(eligibility.reasonKey) : t('handoff.menuTooltip')}
        className={cn(
          'w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors',
          eligibility.enabled
            ? 'text-text-primary hover:bg-background-hover'
            : 'text-text-muted cursor-not-allowed',
        )}
      >
        <GitBranchPlus size={14} className="shrink-0" />
        <span>{t('handoff.menuItem')}</span>
      </button>
    </div>
  )
}
