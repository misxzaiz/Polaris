/**
 * KnowledgeHealthDashboard - 知识系统健康度仪表盘
 *
 * 展示断言健康度统计：
 * - 置信度分布（green/yellow/orange/red/black）
 * - 陷阱统计
 * - 模块覆盖率
 * - 过期状态
 */

import { useMemo } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '../stores/knowledgeStore'
import { type ConfidenceLevel, CONFIDENCE_CONFIG } from './constants'

/** 置信度图标映射 */
const CONFIDENCE_ICONS: Record<ConfidenceLevel, typeof CheckCircle> = {
  green: CheckCircle,
  yellow: HelpCircle,
  orange: AlertTriangle,
  red: ShieldAlert,
  black: XCircle,
}

interface HealthStats {
  totalAssertions: number
  totalTraps: number
  confidenceDistribution: Record<ConfidenceLevel, number>
  moduleCoverage: {
    total: number
    withAssertions: number
    withTraps: number
  }
  staleCount: number
  healthScore: number
}

function calculateHealthStats(
  modules: Array<{
    id: string
    assertions: Array<{ confidence: string }>
    traps: unknown[]
  }>,
  staleCount: number
): HealthStats {
  let totalAssertions = 0
  let totalTraps = 0
  const confidenceDistribution: Record<ConfidenceLevel, number> = {
    green: 0,
    yellow: 0,
    orange: 0,
    red: 0,
    black: 0,
  }
  let modulesWithAssertions = 0
  let modulesWithTraps = 0

  for (const mod of modules) {
    const assertionCount = mod.assertions?.length ?? 0
    const trapCount = mod.traps?.length ?? 0

    totalAssertions += assertionCount
    totalTraps += trapCount

    if (assertionCount > 0) modulesWithAssertions++
    if (trapCount > 0) modulesWithTraps++

    for (const a of mod.assertions ?? []) {
      const conf = a.confidence as ConfidenceLevel
      if (conf in confidenceDistribution) {
        confidenceDistribution[conf]++
      }
    }
  }

  // 计算健康度分数：green 权重 1.0, yellow 0.7, orange 0.3, red/black 0
  const weightedScore =
    confidenceDistribution.green * 1.0 +
    confidenceDistribution.yellow * 0.7 +
    confidenceDistribution.orange * 0.3

  const maxScore = totalAssertions || 1
  const healthScore = Math.round((weightedScore / maxScore) * 100)

  return {
    totalAssertions,
    totalTraps,
    confidenceDistribution,
    moduleCoverage: {
      total: modules.length,
      withAssertions: modulesWithAssertions,
      withTraps: modulesWithTraps,
    },
    staleCount,
    healthScore,
  }
}

interface KnowledgeHealthDashboardProps {
  /** 点击置信度条形筛选回调 */
  onConfidenceFilter?: (level: ConfidenceLevel) => void
}

export function KnowledgeHealthDashboard({ onConfidenceFilter }: KnowledgeHealthDashboardProps) {
  const { t } = useTranslation('knowledge')
  const { index, staleModules } = useKnowledgeStore()

  const stats = useMemo((): HealthStats | null => {
    if (!index?.modules) return null

    const modulesWithDetails = index.modules.map(m => ({
      id: m.id,
      assertions: m.assertions ?? [],
      traps: m.traps ?? [],
    }))

    return calculateHealthStats(modulesWithDetails, staleModules.length)
  }, [index, staleModules])

  if (!stats) {
    return (
      <div className="p-4 text-center text-text-tertiary text-xs">
        {t('noData', '暂无数据')}
      </div>
    )
  }

  return (
    <div className="p-3 space-y-4">
      {/* 健康度总览 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-primary" />
          <span className="text-sm font-medium text-text-primary">
            {t('healthDashboard', '健康度仪表盘')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">
            {t('healthScore', '健康分数')}:
          </span>
          <span
            className={`text-lg font-bold ${
              stats.healthScore >= 70
                ? 'text-green-500'
                : stats.healthScore >= 40
                  ? 'text-yellow-500'
                  : 'text-red-500'
            }`}
          >
            {stats.healthScore}
          </span>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-2 rounded bg-background-surface border border-border-subtle text-center">
          <div className="text-lg font-bold text-text-primary">
            {stats.totalAssertions}
          </div>
          <div className="text-xs text-text-tertiary">
            {t('totalAssertions', '断言总数')}
          </div>
        </div>
        <div className="p-2 rounded bg-background-surface border border-border-subtle text-center">
          <div className="text-lg font-bold text-text-primary">
            {stats.totalTraps}
          </div>
          <div className="text-xs text-text-tertiary">
            {t('totalTraps', '陷阱总数')}
          </div>
        </div>
        <div className="p-2 rounded bg-background-surface border border-border-subtle text-center">
          <div className={`text-lg font-bold ${stats.staleCount > 0 ? 'text-amber-500' : 'text-green-500'}`}>
            {stats.staleCount}
          </div>
          <div className="text-xs text-text-tertiary">
            {t('staleModules', '过期模块')}
          </div>
        </div>
      </div>

      {/* 置信度分布 */}
      <div>
        <div className="text-xs text-text-secondary mb-2">
          {t('confidenceDistribution', '置信度分布')}
        </div>
        <div className="space-y-1.5">
          {(Object.entries(CONFIDENCE_CONFIG) as [ConfidenceLevel, typeof CONFIDENCE_CONFIG.green][]).map(
            ([level, config]) => {
              const count = stats.confidenceDistribution[level]
              const percentage = stats.totalAssertions > 0
                ? Math.round((count / stats.totalAssertions) * 100)
                : 0
              const Icon = CONFIDENCE_ICONS[level]

              return (
                <div
                  key={level}
                  className={`flex items-center gap-2 ${onConfidenceFilter ? 'cursor-pointer hover:bg-background-surface rounded p-1 -m-1 transition-colors' : ''}`}
                  onClick={() => onConfidenceFilter?.(level)}
                  title={onConfidenceFilter ? t('detail.filterByConfidence') : undefined}
                >
                  <Icon size={12} className={config.color} />
                  <span className="text-xs text-text-secondary w-16">
                    {t(config.labelKey)}
                  </span>
                  <div className="flex-1 h-2 bg-background-tertiary rounded overflow-hidden">
                    <div
                      className={`h-full ${config.bgColor} opacity-70`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <span className="text-xs text-text-tertiary w-12 text-right">
                    {count} ({percentage}%)
                  </span>
                </div>
              )
            }
          )}
        </div>
      </div>

      {/* 模块覆盖 */}
      <div>
        <div className="text-xs text-text-secondary mb-2">
          {t('moduleCoverage', '模块覆盖率')}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 rounded bg-background-surface border border-border-subtle">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                {t('assertionCoverage', '断言覆盖')}
              </span>
              <span className="text-xs font-medium text-text-primary">
                {stats.moduleCoverage.withAssertions}/{stats.moduleCoverage.total}
              </span>
            </div>
            <div className="mt-1 h-1.5 bg-background-tertiary rounded overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${(stats.moduleCoverage.withAssertions / stats.moduleCoverage.total) * 100}%`,
                }}
              />
            </div>
          </div>
          <div className="p-2 rounded bg-background-surface border border-border-subtle">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                {t('trapCoverage', '陷阱覆盖')}
              </span>
              <span className="text-xs font-medium text-text-primary">
                {stats.moduleCoverage.withTraps}/{stats.moduleCoverage.total}
              </span>
            </div>
            <div className="mt-1 h-1.5 bg-background-tertiary rounded overflow-hidden">
              <div
                className="h-full bg-amber-500"
                style={{
                  width: `${(stats.moduleCoverage.withTraps / stats.moduleCoverage.total) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
