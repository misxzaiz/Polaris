/**
 * ModuleCard - 知识模块卡片
 *
 * 展示模块 ID、名称、复杂度、变更频率，支持过期状态提示
 */

import { useState } from 'react'
import {
  ChevronRight,
  AlertTriangle,
  Layers,
  GitBranch,
  Activity,
  X,
  ShieldCheck,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModuleIndexEntry as KnowledgeModule, StaleModule } from '@/services/knowledgeService'
import { useKnowledgeStore } from '@/stores/knowledgeStore'

interface ModuleCardProps {
  module: KnowledgeModule
  isStale: boolean
  staleInfo?: StaleModule
  /** 点击查看详情回调 */
  onDetailClick?: (moduleId: string) => void
  /** 点击编辑回调 */
  onEditClick?: (moduleId: string) => void
  /** 点击删除回调 */
  onDeleteClick?: (moduleId: string) => void
}

/** 复杂度颜色映射 */
const COMPLEXITY_COLORS: Record<string, string> = {
  low: 'text-green-500',
  medium: 'text-amber-500',
  high: 'text-red-500',
}

/** 变更频率颜色映射 */
const FREQUENCY_COLORS: Record<string, string> = {
  low: 'text-green-500',
  medium: 'text-amber-500',
  high: 'text-red-500',
}

export function ModuleCard({ module, isStale, staleInfo, onDetailClick, onEditClick, onDeleteClick }: ModuleCardProps) {
  const { t } = useTranslation('knowledge')
  const [expanded, setExpanded] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearStaleMarker = useKnowledgeStore(state => state.clearStaleMarker)

  const handleClearStale = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clearing) return
    setClearing(true)
    try {
      await clearStaleMarker(module.id)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div
      className={`
        p-2 rounded border transition-all cursor-pointer group
        ${isStale
          ? 'bg-amber-500/5 border-amber-500/30 hover:border-amber-500/50'
          : 'bg-background-surface border-border-subtle hover:border-border'
        }
      `}
      onClick={() => {
        if (onDetailClick) {
          onDetailClick(module.id)
        } else {
          setExpanded(!expanded)
        }
      }}
    >
      <div className="flex items-center gap-2">
        {/* 展开/折叠箭头 */}
        <ChevronRight
          size={12}
          className={`text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        />

        {/* 过期标记 */}
        {isStale && (
          <AlertTriangle size={12} className="text-amber-500 flex-shrink-0" />
        )}

        {/* 模块名称 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-text-primary truncate">
              {module.name}
            </span>
          </div>
          <span className="text-xs text-text-tertiary">
            #{module.id}
          </span>
          {module.domain && (
            <span className="px-1 py-0.5 text-[10px] bg-background-tertiary rounded ml-1">
              {module.domain}
            </span>
          )}
        </div>

        {/* 依赖数量 */}
        <div className="flex items-center gap-1 text-xs text-text-tertiary">
          <Layers size={10} />
          <span>{module.dependencies.length}</span>
        </div>

        {/* 断言数量 */}
        {(module.assertions?.length ?? 0) > 0 && (
          <div className="flex items-center gap-0.5 text-xs text-text-tertiary">
            <ShieldCheck size={10} className="text-green-500" />
            <span>{module.assertions!.length}</span>
          </div>
        )}

        {/* 陷阱数量 */}
        {(module.traps?.length ?? 0) > 0 && (
          <div className="flex items-center gap-0.5 text-xs text-text-tertiary">
            <AlertTriangle size={10} className="text-amber-500" />
            <span>{module.traps!.length}</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity">
          {onEditClick && (
            <button
              onClick={(e) => { e.stopPropagation(); onEditClick(module.id) }}
              className="p-0.5 rounded hover:bg-background-tertiary text-text-tertiary hover:text-primary"
              title={t('form.editTitle')}
            >
              <Pencil size={12} />
            </button>
          )}
          {onDeleteClick && (
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteClick(module.id) }}
              className="p-0.5 rounded hover:bg-background-tertiary text-text-tertiary hover:text-red-400"
              title={t('confirm.deleteTitle')}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border-subtle space-y-2">
          {/* 复杂度和变更频率 */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-xs">
              <Activity size={10} className={COMPLEXITY_COLORS[module.complexity] || 'text-text-tertiary'} />
              <span className="text-text-secondary">
                {t('complexity')}:
              </span>
              <span className={COMPLEXITY_COLORS[module.complexity] || ''}>
                {t(`complexityLevel.${module.complexity}`)}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs">
              <GitBranch size={10} className={FREQUENCY_COLORS[module.changeFrequency] || 'text-text-tertiary'} />
              <span className="text-text-secondary">
                {t('changeFrequency')}:
              </span>
              <span className={FREQUENCY_COLORS[module.changeFrequency] || ''}>
                {t(`frequencyLevel.${module.changeFrequency}`)}
              </span>
            </div>
          </div>

          {/* 依赖模块 */}
          {module.dependencies.length > 0 && (
            <div className="text-xs">
              <span className="text-text-secondary">{t('dependencies')}:</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {module.dependencies.slice(0, 5).map(dep => (
                  <span
                    key={dep}
                    className="px-1 py-0.5 bg-background-tertiary rounded text-text-tertiary"
                  >
                    #{dep}
                  </span>
                ))}
                {module.dependencies.length > 5 && (
                  <span className="text-text-tertiary">
                    +{module.dependencies.length - 5}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 过期信息 */}
          {isStale && staleInfo && (
            <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs text-amber-500 font-medium">
                    {t('staleModuleTitle')}
                  </div>
                  <div className="mt-1 text-xs text-text-secondary">
                    {t('changedFiles')}:
                  </div>
                  <div className="mt-1 text-xs text-text-tertiary line-clamp-2">
                    {staleInfo.changedFiles.join(', ')}
                  </div>
                </div>
                <button
                  onClick={handleClearStale}
                  disabled={clearing}
                  className="p-1 rounded hover:bg-amber-500/20 disabled:opacity-50"
                  title={t('clearStale')}
                >
                  <X size={12} className="text-amber-500" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
