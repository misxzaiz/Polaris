/**
 * SessionTabContextMenu - 会话标签右键菜单
 *
 * 提供「续接到新会话」：基于当前会话内容开启一个新会话（可选目标引擎）。
 * 跨引擎时走内容快照（summary/full-file），同引擎 claude-code 走 fork。
 * 按鼠标坐标定位，点击外部 / Esc 关闭。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranchPlus } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getHandoffEligibility } from '@/services/sessionHandoff'
import { getEngineDisplayName } from '@/utils/engineDisplay'
import { getEngineRegistry } from '@/ai-runtime'
import type { EngineId } from '@/types'

/**
 * 引擎展示偏好顺序。
 *
 * 实际渲染前用 engine-registry 过滤掉未注册/不可用的引擎，
 * 避免硬编码与注册表不同步、或展示出不存在的引擎。
 */

interface SessionTabContextMenuProps {
  visible: boolean
  x: number
  y: number
  sessionId: string
  /** 源会话引擎（用于在列表中标记当前引擎） */
  sourceEngineId?: EngineId
  onClose: () => void
  onHandoff: (targetEngineId: EngineId) => void
}

export function SessionTabContextMenu({
  visible,
  x,
  y,
  sessionId,
  sourceEngineId,
  onClose,
  onHandoff,
}: SessionTabContextMenuProps) {
  const { t } = useTranslation('chat')
  const menuRef = useRef<HTMLDivElement>(null)

  // 从 registry 动态读取已注册引擎（registry 未就绪时回退全量，避免菜单空）
  const engineOptions = useMemo<EngineId[]>(() => {
    const registered = new Set(getEngineRegistry().list().map(d => d.id))
    const preferredOrder = ['claude-code', 'codex', 'simple-ai', 'pi'] as EngineId[]
    // 已知引擎按偏好顺序，其余（插件引擎）追加到末尾
    const known = preferredOrder.filter(id => registered.has(id))
    const plugin = registered.size > 0
      ? [...registered].filter(id => !preferredOrder.includes(id as EngineId)) as EngineId[]
      : []
    const combined = known.length > 0 ? [...known, ...plugin] : preferredOrder
    return combined
  }, [])

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
      <div
        className={cn(
          'w-full px-3 py-2 text-left text-xs flex items-center gap-2',
          eligibility.enabled ? 'text-text-muted' : 'text-text-muted/60',
        )}
        title={eligibility.reasonKey ? t(eligibility.reasonKey) : t('handoff.menuTooltip')}
      >
        <GitBranchPlus size={14} className="shrink-0" />
        <span>{t('handoff.menuItem')}</span>
      </div>

      {eligibility.enabled && (
        <div className="px-1 pb-1 flex flex-col">
          {engineOptions.map((engineId) => {
            const isSource = engineId === sourceEngineId
            return (
              <button
                key={engineId}
                onClick={() => {
                  onHandoff(engineId)
                  onClose()
                }}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-sm rounded transition-colors flex items-center justify-between gap-2',
                  'text-text-primary hover:bg-background-hover',
                )}
              >
                <span>{getEngineDisplayName(engineId)}</span>
                {isSource && (
                  <span className="text-[10px] text-text-muted">{t('handoff.currentEngine')}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {!eligibility.enabled && eligibility.reasonKey && (
        <div className="px-3 py-1.5 text-xs text-text-muted/70">
          {t(eligibility.reasonKey)}
        </div>
      )}
    </div>
  )
}
